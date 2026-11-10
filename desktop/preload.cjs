const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('branchlightDesktop', {
    chooseRepository: () => ipcRenderer.invoke('choose-repository'),
    copyCommitHash: hash => ipcRenderer.invoke('copy-commit-hash', hash),
    loadLayout: () => ipcRenderer.invoke('load-layout'),
    saveLayout: layout => ipcRenderer.invoke('save-layout', layout),
    onRefreshApplication: callback => { ipcRenderer.on('refresh-application', () => callback()); },
    onOpenRepository: callback => { ipcRenderer.on('open-repository', () => callback()); },
});
