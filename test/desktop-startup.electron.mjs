import { app, BrowserWindow, Menu } from 'electron';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [directory, repository] = process.argv.slice(-2);
app.setPath('appData', path.join(directory, 'profile'));
process.argv = [process.execPath, fileURLToPath(new URL('../desktop/main.mjs', import.meta.url)), repository];
const timer = setTimeout(() => { console.error('Standalone desktop startup timed out.'); app.exit(1); }, 30000);
async function run() {
    try {
        await import('../desktop/main.mjs');
        await app.whenReady();
        let window;
        let ready = false;
        for (let i = 0; i < 150; i++) {
            window = BrowserWindow.getAllWindows()[0];
            if (window && !window.webContents.isLoading()) {
                ready = await window.webContents.executeJavaScript("Boolean(document.getElementById('repo-name')?.textContent === 'demo-repository' && document.getElementById('toolbar-branch-name')?.textContent === 'main' && !document.getElementById('refresh').disabled)");
                if (ready) break;
            }
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        assert.equal(ready, true, 'The actual standalone launcher must load the repository');
        assert.equal(app.getName(), 'Branchlight');
        assert.equal(app.getPath('userData'), path.join(directory, 'profile', 'branchlight-git'));
        const metadata = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
        const state = await window.webContents.executeJavaScript(`(async () => ({
            title: document.title,
            version: document.querySelector('.standalone-version').textContent,
            versionVisible: document.querySelector('.standalone-version').getBoundingClientRect().width > 0,
            frames: document.querySelectorAll('iframe').length,
            errors: document.getElementById('error-banner').hidden,
            chooseRepository: typeof window.branchlightDesktop?.chooseRepository,
            layout: await window.branchlightDesktop.loadLayout(),
            tokenRemoved: !location.hash
        }))()`);
        assert.equal(state.title, 'demo-repository · Branchlight');
        assert.equal(state.version, 'v' + metadata.version);
        assert.equal(state.versionVisible, true);
        assert.equal(state.frames, 0);
        assert.equal(state.errors, true);
        assert.equal(state.chooseRepository, 'function');
        assert.equal(state.tokenRemoved, true);
        const preferences = JSON.parse(await readFile(path.join(app.getPath('userData'), 'preferences.json'), 'utf8'));
        assert.equal(path.normalize(preferences.repository), path.normalize(repository));
        if (process.env.BRANCHLIGHT_STARTUP_SCREENSHOT) {
            await new Promise(resolve => setTimeout(resolve, 250));
            await writeFile(process.env.BRANCHLIGHT_STARTUP_SCREENSHOT, (await window.webContents.capturePage()).toPNG());
        }
        Menu.getApplicationMenu().items.find(item => item.label === 'File').submenu.items[0].click();
        await new Promise(resolve => setTimeout(resolve, 200));
        assert.equal(await window.webContents.executeJavaScript("document.getElementById('repository-dialog').open"), true);
        await writeFile(path.join(directory, 'success.txt'), 'PASS: standalone launcher, Git repository, isolated preferences, visible package version, desktop bridge, and Open menu.');
        clearTimeout(timer);
        app.exit(0);
    } catch (error) {
        console.error(error);
        clearTimeout(timer);
        app.exit(1);
    }
}
run();
