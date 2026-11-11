import { app, BrowserWindow } from 'electron';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { git, repository } from '../git.mjs';
import { createApp } from '../server.mjs';

app.whenReady().then(async () => {
    let directory, server, window;
    try {
        directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'branchlight-tracking-')));
        const root = path.join(directory, 'demo-repository');
        const remote = path.join(directory, 'remote.git');
        const peer = path.join(directory, 'peer');
        await mkdir(root);
        await git(root, ['init', '-b', 'main']);
        const configure = async folder => {
            for (const [key, value] of Object.entries({ 'user.name': 'Tracking Test', 'user.email': 'test@example.invalid', 'commit.gpgsign': 'false', 'core.hooksPath': path.join(directory, 'no-hooks'), 'core.autocrlf': 'false' })) await git(folder, ['config', key, value]);
        };
        const commit = async (folder, file, content) => {
            await writeFile(path.join(folder, file), content);
            await git(folder, ['add', '.']);
            await git(folder, ['commit', '-m', content.trim()]);
        };
        await configure(root);
        await commit(root, 'file.txt', 'Initial project\n');
        await git(directory, ['init', '--bare', '-b', 'main', remote]);
        await git(root, ['remote', 'add', 'origin', remote]);
        await git(root, ['push', '-u', 'origin', 'main']);
        await git(directory, ['clone', remote, peer]);
        await configure(peer);
        for (let i = 1; i <= 3; i++) await commit(peer, 'remote.txt', 'Remote change ' + i + '\n');
        await git(peer, ['push', 'origin', 'main']);
        await git(root, ['fetch', 'origin']);
        await commit(root, 'local.txt', 'Local improvement\n');
        await git(root, ['branch', 'other-view']);
        const application = await createApp(await repository(root));
        server = application.server;
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        window = new BrowserWindow({ width: 1540, height: 960, show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, partition: 'tracking-' + Date.now() } });
        window.setMenu(null);
        const evaluate = (fn, ...args) => window.webContents.executeJavaScript(`(${fn})(...${JSON.stringify(args)})`);
        const wait = async predicate => {
            for (let i = 0; i < 150; i++) {
                if (await evaluate(predicate)) return;
                await new Promise(resolve => setTimeout(resolve, 100));
            }
            throw new Error('Tracking UI did not settle: ' + predicate);
        };
        const refresh = async () => {
            await evaluate(() => document.getElementById('toolbar-refresh').click());
            await new Promise(resolve => setTimeout(resolve, 100));
            await wait(() => !document.getElementById('refresh').disabled);
        };
        await window.loadURL(`http://127.0.0.1:${server.address().port}/#${application.token}`);
        await wait(() => document.getElementById('toolbar-sync').textContent === '3 behind · 1 ahead' && !document.getElementById('refresh').disabled);
        assert.match(await evaluate(() => document.getElementById('toolbar-sync').title), /3 commits behind and 1 commit ahead of origin\/main.*last fetched/);
        for (const width of [1540, 1024]) {
            window.setSize(width, 960);
            await new Promise(resolve => setTimeout(resolve, 150));
            const bounds = await evaluate(() => {
                const rect = document.getElementById('toolbar-sync').getBoundingClientRect();
                const version = document.querySelector('.standalone-version').getBoundingClientRect();
                return { visible: rect.width > 0 && rect.left >= 0 && rect.right <= innerWidth, versionVisible: version.width > 0 && version.right <= innerWidth };
            });
            assert.equal(bounds.visible, true, 'Behind/ahead counts must fit the compact toolbar');
            assert.equal(bounds.versionVisible, true, 'The version stays visible with the new count');
            for (const view of ['history', 'changes', 'files']) {
                await evaluate(view => document.querySelector('[data-view="' + view + '"]').click(), view);
                assert.equal(await evaluate(() => document.getElementById('toolbar-sync').hidden), false);
            }
        }
        await evaluate(() => document.querySelector('[data-view="history"]').click());
        await evaluate(() => document.querySelector('.branch-item[data-ref="refs/heads/other-view"]').click());
        await wait(() => document.getElementById('history-scope').textContent === 'other-view');
        assert.equal(await evaluate(() => document.getElementById('toolbar-sync').textContent), '3 behind · 1 ahead');
        window.setSize(1540, 960);
        await new Promise(resolve => setTimeout(resolve, 150));
        if (process.env.BRANCHLIGHT_TRACKING_SCREENSHOT) await writeFile(process.env.BRANCHLIGHT_TRACKING_SCREENSHOT, (await window.webContents.capturePage()).toPNG());
        console.log('PASS: current-branch counts stay visible in all views, fit a narrow window, preserve the version, and ignore the soloed branch.');
        await commit(peer, 'remote.txt', 'Remote change 4\n');
        await git(peer, ['push', 'origin', 'main']);
        await refresh();
        assert.equal(await evaluate(() => document.getElementById('toolbar-sync').textContent), '3 behind · 1 ahead');
        await git(root, ['fetch', 'origin']);
        await refresh();
        assert.equal(await evaluate(() => document.getElementById('toolbar-sync').textContent), '4 behind · 1 ahead');
        await git(root, ['update-ref', '-d', 'refs/remotes/origin/main']);
        await refresh();
        assert.equal(await evaluate(() => document.getElementById('toolbar-sync').textContent), 'Upstream unavailable');
        await git(root, ['branch', '--unset-upstream']);
        await refresh();
        assert.equal(await evaluate(() => document.getElementById('toolbar-sync').textContent), 'No upstream');
        await git(root, ['switch', '--detach', 'HEAD']);
        await refresh();
        assert.equal(await evaluate(() => document.getElementById('toolbar-sync').hidden), true);
        console.log('PASS: external fetch updates counts; unavailable upstreams, no upstream, and detached HEAD never show false zero counts.');
    } catch (error) {
        console.error(error);
        process.exitCode = 1;
    } finally {
        window?.destroy();
        if (server) await new Promise(resolve => server.close(resolve));
        if (directory) {
            assert.equal(path.dirname(directory), await realpath(os.tmpdir()));
            assert.ok(path.basename(directory).startsWith('branchlight-tracking-'));
            await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        }
        app.exit(process.exitCode || 0);
    }
});
