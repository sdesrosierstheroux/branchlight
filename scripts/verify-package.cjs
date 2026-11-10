const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const asar = require('@electron/asar');
const root = path.resolve(__dirname, '..');
const archive = path.join(root, 'dist', 'win-unpacked', 'resources', 'app.asar');
const metadata = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const packaged = JSON.parse(asar.extractFile(archive, 'package.json').toString());
assert.equal(packaged.version, metadata.version);
assert.equal(packaged.name, 'branchlight');
const files = asar.listPackage(archive).map(file => file.replaceAll('\\', '/').replace(/^\//, ''));
assert.ok(!files.some(file => /^(dispatch|worktree-manager|test|scripts|node_modules)(\/|$)/.test(file)), 'Only Git app runtime files belong in the package');
assert.ok(!files.some(file => /(^|\/)\.env($|\.)/.test(file)), 'No environment files belong in the package');
for (const file of ['desktop/main.mjs', 'desktop/preload.cjs', 'desktop/windows-identity.mjs', 'public/index.html', 'public/app.js', 'public/styles.css', 'repositories.mjs', 'server.mjs', 'git.mjs']) {
    assert.deepEqual(asar.extractFile(archive, file), fs.readFileSync(path.join(root, file)), 'Bundled file differs: ' + file);
}
assert.ok(fs.existsSync(path.join(root, 'dist', 'win-unpacked', 'LICENSE.electron.txt')));
assert.ok(fs.existsSync(path.join(root, 'dist', 'win-unpacked', 'LICENSES.chromium.html')));
const executable = path.join(root, 'dist', 'Branchlight.exe');
const digest = crypto.createHash('sha256').update(fs.readFileSync(executable)).digest('hex');
fs.writeFileSync(path.join(root, 'dist', 'SHA256SUMS.txt'), digest + '  Branchlight.exe\n');
console.log('Verified Branchlight v' + metadata.version + ': Git-only package, source assets, notices, and executable checksum.');
