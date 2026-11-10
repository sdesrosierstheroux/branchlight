import { app, BrowserWindow } from 'electron';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { git, repository } from '../git.mjs';
import { createApp } from '../server.mjs';

// Run with: electron test/worktree-selection.electron.mjs
app.whenReady().then(async () => {
    let directory, server, window;
    try {
        directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'branchlight-selection-')));
        const root = path.join(directory, 'main-checkout');
        await mkdir(root);
        await git(root, ['init', '-b', 'main']);
        for (const [key, value] of Object.entries({ 'user.name': 'Branchlight Test', 'user.email': 'test@example.invalid', 'commit.gpgsign': 'false', 'core.hooksPath': path.join(directory, 'no-hooks') })) {
            await git(root, ['config', key, value]);
        }
        await writeFile(path.join(root, 'file.txt'), 'base\n');
        await git(root, ['add', '.']);
        await git(root, ['commit', '-m', 'Base']);
        const head = (await git(root, ['rev-parse', 'HEAD'])).trim();
        const ref = 'refs/heads/feature/deep/zz-current';
        await git(root, ['update-ref', ref, head]);
        // Put the target after the first 150 rows in a nested folder.
        execFileSync('git', ['update-ref', '--stdin'], { cwd: root, windowsHide: true, input: Array.from({ length: 180 }, (_, i) => `create refs/heads/feature/deep/topic-${String(i).padStart(3, '0')} ${head}`).join('\n') + '\n' });
        await git(root, ['update-ref', 'refs/remotes/origin/feature/deep/zz-current', head]);
        const linked = path.join(directory, 'linked-checkout');
        const detached = path.join(directory, 'detached-checkout');
        await git(root, ['worktree', 'add', linked, 'feature/deep/zz-current']);
        await git(root, ['worktree', 'add', '--detach', detached, head]);
        const application = await createApp(await repository(root));
        server = application.server;
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        window = new BrowserWindow({ width: 1024, height: 768, show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, partition: 'branchlight-selection-' + Date.now() } });
        window.setMenu(null);
        const evaluate = (fn, ...args) => window.webContents.executeJavaScript(`(${fn})(...${JSON.stringify(args)})`);
        const wait = async fn => {
            for (let i = 0; i < 150; i++) {
                if (await evaluate(fn)) return;
                await new Promise(resolve => setTimeout(resolve, 100));
            }
            throw new Error('UI did not settle: ' + fn);
        };
        const selected = () => {
            const button = document.querySelector('.branch-item[aria-pressed="true"]');
            const bounds = button?.getBoundingClientRect();
            const container = document.getElementById('branches').getBoundingClientRect();
            let ancestor = button?.closest('details');
            let expanded = true;
            while (ancestor) { expanded &&= ancestor.open; ancestor = ancestor.parentElement.closest('details'); }
            return {
                ref: button?.dataset.ref, expanded,
                visible: Boolean(bounds && bounds.top >= container.top - 1 && bounds.bottom <= container.bottom + 1),
                filter: document.getElementById('branch-search').value,
                filesView: !document.getElementById('files-view').hidden,
            };
        };
        await window.loadURL(`http://127.0.0.1:${server.address().port}/#${application.token}`);
        await wait(() => document.querySelectorAll('.worktree-item').length === 3 && !document.getElementById('refresh').disabled);
        await evaluate(() => document.querySelector('[data-view="files"]').click());
        await evaluate(() => [...document.querySelectorAll('.worktree-item')].find(button => button.querySelector('.worktree-name').textContent === 'linked-checkout').click());
        await wait(() => document.getElementById('toolbar-branch-name').textContent === 'feature/deep/zz-current' && !document.getElementById('refresh').disabled);
        assert.deepEqual(await evaluate(selected), { ref, expanded: true, visible: true, filter: '', filesView: true });
        assert.equal(await evaluate(() => document.getElementById('history-scope').textContent), 'feature/deep/zz-current');
        assert.equal(await evaluate(() => {
            const bounds = document.getElementById('toolbar-reveal-branch').getBoundingClientRect();
            return bounds.left >= 0 && bounds.right <= innerWidth;
        }), true);
        if (process.env.BRANCHLIGHT_SELECTION_SCREENSHOT) {
            await new Promise(resolve => setTimeout(resolve, 200));
            await writeFile(process.env.BRANCHLIGHT_SELECTION_SCREENSHOT, (await window.webContents.capturePage()).toPNG());
        }
        console.log('PASS: choosing a worktree selects, expands and scrolls to its branch beyond the first page, preserving the Files view.');

        await evaluate(() => {
            const search = document.getElementById('branch-search');
            search.value = 'main'; search.dispatchEvent(new Event('input'));
            document.querySelectorAll('#branches details').forEach(details => { details.open = false; });
        });
        await new Promise(resolve => setTimeout(resolve, 100));
        await evaluate(() => document.getElementById('toolbar-reveal-branch').click());
        await wait(() => document.querySelector('.branch-item[aria-pressed="true"]')?.dataset.ref === 'refs/heads/feature/deep/zz-current');
        assert.deepEqual(await evaluate(selected), { ref, expanded: true, visible: true, filter: '', filesView: false });
        assert.equal(await evaluate(() => document.activeElement.dataset.ref), ref);
        console.log('PASS: Show in tree clears filtering, expands collapsed folders, selects the local branch and focuses it.');

        await evaluate(() => document.getElementById('all-branches').click());
        await evaluate(() => document.querySelector('.worktree-item.current').click());
        await wait(() => !document.getElementById('refresh').disabled && Boolean(document.querySelector('.branch-item[aria-pressed="true"]')));
        assert.equal((await evaluate(selected)).ref, ref);
        console.log('PASS: reselecting the current worktree restores its associated branch.');

        await evaluate(() => [...document.querySelectorAll('.worktree-item')].find(button => button.querySelector('.worktree-name').textContent === 'detached-checkout').click());
        await wait(() => document.getElementById('toolbar-branch-name').textContent === 'Detached HEAD' && !document.getElementById('refresh').disabled);
        assert.equal(await evaluate(() => document.getElementById('toolbar-reveal-branch').disabled), true);
        assert.equal(await evaluate(() => document.querySelector('.branch-item[aria-pressed="true"]') === null), true);
        assert.equal(await evaluate(() => document.getElementById('error-banner').hidden), true);
        console.log('PASS: detached worktrees focus their commit and disable branch reveal.');
        assert.equal(await git(root, ['branch', '--show-current']).then(value => value.trim()), 'main');
        assert.equal(await git(linked, ['branch', '--show-current']).then(value => value.trim()), 'feature/deep/zz-current');
        console.log('PASS: viewing and revealing branches never changes any checkout.');
    } catch (error) {
        console.error(error);
        process.exitCode = 1;
    } finally {
        window?.destroy();
        if (server) await new Promise(resolve => server.close(resolve));
        if (directory) {
            assert.equal(path.dirname(directory), await realpath(os.tmpdir()));
            assert.ok(path.basename(directory).startsWith('branchlight-selection-'));
            await rm(directory, { recursive: true, force: true });
        }
        app.exit(process.exitCode || 0);
    }
});
