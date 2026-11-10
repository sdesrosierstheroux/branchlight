import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { git, repository } from '../git.mjs';
import { discoverRepositories, chooseStartupRepository } from '../repositories.mjs';
import { createApp } from '../server.mjs';

async function fixture(t) {
    const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'branchlight-repos-test-')));
    const folder = path.join(directory, 'git');
    await mkdir(folder);
    t.after(async () => {
        assert.equal(path.dirname(directory), await realpath(os.tmpdir()));
        assert.ok(path.basename(directory).startsWith('branchlight-repos-test-'));
        await rm(directory, { recursive: true, force: true });
    });
    return { directory, folder };
}

async function init(folder, name) {
    const root = path.join(folder, name);
    await mkdir(root, { recursive: true });
    await git(root, ['init', '-b', 'main']);
    await git(root, ['config', 'user.name', 'Branchlight Test']);
    await git(root, ['config', 'user.email', 'test@example.invalid']);
    await git(root, ['config', 'commit.gpgsign', 'false']);
    await git(root, ['config', 'core.hooksPath', path.join(root, 'no-hooks')]);
    await git(root, ['commit', '--allow-empty', '-m', 'Initial']);
    return repository(root);
}

test('discovers direct repositories without traversing contents, containers or junctions', async t => {
    const { folder, directory } = await fixture(t);
    const alpha = await init(folder, 'alpha ü');
    const rdm = await init(folder, 'RDM');
    await mkdir(path.join(folder, 'backups'));
    await init(folder, 'RDM-worktrees/nested-repo');
    await init(rdm, 'embedded');
    const outside = await init(directory, 'outside');
    await symlink(outside, path.join(folder, 'linked-outside'), process.platform === 'win32' ? 'junction' : 'dir');
    const result = await discoverRepositories(folder);
    assert.equal(result.folder, folder);
    assert.equal(result.warning, '');
    assert.deepEqual(result.repositories, [{ name: 'alpha ü', path: alpha }, { name: 'RDM', path: rdm }]);
});

test('keeps readable repositories when a sibling Git registration is invalid', async t => {
    const { folder } = await fixture(t);
    const rdm = await init(folder, 'RDM');
    const broken = path.join(folder, 'broken');
    await mkdir(broken);
    await writeFile(path.join(broken, '.git'), 'gitdir: missing\n');
    const result = await discoverRepositories(folder);
    assert.deepEqual(result.repositories, [{ name: 'RDM', path: rdm }]);
    assert.match(result.warning, /broken/);
});

test('startup honors an explicit repository, then the last worktree, then the first discovered repository', async t => {
    const { folder, directory } = await fixture(t);
    const alpha = await init(folder, 'alpha');
    const rdm = await init(folder, 'RDM');
    const worktree = path.join(directory, 'feature');
    await git(rdm, ['worktree', 'add', '-b', 'feature/test', worktree]);
    assert.equal(await chooseStartupRepository({ folder }), alpha);
    assert.equal(await chooseStartupRepository({ folder, saved: worktree }), await realpath(worktree));
    assert.equal(await chooseStartupRepository({ folder, requested: alpha, saved: worktree }), alpha);
    assert.equal(await chooseStartupRepository({ folder, requested: path.join(directory, 'missing'), saved: worktree }), await realpath(worktree));
    assert.equal(await chooseStartupRepository({ folder, saved: path.join(directory, 'deleted-checkout') }), alpha);
});

test('startup falls back to the first repository when RDM is absent and returns no repository for empty or missing folders', async t => {
    const { folder, directory } = await fixture(t);
    assert.equal(await chooseStartupRepository({ folder }), null);
    const missing = path.join(directory, 'missing');
    assert.equal(await chooseStartupRepository({ folder: missing }), null);
    assert.match((await discoverRepositories(missing)).warning, /unavailable/);
    await init(folder, 'zeta');
    const alpha = await init(folder, 'alpha');
    assert.equal(await chooseStartupRepository({ folder }), alpha);
});

test('discovery refresh picks up a new repository without returning ordinary subfolders of another repository', async t => {
    const { folder } = await fixture(t);
    const rdm = await init(folder, 'RDM');
    await mkdir(path.join(rdm, 'src'));
    assert.deepEqual((await discoverRepositories(rdm)).repositories, []);
    assert.equal((await discoverRepositories(folder)).repositories.length, 1);
    await init(folder, 'new-project');
    assert.equal((await discoverRepositories(folder)).repositories.length, 2);
});

test('empty app lists repositories securely, opens a choice, and restores that saved choice on the next launch', async t => {
    const { folder, directory } = await fixture(t);
    await init(folder, 'RDM');
    const alpha = await init(folder, 'alpha');
    const preferences = path.join(directory, 'preferences.json');
    const app = await createApp(null, { repositoryFolder: folder, onRepositoryOpened: repository => writeFile(preferences, JSON.stringify({ repository })) });
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => app.server.close(resolve)));
    const origin = `http://127.0.0.1:${app.server.address().port}`;
    const headers = { 'X-Branchlight-Token': app.token, 'Content-Type': 'application/json' };
    assert.equal((await fetch(origin + '/api/repositories')).status, 401);
    assert.equal((await fetch(origin + '/api/repositories', { headers: { ...headers, Origin: 'https://example.invalid' } })).status, 403);
    const list = await (await fetch(origin + '/api/repositories', { headers })).json();
    assert.equal(list.repositories.length, 2);
    const before = await (await fetch(origin + '/api/status', { headers })).json();
    assert.equal(before.root, '');
    assert.equal(before.repositoryFolder, folder);
    assert.deepEqual((await (await fetch(origin + '/api/history', { headers })).json()).commits, []);
    assert.deepEqual(await (await fetch(origin + '/api/tree', { headers })).json(), []);
    assert.equal((await fetch(origin + '/api/diff?path=anything', { headers })).status, 400);
    assert.equal((await fetch(origin + '/api/changes/discard', { method: 'POST', headers, body: JSON.stringify({ root: null }) })).status, 400);
    const opened = await fetch(origin + '/api/open', { method: 'POST', headers, body: JSON.stringify({ path: alpha }) });
    assert.equal(opened.status, 200);
    assert.equal((await opened.json()).root, alpha);
    const saved = JSON.parse(await readFile(preferences, 'utf8'));
    assert.equal(await chooseStartupRepository({ folder, saved: saved.repository }), alpha);
    const next = await createApp(await chooseStartupRepository({ folder, saved: saved.repository }), { repositoryFolder: folder });
    await new Promise(resolve => next.server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => next.server.close(resolve)));
    const nextStatus = await (await fetch(`http://127.0.0.1:${next.server.address().port}/api/status`, { headers: { 'X-Branchlight-Token': next.token } })).json();
    assert.equal(nextStatus.root, alpha);
});
