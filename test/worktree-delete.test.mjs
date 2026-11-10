import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, access, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { git, repository, worktrees, resolveCommit } from '../git.mjs';
import { inspectWorktreeDeletion, deleteWorktree } from '../worktree-actions.mjs';
import { createApp } from '../server.mjs';

async function fixture(t) {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'branchlight-delete-test-'));
    const root = path.join(directory, 'repository');
    const linked = path.join(directory, 'linked folder ü');
    await mkdir(root);
    t.after(async () => {
        assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
        assert.ok(path.basename(directory).startsWith('branchlight-delete-test-'));
        await rm(directory, { recursive: true, force: true });
    });
    await git(root, ['init', '-b', 'main']);
    await git(root, ['config', 'user.name', 'Branchlight Test']);
    await git(root, ['config', 'user.email', 'test@example.invalid']);
    await git(root, ['config', 'commit.gpgsign', 'false']);
    await git(root, ['config', 'core.hooksPath', path.join(directory, 'no-hooks')]);
    await writeFile(path.join(root, '.gitignore'), 'ignored/\n');
    await writeFile(path.join(root, 'file.txt'), 'initial\n');
    await git(root, ['add', '.']);
    await git(root, ['commit', '-m', 'Initial']);
    await git(root, ['worktree', 'add', '-b', 'feature/delete-me', linked]);
    return { directory, root: await repository(root), linked: await repository(linked) };
}

async function newCommit(root) {
    await writeFile(path.join(root, 'file.txt'), 'new content\n');
    await git(root, ['add', '.']);
    await git(root, ['commit', '-m', 'Unmerged work']);
}

async function present(root, linked) {
    await access(linked);
    assert.ok((await worktrees(root)).some(entry => path.resolve(entry.path) === linked));
    await resolveCommit(root, 'refs/heads/feature/delete-me');
}

test('deletes a clean linked worktree and its local branch, preserving remote refs and main files', async t => {
    const { root, linked } = await fixture(t);
    await git(root, ['update-ref', 'refs/remotes/origin/feature/delete-me', 'HEAD']);
    const plan = await inspectWorktreeDeletion(root, linked);
    assert.equal(plan.unmerged, 0);
    const result = await deleteWorktree(plan);
    assert.equal(result.branchDeleted, true);
    assert.equal(result.root, root);
    assert.equal(result.warning, '');
    await assert.rejects(access(linked));
    await assert.rejects(resolveCommit(root, plan.branch));
    await resolveCommit(root, 'refs/remotes/origin/feature/delete-me');
    assert.equal((await worktrees(root)).length, 1);
    assert.equal(await readFile(path.join(root, 'file.txt'), 'utf8'), 'initial\n');
});

test('refuses main, locked, unrelated and dirty targets without changing either worktree or branch', async t => {
    const { root, linked, directory } = await fixture(t);
    await assert.rejects(inspectWorktreeDeletion(root, root), /main checkout/);
    await assert.rejects(inspectWorktreeDeletion(root, directory), /not a registered/);
    await assert.rejects(inspectWorktreeDeletion(root, 'linked'), /listed/);
    await git(root, ['worktree', 'lock', linked]);
    await assert.rejects(inspectWorktreeDeletion(root, linked), /locked/);
    await git(root, ['worktree', 'unlock', linked]);
    await writeFile(path.join(linked, 'untracked.txt'), 'keep this\n');
    await assert.rejects(inspectWorktreeDeletion(root, linked), /uncommitted changes or untracked/);
    await git(linked, ['add', 'untracked.txt']);
    await assert.rejects(inspectWorktreeDeletion(root, linked), /uncommitted changes or untracked/);
    await present(root, linked);
});

test('refuses changed files, moved heads, and active Git operations after preview', async t => {
    const { root, linked } = await fixture(t);
    const plan = await inspectWorktreeDeletion(root, linked);
    await writeFile(path.join(linked, 'file.txt'), 'do not delete\n');
    await assert.rejects(deleteWorktree(plan, { allowUnmerged: true, removeIgnored: true }), /uncommitted/);
    await git(linked, ['add', '.']);
    await git(linked, ['commit', '-m', 'Changed after preview']);
    await assert.rejects(deleteWorktree(plan, { allowUnmerged: true }), /changed/);
    const gitDir = (await git(linked, ['rev-parse', '--absolute-git-dir'])).trim();
    await writeFile(path.join(gitDir, 'MERGE_HEAD'), plan.head + '\n');
    await assert.rejects(inspectWorktreeDeletion(root, linked), /Finish or abort/);
    await present(root, linked);
});

test('unmerged commits require explicit consent and return to main when deleting the displayed worktree', async t => {
    const { root, linked } = await fixture(t);
    await newCommit(linked);
    const plan = await inspectWorktreeDeletion(linked, linked);
    assert.equal(plan.unmerged, 1);
    assert.equal(plan.current, true);
    await assert.rejects(deleteWorktree(plan), /unmerged commits/);
    await present(root, linked);
    const result = await deleteWorktree(plan, { allowUnmerged: true });
    assert.equal(result.root, root);
    assert.equal(result.branchDeleted, true);
});

test('checks merging against the configured upstream, without changing the upstream', async t => {
    const { root, linked } = await fixture(t);
    await newCommit(linked);
    await git(root, ['branch', 'upstream', 'feature/delete-me']);
    await git(root, ['branch', '--set-upstream-to=upstream', 'feature/delete-me']);
    const plan = await inspectWorktreeDeletion(root, linked);
    assert.equal(plan.unmerged, 0);
    assert.equal(plan.comparison, 'refs/heads/upstream');
    assert.equal((await deleteWorktree(plan)).branchDeleted, true);
    assert.equal(await resolveCommit(root, 'upstream'), plan.head);
});

test('ignored files require consent, and new ignored entries invalidate the preview', async t => {
    const { root, linked } = await fixture(t);
    const before = await inspectWorktreeDeletion(root, linked);
    await mkdir(path.join(linked, 'ignored'));
    await writeFile(path.join(linked, 'ignored', 'local-config.txt'), 'test data\n');
    await assert.rejects(deleteWorktree(before, { removeIgnored: true }), /New ignored files/);
    const plan = await inspectWorktreeDeletion(root, linked);
    assert.ok(plan.ignored.length > 0);
    await assert.rejects(deleteWorktree(plan), /ignored files/);
    await present(root, linked);
    assert.equal((await deleteWorktree(plan, { removeIgnored: true })).branchDeleted, true);
});

test('detached worktrees delete only the checkout and preserve the former branch', async t => {
    const { root, linked } = await fixture(t);
    await git(linked, ['checkout', '--detach']);
    const plan = await inspectWorktreeDeletion(root, linked);
    assert.equal(plan.branch, '');
    assert.equal((await deleteWorktree(plan)).branchDeleted, false);
    await resolveCommit(root, 'feature/delete-me');
});

test('rejects targets containing another registered worktree', async t => {
    const { root, linked } = await fixture(t);
    await mkdir(path.join(linked, 'ignored'));
    await git(root, ['worktree', 'add', '-b', 'nested', path.join(linked, 'ignored', 'nested')]);
    await assert.rejects(inspectWorktreeDeletion(root, linked), /contains another checkout/);
    await present(root, linked);
});

test('HTTP deletion requires authentication, same origin, preview, and a matching repository; updates active root', async t => {
    const { root, linked } = await fixture(t);
    let savedRoot;
    const app = await createApp(linked, { onRepositoryOpened: value => { savedRoot = value; } });
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => app.server.close(resolve)));
    const url = 'http://127.0.0.1:' + app.server.address().port;
    const headers = { 'X-Branchlight-Token': app.token, 'Content-Type': 'application/json' };
    const post = (route, body, extra = {}) => fetch(url + '/api/' + route, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body) });
    assert.equal((await post('worktrees/delete', {}, { 'X-Branchlight-Token': '' })).status, 401);
    assert.equal((await post('worktrees/delete-preview', {}, { Origin: 'https://example.invalid' })).status, 403);
    assert.equal((await post('worktrees/delete', { root: linked })).status, 400);
    assert.equal((await post('worktrees/delete-preview', { root, path: linked })).status, 400);
    const previewResponse = await post('worktrees/delete-preview', { root: linked, path: linked });
    assert.equal(previewResponse.status, 200);
    const plan = await previewResponse.json();
    await present(root, linked);
    const result = await post('worktrees/delete', { root: linked, confirmation: plan.confirmation });
    assert.equal(result.status, 200);
    assert.equal((await result.json()).branchDeleted, true);
    assert.equal(savedRoot, root);
    const status = await (await fetch(url + '/api/status', { headers })).json();
    assert.equal(status.root, root);
    assert.equal(status.worktrees.length, 1);
    assert.equal((await post('worktrees/delete', { root, confirmation: plan.confirmation })).status, 400);
});

test('switching repositories invalidates an earlier deletion confirmation', async t => {
    const { root, linked } = await fixture(t);
    const app = await createApp(root);
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => app.server.close(resolve)));
    const url = 'http://127.0.0.1:' + app.server.address().port;
    const headers = { 'X-Branchlight-Token': app.token, 'Content-Type': 'application/json' };
    const post = (route, body) => fetch(url + '/api/' + route, { method: 'POST', headers, body: JSON.stringify(body) });
    const plan = await (await post('worktrees/delete-preview', { root, path: linked })).json();
    await post('open', { path: linked });
    await post('open', { path: root });
    assert.equal((await post('worktrees/delete', { root, confirmation: plan.confirmation })).status, 400);
    await present(root, linked);
});

test('reports partial success and keeps the branch if Git rejects branch deletion', async t => {
    const { root, linked, directory } = await fixture(t);
    const plan = await inspectWorktreeDeletion(root, linked);
    const hooks = path.join(directory, 'no-hooks');
    await mkdir(hooks);
    await writeFile(path.join(hooks, 'reference-transaction'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const result = await deleteWorktree(plan);
    assert.equal(result.branchDeleted, false);
    assert.match(result.warning, /worktree was deleted, but its local branch was kept/);
    await assert.rejects(access(linked));
    await resolveCommit(root, 'feature/delete-me');
    assert.equal((await worktrees(root)).length, 1);
});

async function removeFixtureFolder(directory, folder) {
    const relative = path.relative(await realpath(directory), await realpath(folder));
    assert.ok(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
    assert.ok(path.basename(directory).startsWith('branchlight-delete-test-'));
    await rm(folder, { recursive: true, force: false });
}

test('removes only the selected missing worktree and branch, leaving other stale entries intact', async t => {
    const { directory, root, linked } = await fixture(t);
    const other = path.join(await realpath(directory), 'other missing checkout');
    await git(root, ['worktree', 'add', '-b', 'feature/other-missing', other]);
    await removeFixtureFolder(directory, linked);
    await removeFixtureFolder(directory, other);
    const plan = await inspectWorktreeDeletion(root, linked);
    assert.equal(plan.missing, true);
    assert.equal(plan.unmerged, 0);
    assert.deepEqual(plan.ignored, []);
    assert.equal((await deleteWorktree(plan)).branchDeleted, true);
    const remaining = await worktrees(root);
    assert.equal(remaining.length, 2);
    assert.ok(remaining.some(entry => path.resolve(entry.path) === path.resolve(other)));
    await resolveCommit(root, 'feature/other-missing');
    await assert.rejects(resolveCommit(root, 'feature/delete-me'));
});

test('missing worktrees still protect unmerged branch commits and locked registrations', async t => {
    const { directory, root, linked } = await fixture(t);
    await newCommit(linked);
    await git(root, ['worktree', 'lock', linked]);
    await removeFixtureFolder(directory, linked);
    await assert.rejects(inspectWorktreeDeletion(root, linked), /locked/);
    await git(root, ['worktree', 'unlock', linked]);
    const plan = await inspectWorktreeDeletion(root, linked);
    assert.equal(plan.missing, true);
    assert.equal(plan.unmerged, 1);
    await assert.rejects(deleteWorktree(plan), /unmerged commits/);
    await resolveCommit(root, plan.branch);
    assert.equal((await worktrees(root)).length, 2);
    assert.equal((await deleteWorktree(plan, { allowUnmerged: true })).branchDeleted, true);
});

test('requires a new confirmation if a missing worktree returns or a present worktree disappears', async t => {
    const { directory, root, linked } = await fixture(t);
    const presentPlan = await inspectWorktreeDeletion(root, linked);
    await removeFixtureFolder(directory, linked);
    await assert.rejects(deleteWorktree(presentPlan), /changed/);
    const missingPlan = await inspectWorktreeDeletion(root, linked);
    await git(root, ['worktree', 'add', '--force', linked, 'feature/delete-me']);
    await assert.rejects(deleteWorktree(missingPlan), /changed/);
    await present(root, linked);
});

test('does not delete an existing folder with a missing Git marker', async t => {
    const { directory, root, linked } = await fixture(t);
    const originalContent = await readFile(path.join(linked, 'file.txt'), 'utf8');
    const marker = path.join(linked, '.git');
    assert.ok(path.relative(await realpath(directory), await realpath(marker)).startsWith('linked folder'));
    await rm(marker);
    await assert.rejects(inspectWorktreeDeletion(root, linked), /still exists/);
    assert.equal(await readFile(path.join(linked, 'file.txt'), 'utf8'), originalContent);
    await resolveCommit(root, 'feature/delete-me');
});

test('cleans up a missing detached checkout without deleting any branch', async t => {
    const { directory, root, linked } = await fixture(t);
    await git(linked, ['checkout', '--detach']);
    await removeFixtureFolder(directory, linked);
    const plan = await inspectWorktreeDeletion(root, linked);
    assert.equal(plan.missing, true);
    assert.equal(plan.branch, '');
    assert.equal((await deleteWorktree(plan)).branchDeleted, false);
    await resolveCommit(root, 'feature/delete-me');
});
