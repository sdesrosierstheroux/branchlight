import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// Exercise the action controller with deferred API calls and a minimal DOM.
const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const controller = source.slice(source.indexOf('async function branchAction('), source.indexOf('\nasync function refresh('));

function fixture(api, loadHistory = async () => {}) {
    const nodes = new Map();
    const $ = id => {
        if (!nodes.has(id)) nodes.set(id, { textContent: '', hidden: false, value: '', classList: { remove() {} } });
        return nodes.get(id);
    };
    const state = { status: { root: '/repo', head: 'old', branch: 'main' }, generation: 0, view: 'history', ref: 'refs/heads/main' };
    const clock = { now: 0, tick: null, cleared: false };
    const errors = [];
    const branchAction = vm.runInNewContext(`(${controller})`, {
        $, state, api, loadHistory, document: { querySelector: () => null },
        Date: { now: () => clock.now },
        setInterval(callback) { clock.tick = callback; return 1; },
        clearInterval(id) { assert.equal(id, 1); clock.cleared = true; },
        renderBranchActions() {}, renderBranches() {}, renderWorktrees() {}, empty() {},
        renderStatus(data) { state.status = data; },
        showError(error) { errors.push(error.message); },
    });
    return { branchAction, $, state, clock, errors };
}

const checkedOut = { root: '/repo', head: 'new', branch: 'feature', refs: [{ current: true, name: 'refs/heads/feature' }] };

test('checkout displays elapsed progress through Git and refresh, then clears its timer and busy state', async () => {
    const operation = Promise.withResolvers();
    const history = Promise.withResolvers();
    const refreshing = Promise.withResolvers();
    const ui = fixture(async route => route === 'status' ? checkedOut : operation.promise, async () => {
        refreshing.resolve();
        await history.promise;
    });
    const pending = ui.branchAction('checkout', 'refs/heads/feature');
    assert.equal(ui.state.switching, true);
    ui.clock.now = 11000;
    ui.clock.tick();
    assert.match(ui.$('status-message').textContent, /Checking out feature.*11s elapsed.*Git is still running/);
    operation.resolve({ root: '/repo' });
    await refreshing.promise;
    ui.clock.tick();
    assert.match(ui.$('status-message').textContent, /Refreshing repository view/);
    history.resolve();
    await pending;
    assert.equal(ui.$('status-message').textContent, 'Checked out feature');
    assert.equal(ui.state.switching, false);
    assert.equal(ui.clock.cleared, true);
    assert.deepEqual(ui.errors, []);
});

test('a checkout error after HEAD changes still focuses the actual branch and releases busy state', async () => {
    const ui = fixture(async route => {
        if (route === 'status') return checkedOut;
        throw new Error('Checkout timed out.');
    });
    await ui.branchAction('checkout', 'refs/heads/feature');
    assert.equal(ui.state.ref, 'refs/heads/feature');
    assert.equal(ui.state.status.branch, 'feature');
    assert.equal(ui.state.switching, false);
    assert.equal(ui.clock.cleared, true);
    assert.deepEqual(ui.errors, ['Checkout timed out.']);
});

test('a failed refresh after successful checkout releases busy state and reports that checkout completed', async () => {
    const ui = fixture(async route => {
        if (route === 'status') throw new Error('Status timed out.');
        return { root: '/repo' };
    });
    await ui.branchAction('checkout', 'refs/heads/feature');
    assert.equal(ui.state.switching, false);
    assert.equal(ui.clock.cleared, true);
    assert.match(ui.errors[0], /operation completed.*view could not refresh.*Status timed out/);
});
