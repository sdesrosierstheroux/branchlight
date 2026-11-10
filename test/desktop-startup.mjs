import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { git } from '../git.mjs';

const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'branchlight-startup-')));
try {
    const repository = path.join(directory, 'demo-repository');
    await mkdir(repository);
    await mkdir(path.join(directory, 'profile'));
    await git(repository, ['init', '-b', 'main']);
    for (const [key, value] of Object.entries({ 'user.name': 'Branchlight Demo', 'user.email': 'demo@example.invalid', 'commit.gpgsign': 'false', 'core.hooksPath': path.join(directory, 'no-hooks'), 'core.autocrlf': 'false' })) await git(repository, ['config', key, value]);
    await writeFile(path.join(repository, 'README.md'), '# Demo repository\n\nExplore your local Git history with Branchlight.\n');
    await git(repository, ['add', '.']);
    await git(repository, ['commit', '-m', 'Add project introduction']);
    await writeFile(path.join(repository, 'app.js'), 'export const greeting = "Hello team";\n');
    await git(repository, ['add', '.']);
    await git(repository, ['commit', '-m', 'Add team greeting']);
    await git(repository, ['branch', 'feature/welcome']);
    await writeFile(path.join(repository, 'app.js'), 'export const greeting = "Welcome to Branchlight";\n');
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    await promisify(execFile)(electron, ['--disable-gpu', fileURLToPath(new URL('desktop-startup.electron.mjs', import.meta.url)), directory, repository], { windowsHide: true, env, timeout: 45000, maxBuffer: 1024 * 1024 });

    const success = await readFile(path.join(directory, 'success.txt'), 'utf8');
    console.log(success);
    assert.ok(success.startsWith('PASS: standalone launcher'), 'Desktop startup assertions must finish');
} finally {
    assert.equal(path.dirname(directory), await realpath(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('branchlight-startup-'));
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
