import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { branchlightAppId, windowsLaunchIdentity, windowsAppDetails } from '../desktop/windows-identity.mjs';

const base = { isPackaged:true, executablePath:'C:\\Temp\\extract\\Branchlight.exe', portableDirectory:'D:\\Apps\\Branchlight',
    portableFile:'D:\\Apps\\Branchlight\\Branchlight.exe', userData:'C:\\Users\\Example\\AppData\\Roaming\\branchlight' };

test('portable launch uses the persistent unpacked installation for future taskbar relaunches', () => {
    const identity=windowsLaunchIdentity({...base, exists:file=>file==='D:\\Apps\\Branchlight\\win-unpacked\\Branchlight.exe'});
    assert.equal(identity.target,'D:\\Apps\\Branchlight\\win-unpacked\\Branchlight.exe');
    assert.equal(identity.icon,'C:\\Users\\Example\\AppData\\Roaming\\branchlight\\branchlight.ico');
    assert.doesNotMatch(windowsAppDetails(identity).relaunchCommand,/Temp/);
});

test('a standalone portable copy pins its original executable rather than its temporary runtime', () => {
    const identity=windowsLaunchIdentity({...base, exists:file=>file===base.portableFile});
    assert.equal(identity.target,base.portableFile);
});

test('unpacked and development runs retain their own stable launch commands', () => {
    const unpacked=windowsLaunchIdentity({isPackaged:true,executablePath:'D:\\Branchlight\\Branchlight.exe',userData:'C:\\profile'});
    assert.equal(unpacked.target,'D:\\Branchlight\\Branchlight.exe');
    const dev=windowsLaunchIdentity({isPackaged:false,executablePath:'C:\\Electron\\electron.exe',applicationDirectory:'D:\\My Projects\\Branchlight',userData:'C:\\profile'});
    assert.equal(windowsAppDetails(dev).relaunchCommand,'"C:\\Electron\\electron.exe" "D:\\My Projects\\Branchlight"');
});

test('missing portable launch files cannot create another pin to a temporary extraction path', () => {
    assert.throws(()=>windowsLaunchIdentity({...base,exists:()=>false}),/persistent Branchlight launcher is missing/);
});

test('window details use the same stable icon and application identity as the shortcuts', async () => {
    const packageInfo=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));
    assert.equal(packageInfo.build.appId,branchlightAppId);
    const identity=windowsLaunchIdentity({...base,exists:file=>file===base.portableFile});
    const details=windowsAppDetails(identity);
    assert.equal(details.appId,identity.appUserModelId);
    assert.equal(details.appIconPath,identity.icon);
    assert.equal(details.appIconIndex,0);
    assert.equal(details.relaunchDisplayName,'Branchlight');
});
