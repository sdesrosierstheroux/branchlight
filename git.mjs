import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, realpath, lstat } from 'node:fs/promises';
import path from 'node:path';

const execute = promisify(execFile);
const previewLimit = 2 * 1024 * 1024;

export async function git(root, args, options = {}) {
    const result = await execute('git', [
        '--no-optional-locks', '-c', 'core.quotepath=false', '-c', 'core.fsmonitor=false',
        '-c', 'color.ui=false', ...args,
    ], {
        cwd: root,
        windowsHide: true,
        timeout: 30000,
        maxBuffer: 64 * 1024 * 1024,
        encoding: 'utf8',
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1' },
        ...options,
    });
    return result.stdout;
}

export async function repository(input) {
    const root = (await git(path.resolve(input), ['rev-parse', '--show-toplevel'])).trim();
    return realpath(root);
}

export function parseStatus(output) {
    const fields = output.split('\0');
    const files = [];
    for (let i = 0; i < fields.length; i++) {
        const entry = fields[i];
        if (!entry) {
            continue;
        }
        const index = entry[0];
        const worktree = entry[1];
        const file = { path: entry.slice(3), index, worktree };
        if (index === 'R' || index === 'C' || worktree === 'R' || worktree === 'C') {
            file.previousPath = fields[++i];
        }
        file.untracked = index === '?';
        file.conflict = ['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'].includes(index + worktree);
        files.push(file);
    }
    return files;
}

export async function status(root) {
    const [output, branchOutput, headOutput, refsOutput, worktreeList] = await Promise.all([
        // Cold file-system scans can take longer than history and ref queries.
        git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { timeout: 120000 }),
        git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => ''),
        git(root, ['rev-parse', '--verify', 'HEAD']).catch(() => ''),
        git(root, ['for-each-ref', '--sort=-committerdate', '--format=%(refname)%00%(objectname)%00%(upstream:short)%00%(HEAD)%00%(symref)', 'refs/heads', 'refs/remotes', 'refs/tags']),
        worktrees(root),
    ]);
    const refs = refsOutput.trim().split('\n').filter(Boolean).map(line => {
        const [name, hash, upstream, current, symbolic] = line.split('\0');
        return { name, hash, upstream, current: current.trim() === '*', symbolic: symbolic || '' };
    });
    const current = refs.find(ref => ref.current);
    let ahead = 0;
    let behind = 0;
    if (current?.upstream && headOutput) {
        const counts = await git(root, ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}', '--']).catch(() => '0\t0');
        [ahead, behind] = counts.trim().split(/\s+/).map(Number);
    }
    return {
        root, name: path.basename(root), branch: branchOutput.trim() || (headOutput ? 'Detached HEAD' : 'No commits yet'),
        head: headOutput.trim(), files: parseStatus(output), refs, ahead, behind, worktrees: worktreeList,
    };
}

export function parseWorktrees(output) {
    const entries = [];
    let entry;
    for (const field of output.split('\0')) {
        const space = field.indexOf(' ');
        const label = space === -1 ? field : field.slice(0, space);
        const value = space === -1 ? '' : field.slice(space + 1);
        if (label === 'worktree') {
            entry = { path: value, head: '', branch: '', detached: false, bare: false, locked: false, prunable: false };
            entries.push(entry);
        } else if (entry && ['detached', 'bare', 'locked', 'prunable'].includes(label)) {
            entry[label] = true;
            if (value) {
                entry[`${label}Reason`] = value;
            }
        } else if (entry && label === 'HEAD') {
            entry.head = value;
        } else if (entry && label === 'branch') {
            entry.branch = value;
        }
    }
    return entries;
}

export async function worktrees(root) {
    const [output, canonicalRoot] = await Promise.all([
        git(root, ['worktree', 'list', '--porcelain', '-z']),
        realpath(root),
    ]);
    return Promise.all(parseWorktrees(output).map(async (entry, index) => {
        const canonicalPath = await realpath(entry.path).catch(() => null);
        const normalize = value => process.platform === 'win32' ? value.toLowerCase() : value;
        return {
            ...entry, name: path.basename(entry.path), main: index === 0,
            current: canonicalPath !== null && normalize(canonicalPath) === normalize(canonicalRoot),
            available: canonicalPath !== null && !entry.bare && !entry.prunable,
        };
    }));
}

export async function resolveCommit(root, ref) {
    if (typeof ref !== 'string' || !ref || ref.includes('\0') || ref.length > 1024) {
        throw new Error('Invalid revision.');
    }
    return (await git(root, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`])).trim();
}

export async function history(root, { ref = '', limit = 200 } = {}) {
    const count = Math.min(1000, Math.max(1, Number(limit) || 200));
    const revisions = ref ? [await resolveCommit(root, ref)] : ['--all', 'HEAD'];
    if (!ref && !(await git(root, ['rev-parse', '--verify', 'HEAD']).catch(() => ''))) {
        revisions.pop();
    }
    const output = await git(root, ['log', '--topo-order', `-n${count}`, '-z',
        '--format=%H%x00%P%x00%an%x00%aI%x00%s%x00%D', ...revisions, '--']);
    const fields = output.split('\0');
    const commits = [];
    for (let i = 0; i + 5 < fields.length; i += 6) {
        commits.push({
            hash: fields[i], parents: fields[i + 1].split(' ').filter(Boolean),
            author: fields[i + 2], date: fields[i + 3], subject: fields[i + 4],
            refs: fields[i + 5],
        });
    }
    return { commits, limit: count, more: commits.length === count };
}

export function validPath(input, allowEmpty = false) {
    if (typeof input !== 'string' || (!input && !allowEmpty) || input.includes('\0') ||
        input.includes('\\') || path.posix.isAbsolute(input) || /^[a-z]:/i.test(input) ||
        input.split('/').some(part => part === '..' || part.toLowerCase() === '.git')) {
        throw new Error('Choose a file inside the repository.');
    }
    return input;
}

export async function tree(root, directory = '', ref = '') {
    validPath(directory, true);
    if (ref) {
        const hash = await resolveCommit(root, ref);
        const output = await git(root, ['ls-tree', '-z', `${hash}${directory ? `:${directory}` : ''}`]);
        return output.split('\0').filter(Boolean).map(entry => {
            const tab = entry.indexOf('\t');
            const [mode, type] = entry.slice(0, tab).split(' ');
            const name = entry.slice(tab + 1);
            return { name, path: directory ? `${directory}/${name}` : name, directory: type === 'tree', submodule: type === 'commit', mode };
        }).sort(sortEntries);
    }
    const prefix = directory ? `${directory}/` : '';
    const output = await git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...(prefix ? [`:(literal)${prefix}`] : [])]);
    const entries = new Map();
    for (const file of output.split('\0').filter(Boolean)) {
        if (!file.startsWith(prefix)) {
            continue;
        }
        const remainder = file.slice(prefix.length);
        const name = remainder.split('/')[0];
        if (!name || name.toLowerCase() === '.git') {
            continue;
        }
        const directoryEntry = remainder.includes('/');
        entries.set(name, { name, path: `${prefix}${name}`, directory: directoryEntry || entries.get(name)?.directory || false });
    }
    return [...entries.values()].sort(sortEntries);
}

function sortEntries(a, b) {
    return Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name);
}

export async function fileContent(root, file, ref = '') {
    validPath(file);
    let buffer;
    if (ref) {
        const hash = await resolveCommit(root, ref);
        const object = `${hash}:${file}`;
        const size = Number((await git(root, ['cat-file', '-s', object])).trim());
        if (size > previewLimit) {
            return { text: '', tooLarge: true, size };
        }
        buffer = await git(root, ['cat-file', 'blob', object], { encoding: 'buffer', maxBuffer: previewLimit });
    } else {
        const resolved = path.resolve(root, file);
        const stat = await lstat(resolved);
        if (stat.isSymbolicLink()) {
            return { text: '', message: 'Symbolic links are not followed in file previews.' };
        }
        const actual = await realpath(resolved);
        const relative = path.relative(await realpath(root), actual);
        if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
            throw new Error('This file points outside the repository.');
        }
        if (!stat.isFile()) {
            return { text: '', message: 'This entry is a directory or a submodule.' };
        }
        if (stat.size > previewLimit) {
            return { text: '', tooLarge: true, size: stat.size };
        }
        buffer = await readFile(actual);
    }
    if (buffer.subarray(0, 8192).includes(0)) {
        return { text: '', binary: true, size: buffer.length };
    }
    return { text: buffer.toString('utf8'), size: buffer.length };
}

export async function diff(root, file, { stage = 'worktree', ref = '', previousPath = '' } = {}) {
    validPath(file);
    if (previousPath) {
        validPath(previousPath);
    }
    const paths = [...new Set([file, previousPath].filter(Boolean))].map(item => `:(literal)${item}`);
    const common = ['--no-ext-diff', '--no-textconv', '--no-color', '--find-renames', '--unified=4'];
    if (stage === 'untracked') {
        const content = await fileContent(root, file);
        return { ...content, untracked: true };
    }
    let args;
    if (ref) {
        const hash = await resolveCommit(root, ref);
        const parentLine = (await git(root, ['rev-list', '--parents', '-n1', hash, '--'])).trim().split(' ');
        args = parentLine.length > 1
            ? ['diff', ...common, parentLine[1], hash, '--', ...paths]
            : ['show', '--format=', ...common, hash, '--', ...paths];
    } else {
        if (!['index', 'worktree'].includes(stage)) {
            throw new Error('Invalid change group.');
        }
        args = ['diff', ...common, ...(stage === 'index' ? ['--cached'] : []), '--', ...paths];
    }
    try {
        return { text: await git(root, args, { maxBuffer: previewLimit }) };
    } catch (error) {
        if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
            return { text: '', tooLarge: true };
        }
        throw error;
    }
}

export async function commitDetails(root, ref) {
    const hash = await resolveCommit(root, ref);
    const parents = (await git(root, ['rev-list', '--parents', '-n1', hash, '--'])).trim().split(' ');
    const changeArgs = parents.length > 1
        ? ['diff', '--no-ext-diff', '--no-textconv', '--name-status', '-z', '-M', parents[1], hash, '--']
        : ['diff-tree', '--root', '--no-commit-id', '-r', '--name-status', '-z', '-M', hash, '--'];
    const [description, changes] = await Promise.all([
        git(root, ['show', '-s', '--format=%B', hash, '--']),
        git(root, changeArgs),
    ]);
    const fields = changes.split('\0');
    const files = [];
    for (let i = 0; i < fields.length && fields[i];) {
        const status = fields[i++];
        const firstPath = fields[i++];
        const renamed = /^[RC]/.test(status);
        files.push({ status: status[0], path: renamed ? fields[i++] : firstPath, previousPath: renamed ? firstPath : '' });
    }
    return { hash, description: description.trim(), files };
}
