import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rename, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { git, repository, status, history, commitDetails, diff, tree, fileContent, validPath, parseStatus, parseWorktrees, worktrees } from '../git.mjs';
import { createApp } from '../server.mjs';
import { layoutGraph } from '../graph.mjs';
import { buildRefTree } from '../refs.mjs';

async function fixture(t) {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'branchlight-test-'));
    const root = path.join(directory, 'repository');
    await mkdir(root);
    t.after(async () => {
        const resolved = path.resolve(directory);
        assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
        assert.ok(path.basename(resolved).startsWith('branchlight-test-'));
        await rm(resolved, { recursive: true, force: true });
    });
    await git(root, ['init', '-b', 'main']);
    await git(root, ['config', 'user.name', 'Branchlight Test']);
    await git(root, ['config', 'user.email', 'branchlight@example.invalid']);
    await git(root, ['config', 'commit.gpgsign', 'false']);
    await git(root, ['config', 'core.hooksPath', path.join(directory, 'no-hooks')]);
    await git(root, ['config', 'core.autocrlf', 'false']);
    return { directory, root };
}

async function commit(root, message) {
    await git(root, ['add', '--all']);
    await git(root, ['commit', '-m', message]);
    return (await git(root, ['rev-parse', 'HEAD'])).trim();
}

test('empty repository and first commit are browsable', async t => {
    const { root } = await fixture(t);
    assert.equal(await repository(root), await repository(path.join(root, '.')));
    assert.equal((await status(root)).branch, 'main');
    assert.deepEqual((await history(root)).commits, []);
    assert.deepEqual(await tree(root), []);
    await writeFile(path.join(root, 'hello.txt'), 'first line\n');
    const hash = await commit(root, 'Initial <commit> & details');
    const data = await history(root);
    assert.equal(data.commits[0].hash, hash);
    assert.deepEqual(data.commits[0].parents, []);
    assert.equal(data.commits[0].subject, 'Initial <commit> & details');
    assert.equal((await commitDetails(root, hash)).files[0].status, 'A');
    assert.match((await diff(root, 'hello.txt', { ref: hash })).text, /\+first line/);
    assert.equal((await fileContent(root, 'hello.txt', hash)).text, 'first line\n');
});

test('staged and unstaged changes, renames, literal paths, binary and ignored files', async t => {
    const { root } = await fixture(t);
    await mkdir(path.join(root, 'nested'));
    await writeFile(path.join(root, 'nested', 'name [x] ü.txt'), 'original\n');
    await writeFile(path.join(root, 'rename me.txt'), 'rename content\n');
    await writeFile(path.join(root, 'remove.txt'), 'remove content\n');
    await writeFile(path.join(root, '.gitignore'), '*.ignored\n');
    await commit(root, 'Base');
    await writeFile(path.join(root, 'nested', 'name [x] ü.txt'), 'staged\n');
    await git(root, ['add', '--', 'nested/name [x] ü.txt']);
    await writeFile(path.join(root, 'nested', 'name [x] ü.txt'), 'unstaged\n');
    await rename(path.join(root, 'rename me.txt'), path.join(root, 'renamed ü.txt'));
    await git(root, ['add', '--', 'rename me.txt', 'renamed ü.txt']);
    await rm(path.join(root, 'remove.txt'));
    await writeFile(path.join(root, 'new file.txt'), 'new content\n');
    await writeFile(path.join(root, 'binary.dat'), Buffer.from([1, 0, 2]));
    await writeFile(path.join(root, 'skip.ignored'), 'hidden');
    const data = await status(root);
    const mixed = data.files.find(file => file.path === 'nested/name [x] ü.txt');
    assert.equal(mixed.index + mixed.worktree, 'MM');
    const renamed = data.files.find(file => file.path === 'renamed ü.txt');
    assert.equal(renamed.previousPath, 'rename me.txt');
    assert.equal(renamed.index, 'R');
    assert.match((await diff(root, mixed.path, { stage: 'index' })).text, /\+staged/);
    assert.match((await diff(root, mixed.path)).text, /\+unstaged/);
    assert.match((await diff(root, 'remove.txt')).text, /-remove content/);
    assert.match((await diff(root, renamed.path, { stage: 'index', previousPath: renamed.previousPath })).text, /rename from/);
    assert.equal((await diff(root, 'new file.txt', { stage: 'untracked' })).text, 'new content\n');
    assert.equal((await fileContent(root, 'binary.dat')).binary, true);
    const rootEntries = await tree(root);
    assert.equal(rootEntries.find(file => file.name === 'nested').directory, true);
    assert.equal(rootEntries.some(file => file.name === 'skip.ignored'), false);
    assert.equal((await tree(root, 'nested'))[0].name, 'name [x] ü.txt');
    await writeFile(path.join(root, 'big.txt'), Buffer.alloc(2 * 1024 * 1024 + 1, 65));
    assert.equal((await fileContent(root, 'big.txt')).tooLarge, true);
});

test('branch graph and merge details preserve parent relationships', async t => {
    const { root } = await fixture(t);
    await writeFile(path.join(root, 'base.txt'), 'base\n');
    const base = await commit(root, 'Base');
    await git(root, ['checkout', '-b', 'feature']);
    await writeFile(path.join(root, 'feature.txt'), 'feature\n');
    const feature = await commit(root, 'Feature');
    await git(root, ['checkout', 'main']);
    await writeFile(path.join(root, 'main.txt'), 'main\n');
    const main = await commit(root, 'Main');
    await git(root, ['merge', '--no-ff', 'feature', '-m', 'Merge feature']);
    const data = await history(root);
    assert.deepEqual(data.commits[0].parents, [main, feature]);
    const details = await commitDetails(root, data.commits[0].hash);
    assert.deepEqual(details.files.map(file => file.path), ['feature.txt']);
    assert.match((await diff(root, 'feature.txt', { ref: data.commits[0].hash })).text, /\+feature/);
    const graph = layoutGraph(data.commits);
    assert.equal(graph.rows[0].edges.filter(edge => edge.fromNode).length, 2);
    assert.ok(graph.width >= 2);
    assert.equal(graph.rows.at(-1).outgoing.length, 0);
    const featureHistory = await history(root, { ref: 'refs/heads/feature' });
    assert.deepEqual(featureHistory.commits.map(item => item.hash), [feature, base]);
    assert.equal((await tree(root, '', feature)).some(item => item.name === 'main.txt'), false);
});

test('solo history excludes sibling-only commits and show all restores them without checking out', async t => {
    const { root } = await fixture(t);
    await writeFile(path.join(root, 'base.txt'), 'base\n');
    const base = await commit(root, 'Shared ancestor');
    await git(root, ['checkout', '-b', 'feature/solo']);
    await writeFile(path.join(root, 'solo.txt'), 'solo\n');
    const solo = await commit(root, 'Solo branch commit');
    await git(root, ['update-ref', 'refs/remotes/origin/feature/solo', solo]);
    await git(root, ['checkout', 'main']);
    await writeFile(path.join(root, 'main.txt'), 'main\n');
    const main = await commit(root, 'Only on main');
    const app = await createApp(root);
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => app.server.close(resolve)));
    const url = `http://127.0.0.1:${app.server.address().port}`;
    const headers = { 'X-Branchlight-Token': app.token };
    for (const ref of ['refs/heads/feature/solo', 'refs/remotes/origin/feature/solo']) {
        const response = await fetch(`${url}/api/history?${new URLSearchParams({ ref })}`, { headers });
        assert.equal(response.status, 200);
        assert.deepEqual((await response.json()).commits.map(item => item.hash), [solo, base]);
    }
    const response = await fetch(`${url}/api/history`, { headers });
    const restored = (await response.json()).commits.map(item => item.hash);
    assert.deepEqual(new Set(restored), new Set([base, solo, main]));
    assert.equal((await status(root)).branch, 'main');
});

test('detached HEAD and unmerged files are represented', async t => {
    const { root } = await fixture(t);
    await writeFile(path.join(root, 'conflict.txt'), 'base\n');
    const base = await commit(root, 'Base');
    await git(root, ['checkout', '-b', 'other']);
    await writeFile(path.join(root, 'conflict.txt'), 'other\n');
    await commit(root, 'Other');
    await git(root, ['checkout', 'main']);
    await writeFile(path.join(root, 'conflict.txt'), 'main\n');
    await commit(root, 'Main');
    await assert.rejects(git(root, ['merge', 'other']));
    assert.equal((await status(root)).files.find(file => file.path === 'conflict.txt').conflict, true);
    await git(root, ['merge', '--abort']);
    await git(root, ['checkout', '--detach', base]);
    assert.equal((await status(root)).branch, 'Detached HEAD');
    assert.ok((await history(root)).commits.some(item => item.hash === base));
});

test('status parser preserves tabs and newlines inside paths', () => {
    const files = parseStatus(' M tab\tname\nfile\0R  new name\0old name\0?? -file\0');
    assert.equal(files[0].path, 'tab\tname\nfile');
    assert.equal(files[1].previousPath, 'old name');
    assert.equal(files[2].untracked, true);
});

test('worktrees identify linked, locked, detached, and active checkouts and open their own changes', async t => {
    const { root, directory } = await fixture(t);
    await writeFile(path.join(root, 'base.txt'), 'base\n');
    await commit(root, 'Base');
    const linked = path.join(directory, 'linked folder ü');
    const detached = path.join(directory, 'detached');
    await git(root, ['worktree', 'add', '-b', 'feature/nested', linked]);
    await git(root, ['worktree', 'add', '--detach', detached]);
    await git(root, ['worktree', 'lock', '--reason', 'Keep this checkout', linked]);
    await writeFile(path.join(linked, 'only-in-worktree.txt'), 'local change\n');
    const entries = await worktrees(root);
    assert.equal(entries.length, 3);
    assert.equal(entries[0].main, true);
    assert.equal(entries[0].current, true);
    const linkedEntry = entries.find(item => item.name === 'linked folder ü');
    assert.equal(linkedEntry.branch, 'refs/heads/feature/nested');
    assert.equal(linkedEntry.lockedReason, 'Keep this checkout');
    assert.equal(linkedEntry.available, true);
    assert.equal(entries.find(item => item.name === 'detached').detached, true);
    const app = await createApp(root);
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => app.server.close(resolve)));
    const url = `http://127.0.0.1:${app.server.address().port}`;
    const headers = { 'X-Branchlight-Token': app.token };
    const response = await fetch(`${url}/api/open`, { method: 'POST', headers, body: JSON.stringify({ path: linked }) });
    assert.equal(response.status, 200);
    const opened = await response.json();
    assert.equal(opened.branch, 'feature/nested');
    assert.deepEqual(opened.files.map(file => file.path), ['only-in-worktree.txt']);
    assert.equal(opened.worktrees.find(item => item.current).name, 'linked folder ü');
    const viewed = await fetch(`${url}/api/diff?stage=untracked&path=only-in-worktree.txt`, { headers });
    assert.equal((await viewed.json()).text, 'local change\n');
    const restored = await fetch(`${url}/api/open`, { method: 'POST', headers, body: JSON.stringify({ path: root }) });
    assert.equal((await restored.json()).files.length, 0);
});

test('worktree records preserve unusual paths and flags with empty reasons', () => {
    const entries = parseWorktrees('worktree /main\0bare\0\0worktree /linked name\nü\0HEAD abc\0detached\0locked\0prunable missing\0\0');
    assert.equal(entries[0].bare, true);
    assert.equal(entries[1].path, '/linked name\nü');
    assert.equal(entries[1].locked, true);
    assert.equal(entries[1].detached, true);
    assert.equal(entries[1].prunableReason, 'missing');
});

test('branch folders preserve full ref identities and all entries in large groups', () => {
    const refs = [
        { name: 'refs/heads/main' },
        { name: 'refs/heads/hub/feature/one', current: true },
        { name: 'refs/heads/hub/feature/two' },
        { name: 'refs/heads/__proto__/safe' },
        ...Array.from({ length: 180 }, (_, i) => ({ name: `refs/remotes/origin/topic/branch-${i}` })),
    ];
    const local = buildRefTree(refs, 'refs/heads/');
    assert.equal(local.count, 4);
    assert.equal(local.refs[0].displayName, 'main');
    const feature = local.folders.get('hub').folders.get('feature');
    assert.equal(feature.key, 'refs/heads/hub/feature/');
    assert.equal(feature.count, 2);
    assert.equal(feature.refs.find(ref => ref.current).name, 'refs/heads/hub/feature/one');
    assert.equal(local.folders.get('__proto__').refs[0].displayName, 'safe');
    const remote = buildRefTree(refs, 'refs/remotes/');
    assert.equal(remote.folders.get('origin').folders.get('topic').refs.length, 180);
});

test('previews reject traversal, Git internals, and directory junction escapes', async t => {
    const { root, directory } = await fixture(t);
    for (const file of ['../secret', '/etc/passwd', 'C:/secret', '.git/config', 'folder/../secret', 'folder/.GIT/config', 'a\\b', 'a\0b']) {
        assert.throws(() => validPath(file));
    }
    const outside = path.join(directory, 'outside');
    await mkdir(outside);
    await writeFile(path.join(outside, 'secret.txt'), 'outside');
    try {
        await symlink(outside, path.join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
        if (['EPERM', 'EACCES'].includes(error.code)) {
            t.diagnostic('Host cannot create symlinks; junction case skipped.');
            return;
        }
        throw error;
    }
    await assert.rejects(fileContent(root, 'link/secret.txt'), /outside the repository/);
});

test('HTTP requires a token, rejects foreign origins and writes, serves CSP, and opens repositories', async t => {
    const { root } = await fixture(t);
    const app = await createApp(root);
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => app.server.close(resolve)));
    const url = `http://127.0.0.1:${app.server.address().port}`;
    const headers = { 'X-Branchlight-Token': app.token };
    const page = await fetch(url);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('Content-Security-Policy'), /frame-ancestors 'none'/);
    assert.equal((await fetch(`${url}/api/status`)).status, 401);
    assert.equal((await fetch(`${url}/api/status`, { headers })).status, 200);
    assert.equal((await fetch(`${url}/api/status`, { headers: { ...headers, Origin: 'https://example.invalid' } })).status, 403);
    const foreignHostStatus = await new Promise((resolve, reject) => {
        const request = http.get(`${url}/api/status`, { headers: { ...headers, Host: 'evil.invalid' } }, response => {
            response.resume();
            resolve(response.statusCode);
        });
        request.on('error', reject);
    });
    assert.equal(foreignHostStatus, 403);
    assert.equal((await fetch(`${url}/api/status`, { method: 'POST', headers })).status, 405);
    assert.equal((await fetch(`${url}/api/file?path=..%2Fsecret`, { headers })).status, 400);
    assert.equal((await fetch(`${url}/api/open`, { method: 'POST', headers, body: JSON.stringify({ path: root }) })).status, 200);
});

test('standalone launch keeps its token private, blocks framing, and displays the package version', async t => {
    const { root } = await fixture(t);
    const app = await createApp(root);
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => app.server.close(resolve)));
    const url = 'http://127.0.0.1:' + app.server.address().port;
    const page = await fetch(url);
    const html = await page.text();
    const { readFile } = await import('node:fs/promises');
    const metadata = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    assert.match(page.headers.get('Content-Security-Policy'), /frame-src 'none'/);
    assert.ok(!html.includes(app.token));
    assert.ok(html.includes('v' + metadata.version));
    assert.ok(!html.includes('{{APP_VERSION}}'));
    assert.doesNotMatch(html, /DevDeck|Dispatch|PAM Factory|Dev Launchers|<iframe/);
    assert.equal((await fetch(url + '/api/apps', { headers: { 'X-Branchlight-Token': app.token } })).status, 404);
});
