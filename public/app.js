import { layoutGraph } from '/graph.mjs';
import { buildRefTree } from '/refs.mjs';
import { initializeResizing } from '/resize.js';

const $ = id => document.getElementById(id);
const state = {
    status: null, view: 'history', ref: '', limit: 200, commits: [], commit: null,
    change: null, treePath: '', diffMode: localStorage.getItem('branchlight-diff') || 'unified',
    busy: false, switching: false, generation: 0, requests: new Map(),
    folderExpansion: new Map(), branchSignature: '', worktreeSignature: '',
};
const token = location.hash.slice(1) || sessionStorage.getItem('branchlight-token') || '';
sessionStorage.setItem('branchlight-token', token);
window.history.replaceState(null, '', location.pathname);

function element(tag, className = '', text = '') {
    const node = document.createElement(tag);
    node.className = className;
    node.textContent = text;
    return node;
}

async function api(route, parameters = {}, body) {
    const query = new URLSearchParams(parameters);
    const response = await fetch(`/api/${route}${query.size ? `?${query}` : ''}`, {
        method: body ? 'POST' : 'GET',
        headers: { 'X-Branchlight-Token': token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const result = await response.json();
    if (!response.ok) {
        throw new Error(result.error || 'Could not load the repository.');
    }
    return result;
}

function ticket(key) {
    const version = (state.requests.get(key) || 0) + 1;
    state.requests.set(key, version);
    const generation = state.generation;
    return () => state.generation === generation && state.requests.get(key) === version;
}

function showError(error) {
    $('error-banner').textContent = error.message;
    $('error-banner').hidden = false;
    $('status-message').textContent = 'Operation failed · Review the message above';
}

function run(action) {
    Promise.resolve().then(action).catch(showError);
}

function empty(target, title, message, compact = false) {
    const container = element('div', `empty-state${compact ? ' compact' : ''}`);
    container.append(element('span', 'empty-symbol', '⌁'));
    if (title) {
        container.append(element('h2', '', title));
    }
    container.append(element('p', '', message));
    target.replaceChildren(container);
}

function setView(view) {
    state.view = view;
    const titles = {
        history: ['Commit graph', 'Follow the branches. See how everything connects.'],
        changes: ['Working changes', 'A clear picture of what changed, one file at a time.'],
        files: ['Repository files', 'Explore the files behind your work.'],
    };
    for (const name of Object.keys(titles)) {
        $(`${name}-view`).hidden = name !== view;
    }
    for (const button of document.querySelectorAll('[data-view]')) {
        button.classList.toggle('active', button.dataset.view === view);
    }
    $('page-title').textContent = titles[view][0];
    $('view-name').textContent = titles[view][0];
    $('page-description').textContent = titles[view][1];
    if (view === 'files') {
        run(loadTree);
    } else if (view === 'changes' && !state.change) {
        const file = state.status?.files[0];
        if (file) {
            run(() => selectChange(file, file.untracked ? 'untracked' : file.worktree !== ' ' ? 'worktree' : 'index'));
        }
    }
}

function renderSyncStatus() {
    const data = state.status;
    const current = data?.refs.find(ref => ref.current);
    const indicator = $('toolbar-sync');
    indicator.hidden = !data?.root || !current;
    if (indicator.hidden) return;
    let label;
    let description;
    if (!current.upstream) {
        label = 'No upstream';
        description = 'This branch has no tracking upstream. Configure one in Git to compare commits.';
    } else if (!data.trackingAvailable) {
        label = 'Upstream unavailable';
        description = 'Cannot compare with ' + current.upstream + '. Fetch in your Git tool and refresh to update the remote tracking branch.';
    } else {
        label = data.behind + ' behind' + (data.ahead ? ' · ' + data.ahead + ' ahead' : '');
        const commits = count => count + (count === 1 ? ' commit' : ' commits');
        description = commits(data.behind) + ' behind and ' + commits(data.ahead) + ' ahead of ' + current.upstream + '. Based on the last fetched remote state; Pull or fetch in your Git tool to update it.';
    }
    if (indicator.textContent !== label) indicator.textContent = label;
    indicator.title = description;
    indicator.setAttribute('aria-label', description);
    indicator.classList.toggle('is-behind', Boolean(data.trackingAvailable && data.behind));
}

function renderStatus(data) {
    state.status = data;
    $('repo-name').textContent = data.name;
    $('repo-path').textContent = data.root;
    $('repo-path').title = data.root;
    $('breadcrumb-repo').textContent = data.name;
    $('tab-name').textContent = data.name;
    $('repository-tab').title = data.root;
    $('toolbar-branch-name').textContent = data.branch;
    $('toolbar-branch-name').title = data.branch;
    $('working-branch-name').textContent = data.branch;
    $('working-count').textContent = data.files.length;
    $('wip-summary').textContent = data.files.length ? `${data.files.length} changed files in working directory` : 'Working directory is clean';
    $('current-branch').textContent = data.branch;
    $('current-branch').title = data.branch;
    $('sync-counts').textContent = data.ahead || data.behind ? `↑${data.ahead} ↓${data.behind}` : '';
    renderSyncStatus();
    $('change-count').textContent = data.files.length;
    $('changes-total').textContent = data.files.length;
    $('branch-count').textContent = data.refs.filter(ref => ref.name.startsWith('refs/heads/')).length;
    document.title = `${data.name} · Branchlight`;
    renderBranchActions();
    renderBranches();
    renderWorktrees();
    renderChanges();
    renderWorkingInspector();
    for (const button of document.querySelectorAll('[data-discard-all]')) button.disabled = !data.files.length || state.switching;
    $('status-message').textContent = `Updated ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · Local repository`;
}

function renderBranches() {
    const query = $('branch-search').value.toLowerCase();
    const signature = JSON.stringify([state.status?.root, query, state.ref, state.switching, state.status?.worktrees, state.status?.refs.map(ref => [ref.name, ref.current, ref.symbolic])]);
    if (signature === state.branchSignature) {
        return;
    }
    state.branchSignature = signature;
    const container = $('branches');
    container.replaceChildren();
    for (const [label, prefix] of [['LOCAL', 'refs/heads/'], ['REMOTES', 'refs/remotes/'], ['TAGS', 'refs/tags/']]) {
        const refs = (state.status?.refs || []).filter(ref => ref.name.startsWith(prefix) && ref.name.toLowerCase().includes(query));
        if (!refs.length) {
            continue;
        }
        const group = element('details', 'ref-group');
        group.append(element('summary', 'branch-group', `${label}  ${refs.length}`));
        const children = element('div');
        group.append(children);
        group.open = Boolean(query) || state.ref.startsWith(prefix) || (state.folderExpansion.get(prefix) ?? label === 'LOCAL');
        const populate = () => {
            if (group.open && !children.childElementCount) {
                appendRefTree(children, buildRefTree(refs, prefix), label === 'TAGS', query);
            }
        };
        populate();
        group.addEventListener('toggle', () => {
            if (!query) {
                state.folderExpansion.set(prefix, group.open);
            }
            populate();
        });
        container.append(group);
    }
    if (!container.childElementCount) {
        container.append(element('div', 'empty-inline', 'No matching branches or tags.'));
    }
    $('all-branches').classList.toggle('selected', !state.ref);
    $('all-branches').setAttribute('aria-pressed', !state.ref);
    const name = state.ref.replace(/^refs\/(heads|remotes|tags)\//, '');
    $('history-scope').textContent = name || 'All branches';
    $('history-scope').title = name ? `History reachable from ${name}, including shared ancestors` : 'History across all local and remote branches';
    $('solo-indicator').hidden = !state.ref;
    $('exit-solo').hidden = !state.ref;
}

function appendRefTree(container, tree, tags, query) {
    const currentRef = state.status?.refs.find(ref => ref.current)?.name || '';
    const folders = [...tree.folders.values()].sort((a, b) => a.name.localeCompare(b.name));
    for (const folder of folders) {
        const details = element('details', 'branch-folder');
        const summary = element('summary');
        summary.title = folder.key.replace(/^refs\/(heads|remotes|tags)\//, '');
        summary.append(element('span', 'folder-symbol', '▱'), element('span', 'folder-name', folder.name), element('span', 'folder-count', folder.count));
        const children = element('div', 'branch-folder-children');
        details.append(summary, children);
        details.open = Boolean(query) || (state.folderExpansion.get(folder.key) ?? (currentRef.startsWith(folder.key) || state.ref.startsWith(folder.key)));
        const populate = () => {
            if (details.open && !children.childElementCount) {
                appendRefTree(children, folder, tags, query);
            }
        };
        populate();
        details.addEventListener('toggle', () => {
            if (!query) {
                state.folderExpansion.set(folder.key, details.open);
            }
            populate();
        });
        container.append(details);
    }
    const refs = tree.refs.sort((a, b) => a.displayName.localeCompare(b.displayName));
    let shown = 0;
    const more = element('button', 'text-button branch-folder-more');
    const appendBatch = () => {
        more.remove();
        // Keep a selected branch visible even when it falls beyond the first page.
        const end = Math.min(refs.length, Math.max(shown + 150, refs.findIndex(ref => ref.name === state.ref) + 1));
        for (const ref of refs.slice(shown, end)) {
            const selected = state.ref === ref.name;
            const row = element('div', `branch-row${selected ? ' selected' : ''}`);
            const button = element('button', 'branch-item');
            button.dataset.ref = ref.name;
            button.title = `${ref.name.replace(/^refs\/(heads|remotes|tags)\//, '')}${ref.current ? ' (current branch)' : ''}`;
            button.append(element('span', 'branch-symbol', tags ? '◇' : '⑂'), element('span', '', ref.displayName));
            if (ref.current) {
                button.append(element('span', 'head-dot'));
            }
            button.addEventListener('click', () => run(() => selectBranch(ref.name)));
            button.setAttribute('aria-pressed', selected);
            const solo = element('button', 'solo-button', 'Solo');
            solo.title = selected ? 'Exit solo and show all branches' : `Solo ${button.title}`;
            solo.setAttribute('aria-label', `${selected ? 'Unsolo' : 'Solo'} ${ref.name.replace(/^refs\/(heads|remotes|tags)\//, '')}`);
            solo.setAttribute('aria-pressed', selected);
            solo.addEventListener('click', () => run(() => selectBranch(selected ? '' : ref.name)));
            row.append(button, solo);
            if (!tags && !ref.symbolic) {
                const checkout = element('button', 'checkout-button', ref.current ? 'Current' : 'Checkout');
                const occupied = state.status.worktrees.some(worktree => !worktree.current && worktree.branch === ref.name);
                checkout.disabled = state.switching || ref.current || occupied;
                checkout.title = occupied ? 'This branch is checked out in another worktree; open that worktree instead' : `Check out ${button.title} in ${state.status.root}`;
                checkout.setAttribute('aria-label', `Check out ${ref.name.replace(/^refs\/(heads|remotes)\//, '')}`);
                checkout.addEventListener('click', () => run(() => branchAction('checkout', ref.name)));
                row.append(checkout);
            }
            container.append(row);
        }
        shown = end;
        if (shown < refs.length) {
            more.textContent = `Show more (${refs.length - shown} remaining)`;
            container.append(more);
        }
    };
    more.addEventListener('click', appendBatch);
    appendBatch();
}

function renderWorktrees() {
    const entries = state.status?.worktrees || [];
    const signature = JSON.stringify([state.status?.root, state.switching, entries]);
    if (signature === state.worktreeSignature) {
        return;
    }
    state.worktreeSignature = signature;
    $('worktree-count').textContent = entries.length;
    const container = $('worktrees');
    container.replaceChildren();
    for (const worktree of entries) {
        const branch = worktree.bare ? 'Bare repository' : worktree.detached ? `Detached · ${worktree.head.slice(0, 7)}` : worktree.branch.replace(/^refs\/heads\//, '') || 'No commits yet';
        const button = element('button', `worktree-item${worktree.current ? ' current' : ''}`);
        button.title = [worktree.path, branch, worktree.locked ? `Locked${worktree.lockedReason ? `: ${worktree.lockedReason}` : ''}` : '', worktree.prunableReason || ''].filter(Boolean).join('\n');
        button.setAttribute('aria-current', worktree.current ? 'true' : 'false');
        button.disabled = !worktree.available || state.switching;
        const text = element('span', 'worktree-text');
        text.append(element('span', 'worktree-name', worktree.name), element('span', 'worktree-branch', branch));
        const badge = worktree.current ? 'Current' : !worktree.available ? 'Unavailable' : worktree.locked ? 'Locked' : worktree.main ? 'Main' : '';
        button.append(element('span', 'worktree-symbol', '⑂'), text, element('span', 'worktree-state', badge));
        button.addEventListener('click', () => {
            run(() => openRepository(worktree.path, state.view, true));
        });
        const row = element('div', 'worktree-row');
        row.append(button);
        if (!worktree.main && !worktree.bare) {
            const remove = element('button', 'worktree-delete', 'Delete');
            remove.setAttribute('aria-label', 'Delete worktree ' + worktree.name);
            remove.title = worktree.locked ? 'Unlock this worktree before deleting it' : worktree.available ? 'Delete worktree and its local branch…' : 'Review removal of this unavailable worktree and its local branch…';
            remove.disabled = state.switching || worktree.locked;
            remove.addEventListener('click', () => run(() => showWorktreeDeletion(worktree)));
            row.append(remove);
        }
        container.append(row);
    }
}

function revealBranch(ref, focus = false) {
    if (!state.status?.refs.some(branch => branch.name === ref)) return;
    const prefix = ['refs/heads/', 'refs/remotes/', 'refs/tags/'].find(prefix => ref.startsWith(prefix));
    if (!prefix) return;
    $('branch-search').value = '';
    let key = prefix;
    state.folderExpansion.set(key, true);
    for (const segment of ref.slice(prefix.length).split('/').slice(0, -1)) {
        key += `${segment}/`;
        state.folderExpansion.set(key, true);
    }
    // Expansion preferences are deliberately excluded from the ordinary render signature.
    state.branchSignature = '';
    renderBranches();
    const button = [...$('branches').querySelectorAll('.branch-item')].find(button => button.dataset.ref === ref);
    if (button) {
        button.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        if (focus) button.focus({ preventScroll: true });
    }
}

async function selectBranch(ref, reveal = false) {
    if (state.switching) {
        return;
    }
    state.ref = ref;
    state.limit = 200;
    $('history-search').value = '';
    $('history-diff').hidden = true;
    $('error-banner').hidden = true;
    renderBranches();
    if (reveal) revealBranch(ref, true);
    setView('history');
    await loadHistory();
}

function graphSvg(row, width) {
    const ns = 'http://www.w3.org/2000/svg';
    const colors = ['#7ce4ba', '#aa97ed', '#67adea', '#e5b777', '#df88b0', '#69c9cf'];
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('xmlns', ns);
    svg.setAttribute('width', width * 12 + 16);
    svg.setAttribute('height', 22);
    svg.setAttribute('viewBox', `0 0 ${width * 12 + 16} 22`);
    svg.setAttribute('aria-hidden', 'true');
    const x = lane => lane * 12 + 12;
    const line = (d, color) => {
        const shape = document.createElementNS(ns, 'path');
        shape.setAttribute('d', d);
        shape.setAttribute('stroke', colors[color]);
        shape.setAttribute('stroke-width', 1.8);
        shape.setAttribute('fill', 'none');
        svg.append(shape);
    };
    if (row.incoming) {
        line(`M${x(row.lane)} 0 V11`, row.color);
    }
    for (const edge of row.edges) {
        const y = edge.fromNode ? 11 : 0;
        line(`M${x(edge.from)} ${y} C${x(edge.from)} 16 ${x(edge.to)} 16 ${x(edge.to)} 22`, edge.color);
    }
    const circle = document.createElementNS(ns, 'circle');
    circle.setAttribute('cx', x(row.lane));
    circle.setAttribute('cy', 11);
    circle.setAttribute('r', 3);
    circle.setAttribute('stroke', colors[row.color]);
    circle.setAttribute('stroke-width', 2.2);
    circle.setAttribute('fill', '#1e212a');
    svg.append(circle);
    return svg;
}

function relativeDate(date) {
    const days = Math.floor((Date.now() - new Date(date).getTime()) / 86400000);
    return days < 0 ? new Date(date).toLocaleDateString() : days === 0 ? 'Today' : days === 1 ? 'Yesterday' :
        days < 7 ? `${days} days ago` : new Date(date).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

async function loadHistory() {
    const current = ticket('history');
    $('history-note').textContent = 'Reading repository history…';
    const data = await api('history', { ref: state.ref, limit: state.limit });
    if (!current()) {
        return;
    }
    state.commits = data.commits;
    const graph = layoutGraph(data.commits);
    const fragment = document.createDocumentFragment();
    for (let index = 0; index < data.commits.length; index++) {
        const commit = data.commits[index];
        const row = element('tr');
        row.dataset.hash = commit.hash;
        row.tabIndex = 0;
        row.setAttribute('aria-label', `${commit.subject}, ${commit.author}, ${commit.hash.slice(0, 7)}`);
        const graphCell = element('td', 'graph-cell');
        graphCell.append(graphSvg(graph.rows[index], graph.width));
        const message = element('td');
        if (commit.refs) {
            const labels = commit.refs.split(', ');
            const soloName = state.ref.replace(/^refs\/(heads|remotes|tags)\//, '');
            labels.sort((a, b) => Number(b.replace('HEAD -> ', '') === soloName) - Number(a.replace('HEAD -> ', '') === soloName));
            for (const ref of labels.slice(0, 2)) {
                const label = ref.replace('HEAD -> ', '');
                const chip = element('span', `ref-chip${label.startsWith('origin/') ? ' remote' : ''}`, label);
                chip.title = commit.refs;
                message.append(chip);
            }
        }
        message.append(document.createTextNode(commit.subject));
        message.title = commit.subject;
        const date = element('td', '', relativeDate(commit.date));
        date.title = new Date(commit.date).toLocaleString();
        row.append(graphCell, message, element('td', '', commit.author), date, element('td', '', commit.hash.slice(0, 7)));
        row.addEventListener('click', () => run(() => selectCommit(commit)));
        row.addEventListener('keydown', event => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                run(() => selectCommit(commit));
            } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                const sibling = event.key === 'ArrowDown' ? row.nextElementSibling : row.previousElementSibling;
                sibling?.focus();
            }
        });
        fragment.append(row);
    }
    const previousTable = document.querySelector('.history-table');
    const table = previousTable.cloneNode(false);
    const heading = previousTable.tHead.cloneNode(true);
    heading.querySelector('th:first-child').setAttribute('width', graph.width * 12 + 26);
    const commits = element('tbody');
    commits.id = 'commits';
    commits.append(fragment);
    table.append(heading, commits);
    previousTable.replaceWith(table);
    $('history-empty').hidden = data.commits.length > 0;
    $('history-count').textContent = data.commits.length;
    $('history-scope').textContent = state.ref.replace(/^refs\/(heads|remotes|tags)\//, '') || 'All branches';
    $('load-more').hidden = !data.more || state.limit >= 1000;
    $('history-note').textContent = `Showing ${data.commits.length} commits${data.more ? ' · Latest history' : ''} · Local refs`;
    filterHistory();
    const selected = state.commit ? data.commits.find(commit => commit.hash === state.commit.hash) || data.commits[0] : null;
    if (selected) {
        await selectCommit(selected);
    } else {
        state.commit = null;
        $('history-view').classList.remove('has-selection');
        $('commit-inspector').hidden = true;
        $('working-inspector').hidden = false;
        $('history-diff').hidden = true;
        $('commit-title').textContent = 'No commit selected';
        $('commit-meta').textContent = 'Create a commit in your preferred editor to start your history.';
        $('commit-description').hidden = true;
        $('commit-files').replaceChildren();
        empty($('commit-preview'), '', 'No commit to preview.', true);
    }
}

function filterHistory() {
    const query = $('history-search').value.toLowerCase();
    const rows = $('commits').children;
    let matches = 0;
    state.commits.forEach((commit, index) => {
        const match = `${commit.subject} ${commit.author} ${commit.hash} ${commit.refs}`.toLowerCase().includes(query);
        rows[index]?.classList.toggle('dimmed', !match);
        matches += Number(match);
    });
    if (query) {
        $('history-note').textContent = `${matches} matches in ${state.commits.length} loaded commits · Nonmatching rows dimmed to preserve the graph`;
    } else {
        $('history-note').textContent = `Showing ${state.commits.length} commits · ${state.ref ? 'Solo history · Includes shared ancestors' : 'All branches'}`;
    }
}

function fileRow(file, status, selected = false) {
    const button = element('button', `file-row${selected ? ' selected' : ''}`);
    const conflict = file.conflict || status === 'U';
    const className = ['A', '?'].includes(status) ? ' added' : status === 'D' ? ' deleted' : conflict ? ' conflict' : '';
    button.append(element('span', `file-status${className}`, conflict ? '!' : status || 'M'));
    const text = element('span', 'file-row-text');
    const slash = file.path.lastIndexOf('/');
    text.append(element('span', 'file-name', file.path.slice(slash + 1)));
    if (slash >= 0) {
        text.append(element('span', 'file-directory', file.path.slice(0, slash)));
    }
    button.append(text);
    button.title = file.previousPath ? `${file.previousPath} → ${file.path}` : file.path;
    return button;
}

async function selectCommit(commit) {
    const current = ticket('commit');
    ticket('commit-preview');
    state.commit = commit;
    $('history-view').classList.add('has-selection');
    $('commit-inspector').hidden = false;
    $('working-inspector').hidden = true;
    $('history-diff').hidden = true;
    for (const row of $('commits').children) {
        row.classList.toggle('selected', row.dataset.hash === commit.hash);
        row.setAttribute('aria-selected', row.dataset.hash === commit.hash);
    }
    $('commit-title').textContent = commit.subject;
    $('commit-title').title = commit.subject;
    const copy = element('button', '', commit.hash.slice(0, 10));
    copy.title = 'Copy commit hash';
    copy.addEventListener('click', () => run(async () => {
        if (window.branchlightDesktop) {
            if (!await window.branchlightDesktop.copyCommitHash(commit.hash)) {
                return;
            }
        } else {
            await navigator.clipboard.writeText(commit.hash);
        }
        copy.textContent = 'Copied';
        setTimeout(() => { copy.textContent = commit.hash.slice(0, 10); }, 1500);
    }));
    $('commit-meta').replaceChildren(element('span', '', commit.author), element('span', '', new Date(commit.date).toLocaleString()), copy);
    $('commit-description').hidden = true;
    $('commit-files').replaceChildren(element('div', 'empty-inline', 'Loading changed files…'));
    empty($('commit-preview'), '', 'Loading commit…', true);
    const details = await api('commit', { ref: commit.hash });
    if (!current()) {
        return;
    }
    const body = details.description.split('\n').slice(1).join('\n').trim();
    $('commit-description').textContent = body;
    $('commit-description').hidden = true;
    if (body) {
        const toggle = element('button', '', 'Full message ▾');
        toggle.addEventListener('click', () => {
            $('commit-description').hidden = !$('commit-description').hidden;
            toggle.textContent = $('commit-description').hidden ? 'Full message ▾' : 'Hide message ▴';
        });
        $('commit-meta').append(toggle);
    }
    const title = element('div', 'file-group-title', `${details.files.length} changed files${commit.parents.length > 1 ? ' · first parent' : ''}`);
    $('commit-files').replaceChildren(title);
    for (const file of details.files) {
        const button = fileRow(file, file.status);
        button.addEventListener('click', () => {
            $('history-diff').hidden = false;
            for (const sibling of $('commit-files').querySelectorAll('.file-row')) {
                sibling.classList.toggle('selected', sibling === button);
            }
            run(() => loadDiff($('commit-preview'), file, { ref: commit.hash }));
        });
        $('commit-files').append(button);
    }
    if (!details.files.length) {
        empty($('commit-preview'), '', 'This commit has no file changes.', true);
    }
}

function discardButton(scope, file) {
    const button = element('button', 'discard-button', file ? 'Discard' : 'Discard all');
    button.type = 'button';
    button.disabled = state.switching || file?.conflict;
    button.title = file ? `Discard ${scope} changes: ${file.path}` : `Discard all ${scope} changes in this checkout`;
    button.setAttribute('aria-label', button.title);
    button.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        run(() => showDiscard(scope, file?.path));
    });
    return button;
}

function changeRow(button, file, stage) {
    const row = element('div', 'change-row');
    row.append(button, discardButton(stage === 'index' ? 'staged' : 'unstaged', file));
    return row;
}

let discardPlan = null;
let discarding = false;

async function showDiscard(scope, filePath) {
    if (state.switching || !state.status || document.querySelector('dialog[open]')) return;
    discardPlan = null;
    $('discard-title').textContent = filePath ? 'Discard file changes' : `Discard all ${scope === 'all' ? '' : scope + ' '}changes`;
    $('discard-description').textContent = scope === 'unstaged'
        ? 'Restore tracked files to their staged version and delete selected new files. Staged changes are kept.'
        : 'Restore the selected files to the last commit. Both staged and unstaged edits to these files will be lost, and new files will be deleted.';
    $('discard-root').textContent = state.status.root;
    $('discard-branch').textContent = state.status.branch;
    $('discard-files').replaceChildren(element('li', '', 'Checking files…'));
    $('discard-error').textContent = '';
    $('discard-warning').textContent = 'This cannot be undone in Branchlight.';
    $('confirm-discard').disabled = true;
    $('discard-dialog').showModal();
    $('cancel-discard').focus();
    const current = ticket('discard-preview');
    try {
        const plan = await api('changes/discard-preview', {}, {
            root: state.status.root, head: state.status.head, branch: state.status.branch,
            scope, ...(filePath === undefined ? {} : { path: filePath }),
        });
        if (!current() || !$('discard-dialog').open) return;
        discardPlan = plan;
        $('discard-files').replaceChildren(...plan.files.map(file => element('li', '', `${file.path}${file.deleted ? ' — delete file' : ' — restore'}`)));
        $('discard-warning').textContent = `${plan.files.length} file${plan.files.length === 1 ? '' : 's'} affected. This cannot be undone in Branchlight.`;
        $('confirm-discard').disabled = false;
    } catch (error) {
        if (!current() || !$('discard-dialog').open) return;
        $('discard-files').replaceChildren();
        $('discard-error').textContent = error.message;
    }
}

$('cancel-discard').addEventListener('click', () => $('discard-dialog').close());
$('discard-dialog').addEventListener('cancel', event => { if (discarding) event.preventDefault(); });
$('discard-dialog').addEventListener('close', () => { discardPlan = null; ticket('discard-preview'); });
$('discard-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (!discardPlan || discarding || $('confirm-discard').disabled) return;
    discarding = true;
    state.switching = true;
    state.generation++;
    $('confirm-discard').disabled = true;
    $('confirm-discard').textContent = 'Discarding…';
    $('cancel-discard').disabled = true;
    renderBranchActions();
    renderBranches();
    renderWorktrees();
    try {
        const result = await api('changes/discard', {}, { root: discardPlan.root, confirmation: discardPlan.confirmation });
        $('discard-dialog').close();
        state.change = null;
        empty($('change-preview'), '', 'Select a changed file.');
        state.switching = false;
        renderStatus(await api('status'));
        if (state.view === 'files') await loadTree();
        $('error-banner').hidden = true;
        $('status-message').textContent = `Discarded changes in ${result.count} file${result.count === 1 ? '' : 's'}`;
    } catch (error) {
        discardPlan = null;
        if ($('discard-dialog').open) $('discard-error').textContent = error.message + ' Close this dialog and review the files again.';
        else showError(error);
    } finally {
        discarding = false;
        state.switching = false;
        $('cancel-discard').disabled = false;
        $('confirm-discard').textContent = 'Discard changes';
        renderBranchActions();
        renderBranches();
        renderWorktrees();
        renderChanges();
        renderWorkingInspector();
    }
});

for (const button of document.querySelectorAll('[data-discard-all]')) {
    button.addEventListener('click', () => run(() => showDiscard('all')));
}


function renderWorkingInspector() {
    const container = $('working-files');
    container.replaceChildren();
    const files = state.status?.files || [];
    const groups = [
        ['Unstaged files', 'worktree', file => file.untracked || file.worktree !== ' '],
        ['Staged files', 'index', file => !file.untracked && file.index !== ' '],
    ];
    for (const [label, stage, matches] of groups) {
        const entries = files.filter(matches);
        const section = element('details', 'working-group');
        section.open = true;
        const heading = element('summary', 'file-group-title', label);
        heading.append(element('span', 'count', entries.length));
        if (entries.length) heading.append(discardButton(stage === 'index' ? 'staged' : 'unstaged'));
        section.append(heading);
        for (const file of entries) {
            const fileStage = file.untracked ? 'untracked' : stage;
            const button = fileRow(file, stage === 'index' ? file.index : file.worktree);
            button.addEventListener('click', () => run(async () => {
                state.change = { ...file, stage: fileStage };
                setView('changes');
                await selectChange(file, fileStage);
            }));
            section.append(changeRow(button, file, stage));
        }
        if (!entries.length) {
            section.append(element('div', 'empty-inline', 'No files'));
        }
        container.append(section);
    }
}

function renderChanges() {
    const query = $('file-search').value.toLowerCase();
    const files = state.status?.files || [];
    const groups = [
        ['Unstaged', 'worktree', file => file.untracked || file.worktree !== ' '],
        ['Staged', 'index', file => !file.untracked && file.index !== ' '],
    ];
    $('changed-files').replaceChildren();
    for (const [label, stage, matches] of groups) {
        const entries = files.filter(file => matches(file) && file.path.toLowerCase().includes(query));
        if (!entries.length) {
            continue;
        }
        const header = element('div', 'file-group-title', label);
        header.append(element('span', 'count', entries.length));
        if (!query) header.append(discardButton(stage === 'index' ? 'staged' : 'unstaged'));
        $('changed-files').append(header);
        for (const file of entries) {
            const fileStage = file.untracked ? 'untracked' : stage;
            const selected = state.change?.path === file.path && state.change?.stage === fileStage;
            const button = fileRow(file, stage === 'index' ? file.index : file.worktree, selected);
            button.addEventListener('click', () => run(() => selectChange(file, fileStage)));
            $('changed-files').append(changeRow(button, file, stage));
        }
    }
    if (!files.length) {
        empty($('changed-files'), 'All clear', 'Your working tree is clean.');
    } else if (!$('changed-files').childElementCount) {
        empty($('changed-files'), 'No matches', 'Try another file name.');
    }
}

async function selectChange(file, stage) {
    state.change = { ...file, stage };
    renderChanges();
    await loadDiff($('change-preview'), file, { stage });
}

function parseDiff(text, untracked) {
    const rows = [];
    let oldLine = 0;
    let newLine = 0;
    let inHunk = false;
    const lines = text.split('\n');
    if (lines.at(-1) === '') {
        lines.pop();
    }
    if (untracked) {
        return lines.map((line, index) => ({ kind: 'addition', old: '', new: index + 1, text: line }));
    }
    for (const line of lines) {
        const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        if (hunk) {
            oldLine = Number(hunk[1]);
            newLine = Number(hunk[2]);
            inHunk = true;
            rows.push({ kind: 'hunk', text: line });
        } else if (inHunk && line.startsWith('+')) {
            rows.push({ kind: 'addition', old: '', new: newLine++, text: line.slice(1) });
        } else if (inHunk && line.startsWith('-')) {
            rows.push({ kind: 'deletion', old: oldLine++, new: '', text: line.slice(1) });
        } else if (inHunk && line.startsWith(' ')) {
            rows.push({ kind: 'context', old: oldLine++, new: newLine++, text: line.slice(1) });
        } else if (line.startsWith('diff --git')) {
            inHunk = false;
        } else if (!line.startsWith('index ') && !line.startsWith('--- ') && !line.startsWith('+++ ')) {
            rows.push({ kind: 'metadata', text: line });
        }
    }
    return rows;
}

function codeCell(text, className = 'code') {
    return element('td', className, String(text ?? ''));
}

function diffTable(rows, split) {
    const table = element('table', `code-table${split ? ' split' : ''}`);
    if (split) {
        // A spanning hunk or metadata row cannot define fixed-layout column widths.
        const columns = element('colgroup');
        for (const className of ['gutter-column', 'code-column', 'gutter-column', 'code-column']) {
            columns.append(element('col', className));
        }
        table.append(columns);
    }
    const body = element('tbody');
    table.append(body);
    function wide(row) {
        const tr = element('tr', row.kind);
        const td = codeCell(row.text);
        td.colSpan = 4;
        tr.append(td);
        body.append(tr);
    }
    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        if (['hunk', 'metadata'].includes(row.kind)) {
            wide(row);
            continue;
        }
        if (!split) {
            const tr = element('tr', row.kind);
            tr.append(codeCell(row.old, 'line-no'), codeCell(row.new, 'line-no'), codeCell(row.kind === 'addition' ? '+' : row.kind === 'deletion' ? '−' : '', 'sign'), codeCell(row.text));
            body.append(tr);
        } else if (row.kind === 'context') {
            const tr = element('tr');
            tr.append(codeCell(row.old, 'line-no'), codeCell(row.text), codeCell(row.new, 'line-no'), codeCell(row.text));
            body.append(tr);
        } else {
            const removed = [];
            const added = [];
            while (i < rows.length && ['addition', 'deletion'].includes(rows[i].kind)) {
                (rows[i].kind === 'deletion' ? removed : added).push(rows[i]);
                i++;
            }
            i--;
            for (let j = 0; j < Math.max(removed.length, added.length); j++) {
                const tr = element('tr');
                tr.append(codeCell(removed[j]?.old, 'line-no'), codeCell(removed[j]?.text, `code${removed[j] ? ' deletion' : ''}`),
                    codeCell(added[j]?.new, 'line-no'), codeCell(added[j]?.text, `code${added[j] ? ' addition' : ''}`));
                body.append(tr);
            }
        }
    }
    return table;
}

function previewHeader(target, file, content, rows = null) {
    const toolbar = element('div', 'preview-toolbar');
    const title = element('div', 'preview-title');
    const name = element('strong', '', file);
    name.title = file;
    title.append(name);
    toolbar.append(title);
    if (rows) {
        const stats = element('span', 'diff-stats');
        stats.append(element('span', 'added-text', `+${rows.filter(row => row.kind === 'addition').length}`),
            document.createTextNode('  '), element('span', 'removed-text', `−${rows.filter(row => row.kind === 'deletion').length}`));
        title.append(stats);
        const segments = element('div', 'segments');
        for (const [mode, label] of [['unified', 'Unified'], ['split', 'Split']]) {
            const button = element('button', state.diffMode === mode ? 'active' : '', label);
            button.addEventListener('click', () => {
                state.diffMode = mode;
                localStorage.setItem('branchlight-diff', mode);
                renderDiff(target, file, content);
            });
            segments.append(button);
        }
        toolbar.append(segments);
    }
    target.replaceChildren(toolbar);
}

function contentMessage(content) {
    return content.tooLarge ? 'This preview is larger than 2 MB. Open the file in your editor to inspect it.' :
        content.binary ? `Binary file · ${new Intl.NumberFormat().format(content.size || 0)} bytes. Text preview is unavailable.` :
        content.message || '';
}

function renderDiff(target, file, content) {
    const message = contentMessage(content);
    const allRows = parseDiff(content.text || '', content.untracked);
    const rows = allRows.slice(0, 12000);
    previewHeader(target, file, content, rows);
    if (message) {
        target.append(element('div', 'preview-message', message));
        return;
    }
    if (!rows.length) {
        empty(target, 'No text changes', content.untracked ? 'This is an empty new file.' : 'This file has no text diff in the selected group.', true);
        return;
    }
    if (allRows.length > rows.length) {
        target.append(element('div', 'preview-message', 'Showing the first 12,000 lines. Counts reflect this preview.'));
    }
    const scroll = element('div', 'code-scroll');
    scroll.append(diffTable(rows, state.diffMode === 'split'));
    target.append(scroll);
}

async function loadDiff(target, file, options) {
    const current = ticket(target.id);
    empty(target, '', 'Loading diff…', true);
    try {
        const content = await api('diff', { path: file.path, previousPath: file.previousPath || '', ...options });
        if (current()) {
            renderDiff(target, file.path, content);
        }
    } catch (error) {
        if (current()) {
            empty(target, 'Preview unavailable', error.message, true);
        }
    }
}

async function loadTree() {
    const current = ticket('tree');
    $('tree-path').textContent = `/${state.treePath}`;
    $('tree-up').disabled = !state.treePath;
    $('tree-list').replaceChildren(element('div', 'empty-inline', 'Loading files…'));
    const entries = await api('tree', { path: state.treePath });
    if (!current()) {
        return;
    }
    $('tree-list').replaceChildren();
    for (const entry of entries) {
        const button = element('button', 'file-row');
        button.append(element('span', entry.directory ? 'folder-icon' : 'file-icon', entry.directory ? '▱' : '≡'), element('span', 'file-name', entry.name));
        button.title = entry.path;
        button.addEventListener('click', () => run(async () => {
            if (entry.directory) {
                state.treePath = entry.path;
                await loadTree();
            } else {
                for (const sibling of $('tree-list').children) {
                    sibling.classList.toggle('selected', sibling === button);
                }
                await loadFile(entry.path);
            }
        }));
        $('tree-list').append(button);
    }
    if (!entries.length) {
        empty($('tree-list'), '', 'This folder has no visible files.', true);
    }
}

async function loadFile(file) {
    const current = ticket('file-preview');
    const target = $('file-preview');
    empty(target, '', 'Loading file…', true);
    try {
        const content = await api('file', { path: file });
        if (!current()) {
            return;
        }
        previewHeader(target, file, content);
        const message = contentMessage(content);
        if (message) {
            target.append(element('div', 'preview-message', message));
            return;
        }
        const lines = content.text.split('\n');
        if (lines.length > 12000) {
            target.append(element('div', 'preview-message', 'Showing the first 12,000 lines.'));
        }
        const table = element('table', 'code-table');
        const body = element('tbody');
        lines.slice(0, 12000).forEach((text, index) => {
            const row = element('tr');
            row.append(codeCell(index + 1, 'line-no'), codeCell(text));
            body.append(row);
        });
        table.append(body);
        const scroll = element('div', 'code-scroll');
        scroll.append(table);
        target.append(scroll);
    } catch (error) {
        if (current()) {
            empty(target, 'Preview unavailable', error.message, true);
        }
    }
}

function renderBranchActions() {
    const current = state.status?.refs.find(ref => ref.current);
    $('toolbar-reveal-branch').disabled = state.switching || !current;
    $('toolbar-reveal-branch').title = current ? `Select ${state.status.branch} in the branch tree` : 'No branch is checked out';
    $('toolbar-pull').disabled = state.switching || !current?.upstream;
    $('toolbar-pull').title = state.switching ? 'A repository operation is in progress' : current?.upstream
        ? `Pull ${state.status.branch} from ${current.upstream} (fast-forward only)`
        : 'Check out a branch with a tracking upstream to pull';
}

async function branchAction(action, ref) {
    if (state.switching || !state.status?.root || document.querySelector('dialog[open]')) return;
    const snapshot = state.status;
    state.switching = true;
    state.generation++;
    $('error-banner').hidden = true;
    $('pull-label').textContent = action === 'pull' ? 'Pulling…' : 'Pull';
    const label = action === 'pull' ? `Pulling ${snapshot.branch}` : `Checking out ${ref.replace(/^refs\/(heads|remotes)\//, '')}`;
    const started = Date.now();
    let phase = label;
    const updateProgress = () => {
        const seconds = Math.floor((Date.now() - started) / 1000);
        $('status-message').textContent = `${phase}…${seconds ? ` · ${seconds}s elapsed` : ''}${seconds >= 10 && phase === label ? ' · Git is still running; large checkouts or hooks can take several minutes.' : ''}`;
    };
    updateProgress();
    renderBranchActions();
    renderBranches();
    renderWorktrees();
    const progress = setInterval(updateProgress, 1000);
    let result;
    let failure;
    try {
        result = await api(`branches/${action}`, {}, { root: snapshot.root, head: snapshot.head, branch: snapshot.branch, ...(ref ? { ref } : {}) });
    } catch (error) {
        failure = error;
    }
    try {
        phase = failure ? 'Checking repository after the error' : 'Refreshing repository view';
        updateProgress();
        state.generation++;
        const data = await api('status');
        if (action === 'checkout' && (!failure || data.branch !== snapshot.branch || data.head !== snapshot.head)) {
            state.ref = data.refs.find(ref => ref.current)?.name || '';
            state.limit = 200;
            $('history-search').value = '';
            $('branch-search').value = '';
        }
        state.commit = null;
        state.change = null;
        state.treePath = '';
        $('history-view').classList.remove('has-selection');
        $('commit-inspector').hidden = true;
        $('working-inspector').hidden = false;
        $('history-diff').hidden = true;
        empty($('change-preview'), '', 'Select a changed file.');
        empty($('file-preview'), '', 'Select a file to preview.');
        renderStatus(data);
        await loadHistory();
        if (state.view === 'files') await loadTree();
        if (!failure) $('status-message').textContent = action === 'checkout' ? `Checked out ${data.branch}` :
            result.updated ? `Pulled ${data.branch}` : `${data.branch} is already up to date`;
    } catch (error) {
        failure ||= new Error(`The operation ${result ? 'completed' : 'failed'}, but the view could not refresh. ${error.message}`);
    } finally {
        clearInterval(progress);
        state.switching = false;
        $('pull-label').textContent = 'Pull';
        renderBranchActions();
        renderBranches();
        renderWorktrees();
    }
    if (failure) showError(failure);
}

async function refresh(full = true) {
    if (state.busy || state.switching || document.querySelector('dialog[open]')) {
        return;
    }
    state.busy = true;
    $('refresh').disabled = true;
    try {
        const current = ticket('status');
        const data = await api('status');
        if (!current()) {
            return;
        }
        renderStatus(data);
        $('error-banner').hidden = true;
        if (!data.root) {
            $('error-banner').textContent = `No repository is open. Use the repository menu to choose a project in ${data.repositoryFolder} or scan again.`;
            $('error-banner').hidden = false;
        }
        if (full) {
            await loadHistory();
        }
        if (state.change && state.view === 'changes') {
            const file = data.files.find(file => file.path === state.change.path);
            if (file) {
                await selectChange(file, state.change.stage);
            } else {
                state.change = null;
                empty($('change-preview'), 'Up to date', 'This file no longer has changes.');
            }
        }
        if (full && state.view === 'files') {
            await loadTree();
        }
    } finally {
        state.busy = false;
        $('refresh').disabled = false;
    }
}

async function openRepository(input, view = 'history', focusBranch = false) {
    if (state.switching) {
        return;
    }
    state.switching = true;
    state.generation++;
    $('refresh').disabled = true;
    renderBranchActions();
    renderBranches();
    renderWorktrees();
    let branchToReveal = '';
    try {
        const data = await api('open', {}, { path: input });
        state.generation++;
        state.ref = focusBranch ? data.refs.find(ref => ref.current)?.name || data.head : '';
        branchToReveal = focusBranch ? state.ref : '';
        state.limit = 200;
        state.commit = null;
        state.change = null;
        state.treePath = '';
        state.folderExpansion.clear();
        $('history-search').value = '';
        $('branch-search').value = '';
        $('file-search').value = '';
        $('history-view').classList.remove('has-selection');
        $('commit-inspector').hidden = true;
        $('working-inspector').hidden = false;
        $('history-diff').hidden = true;
        empty($('change-preview'), '', 'Select a changed file.');
        empty($('file-preview'), '', 'Select a file to preview.');
        renderStatus(data);
        $('error-banner').hidden = true;
        if ($('repository-dialog').open) {
            $('repository-dialog').close();
        }
        setView(view);
        await loadHistory();
    } finally {
        state.switching = false;
        $('refresh').disabled = false;
        renderBranchActions();
        renderBranches();
        renderWorktrees();
        if (branchToReveal) revealBranch(branchToReveal);
    }
}

let deletionPlan = null;
let deletingWorktree = false;

function updateDeleteButton() {
    $('confirm-delete-worktree').disabled = deletingWorktree || !deletionPlan ||
        (deletionPlan.unmerged > 0 && !$('delete-unmerged').checked) ||
        (deletionPlan.ignored.length > 0 && !$('delete-ignored').checked);
}

async function showWorktreeDeletion(worktree) {
    if (state.switching) return;
    deletionPlan = null;
    $('delete-worktree-description').textContent = 'The checkout folder and its local branch will be removed. Remote branches are unchanged. This cannot be undone in Branchlight.';
    $('delete-worktree-title').textContent = worktree.branch ? 'Delete worktree and branch' : 'Delete worktree';
    $('delete-worktree-path').textContent = worktree.path;
    $('delete-worktree-branch').textContent = worktree.branch.replace(/^refs\/heads\//, '') || 'Detached HEAD — no branch to delete';
    $('delete-worktree-checks').textContent = 'Checking working files and branch history…';
    $('delete-worktree-error').textContent = '';
    $('delete-ignored-option').hidden = true;
    $('delete-unmerged-option').hidden = true;
    $('delete-ignored').checked = false;
    $('delete-unmerged').checked = false;
    $('confirm-delete-worktree').textContent = worktree.branch ? 'Delete worktree and branch' : 'Delete worktree';
    updateDeleteButton();
    $('delete-worktree-dialog').showModal();
    $('cancel-delete-worktree').focus();
    const stillCurrent = ticket('delete-preview');
    try {
        const plan = await api('worktrees/delete-preview', {}, { root: state.status.root, path: worktree.path });
        if (!stillCurrent() || !$('delete-worktree-dialog').open) return;
        deletionPlan = plan;
        if (plan.missing) {
            $('delete-worktree-description').textContent = 'The folder is already missing. This removes its leftover Git registration' + (plan.branch ? ' and local branch' : '') + '. If the folder was moved or its drive is offline, cancel and reconnect or repair it instead. Remote branches are unchanged.';
            $('delete-worktree-title').textContent = plan.branch ? 'Remove missing worktree and branch' : 'Remove missing worktree';
            $('confirm-delete-worktree').textContent = plan.branch ? 'Remove entry and branch' : 'Remove entry';
        }
        const comparison = plan.comparison.replace(/^refs\/(heads|remotes)\//, '');
        $('delete-worktree-checks').textContent = (plan.unmerged
            ? `${plan.unmerged} commit${plan.unmerged === 1 ? ' is' : 's are'} not merged into ${comparison}. Those commits may become unreachable.`
            : `${plan.missing ? 'Working files cannot be checked because the folder is missing.' : 'Working files are clean.'} Commits are already reachable from ${comparison}.`) +
            (plan.current ? ' Branchlight will return to the main checkout.' : '');
        $('delete-unmerged-option').hidden = !plan.unmerged;
        $('delete-ignored-option').hidden = !plan.ignored.length;
        $('delete-ignored-files').textContent = plan.ignored.slice(0, 5).join(', ') + (plan.ignored.length > 5 ? `, and ${plan.ignored.length - 5} more` : '');
        updateDeleteButton();
    } catch (error) {
        if (stillCurrent() && $('delete-worktree-dialog').open) {
            $('delete-worktree-checks').textContent = 'This worktree cannot be deleted yet.';
            $('delete-worktree-error').textContent = error.message;
        }
    }
}

$('delete-ignored').addEventListener('change', updateDeleteButton);
$('delete-unmerged').addEventListener('change', updateDeleteButton);
$('cancel-delete-worktree').addEventListener('click', () => $('delete-worktree-dialog').close());
$('delete-worktree-dialog').addEventListener('cancel', event => { if (deletingWorktree) event.preventDefault(); });
$('delete-worktree-dialog').addEventListener('close', () => { deletionPlan = null; ticket('delete-preview'); });
$('delete-worktree-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (!deletionPlan || $('confirm-delete-worktree').disabled) return;
    deletingWorktree = true;
    state.switching = true;
    state.generation++;
    $('cancel-delete-worktree').disabled = true;
    $('confirm-delete-worktree').textContent = 'Deleting…';
    $('delete-worktree-error').textContent = '';
    updateDeleteButton();
    renderBranchActions();
    renderBranches();
    renderWorktrees();
    try {
        const result = await api('worktrees/delete', {}, {
            root: deletionPlan.root, confirmation: deletionPlan.confirmation,
            allowUnmerged: $('delete-unmerged').checked, removeIgnored: $('delete-ignored').checked,
        });
        $('delete-worktree-dialog').close();
        state.switching = false;
        await openRepository(result.root, state.view);
        if (result.warning) {
            $('error-banner').textContent = result.warning;
            $('error-banner').hidden = false;
        } else {
            $('status-message').textContent = result.branchDeleted ? 'Worktree and local branch deleted' : 'Worktree deleted';
        }
    } catch (error) {
        deletionPlan = null;
        if ($('delete-worktree-dialog').open) {
            $('delete-worktree-error').textContent = error.message + ' Close this dialog and try again.';
        } else {
            showError(error);
        }
    } finally {
        deletingWorktree = false;
        state.switching = false;
        $('cancel-delete-worktree').disabled = false;
        $('confirm-delete-worktree').textContent = 'Delete worktree and branch';
        updateDeleteButton();
        renderBranchActions();
        renderBranches();
        renderWorktrees();
    }
});


let repositoryChoices = [];
let repositoryScanWarning = '';
let scanningRepositories = false;

function renderRepositoryChoices() {
    const query = $('repository-search').value.toLowerCase();
    const container = $('repository-choices');
    container.replaceChildren();
    const normalize = value => (value || '').replaceAll('\\', '/').toLowerCase();
    const currentMain = state.status?.worktrees.find(worktree => worktree.main)?.path || state.status?.root;
    const matches = repositoryChoices.filter(choice => `${choice.name} ${choice.path}`.toLowerCase().includes(query));
    for (const choice of matches) {
        const button = element('button', 'repository-choice');
        button.type = 'button';
        button.disabled = state.switching;
        button.setAttribute('aria-label', `Open repository ${choice.name}`);
        const text = element('span', 'repository-choice-text');
        text.append(element('strong', '', choice.name), element('small', '', choice.path));
        button.append(element('span', 'repository-choice-icon', '⑂'), text);
        if (normalize(choice.path) === normalize(currentMain)) {
            button.append(element('span', 'repository-current', 'Current'));
            button.setAttribute('aria-current', 'true');
        }
        button.addEventListener('click', async () => {
            if (state.switching) return;
            $('open-error').textContent = '';
            const opening = openRepository(choice.path);
            renderRepositoryChoices();
            try { await opening; }
            catch (error) {
                if ($('repository-dialog').open) $('open-error').textContent = error.message;
                else showError(error);
            } finally { renderRepositoryChoices(); }
        });
        container.append(button);
    }
    if (!matches.length) {
        container.append(element('div', 'empty-inline', scanningRepositories ? 'Finding repositories…' :
            query ? 'No matching repositories.' : 'No repositories found. Add a clone to this folder, then scan again.'));
    }
    $('repository-scan-note').textContent = repositoryScanWarning || `${repositoryChoices.length} repositories · Your last selection opens automatically`;
}

async function scanRepositories() {
    if (scanningRepositories || state.switching) return;
    scanningRepositories = true;
    $('rescan-repositories').disabled = true;
    repositoryScanWarning = '';
    renderRepositoryChoices();
    const current = ticket('repositories');
    try {
        const result = await api('repositories');
        if (!current()) return;
        repositoryChoices = result.repositories;
        repositoryScanWarning = result.warning;
        $('repository-folder-label').textContent = result.folder;
    } catch (error) {
        if (current()) repositoryScanWarning = error.message;
    } finally {
        scanningRepositories = false;
        $('rescan-repositories').disabled = false;
        renderRepositoryChoices();
    }
}

function openDialog() {
    if (state.switching || document.querySelector('dialog[open]')) return;
    $('repository-path').value = state.status?.root || '';
    $('repository-search').value = '';
    $('repository-other').open = false;
    $('open-error').textContent = '';
    $('repository-dialog').showModal();
    $('repository-search').focus();
    run(scanRepositories);
}

$('repository-search').addEventListener('input', renderRepositoryChoices);
$('rescan-repositories').addEventListener('click', () => run(scanRepositories));

for (const button of document.querySelectorAll('[data-view]')) {
    button.addEventListener('click', () => setView(button.dataset.view));
}
$('refresh').addEventListener('click', () => run(() => refresh()));
$('open-repository').addEventListener('click', openDialog);
$('rail-repository').addEventListener('click', openDialog);
$('cancel-dialog').addEventListener('click', () => $('repository-dialog').close());
$('close-dialog').addEventListener('click', () => $('repository-dialog').close());
$('close-inspector').addEventListener('click', () => {
    state.commit = null;
    ticket('commit');
    ticket('commit-preview');
    $('history-view').classList.remove('has-selection');
    $('commit-inspector').hidden = true;
    $('working-inspector').hidden = false;
    $('history-diff').hidden = true;
    for (const row of $('commits').children) {
        row.classList.remove('selected');
        row.setAttribute('aria-selected', 'false');
    }
});
$('wip-row').addEventListener('click', () => $('close-inspector').click());
$('back-to-graph').addEventListener('click', () => { $('history-diff').hidden = true; });
$('toolbar-open').addEventListener('click', openDialog);
$('add-repository').addEventListener('click', openDialog);
$('repository-tab').addEventListener('click', openDialog);
$('toolbar-pull').addEventListener('click', () => run(() => branchAction('pull')));
$('toolbar-refresh').addEventListener('click', () => run(() => refresh()));
$('toolbar-current').addEventListener('click', () => run(() => selectBranch(state.status?.refs.find(ref => ref.current)?.name || '', true)));
$('toolbar-reveal-branch').addEventListener('click', () => run(() => selectBranch(state.status?.refs.find(ref => ref.current)?.name || '', true)));
$('toolbar-search').addEventListener('click', () => { setView('history'); $('history-search').focus(); });
if (window.branchlightDesktop) {
    $('browse-repository').hidden = false;
    window.branchlightDesktop.onOpenRepository(openDialog);
    $('browse-repository').addEventListener('click', () => run(async () => {
        const folder = await window.branchlightDesktop.chooseRepository();
        if (folder) {
            $('repository-path').value = folder;
        }
    }));
}
$('branch-search').addEventListener('input', renderBranches);
$('history-search').addEventListener('input', filterHistory);
$('file-search').addEventListener('input', renderChanges);
$('all-branches').addEventListener('click', () => run(() => selectBranch('')));
$('exit-solo').addEventListener('click', () => run(() => selectBranch('')));
$('load-more').addEventListener('click', () => run(async () => {
    state.limit = Math.min(1000, state.limit + 200);
    await loadHistory();
}));
$('tree-up').addEventListener('click', () => run(async () => {
    state.treePath = state.treePath.split('/').slice(0, -1).join('/');
    await loadTree();
}));
$('repository-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (!$('repository-other').open) {
        $('repository-choices').querySelector('button')?.click();
        return;
    }
    $('submit-repository').disabled = true;
    try {
        await openRepository($('repository-path').value);
    } catch (error) {
        if ($('repository-dialog').open) {
            $('open-error').textContent = error.message;
        } else {
            showError(error);
        }
    } finally {
        $('submit-repository').disabled = false;
    }
});
document.addEventListener('keydown', event => {
    if (state.switching || event.target.matches('input, textarea') || event.ctrlKey || event.altKey || event.metaKey || document.querySelector('dialog[open]')) {
        return;
    }
    if (['1', '2', '3'].includes(event.key)) {
        setView({ 1: 'history', 2: 'changes', 3: 'files' }[event.key]);
    } else if (event.key.toLowerCase() === 'r') {
        run(() => refresh());
    } else if (event.key === '/') {
        event.preventDefault();
        $(state.view === 'changes' ? 'file-search' : state.view === 'history' ? 'history-search' : 'branch-search').focus();
    }
});
setInterval(() => {
    if (!document.hidden && !$('repository-dialog').open && state.status) {
        run(() => refresh(false));
    }
}, 15000);
run(initializeResizing);
run(() => refresh());

window.branchlightDesktop?.onRefreshApplication(() => run(() => refresh()));
document.addEventListener('keydown', event => {
    if (event.key === 'F5' || ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'r')) {
        event.preventDefault();
        run(() => refresh());
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'o') {
        event.preventDefault();
        openDialog();
    }
});
