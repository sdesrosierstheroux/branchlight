import assert from 'node:assert/strict';
import { createApp } from '../server.mjs';

const root = process.argv[2];
if (!root) {
    console.error('Usage: node test/smoke.mjs <repository-path>');
    process.exitCode = 1;
} else {
    const { server, token } = await createApp(root);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const headers = { 'X-Branchlight-Token': token };
    async function get(route, parameters = {}) {
        const response = await fetch(`${base}/api/${route}?${new URLSearchParams(parameters)}`, { headers });
        assert.equal(response.status, 200, route);
        return response.json();
    }
    try {
        const status = await get('status');
        const history = await get('history', { limit: 20 });
        const tree = await get('tree');
        const details = history.commits.length ? await get('commit', { ref: history.commits[0].hash }) : { files: [] };
        const file = status.files.find(file => !file.untracked && file.worktree !== ' ' && !file.conflict);
        let diffLength = null;
        if (file) {
            const patch = await get('diff', { path: file.path });
            diffLength = patch.text.length;
        }
        for (const asset of ['/', '/app.js', '/styles.css', '/desktop.css', '/graph.mjs', '/refs.mjs']) {
            assert.equal((await fetch(base + asset)).status, 200, asset);
        }
        console.log(JSON.stringify({
            repository: status.name, branch: status.branch, changedFiles: status.files.length,
            refs: status.refs.length, worktrees: status.worktrees.length, loadedCommits: history.commits.length, rootEntries: tree.length,
            commitFiles: details.files.length, diffCharacters: diffLength, assets: 'all served',
        }, null, 2));
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
}
