import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, unlink, rm, rmdir, symlink, realpath, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { git, repository } from '../git.mjs';
import { inspectDiscard, discardChanges } from '../change-actions.mjs';
import { createApp } from '../server.mjs';

async function fixture(t, unborn = false) {
    const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'branchlight-discard-test-')));
    const root = path.join(directory, 'repository');
    await mkdir(root);
    t.after(async () => {
        assert.equal(path.dirname(directory), await realpath(os.tmpdir()));
        assert.ok(path.basename(directory).startsWith('branchlight-discard-test-'));
        await rm(directory, { recursive: true, force: true });
    });
    await git(root, ['init', '-b', 'main']);
    await git(root, ['config', 'user.name', 'Branchlight Test']);
    await git(root, ['config', 'user.email', 'test@example.invalid']);
    await git(root, ['config', 'commit.gpgsign', 'false']);
    await git(root, ['config', 'core.autocrlf', 'false']);
    await git(root, ['config', 'core.hooksPath', path.join(directory, 'no-hooks')]);
    if (!unborn) {
        await writeFile(path.join(root, 'file.txt'), 'committed\n');
        await writeFile(path.join(root, 'other.txt'), 'other committed\n');
        await writeFile(path.join(root, '.gitignore'), 'ignored/\n');
        await git(root, ['add', '.']);
        await git(root, ['commit', '-m', 'Initial']);
    }
    return { root: await repository(root), directory };
}
const write = (root, file, content) => writeFile(path.join(root, file), content);
const read = (root, file = 'file.txt') => readFile(path.join(root, file), 'utf8');
const inspect = (root, scope, file) => inspectDiscard(root, { scope, ...(file === undefined ? {} : { path: file }) });
const discard = async (root, scope, file) => discardChanges(await inspect(root, scope, file));
const status = root => git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);

test('unstaged file discard keeps staged content, other changes, and branch history', async t => {
    const { root } = await fixture(t);
    const head = await git(root, ['rev-parse', 'HEAD']);
    await write(root, 'file.txt', 'staged\n');
    await git(root, ['add', 'file.txt']);
    await write(root, 'file.txt', 'unstaged\n');
    await write(root, 'other.txt', 'keep other edits\n');
    await discard(root, 'unstaged', 'file.txt');
    assert.equal(await read(root), 'staged\n');
    assert.equal(await git(root, ['show', ':file.txt']), 'staged\n');
    assert.equal(await read(root, 'other.txt'), 'keep other edits\n');
    assert.equal(await git(root, ['rev-parse', 'HEAD']), head);
});

test('staged file discard restores HEAD and explicitly previews additional unstaged edits', async t => {
    const { root } = await fixture(t);
    await write(root, 'file.txt', 'staged\n');
    await git(root, ['add', 'file.txt']);
    await write(root, 'file.txt', 'unstaged too\n');
    const plan = await inspect(root, 'staged', 'file.txt');
    assert.equal(plan.includesUnstaged, true);
    await discardChanges(plan);
    assert.equal(await read(root), 'committed\n');
    assert.equal(await status(root), '');
});

test('whole checkout discard handles modified, deleted, new, staged and untracked files and preserves ignored files', async t => {
    const { root } = await fixture(t);
    await mkdir(path.join(root, 'ignored'));
    await write(root, 'ignored/config.txt', 'keep local configuration');
    await write(root, 'file.txt', 'staged\n');
    await write(root, 'new staged.txt', 'new staged');
    await git(root, ['add', '.']);
    await unlink(path.join(root, 'other.txt'));
    await write(root, 'new untracked.txt', 'new untracked');
    const plan = await inspect(root, 'all');
    assert.deepEqual(plan.deletedFiles, ['new staged.txt', 'new untracked.txt']);
    await discardChanges(plan);
    assert.equal(await status(root), '');
    assert.equal(await read(root), 'committed\n');
    assert.equal(await read(root, 'other.txt'), 'other committed\n');
    assert.equal(await read(root, 'ignored/config.txt'), 'keep local configuration');
    await assert.rejects(access(path.join(root, 'new staged.txt')));
    await assert.rejects(access(path.join(root, 'new untracked.txt')));
});

test('unstaged group preserves staged additions and renames while reverting their later edits', async t => {
    const { root } = await fixture(t);
    await git(root, ['mv', 'file.txt', 'renamed.txt']);
    await write(root, 'added.txt', 'staged addition');
    await git(root, ['add', '.']);
    await write(root, 'renamed.txt', 'later rename edit');
    await write(root, 'added.txt', 'later addition edit');
    await discard(root, 'unstaged');
    assert.equal(await read(root, 'renamed.txt'), 'committed\n');
    assert.equal(await read(root, 'added.txt'), 'staged addition');
    assert.match(await status(root), /R  renamed.txt/);
    assert.match(await status(root), /A  added.txt/);
});

test('staged rename discard restores the old name, removes the new name, and preserves unrelated files', async t => {
    const { root } = await fixture(t);
    await git(root, ['mv', 'file.txt', 'renamed.txt']);
    await write(root, 'unrelated.txt', 'keep me');
    const plan = await inspect(root, 'staged', 'renamed.txt');
    assert.deepEqual(plan.snapshots.map(file => file.path), ['file.txt', 'renamed.txt']);
    await discardChanges(plan);
    assert.equal(await read(root), 'committed\n');
    await assert.rejects(access(path.join(root, 'renamed.txt')));
    assert.equal(await read(root, 'unrelated.txt'), 'keep me');
});

test('discarding staged deletion also restores an untracked replacement at the same path', async t => {
    const { root } = await fixture(t);
    await git(root, ['rm', 'file.txt']);
    await write(root, 'file.txt', 'untracked replacement');
    await discard(root, 'staged', 'file.txt');
    assert.equal(await read(root), 'committed\n');
    assert.equal(await status(root), '');
});

test('new files before the first commit support both unstaged and staged discard', async t => {
    const { root } = await fixture(t, true);
    await write(root, 'new.txt', 'staged');
    await git(root, ['add', '.']);
    await write(root, 'new.txt', 'extra edits');
    await discard(root, 'unstaged', 'new.txt');
    assert.equal(await read(root, 'new.txt'), 'staged');
    await discard(root, 'staged', 'new.txt');
    assert.equal(await status(root), '');
    await assert.rejects(access(path.join(root, 'new.txt')));
});

test('linked checkout discard leaves the main checkout and local branch intact', async t => {
    const { root, directory } = await fixture(t);
    const linked = path.join(directory, 'linked');
    await git(root, ['worktree', 'add', '-b', 'feature/changes', linked]);
    await write(root, 'file.txt', 'main edits');
    await write(linked, 'file.txt', 'feature edits');
    await discard(linked, 'all');
    assert.equal(await read(linked), 'committed\n');
    assert.equal(await read(root), 'main edits');
    assert.equal((await git(linked, ['symbolic-ref', '--short', 'HEAD'])).trim(), 'feature/changes');
});

test('revalidation rejects new edits, index changes, branch switches and new files in a bulk plan', async t => {
    const { root } = await fixture(t);
    await write(root, 'file.txt', 'first edits');
    let plan = await inspect(root, 'all');
    await write(root, 'file.txt', 'newer edits');
    await assert.rejects(discardChanges(plan), /changed/);
    assert.equal(await read(root), 'newer edits');
    plan = await inspect(root, 'all');
    await git(root, ['add', 'file.txt']);
    await assert.rejects(discardChanges(plan), /changed/);
    plan = await inspect(root, 'all');
    await git(root, ['checkout', '-b', 'different-branch']);
    await assert.rejects(discardChanges(plan), /changed/);
    plan = await inspect(root, 'all');
    await write(root, 'newer.txt', 'keep this');
    await assert.rejects(discardChanges(plan), /changed/);
    assert.equal(await read(root, 'newer.txt'), 'keep this');
});

test('literal paths preserve similarly named files and reject arbitrary paths', async t => {
    const { root } = await fixture(t);
    for (const file of ['[draft].txt', 'd.txt', '-option.txt', 'name ü.txt']) await write(root, file, file);
    await discard(root, 'unstaged', '[draft].txt');
    assert.equal(await read(root, 'd.txt'), 'd.txt');
    await discard(root, 'unstaged', '-option.txt');
    await discard(root, 'unstaged', 'name ü.txt');
    for (const file of ['../outside.txt', '.git/config', 'C:/other.txt', 'file.txt:stream', '']) {
        await assert.rejects(inspect(root, 'all', file));
    }
    await assert.rejects(inspect(root, 'all', 'other.txt'), /no longer have changes/);
});

test('active Git operations and nested repositories block discard', async t => {
    const { root } = await fixture(t);
    await write(root, 'file.txt', 'keep edits');
    const marker = path.join(root, '.git', 'MERGE_HEAD');
    await writeFile(marker, (await git(root, ['rev-parse', 'HEAD'])).trim());
    await assert.rejects(inspect(root, 'all'), /active Git operation/);
    await unlink(marker);
    const nested = path.join(root, 'nested');
    await mkdir(nested);
    await git(nested, ['init']);
    await write(nested, 'keep.txt', 'nested content');
    await assert.rejects(inspect(root, 'all'), /Folders and submodules|regular file/);
    assert.equal(await read(root), 'keep edits');
    assert.equal(await read(nested, 'keep.txt'), 'nested content');
});

test('a parent folder replaced by a junction after preview cannot delete outside files', async t => {
    const { root, directory } = await fixture(t);
    const folder = path.join(root, 'folder');
    const outside = path.join(directory, 'outside');
    await mkdir(folder);
    await mkdir(outside);
    await write(folder, 'file.txt', 'untracked');
    await write(outside, 'file.txt', 'outside content');
    const plan = await inspect(root, 'unstaged', 'folder/file.txt');
    await unlink(path.join(folder, 'file.txt'));
    await rmdir(folder);
    await symlink(outside, folder, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(discardChanges(plan), /junctions/);
    assert.equal(await read(outside), 'outside content');
});

test('HTTP requires authentication, same origin, expected branch and a single use confirmation; switching invalidates it', async t => {
    const { root, directory } = await fixture(t);
    await write(root, 'file.txt', 'discard this');
    const app = await createApp(root);
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => app.server.close(resolve)));
    const url = `http://127.0.0.1:${app.server.address().port}`;
    const headers = { 'X-Branchlight-Token': app.token, 'Content-Type': 'application/json' };
    const post = (route, body, extra = {}) => fetch(url + '/api/' + route, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body) });
    const input = { root, head: (await git(root, ['rev-parse', 'HEAD'])).trim(), branch: 'main', scope: 'all' };
    assert.equal((await post('changes/discard', {}, { 'X-Branchlight-Token': '' })).status, 401);
    assert.equal((await post('changes/discard-preview', input, { Origin: 'https://example.invalid' })).status, 403);
    assert.equal((await post('changes/discard', { root })).status, 400);
    assert.equal((await post('changes/discard-preview', { ...input, branch: 'other' })).status, 400);
    assert.equal((await post('changes/discard-preview', { ...input, root: directory })).status, 400);
    let response = await post('changes/discard-preview', input);
    assert.equal(response.status, 200);
    let plan = await response.json();
    assert.deepEqual(plan.files, [{ path: 'file.txt', deleted: false }]);
    assert.equal(await read(root), 'discard this');
    await post('open', { path: root });
    assert.equal((await post('changes/discard', { root, confirmation: plan.confirmation })).status, 400);
    plan = await (await post('changes/discard-preview', input)).json();
    response = await post('changes/discard', { root, confirmation: plan.confirmation, path: 'other.txt' });
    assert.equal(response.status, 200);
    assert.equal(await read(root), 'committed\n');
    assert.equal((await post('changes/discard', { root, confirmation: plan.confirmation })).status, 400);
});

test('tracked wildcard names are restored literally, without affecting a matching sibling', async t => {
    const { root } = await fixture(t);
    await write(root, '[draft].txt', 'committed literal');
    await write(root, 'd.txt', 'committed sibling');
    await git(root, ['add', '.']);
    await git(root, ['commit', '-m', 'Literal names']);
    await write(root, '[draft].txt', 'discard');
    await write(root, 'd.txt', 'keep sibling edits');
    await discard(root, 'unstaged', '[draft].txt');
    assert.equal(await read(root, '[draft].txt'), 'committed literal');
    assert.equal(await read(root, 'd.txt'), 'keep sibling edits');
});

test('submodule entries are protected from staged discard', async t => {
    const { root } = await fixture(t);
    const head = (await git(root, ['rev-parse', 'HEAD'])).trim();
    await git(root, ['update-index', '--add', '--cacheinfo', '160000', head, 'module']);
    await assert.rejects(inspect(root, 'staged', 'module'), /Submodules/);
    assert.match(await status(root), /A[D ] module/);
});
