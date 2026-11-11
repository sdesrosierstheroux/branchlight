import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { git, repository, status } from '../git.mjs';
import { checkoutBranch, pullBranch } from '../branch-actions.mjs';
import { createApp } from '../server.mjs';

async function fixture(t) {
    const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'branchlight-branches-')));
    t.after(async () => {
        assert.equal(path.dirname(directory), await realpath(os.tmpdir()));
        assert.ok(path.basename(directory).startsWith('branchlight-branches-'));
        await rm(directory, { recursive: true, force: true });
    });
    const root = path.join(directory, 'repository');
    await mkdir(root);
    await git(root, ['init', '-b', 'main']);
    await configure(root, directory);
    await writeFile(path.join(root, 'file.txt'), 'base\n');
    await writeFile(path.join(root, '.gitignore'), 'ignored.txt\n');
    await commit(root, 'Base');
    return { root: await repository(root), directory };
}

async function configure(root, directory) {
    for (const [key, value] of Object.entries({ 'user.name': 'Branchlight Test', 'user.email': 'test@example.invalid', 'commit.gpgsign': 'false', 'core.autocrlf': 'false', 'core.hooksPath': path.join(directory, 'no-hooks') })) {
        await git(root, ['config', key, value]);
    }
}
async function commit(root, message) {
    await git(root, ['add', '.']);
    await git(root, ['commit', '-m', message]);
}
async function input(root, ref) {
    const data = await status(root);
    return { root, head: data.head, branch: data.branch, ...(ref ? { ref } : {}) };
}
const checkout = async (root, ref) => checkoutBranch(root, await input(root, ref));
const pull = async root => pullBranch(root, await input(root));

async function remoteFixture(t) {
    const result = await fixture(t);
    const remote = path.join(result.directory, 'remote.git');
    const peer = path.join(result.directory, 'peer');
    await git(result.directory, ['init', '--bare', '-b', 'main', remote]);
    await git(result.root, ['remote', 'add', 'origin', remote]);
    await git(result.root, ['push', '-u', 'origin', 'main']);
    await git(result.directory, ['clone', remote, peer]);
    await configure(peer, result.directory);
    return { ...result, remote, peer };
}

test('checkout switches local branches and preserves nonconflicting staged and unstaged edits', async t => {
    const { root } = await fixture(t);
    await git(root, ['branch', 'feature/nested']);
    await writeFile(path.join(root, 'file.txt'), 'staged\n');
    await git(root, ['add', 'file.txt']);
    await writeFile(path.join(root, 'file.txt'), 'unstaged\n');
    await checkout(root, 'refs/heads/feature/nested');
    assert.equal((await status(root)).branch, 'feature/nested');
    assert.equal(await git(root, ['show', ':file.txt']), 'staged\n');
    assert.equal(await readFile(path.join(root, 'file.txt'), 'utf8'), 'unstaged\n');
});

test('checkout survives a hook exceeding 30 seconds while the server stays responsive and blocks competing writes', { timeout: 60000 }, async t => {
    const { root, directory } = await fixture(t);
    await git(root, ['branch', 'feature']);
    const hooks = path.join(directory, 'hooks');
    await mkdir(hooks);
    await writeFile(path.join(hooks, 'post-checkout'), '#!/bin/sh\nsleep 31\n', { mode: 0o755 });
    await git(root, ['config', 'core.hooksPath', hooks]);
    const { server, token } = await createApp(root);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const url = `http://127.0.0.1:${server.address().port}`;
    const headers = { 'X-Branchlight-Token': token };
    const body = await input(root, 'refs/heads/feature');
    const post = () => fetch(url + '/api/branches/checkout', { method: 'POST', headers, body: JSON.stringify(body) });
    const pending = post();
    // Git updates HEAD before running post-checkout; wait until the hook is in flight.
    const deadline = Date.now() + 10000;
    let branch;
    do {
        branch = (await git(root, ['branch', '--show-current'])).trim();
        if (branch === 'feature') break;
        await delay(100);
    } while (Date.now() < deadline);
    assert.equal(branch, 'feature');
    const during = await fetch(url + '/api/status', { headers });
    assert.equal(during.status, 200);
    assert.equal((await during.json()).branch, 'feature');
    assert.equal((await post()).status, 409);
    const response = await pending;
    const result = await response.json();
    assert.equal(response.status, 200, result.error);
    assert.equal(result.root, root);
    assert.equal((await status(root)).branch, 'feature');
});

test('checkout refuses overwrites, stale requests, invalid refs, and active operations', async t => {
    const { root } = await fixture(t);
    await git(root, ['switch', '-c', 'feature']);
    await writeFile(path.join(root, 'file.txt'), 'feature\n');
    await commit(root, 'Feature');
    await git(root, ['switch', 'main']);
    await writeFile(path.join(root, 'file.txt'), 'keep edits\n');
    await assert.rejects(checkout(root, 'refs/heads/feature'), /overwritten/);
    assert.equal((await status(root)).branch, 'main');
    assert.equal(await readFile(path.join(root, 'file.txt'), 'utf8'), 'keep edits\n');
    for (const ref of ['--discard-changes', 'HEAD', 'refs/tags/main', 'refs/heads/missing']) {
        await assert.rejects(checkout(root, ref), /existing local or remote branch/);
    }
    await assert.rejects(checkoutBranch(root, { ...await input(root, 'refs/heads/feature'), head: 'stale' }), /branch changed/);
    const dir = (await git(root, ['rev-parse', '--absolute-git-dir'])).trim();
    await writeFile(path.join(dir, 'MERGE_HEAD'), (await status(root)).head);
    await assert.rejects(checkout(root, 'refs/heads/feature'), /active Git operation/);
});

test('checkout protects ignored files, untracked files, and branches occupied by another worktree', async t => {
    const { root, directory } = await fixture(t);
    await git(root, ['switch', '-c', 'feature']);
    await writeFile(path.join(root, 'ignored.txt'), 'tracked on feature\n');
    await writeFile(path.join(root, 'new.txt'), 'tracked on feature\n');
    await git(root, ['add', '-f', 'ignored.txt', 'new.txt']);
    await commit(root, 'Feature files');
    await git(root, ['switch', 'main']);
    await writeFile(path.join(root, 'ignored.txt'), 'keep ignored\n');
    await writeFile(path.join(root, 'new.txt'), 'keep untracked\n');
    await assert.rejects(checkout(root, 'refs/heads/feature'), /overwritten/);
    assert.equal(await readFile(path.join(root, 'ignored.txt'), 'utf8'), 'keep ignored\n');
    assert.equal(await readFile(path.join(root, 'new.txt'), 'utf8'), 'keep untracked\n');
    await git(root, ['worktree', 'add', path.join(directory, 'linked'), 'feature']);
    await assert.rejects(checkout(root, 'refs/heads/feature'), /used by worktree|already checked out/);
});

test('remote checkout creates tracking branch, reuses matching local branch, and rejects collisions and symbolic HEAD', async t => {
    const { root, peer } = await remoteFixture(t);
    await git(peer, ['switch', '-c', 'feature/nested']);
    await writeFile(path.join(peer, 'feature.txt'), 'remote feature\n');
    await commit(peer, 'Remote feature');
    await git(peer, ['push', '-u', 'origin', 'feature/nested']);
    await git(root, ['fetch', 'origin']);
    await checkout(root, 'refs/remotes/origin/feature/nested');
    assert.equal((await status(root)).branch, 'feature/nested');
    assert.equal((await git(root, ['rev-parse', '--symbolic-full-name', '@{upstream}'])).trim(), 'refs/remotes/origin/feature/nested');
    await checkout(root, 'refs/heads/main');
    await checkout(root, 'refs/remotes/origin/feature/nested');
    await checkout(root, 'refs/heads/main');
    await git(root, ['branch', '--unset-upstream', 'feature/nested']);
    await assert.rejects(checkout(root, 'refs/remotes/origin/feature/nested'), /already exists/);
    await git(root, ['remote', 'set-head', 'origin', 'main']);
    await assert.rejects(checkout(root, 'refs/remotes/origin/HEAD'), /existing local or remote branch/);
});

test('pull fast-forwards current branch and is repeatable even with rebase configured', async t => {
    const { root, peer } = await remoteFixture(t);
    await writeFile(path.join(peer, 'file.txt'), 'upstream\n');
    await commit(peer, 'Upstream');
    await git(peer, ['push']);
    await git(root, ['config', 'pull.rebase', 'true']);
    assert.equal((await pull(root)).updated, true);
    assert.equal(await readFile(path.join(root, 'file.txt'), 'utf8'), 'upstream\n');
    assert.equal((await pull(root)).updated, false);
    assert.equal((await status(root)).branch, 'main');
});

test('pull refuses dirty, detached, untracked-upstream, and diverged branches without autostash or rebase', async t => {
    const { root, peer } = await remoteFixture(t);
    await writeFile(path.join(root, 'file.txt'), 'local work\n');
    await git(root, ['config', 'pull.autostash', 'true']);
    await assert.rejects(pull(root), /Commit or stash/);
    assert.equal(await readFile(path.join(root, 'file.txt'), 'utf8'), 'local work\n');
    await commit(root, 'Local');
    const head = (await status(root)).head;
    await writeFile(path.join(peer, 'file.txt'), 'remote work\n');
    await commit(peer, 'Remote');
    await git(peer, ['push']);
    await assert.rejects(pull(root), /Pull did not finish/);
    assert.equal((await status(root)).head, head);
    assert.equal(await git(root, ['status', '--porcelain']), '');
    assert.equal(await git(root, ['stash', 'list']), '');
    await git(root, ['switch', '--detach']);
    await assert.rejects(pull(root), /tracking upstream/);
    await git(root, ['switch', '-c', 'no-upstream']);
    await assert.rejects(pull(root), /tracking upstream/);
});

test('pull protects ignored local files that become tracked upstream', async t => {
    const { root, peer } = await remoteFixture(t);
    await writeFile(path.join(peer, 'ignored.txt'), 'remote file\n');
    await git(peer, ['add', '-f', 'ignored.txt']);
    await commit(peer, 'Track previously ignored file');
    await git(peer, ['push']);
    await writeFile(path.join(root, 'ignored.txt'), 'keep local configuration\n');
    const head = (await status(root)).head;
    await assert.rejects(pull(root), /overwritten/);
    assert.equal((await status(root)).head, head);
    assert.equal(await readFile(path.join(root, 'ignored.txt'), 'utf8'), 'keep local configuration\n');
});

test('HTTP branch actions require authentication, POST, current root and current checkout', async t => {
    const { root } = await fixture(t);
    await git(root, ['branch', 'feature']);
    const { server, token } = await createApp(root);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const url = `http://127.0.0.1:${server.address().port}`;
    const post = (route, body, headers = { 'X-Branchlight-Token': token }) => fetch(url + route, { method: 'POST', headers, body: JSON.stringify(body) });
    const body = await input(root, 'refs/heads/feature');
    assert.equal((await post('/api/branches/checkout', body, {})).status, 401);
    assert.equal((await post('/api/branches/checkout', body, { 'X-Branchlight-Token': token, Origin: 'https://example.invalid' })).status, 403);
    assert.equal((await post('/api/branches/checkout', { ...body, root: 'other' })).status, 400);
    assert.equal((await post('/api/branches/checkout', { ...body, head: 'stale' })).status, 400);
    assert.equal((await fetch(url + '/api/branches/checkout', { headers: { 'X-Branchlight-Token': token } })).status, 404);
    assert.equal((await post('/api/branches/checkout', body)).status, 200);
    assert.equal((await status(root)).branch, 'feature');
    const response = await post('/api/branches/pull', await input(root));
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /tracking upstream/);
});


test('status compares the current upstream without fetching or mistaking missing tracking data for zero', async t => {
    const { root, peer } = await remoteFixture(t);
    const initial = await status(root);
    assert.equal(initial.trackingAvailable, true);
    assert.equal(initial.behind, 0);
    assert.equal(initial.ahead, 0);
    for (let i = 1; i <= 3; i++) {
        await writeFile(path.join(peer, 'remote.txt'), 'Remote change ' + i + '\n');
        await commit(peer, 'Remote change ' + i);
    }
    await git(peer, ['push', 'origin', 'main']);
    assert.equal((await status(root)).behind, 0, 'Status uses the last fetched refs and never fetches on its own');
    await git(root, ['fetch', 'origin']);
    assert.equal((await status(root)).behind, 3);
    await writeFile(path.join(root, 'local.txt'), 'Local commit\n');
    await commit(root, 'Local commit');
    await writeFile(path.join(root, 'file.txt'), 'Uncommitted edit\n');
    const diverged = await status(root);
    assert.equal(diverged.trackingAvailable, true);
    assert.equal(diverged.behind, 3);
    assert.equal(diverged.ahead, 1);
    assert.equal(await readFile(path.join(root, 'file.txt'), 'utf8'), 'Uncommitted edit\n');
    await git(root, ['update-ref', '-d', 'refs/remotes/origin/main']);
    const missing = await status(root);
    assert.ok(missing.refs.find(ref => ref.current).upstream);
    assert.equal(missing.trackingAvailable, false);
    await git(root, ['branch', '--unset-upstream']);
    assert.equal((await status(root)).trackingAvailable, false);
    await git(root, ['switch', '--detach', 'HEAD']);
    const detached = await status(root);
    assert.equal(detached.trackingAvailable, false);
    assert.equal(detached.refs.some(ref => ref.current), false);
    assert.equal(detached.head, diverged.head);
    assert.equal(await readFile(path.join(root, 'file.txt'), 'utf8'), 'Uncommitted edit\n');
});
