import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanLayout, fitLayout } from '../layout.mjs';

test('saved layout accepts only bounded numeric panel sizes', () => {
    assert.deepEqual(cleanLayout({ sidebarWidth: 320, inspectorWidth: '500', worktreesHeight: Infinity, repository: 'untrusted' }), { sidebarWidth: 320 });
    assert.deepEqual(cleanLayout({ sidebarWidth: -50, inspectorWidth: 99999, worktreesHeight: 312.7 }), { sidebarWidth: 160, inspectorWidth: 800, worktreesHeight: 313 });
    for (const input of [null, [], 'invalid']) {
        assert.deepEqual(cleanLayout(input), {});
    }
});

test('large panels fit a smaller window without losing preferred sizes', () => {
    const preferred = { sidebarWidth: 500, inspectorWidth: 700, worktreesHeight: 600 };
    const narrow = fitLayout(preferred, 1024, 606);
    assert.ok(narrow.sidebarWidth >= 160);
    assert.ok(narrow.inspectorWidth >= 200);
    assert.ok(1024 - narrow.sidebarWidth - narrow.inspectorWidth - 10 >= 360);
    assert.ok(606 - narrow.worktreesHeight >= 170);
    assert.deepEqual(fitLayout(preferred, 1920, 1046), preferred);
});
