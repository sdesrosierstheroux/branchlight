import { existsSync } from 'node:fs';
import path from 'node:path';

export const branchlightAppId = 'local.branchlight.git';

export function windowsLaunchIdentity({ isPackaged, executablePath, portableDirectory, portableFile, applicationDirectory, userData, exists = existsSync }) {
    const windows = path.win32;
    let target = executablePath;
    let args = '';
    if (isPackaged && portableDirectory) {
        const candidates = [windows.join(portableDirectory, 'win-unpacked', 'Branchlight.exe'),
            portableFile, windows.join(portableDirectory, windows.basename(executablePath))].filter(Boolean);
        target = candidates.find(file => exists(file));
        if (!target) throw new Error('The persistent Branchlight launcher is missing.');
    } else if (!isPackaged) {
        args = `"${applicationDirectory}"`;
    }
    return {
        target: windows.normalize(target), args, cwd: windows.dirname(target),
        icon: windows.join(userData, 'branchlight.ico'), iconIndex: 0, appUserModelId: branchlightAppId,
        description: 'Branchlight Git workspace',
    };
}

export function windowsAppDetails(identity) {
    return { appId: identity.appUserModelId, appIconPath: identity.icon, appIconIndex: identity.iconIndex,
        relaunchCommand: `"${identity.target}"${identity.args ? ' ' + identity.args : ''}`, relaunchDisplayName: 'Branchlight' };
}
