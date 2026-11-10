import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const metadata = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));
assert.equal(metadata.version, lock.version, 'Lockfile version must match package.json');
assert.equal(metadata.version, lock.packages[''].version, 'Lockfile root version must match package.json');
if (process.env.GITHUB_REF_TYPE === 'tag') assert.equal(process.env.GITHUB_REF_NAME, 'v' + metadata.version, 'Release tag must match package.json');
console.log('Release metadata verified: v' + metadata.version);
