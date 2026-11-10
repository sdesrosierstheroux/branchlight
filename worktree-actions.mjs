import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { git, repository, resolveCommit, worktrees } from './git.mjs';

const pathKey = value => {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};

function inside(parent, child) {
    const relative = path.relative(pathKey(parent), pathKey(child));
    return !relative || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function exists(file) {
    try { await lstat(file); return true; }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

export async function inspectWorktreeDeletion(root, input) {
    if (typeof input !== 'string' || !path.isAbsolute(input) || input.includes('\0')) {
        throw new Error('Choose a worktree listed in this repository.');
    }
    const entries = await worktrees(root);
    const target = entries.find(entry => pathKey(entry.path) === pathKey(input));
    if (!target) throw new Error('This folder is not a registered worktree in this repository.');
    if (target.main || target.bare) throw new Error('The main checkout cannot be deleted.');
    if (target.locked) throw new Error('This worktree is locked. Unlock it before deleting it.');
    const missing = !await exists(target.path);
    if (!missing && !target.available) throw new Error('This folder still exists, but its Git registration is damaged. Repair it before deleting it.');
    if (missing && !await exists(path.parse(target.path).root)) throw new Error('The drive or share is unavailable. Reconnect it before removing this worktree.');
    const main = entries.find(entry => entry.main && entry.available);
    if (!main) throw new Error('The main checkout must be available before deleting a worktree.');
    const targetPath = missing ? path.resolve(target.path) : await realpath(target.path);
    if (!missing && ((await lstat(target.path)).isSymbolicLink() || pathKey(targetPath) !== pathKey(target.path))) {
        throw new Error('Worktrees reached through a symbolic link or junction cannot be deleted here.');
    }
    if (entries.some(entry => entry !== target && inside(targetPath, entry.path))) {
        throw new Error('This folder contains another checkout. Move that checkout before deleting it.');
    }
    const mainPath = await repository(main.path);
    const commonDirectory = await realpath((await git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim());
    let head;
    let branch;
    let entriesInStatus = [];
    if (missing) {
        if (!/^[a-f0-9]{40,64}$/i.test(target.head)) throw new Error('The missing worktree has no readable commit. Repair its registration first.');
        head = await resolveCommit(mainPath, target.head);
        branch = target.branch;
        if (branch && await resolveCommit(mainPath, branch) !== head) throw new Error('The branch changed. Refresh and try again.');
    } else {
        const targetCommon = await realpath((await git(targetPath, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim());
        if (pathKey(commonDirectory) !== pathKey(targetCommon)) throw new Error('The worktree now belongs to a different repository.');
        const [currentHead, currentBranch, status, gitDirectory] = await Promise.all([
            resolveCommit(targetPath, 'HEAD'),
            git(targetPath, ['symbolic-ref', '--quiet', 'HEAD']).then(value => value.trim()).catch(error => {
                if (error.code === 1) return '';
                throw error;
            }),
            git(targetPath, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching', '--ignore-submodules=none']),
            git(targetPath, ['rev-parse', '--absolute-git-dir']).then(value => value.trim()),
        ]);
        head = currentHead;
        branch = currentBranch;
        const operations = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG', 'rebase-merge', 'rebase-apply', 'sequencer'];
        if ((await Promise.all(operations.map(name => exists(path.join(gitDirectory, name))))).some(Boolean)) {
            throw new Error('Finish or abort the Git operation in this worktree before deleting it.');
        }
        entriesInStatus = status.split('\0').filter(Boolean);
        if (entriesInStatus.some(entry => !entry.startsWith('!! '))) {
            throw new Error('This worktree has uncommitted changes or untracked files. Commit, stash, or move them before deleting it.');
        }
    }
    if (branch && !branch.startsWith('refs/heads/')) throw new Error('Only a local branch can be deleted with its worktree.');
    if (head !== target.head || branch !== target.branch) throw new Error('The checkout changed. Refresh and try again.');
    if (branch && entries.some(entry => entry !== target && entry.branch === branch)) {
        throw new Error('This branch is also checked out in another worktree.');
    }
    let upstream = '';
    if (branch) {
        const refs = await git(mainPath, ['for-each-ref', '--format=%(refname)%00%(upstream)', branch]);
        upstream = refs.split('\n').map(line => line.split('\0')).find(fields => fields[0] === branch)?.[1] || '';
    }
    let comparison = upstream;
    let comparisonHead = upstream ? await resolveCommit(mainPath, upstream).catch(() => '') : '';
    if (!comparisonHead) {
        comparison = main.branch || 'main checkout HEAD';
        comparisonHead = await resolveCommit(mainPath, 'HEAD');
    }
    const unmerged = Number((await git(mainPath, ['rev-list', '--count', head, '--not', comparisonHead, '--'])).trim());
    if (!Number.isSafeInteger(unmerged) || unmerged < 0) throw new Error('Could not check the branch history.');
    return {
        root, path: targetPath, name: target.name, branch, head, mainPath, commonDirectory,
        current: target.current, missing, comparison, comparisonHead, unmerged,
        ignored: entriesInStatus.filter(entry => entry.startsWith('!! ')).map(entry => entry.slice(3)),
    };
}

export async function deleteWorktree(plan, choices = {}) {
    const fresh = await inspectWorktreeDeletion(plan.root, plan.path);
    for (const key of ['root', 'path', 'branch', 'head', 'mainPath', 'commonDirectory', 'missing', 'comparison', 'comparisonHead']) {
        if (fresh[key] !== plan[key]) throw new Error('The worktree or branch changed. Review a new confirmation before deleting it.');
    }
    if (fresh.unmerged && choices.allowUnmerged !== true) throw new Error('Confirm removal of the unmerged commits first.');
    if (fresh.ignored.length && choices.removeIgnored !== true) throw new Error('Confirm removal of ignored files first.');
    if (fresh.ignored.some(file => !plan.ignored.includes(file))) {
        throw new Error('New ignored files appeared. Review a new confirmation before deleting this worktree.');
    }
    const result = { root: fresh.current ? fresh.mainPath : fresh.root, path: fresh.path, branch: fresh.branch, branchDeleted: false, warning: '' };
    try {
        await git(fresh.mainPath, ['worktree', 'remove', '--', fresh.path], { timeout: 300000 });
    } catch (error) {
        const remaining = await worktrees(fresh.mainPath);
        if (remaining.some(entry => pathKey(entry.path) === pathKey(fresh.path))) throw error;
        result.warning = 'Git removed the worktree registration but reported an error. Check the folder; the local branch was kept. ' + String(error.stderr || error.message).trim().slice(0, 400);
        return result;
    }
    if (fresh.branch) {
        try {
            if (await resolveCommit(fresh.mainPath, fresh.branch) !== fresh.head) {
                throw new Error('The branch moved during deletion.');
            }
            await git(fresh.mainPath, ['branch', choices.allowUnmerged === true && fresh.unmerged ? '-D' : '-d', '--', fresh.branch.slice('refs/heads/'.length)]);
            result.branchDeleted = true;
        } catch (error) {
            result.warning = 'The worktree was deleted, but its local branch was kept. ' + String(error.stderr || error.message).trim().slice(0, 400);
        }
    }
    return result;
}
