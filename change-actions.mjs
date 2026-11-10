import { createReadStream } from 'node:fs';
import { lstat, realpath, mkdtemp, writeFile, unlink, rmdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { git, repository, parseStatus, validPath } from './git.mjs';

async function statOrMissing(file) {
    try { return await lstat(file); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function fileSnapshot(root, file) {
    validPath(file);
    const parts = file.split('/');
    if (parts.some(part => !part || part === '.') || file.includes(':')) throw new Error('Choose a regular file inside this checkout.');
    let current = root;
    for (let i = 0; i < parts.length; i++) {
        current = path.join(current, parts[i]);
        const info = await statOrMissing(current);
        if (!info) return { path: file, missing: true };
        if (info.isSymbolicLink()) throw new Error(`Symbolic links and junctions cannot be discarded here: ${file}`);
        if (i < parts.length - 1) {
            if (!info.isDirectory()) throw new Error(`A parent folder changed: ${file}`);
            if (await statOrMissing(path.join(current, '.git'))) throw new Error(`Files inside a nested repository cannot be discarded here: ${file}`);
        } else {
            if (!info.isFile()) throw new Error(`Folders and submodules cannot be discarded here: ${file}`);
            const hash = createHash('sha256');
            for await (const chunk of createReadStream(current)) hash.update(chunk);
            return { path: file, hash: hash.digest('hex'), mode: info.mode, size: info.size };
        }
    }
}

function parseEntries(output, index = false) {
    const entries = new Map();
    for (const entry of output.split('\0').filter(Boolean)) {
        const tab = entry.indexOf('\t');
        const fields = entry.slice(0, tab).split(' ');
        const file = entry.slice(tab + 1);
        if (index && fields[2] !== '0') throw new Error('Resolve the merge conflicts before discarding files.');
        entries.set(file, { mode: fields[0], hash: fields[index ? 1 : 2] });
    }
    return entries;
}

async function checkoutIdentity(root) {
    const [canonicalRoot, gitDirectory, head, branch] = await Promise.all([
        repository(root),
        git(root, ['rev-parse', '--absolute-git-dir']).then(value => realpath(value.trim())),
        git(root, ['rev-parse', '--verify', 'HEAD']).then(value => value.trim()).catch(error => {
            if (error.code === 128) return '';
            throw error;
        }),
        git(root, ['symbolic-ref', '--quiet', 'HEAD']).then(value => value.trim()).catch(error => {
            if (error.code === 1) return '';
            throw error;
        }),
    ]);
    if (!head) {
        const refs = branch ? await git(root, ['for-each-ref', '--format=%(refname)', branch]) : '';
        if (!branch || refs.split('\n').includes(branch)) throw new Error('The current commit cannot be read. Repair the checkout before discarding files.');
    }
    const operations = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG', 'rebase-merge', 'rebase-apply', 'sequencer', 'index.lock'];
    for (const operation of operations) {
        if (await statOrMissing(path.join(gitDirectory, operation))) throw new Error('Finish or abort the active Git operation before discarding files.');
    }
    return { root: canonicalRoot, gitDirectory, head, branch };
}

export async function inspectDiscard(root, input) {
    if (!['unstaged', 'staged', 'all'].includes(input.scope)) throw new Error('Choose unstaged, staged, or all changes.');
    if (input.path !== undefined) validPath(input.path);
    const identity = await checkoutIdentity(root);
    const [statusOutput, indexOutput, headOutput] = await Promise.all([
        git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none']),
        git(root, ['ls-files', '--stage', '-z']),
        identity.head ? git(root, ['ls-tree', '-r', '-z', identity.head]) : '',
    ]);
    const index = parseEntries(indexOutput, true);
    const committed = parseEntries(headOutput);
    const files = parseStatus(statusOutput).filter(file =>
        (input.path === undefined || file.path === input.path) &&
        (input.scope === 'all' || (input.scope === 'unstaged' ? file.untracked || file.worktree !== ' ' : !file.untracked && file.index !== ' ')));
    if (!files.length) throw new Error('These files no longer have changes. Refresh and try again.');
    if (files.some(file => file.conflict)) throw new Error('Resolve the merge conflicts before discarding files.');
    const paths = [...new Set(files.flatMap(file =>
        input.scope !== 'unstaged' && file.index === 'R' ? [file.path, file.previousPath] : [file.path]))].sort();
    const snapshots = [];
    const restore = [];
    const remove = [];
    const removeIndex = [];
    for (const file of paths) {
        if ([index.get(file), committed.get(file)].some(entry => entry && !['100644', '100755'].includes(entry.mode))) {
            throw new Error(`Submodules and symbolic links cannot be discarded here: ${file}`);
        }
        const snapshot = await fileSnapshot(identity.root, file);
        snapshots.push({ ...snapshot, index: index.get(file) || null, committed: committed.get(file) || null });
        const source = input.scope === 'unstaged' ? index : committed;
        if (source.has(file) || (input.scope !== 'unstaged' && identity.head && index.has(file))) {
            restore.push(file);
        } else {
            if (!snapshot.missing) remove.push(file);
            if (input.scope !== 'unstaged' && index.has(file)) removeIndex.push(file);
        }
    }
    const finalIdentity = await checkoutIdentity(root);
    if (JSON.stringify(identity) !== JSON.stringify(finalIdentity)) throw new Error('The branch changed while checking files. Review a new confirmation.');
    return {
        ...identity, scope: input.scope, ...(input.path === undefined ? {} : { path: input.path }),
        files, snapshots, restore, remove, removeIndex,
        deletedFiles: paths.filter(file => !(input.scope === 'unstaged' ? index : committed).has(file)),
        includesUnstaged: input.scope === 'staged' && files.some(file => file.worktree !== ' '),
    };
}

async function withPathspec(files, action) {
    if (!files.length) return;
    const directory = await mkdtemp(path.join(os.tmpdir(), 'branchlight-pathspec-'));
    const filename = path.join(directory, 'paths');
    try {
        await writeFile(filename, files.map(file => `:(literal)${file}\0`).join(''));
        await action([`--pathspec-from-file=${filename}`, '--pathspec-file-nul']);
    } finally {
        await unlink(filename).catch(error => { if (error.code !== 'ENOENT') throw error; });
        await rmdir(directory);
    }
}

export async function discardChanges(plan) {
    const fresh = await inspectDiscard(plan.root, { scope: plan.scope, ...(plan.path === undefined ? {} : { path: plan.path }) });
    if (JSON.stringify(fresh) !== JSON.stringify(plan)) {
        throw new Error('The branch or files changed since this confirmation. Review the changes again before discarding.');
    }
    try {
        await withPathspec(fresh.restore, args => git(fresh.root, ['restore', '--no-recurse-submodules',
            ...(fresh.scope === 'unstaged' ? ['--worktree'] : [`--source=${fresh.head}`, '--staged', '--worktree']), ...args]));
        await withPathspec(fresh.removeIndex, args => git(fresh.root, ['rm', '--cached', '-f', ...args]));
        for (const file of fresh.remove) {
            const expected = fresh.snapshots.find(snapshot => snapshot.path === file);
            const actual = await fileSnapshot(fresh.root, file);
            if (actual.hash !== expected.hash || actual.mode !== expected.mode || actual.size !== expected.size) {
                throw new Error(`The file changed during discard: ${file}`);
            }
            await unlink(path.join(fresh.root, file));
        }
    } catch (error) {
        throw new Error('Discard did not finish. Some files may already have been restored; refresh and review before trying again. ' + String(error.stderr || error.message).trim().slice(0, 500));
    }
    return { root: fresh.root, count: fresh.snapshots.length };
}
