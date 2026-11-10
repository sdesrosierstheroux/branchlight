import { readdir, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { repository } from './git.mjs';

export const defaultRepositoryFolder = process.env.BRANCHLIGHT_REPOSITORIES || path.join(os.homedir(), 'git');

const pathKey = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);

export async function discoverRepositories(folder = defaultRepositoryFolder) {
    const resolved = path.resolve(folder);
    let entries;
    let canonicalFolder;
    try {
        canonicalFolder = await realpath(resolved);
        entries = await readdir(canonicalFolder, { withFileTypes: true });
    } catch (error) {
        return { folder: resolved, repositories: [], warning: error.code === 'ENOENT'
            ? 'The repository folder is unavailable. Reconnect the drive and scan again.'
            : 'The repository folder could not be read. Check access and scan again.' };
    }
    const repositories = [];
    const skipped = [];
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith('.')) continue;
        const candidate = path.join(canonicalFolder, entry.name);
        try {
            const marker = await lstat(path.join(candidate, '.git'));
            if (!marker.isDirectory() && !marker.isFile()) continue;
        } catch (error) {
            if (error.code !== 'ENOENT') skipped.push(entry.name);
            continue;
        }
        try {
            const root = await repository(candidate);
            if (pathKey(root) !== pathKey(candidate)) continue;
            repositories.push({ name: entry.name, path: root });
        } catch { skipped.push(entry.name); }
    }
    return {
        folder: canonicalFolder, repositories,
        warning: skipped.length ? `Could not open: ${skipped.join(', ')}. Check those folders and scan again.` : '',
    };
}

export async function chooseStartupRepository({ requested, saved, folder = defaultRepositoryFolder } = {}) {
    for (const candidate of [requested, saved].filter(value => typeof value === 'string' && value.trim())) {
        try { return await repository(candidate); }
        catch { /* A missing last checkout falls back to the repository folder. */ }
    }
    const catalog = await discoverRepositories(folder);
    return catalog.repositories[0]?.path || null;
}
