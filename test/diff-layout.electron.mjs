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
        directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'branchlight-diff-layout-')));
        const root = path.join(directory, 'demo-repository');
        await mkdir(path.join(root, 'src'), { recursive: true });
        await git(root, ['init', '-b', 'main']);
        for (const [key, value] of Object.entries({ 'user.name': 'Layout Test', 'user.email': 'test@example.invalid', 'commit.gpgsign': 'false', 'core.hooksPath': path.join(directory, 'no-hooks'), 'core.autocrlf': 'false' })) {
            await git(root, ['config', key, value]);
        }
        const longAttribute = '                    Description="' + 'Navigation items should use the full width of the code pane. '.repeat(7) + '"';
        const prefix = ['<Window>', '    <Grid>', ...Array.from({ length: 21 }, (_, i) => `        <!-- Section ${i + 1} -->`)];
        const original = [...prefix, '        <Border Grid.Column="0" Padding="8,12">', '            <ListBox ItemsSource="{Binding Tabs}"', '                     SelectedItem="{Binding SelectedTab}">', '                <TextBlock Text="Original navigation" />', longAttribute, '            </ListBox>', '        </Border>', '    </Grid>', '</Window>', ''].join('\n');
        const file = path.join(root, 'src', 'ProvidersView.xaml');
        await writeFile(file, original);
        await git(root, ['add', '.']);
        await git(root, ['commit', '-m', 'Add navigation view']);
        const committed = original.replace('Original navigation', 'Provider navigation');
        await writeFile(file, committed);
        await git(root, ['add', '.']);
        await git(root, ['commit', '-m', 'Describe provider navigation']);
        const changed = [...prefix, '        <Border Grid.Column="0" Padding="0,12,0,0">', '            <ScrollViewer HorizontalScrollBarVisibility="Disabled">', '                <ItemsControl ItemsSource="{Binding NavigationGroups}">', '                    <TextBlock Text="Grouped navigation" />', longAttribute, '                    <ItemsControl ItemsSource="{Binding Rows}" />', '                </ItemsControl>', '            </ScrollViewer>', '        </Border>', '    </Grid>', '</Window>', ''].join('\n');
        await writeFile(file, changed);
        await writeFile(path.join(root, 'new-file.txt'), 'A new file without a diff hunk header\n' + 'A long added line. '.repeat(40) + '\n');
        const application = await createApp(await repository(root));
        server = application.server;
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        window = new BrowserWindow({ width: 1820, height: 980, show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, partition: 'diff-layout-' + Date.now() } });
        window.setMenu(null);
        const evaluate = (fn, ...args) => window.webContents.executeJavaScript(`(${fn})(...${JSON.stringify(args)})`);
        const wait = async predicate => {
            for (let attempt = 0; attempt < 150; attempt++) {
                if (await evaluate(predicate)) return;
                await new Promise(resolve => setTimeout(resolve, 100));
            }
            throw new Error('Diff UI did not settle: ' + predicate);
        };
        const verify = async selector => {
            const geometry = await evaluate(selector => {
                const table = document.querySelector(selector);
                const row = [...table.tBodies[0].rows].find(row => row.cells.length === 4);
                return {
                    tableWidth: table.getBoundingClientRect().width,
                    widths: [...row.cells].map(cell => cell.getBoundingClientRect().width),
                    midpoint: row.cells[2].getBoundingClientRect().left - table.getBoundingClientRect().left,
                    textFits: [...table.querySelectorAll('td.code')].every(cell => cell.scrollWidth <= cell.clientWidth + 1),
                    scrollFits: table.getBoundingClientRect().width <= table.parentElement.clientWidth + 1,
                };
            }, selector);
            assert.ok(geometry.widths[0] >= 50 && geometry.widths[0] <= 60, 'Old gutter stays narrow: ' + JSON.stringify(geometry));
            assert.ok(geometry.widths[2] >= 50 && geometry.widths[2] <= 60, 'New gutter stays narrow: ' + JSON.stringify(geometry));
            assert.ok(Math.abs(geometry.widths[1] - geometry.widths[3]) <= 1, 'Code panes share remaining space equally');
            assert.ok(Math.abs(geometry.midpoint - geometry.tableWidth / 2) <= 1, 'Before/after boundary stays centered');
            assert.ok(geometry.widths[1] > geometry.tableWidth * 0.35, 'Each code pane receives the available width');
            assert.equal(geometry.textFits, true, 'Long code lines wrap inside their pane');
            assert.equal(geometry.scrollFits, true, 'Split diff fits the preview');
        };
        await window.loadURL(`http://127.0.0.1:${server.address().port}/#${application.token}`);
        await wait(() => document.getElementById('repo-name').textContent === 'demo-repository' && !document.getElementById('refresh').disabled);
        await evaluate(() => document.querySelector('[data-view="changes"]').click());
        await evaluate(() => [...document.querySelectorAll('#changed-files .file-row')].find(button => button.title === 'src/ProvidersView.xaml').click());
        await wait(() => Boolean(document.querySelector('#change-preview .segments')));
        await evaluate(() => [...document.querySelectorAll('#change-preview .segments button')].find(button => button.textContent === 'Split').click());
        await wait(() => Boolean(document.querySelector('#change-preview .code-table.split')));
        assert.equal(await evaluate(() => document.querySelector('#change-preview tbody tr').className), 'hunk');
        for (const width of [1820, 1280, 1024]) {
            window.setSize(width, 980);
            await new Promise(resolve => setTimeout(resolve, 150));
            await verify('#change-preview .code-table.split');
        }
        window.setSize(1820, 980);
        await new Promise(resolve => setTimeout(resolve, 150));
        if (process.env.BRANCHLIGHT_DIFF_SCREENSHOT) {
            await writeFile(process.env.BRANCHLIGHT_DIFF_SCREENSHOT, (await window.webContents.capturePage()).toPNG());
        }
        console.log('PASS: split diff with a spanning hunk header has narrow gutters and equal code panes at 1820, 1280, and 1024 pixels; long lines fit.');
        await evaluate(() => [...document.querySelectorAll('#change-preview .segments button')].find(button => button.textContent === 'Unified').click());
        assert.equal(await evaluate(() => Boolean(document.querySelector('#change-preview .code-table:not(.split)'))), true);
        await evaluate(() => [...document.querySelectorAll('#changed-files .file-row')].find(button => button.title === 'new-file.txt').click());
        await wait(() => document.querySelector('#change-preview .preview-title strong')?.textContent === 'new-file.txt');
        await evaluate(() => [...document.querySelectorAll('#change-preview .segments button')].find(button => button.textContent === 'Split').click());
        await verify('#change-preview .code-table.split');
        console.log('PASS: unified diff switching and new-file split diffs keep correct columns.');
        await evaluate(() => document.querySelector('[data-view="history"]').click());
        await evaluate(() => document.querySelector('#commits tr').click());
        await wait(() => Boolean(document.querySelector('#commit-files .file-row')));
        await evaluate(() => document.querySelector('#commit-files .file-row').click());
        await wait(() => Boolean(document.querySelector('#commit-preview .code-table.split')));
        await verify('#commit-preview .code-table.split');
        console.log('PASS: historical commit split diffs use the same correct layout.');
    } catch (error) {
        console.error(error);
        process.exitCode = 1;
    } finally {
        window?.destroy();
        if (server) await new Promise(resolve => server.close(resolve));
        if (directory) {
            assert.equal(path.dirname(directory), await realpath(os.tmpdir()));
            assert.ok(path.basename(directory).startsWith('branchlight-diff-layout-'));
            await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        }
        app.exit(process.exitCode || 0);
    }
});
