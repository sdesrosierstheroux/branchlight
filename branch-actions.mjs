import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { git, status } from './git.mjs';

async function ready(root, input, clean = false) {
    const data = await status(root);
    if (input.head !== data.head || input.branch !== data.branch) {
        throw new Error('The current branch changed. Refresh and try again.');
    }
    const directory = (await git(root, ['rev-parse', '--absolute-git-dir'])).trim();
    for (const name of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG', 'rebase-merge', 'rebase-apply', 'sequencer', 'index.lock']) {
        const exists = await lstat(path.join(directory, name)).then(() => true).catch(error => {
            if (error.code === 'ENOENT') return false;
            throw error;
        });
        if (exists) throw new Error('Finish or abort the active Git operation before checking out or pulling a branch.');
    }
    if (data.files.some(file => file.conflict)) throw new Error('Resolve the merge conflicts first.');
    if (clean && data.files.length) throw new Error('Commit or stash your working changes before pulling.');
    return data;
}

export async function checkoutBranch(root, input) {
    const data = await ready(root, input);
    const ref = data.refs.find(ref => ref.name === input.ref);
    if (!ref || !/^refs\/(heads|remotes)\//.test(ref.name) || ref.symbolic) {
        throw new Error('Choose an existing local or remote branch to check out.');
    }
    const options = ['switch', '--no-guess', '--no-recurse-submodules', '--no-overwrite-ignore'];
    const switchBranch = async args => {
        try {
            // Updating a large working tree or running checkout hooks can exceed read timeouts.
            await git(root, args, { timeout: 300000 });
        } catch (error) {
            if (error.killed) throw new Error('Checkout timed out after 5 minutes. Git may have already switched branches. Refresh to check the current branch and working changes before trying again.');
            throw error;
        }
    };
    if (ref.name.startsWith('refs/heads/')) {
        await switchBranch([...options, '--', ref.name.slice('refs/heads/'.length)]);
    } else {
        const remotes = (await git(root, ['remote'])).trim().split('\n').filter(Boolean).sort((a, b) => b.length - a.length);
        const short = ref.name.slice('refs/remotes/'.length);
        const remote = remotes.find(name => short.startsWith(name + '/'));
        if (!remote) throw new Error('This remote branch has no configured remote. Refresh and try again.');
        const branch = short.slice(remote.length + 1);
        const existing = data.refs.find(candidate => candidate.name === `refs/heads/${branch}`);
        if (existing) {
            const upstream = (await git(root, ['for-each-ref', '--format=%(upstream)', existing.name])).trim();
            if (upstream !== ref.name) throw new Error(`Local branch ${branch} already exists and tracks a different branch. Check it out from Local instead.`);
            await switchBranch([...options, '--', branch]);
        } else {
            // Validate the local name too: a remote ref can contain a name such as "-topic".
            if (branch.startsWith('-')) throw new Error('This remote branch cannot be used as a local branch name.');
            await git(root, ['check-ref-format', '--branch', branch]);
            await switchBranch([...options, '--track=direct', '-c', branch, '--', ref.name]);
        }
    }
    return { root };
}

export async function pullBranch(root, input) {
    const data = await ready(root, input, true);
    const current = data.refs.find(ref => ref.current);
    if (!current || !current.upstream) throw new Error('The current branch needs a tracking upstream before it can be pulled.');
    const tracking = () => git(root, ['for-each-ref', '--format=%(upstream)%00%(upstream:remotename)', current.name]).then(value => value.trim());
    const configuration = await tracking();
    const [upstream, remote] = configuration.split('\0');
    if (!upstream || !remote) throw new Error('The current branch needs a configured tracking remote before it can be pulled.');
    try {
        await git(root, ['fetch', '--no-recurse-submodules', '--', remote], { timeout: 120000 });
        // Network access can take time; recheck the checkout before updating files.
        await ready(root, input, true);
        if (await tracking() !== configuration) throw new Error('The tracking upstream changed. Refresh and try again.');
        await git(root, ['merge', '--ff-only', '--no-autostash', '--no-overwrite-ignore', '--no-edit', '--no-stat', '--', upstream]);
    } catch (error) {
        if (error.killed) throw new Error('Pull timed out. Refresh to check the branch before trying again.');
        throw new Error('Pull did not finish. ' + String(error.stderr || error.message).trim().slice(-700));
    }
    return { root, updated: (await status(root)).head !== data.head };
}
