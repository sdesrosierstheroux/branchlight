import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as repo from './git.mjs';
import { chooseStartupRepository, discoverRepositories, defaultRepositoryFolder } from './repositories.mjs';
import { inspectWorktreeDeletion, deleteWorktree } from './worktree-actions.mjs';
import { inspectDiscard, discardChanges } from './change-actions.mjs';
import { checkoutBranch, pullBranch } from './branch-actions.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const assets = new Map([
    ['/favicon.ico', ['favicon.ico', 'image/x-icon']],
    ['/', ['index.html', 'text/html; charset=utf-8']],
    ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
    ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
    ['/desktop.css', ['desktop.css', 'text/css; charset=utf-8']],
    ['/resize.js', ['resize.js', 'text/javascript; charset=utf-8']],
    ['/layout.mjs', ['../layout.mjs', 'text/javascript; charset=utf-8']],
    ['/graph.mjs', ['../graph.mjs', 'text/javascript; charset=utf-8']],
    ['/refs.mjs', ['../refs.mjs', 'text/javascript; charset=utf-8']],
]);

export async function createApp(initialRepository, options = {}) {
    const version = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8')).version;
    let root = initialRepository ? await repo.repository(initialRepository) : null;
    const repositoryFolder = options.repositoryFolder || defaultRepositoryFolder;
    let changing = false;
    let pendingDeletion = null;
    let pendingDiscard = null;
    const token = randomBytes(32).toString('hex');
    const server = http.createServer(async (request, response) => {
        const origin = `http://127.0.0.1:${server.address().port}`;
        const headers = {
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
            'Referrer-Policy': 'no-referrer',
            'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; frame-src 'none'",
            'Cross-Origin-Resource-Policy': 'same-origin',
        };
        const send = (status, body, type = 'application/json; charset=utf-8') => {
            response.writeHead(status, { ...headers, 'Content-Type': type });
            response.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
        };
        if (request.headers.host !== `127.0.0.1:${server.address().port}` ||
            (request.headers.origin && request.headers.origin !== origin) ||
            request.headers['sec-fetch-site'] === 'cross-site') {
            send(403, { error: 'Only this local application can access the repository.' });
            return;
        }
        const url = new URL(request.url, origin);
        try {
            if (assets.has(url.pathname) && request.method === 'GET') {
                const [file, type] = assets.get(url.pathname);
                let contents = await readFile(path.join(directory, 'public', file));
                if (file === 'index.html') contents = contents.toString('utf8').replaceAll('{{APP_VERSION}}', version);
                send(200, contents, type);
                return;
            }
            const provided = Buffer.from(request.headers['x-branchlight-token'] || '');
            const expected = Buffer.from(token);
            if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
                send(401, { error: 'Open the launch link printed by Branchlight to connect.' });
                return;
            }
            if (['/api/branches/checkout', '/api/branches/pull', '/api/open', '/api/worktrees/delete-preview', '/api/worktrees/delete', '/api/changes/discard-preview', '/api/changes/discard'].includes(url.pathname) && request.method === 'POST') {
                if (changing) { send(409, { error: 'Another repository operation is in progress.' }); return; }
                changing = true;
                try {
                    let body = '';
                    for await (const chunk of request) {
                        body += chunk;
                        if (body.length > 16384) { send(413, { error: 'The request is too large.' }); return; }
                    }
                    const input = JSON.parse(body);
                    if (!input || typeof input !== 'object') throw new Error('Invalid repository request.');
                    if (url.pathname === '/api/open') {
                        if (typeof input.path !== 'string' || !input.path.trim()) throw new Error('Enter the full path to a local repository.');
                        const nextRoot = await repo.repository(input.path);
                        const result = await repo.status(nextRoot);
                        root = nextRoot;
                        pendingDeletion = null;
                        pendingDiscard = null;
                        await options.onRepositoryOpened?.(nextRoot);
                        send(200, result);
                    } else {
                        if (!root || input.root !== root) throw new Error('The selected repository changed. Refresh and try again.');
                        if (url.pathname === '/api/branches/checkout' || url.pathname === '/api/branches/pull') {
                            pendingDiscard = null;
                            pendingDeletion = null;
                            const action = url.pathname === '/api/branches/checkout' ? checkoutBranch : pullBranch;
                            send(200, await action(root, input));
                        } else if (url.pathname === '/api/changes/discard-preview') {
                            pendingDiscard = null;
                            pendingDeletion = null;
                            const plan = await inspectDiscard(root, input);
                            const branchLabel = plan.head ? plan.branch.replace(/^refs\/heads\//, '') || 'Detached HEAD' : 'No commits yet';
                            if (input.head !== plan.head || input.branch !== (plan.branch ? plan.branch.slice('refs/heads/'.length) : branchLabel)) {
                                throw new Error('The branch changed. Refresh and review the files again.');
                            }
                            const confirmation = randomBytes(24).toString('hex');
                            pendingDiscard = { plan, confirmation, expires: Date.now() + 5 * 60 * 1000 };
                            send(200, { root, confirmation, files: plan.snapshots.map(file => ({ path: file.path, deleted: plan.deletedFiles.includes(file.path) })) });
                        } else if (url.pathname === '/api/changes/discard') {
                            if (!pendingDiscard || pendingDiscard.confirmation !== input.confirmation || pendingDiscard.expires < Date.now()) {
                                throw new Error('Open a new discard confirmation and review the files first.');
                            }
                            const plan = pendingDiscard.plan;
                            pendingDiscard = null;
                            pendingDeletion = null;
                            send(200, await discardChanges(plan));
                        } else if (url.pathname === '/api/worktrees/delete-preview') {
                            pendingDiscard = null;
                            pendingDeletion = null;
                            const plan = await inspectWorktreeDeletion(root, input.path);
                            const confirmation = randomBytes(24).toString('hex');
                            pendingDeletion = { plan, confirmation, expires: Date.now() + 5 * 60 * 1000 };
                            send(200, { ...plan, confirmation });
                        } else {
                            if (!pendingDeletion || pendingDeletion.confirmation !== input.confirmation || pendingDeletion.expires < Date.now()) {
                                throw new Error('Open a new deletion confirmation and review the worktree first.');
                            }
                            const plan = pendingDeletion.plan;
                            pendingDeletion = null;
                            const result = await deleteWorktree(plan, input);
                            root = result.root;
                            try { await options.onRepositoryOpened?.(root); }
                            catch { result.warning += ' The operation completed, but the last repository preference could not be saved.'; }
                            send(200, result);
                        }
                    }
                } finally { changing = false; }
                return;
            }
            if (request.method !== 'GET') {
                send(405, { error: 'This operation is not supported.' });
                return;
            }
            const activeRoot = root;
            const parameters = Object.fromEntries(url.searchParams);
            if (!activeRoot && !['/api/repositories', '/api/status', '/api/history', '/api/tree'].includes(url.pathname)) {
                throw new Error('Choose a repository from the repository menu first.');
            }
            let result;
            switch (url.pathname) {
                case '/api/repositories': result = await discoverRepositories(repositoryFolder); break;
                case '/api/status': result = activeRoot ? await repo.status(activeRoot) : { root: '', name: 'No repository', branch: '', head: '', files: [], refs: [], worktrees: [], ahead: 0, behind: 0, repositoryFolder }; break;
                case '/api/history': result = activeRoot ? await repo.history(activeRoot, parameters) : { commits: [], limit: 200, more: false }; break;
                case '/api/tree': result = activeRoot ? await repo.tree(activeRoot, parameters.path || '', parameters.ref || '') : []; break;
                case '/api/file': result = await repo.fileContent(activeRoot, parameters.path, parameters.ref || ''); break;
                case '/api/diff': result = await repo.diff(activeRoot, parameters.path, parameters); break;
                case '/api/commit': result = await repo.commitDetails(activeRoot, parameters.ref); break;
                default: send(404, { error: 'This view was not found.' }); return;
            }
            send(200, result);
        } catch (error) {
            const message = error.code === 'ENOENT' ? 'The file or folder is no longer available.' :
                error.killed ? 'Git took too long to respond. Refresh the repository before trying again.' :
                error.stderr ? String(error.stderr).trim().slice(0, 600) : error.message;
            send(400, { error: message || 'Could not read this repository.' });
        }
    });
    return { server, token };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const args = process.argv.slice(2);
    const root = await chooseStartupRepository({ requested: args.find(value => !value.startsWith('--')) });
    const port = Number(args.find(value => value.startsWith('--port='))?.slice(7) || 48765);
    try {
        const { server, token } = await createApp(root);
        server.on('error', error => {
            console.error(error.code === 'EADDRINUSE' ? `Port ${port} is in use. Launch with --port=48766.` : error.message);
            process.exitCode = 1;
        });
        server.listen(port, '127.0.0.1', () => {
            const url = `http://127.0.0.1:${server.address().port}/#${token}`;
            console.log(`Branchlight is ready\n${url}\nLocal repository access. Press Ctrl+C to stop.`);
            if (args.includes('--open')) {
                const command = process.platform === 'win32' ? 'rundll32.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
                const argumentsList = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
                execFile(command, argumentsList, { windowsHide: true }, error => {
                    if (error) {
                        console.error('Open the link above in your browser.');
                    }
                });
            }
        });
    } catch (error) {
        console.error(`Could not open the repository: ${error.stderr || error.message}`);
        process.exitCode = 1;
    }
}
