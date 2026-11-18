/*
 * SHAKTI BROWSER — preload for the browser UI (not for web pages).
 * Exposes a small, explicit API to the renderer.
 */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function on(channel, fn) {
  const handler = (_e, payload) => fn(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('shakti', {
  window: {
    control: (action) => ipcRenderer.invoke('window:control', action),
    newWindow: (opts) => ipcRenderer.invoke('window:new', opts),
    onState: (fn) => on('window-state', fn)
  },
  tab: {
    attached: (id) => ipcRenderer.invoke('tab:attached', id),
    action: (id, action, arg) => ipcRenderer.invoke('tab:action', id, action, arg)
  },
  page: {
    run: (id, cmd, args) => ipcRenderer.invoke('page:run', id, cmd, args)
  },
  agent: {
    status: () => ipcRenderer.invoke('agent:status'),
    setKey: (key) => ipcRenderer.invoke('agent:set-key', key),
    turn: (messages) => ipcRenderer.invoke('agent:turn', messages)
  },
  shell: {
    showItem: (p) => ipcRenderer.invoke('shell:show-item', p),
    openItem: (p) => ipcRenderer.invoke('shell:open-item', p)
  },
  clearData: () => ipcRenderer.invoke('browser:clear-data'),
  onCommand: (fn) => on('command', fn),
  onDownload: (fn) => on('download', fn)
});
