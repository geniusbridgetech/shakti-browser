/*
 * SHAKTI BROWSER — main process
 *
 * Windows, menus, shortcuts, downloads, permissions, page tools for the
 * agent, and the Claude connection. Runs on macOS, Windows and Linux.
 */
'use strict';

const {
  app, BrowserWindow, Menu, ipcMain, session, shell, dialog, clipboard, webContents, nativeTheme
} = require('electron');
const path = require('path');
const fs = require('fs');
const agent = require('./agent');
const pageTools = require('./page-tools');

const IS_MAC = process.platform === 'darwin';
const RENDERER = path.join(__dirname, '..', 'renderer', 'index.html');
const PRELOAD = path.join(__dirname, '..', 'preload', 'preload.js');
const PERSIST_PARTITION = 'persist:shakti';

app.setName('Shakti Browser');
if (process.platform === 'win32') app.setAppUserModelId('in.shakti.browser');

// Single instance: a second launch (e.g. clicking a link elsewhere) opens a tab here.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const url = urlFromArgv(argv);
    const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
      if (url) send(win, 'command', { cmd: 'open-url', url });
    } else {
      createWindow({ url });
    }
  });
}

function urlFromArgv(argv) {
  return argv.slice(1).find((a) => /^https?:\/\//i.test(a)) || null;
}

// =========================================================
// WINDOW STATE (size/position remembered between launches)
// =========================================================
const stateFile = () => path.join(app.getPath('userData'), 'window-state.json');
function loadWindowState() {
  try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')); } catch (e) { return { width: 1280, height: 820 }; }
}
function saveWindowState(win) {
  if (win.isDestroyed() || win.isMinimized()) return;
  const b = win.getNormalBounds();
  try { fs.writeFileSync(stateFile(), JSON.stringify({ ...b, maximized: win.isMaximized() })); } catch (e) { /* ignore */ }
}

// =========================================================
// WINDOWS
// =========================================================
function createWindow({ incognito = false, url = null } = {}) {
  const state = loadWindowState();
  const win = new BrowserWindow({
    width: state.width || 1280,
    height: state.height || 820,
    x: state.x,
    y: state.y,
    minWidth: 480,
    minHeight: 360,
    show: false,
    title: 'Shakti Browser',
    backgroundColor: nativeTheme.shouldUseDarkColors || incognito ? '#202124' : '#dee1e6',
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    // Chrome-style: the tab strip is the title bar.
    frame: IS_MAC,
    titleBarStyle: IS_MAC ? 'hiddenInset' : undefined,
    trafficLightPosition: IS_MAC ? { x: 12, y: 13 } : undefined,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: true,
      spellcheck: true
    }
  });
  win.shaktiIncognito = incognito;
  if (state.maximized && !incognito) win.maximize();

  const query = { platform: process.platform };
  if (incognito) query.incognito = '1';
  if (url) query.url = url;
  win.loadFile(RENDERER, { query });

  win.once('ready-to-show', () => win.show());
  win.on('maximize', () => send(win, 'window-state', { maximized: true }));
  win.on('unmaximize', () => send(win, 'window-state', { maximized: false }));
  win.on('enter-full-screen', () => send(win, 'window-state', { fullscreen: true }));
  win.on('leave-full-screen', () => send(win, 'window-state', { fullscreen: false }));
  win.on('close', () => { if (!incognito) saveWindowState(win); });

  // The browser UI itself never navigates away or opens windows.
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  return win;
}

function send(win, channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function hostWindowOf(contents) {
  const host = contents.hostWebContents || contents;
  return BrowserWindow.fromWebContents(host);
}

// =========================================================
// WEB CONTENTS HARDENING + TAB BEHAVIOUR
// =========================================================
app.on('web-contents-created', (_e, contents) => {
  // Lock down every <webview> the UI creates.
  contents.on('will-attach-webview', (event, webPreferences, params) => {
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.nodeIntegrationInSubFrames = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    webPreferences.webSecurity = true;
    const ok = /^(https?:|about:blank|data:text\/html)/i.test(params.src || 'about:blank');
    const partitionOk = params.partition === PERSIST_PARTITION || /^shakti-incognito-\d+$/.test(params.partition || '');
    if (!ok || !partitionOk) event.preventDefault();
  });

  contents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const cmd = shortcutFor(input);
    if (!cmd) return;
    // The UI handles Escape itself (omnibox, menus); pages forward it.
    if (cmd === 'escape' && contents.getType() !== 'webview') return;
    event.preventDefault();
    const win = hostWindowOf(contents);
    send(win, 'command', { cmd });
  });

  if (contents.getType() !== 'webview') return;

  // Pop-ups and target=_blank links become tabs, like Chrome.
  contents.setWindowOpenHandler(({ url, disposition }) => {
    if (/^https?:/i.test(url)) {
      send(hostWindowOf(contents), 'command', {
        cmd: 'open-url',
        url,
        background: disposition === 'background-tab',
        newWindow: disposition === 'new-window'
      });
    } else if (/^mailto:|^tel:/i.test(url)) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  contents.on('will-navigate', (e, url) => {
    if (/^(mailto|tel|zoommtg|msteams|slack|whatsapp):/i.test(url)) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });

  contents.on('context-menu', (_e, params) => showPageContextMenu(contents, params));
});

// =========================================================
// KEYBOARD SHORTCUTS (work even while a web page has focus)
// =========================================================
function shortcutFor(input) {
  const mod = IS_MAC ? input.meta : input.control;
  const key = (input.key || '').toLowerCase();
  const code = input.code || '';
  if (mod && input.shift && key === 'n') return 'new-incognito';
  if (mod && input.shift && key === 't') return 'reopen-tab';
  if (mod && input.shift && key === 'b') return 'toggle-bookmarks-bar';
  if (mod && input.shift && key === 'o') return 'bookmarks';
  if (mod && input.shift && key === 'r') return 'hard-reload';
  if ((mod && input.shift && key === 'i') || key === 'f12' || (IS_MAC && input.meta && input.alt && key === 'i')) return 'devtools';
  if (mod && input.shift && code === 'Tab') return 'prev-tab';
  if (mod && code === 'Tab') return 'next-tab';
  if (mod && input.alt && (key === 'arrowright')) return 'next-tab';
  if (mod && input.alt && (key === 'arrowleft')) return 'prev-tab';
  if (mod && !input.shift && !input.alt) {
    if (key === 't') return 'new-tab';
    if (key === 'n') return 'new-window';
    if (key === 'w' || key === 'f4') return 'close-tab';
    if (key === 'l') return 'focus-omnibox';
    if (key === 'r') return 'reload';
    if (key === 'd') return 'bookmark';
    if (key === 'h' && !IS_MAC) return 'history';
    if (key === 'y' && IS_MAC) return 'history';
    if (key === 'j') return 'downloads';
    if (key === 'e') return 'toggle-agent';
    if (key === 'f') return 'find';
    if (key === 'p') return 'print';
    if (key === '=' || key === '+') return 'zoom-in';
    if (key === '-') return 'zoom-out';
    if (key === '0') return 'zoom-reset';
    if (/^[1-8]$/.test(key)) return 'tab-' + key;
    if (key === '9') return 'tab-last';
    if (IS_MAC && key === '[') return 'back';
    if (IS_MAC && key === ']') return 'forward';
    if (IS_MAC && key === ',') return 'settings';
  }
  if (!IS_MAC && input.alt && !input.control && key === 'arrowleft') return 'back';
  if (!IS_MAC && input.alt && !input.control && key === 'arrowright') return 'forward';
  if (key === 'f5' && !mod) return 'reload';
  if (key === 'f11' && !IS_MAC) return 'fullscreen';
  if (key === 'escape') return 'escape';
  return null;
}

// =========================================================
// APPLICATION MENU (shows on macOS; provides Edit roles everywhere)
// Accelerators are labels only — before-input-event does the work.
// =========================================================
function buildAppMenu() {
  const cmd = (name) => () => send(BrowserWindow.getFocusedWindow(), 'command', { cmd: name });
  const item = (label, name, accelerator) => ({ label, accelerator, registerAccelerator: false, click: cmd(name) });
  const template = [
    ...(IS_MAC ? [{
      label: 'Shakti Browser',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        item('Settings…', 'settings', 'Cmd+,'),
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    }] : []),
    {
      label: 'File',
      submenu: [
        item('New Tab', 'new-tab', 'CmdOrCtrl+T'),
        { label: 'New Window', accelerator: 'CmdOrCtrl+N', registerAccelerator: false, click: () => createWindow() },
        { label: 'New Incognito Window', accelerator: 'CmdOrCtrl+Shift+N', registerAccelerator: false, click: () => createWindow({ incognito: true }) },
        item('Reopen Closed Tab', 'reopen-tab', 'CmdOrCtrl+Shift+T'),
        { type: 'separator' },
        item('Close Tab', 'close-tab', 'CmdOrCtrl+W'),
        item('Print…', 'print', 'CmdOrCtrl+P'),
        ...(IS_MAC ? [] : [{ type: 'separator' }, { role: 'quit', label: 'Exit' }])
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'pasteAndMatchStyle' },
        { role: 'delete' }, { role: 'selectAll' }, { type: 'separator' },
        item('Find…', 'find', 'CmdOrCtrl+F')
      ]
    },
    {
      label: 'View',
      submenu: [
        item('Reload', 'reload', 'CmdOrCtrl+R'),
        item('Hard Reload', 'hard-reload', 'CmdOrCtrl+Shift+R'),
        { type: 'separator' },
        item('Zoom In', 'zoom-in', 'CmdOrCtrl+='),
        item('Zoom Out', 'zoom-out', 'CmdOrCtrl+-'),
        item('Actual Size', 'zoom-reset', 'CmdOrCtrl+0'),
        { type: 'separator' },
        item('Always Show Bookmarks Bar', 'toggle-bookmarks-bar', 'CmdOrCtrl+Shift+B'),
        item('Shakti AI', 'toggle-agent', 'CmdOrCtrl+E'),
        { role: 'togglefullscreen' },
        { type: 'separator' },
        item('Developer Tools', 'devtools', IS_MAC ? 'Alt+Cmd+I' : 'Ctrl+Shift+I')
      ]
    },
    {
      label: 'History',
      submenu: [
        item('Back', 'back', IS_MAC ? 'Cmd+[' : 'Alt+Left'),
        item('Forward', 'forward', IS_MAC ? 'Cmd+]' : 'Alt+Right'),
        item('Show Full History', 'history', IS_MAC ? 'Cmd+Y' : 'Ctrl+H')
      ]
    },
    {
      label: 'Bookmarks',
      submenu: [
        item('Bookmark This Tab', 'bookmark', 'CmdOrCtrl+D'),
        item('Bookmark Manager', 'bookmarks', 'CmdOrCtrl+Shift+O')
      ]
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [{ label: 'About Shakti Browser', click: cmd('about') }]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// =========================================================
// PAGE CONTEXT MENU
// =========================================================
function showPageContextMenu(contents, params) {
  const win = hostWindowOf(contents);
  const items = [];
  const open = (url, background) => send(win, 'command', { cmd: 'open-url', url, background });

  if (params.linkURL) {
    items.push(
      { label: 'Open link in new tab', click: () => open(params.linkURL, true) },
      { label: 'Open link in new window', click: () => createWindow({ url: params.linkURL }) },
      { label: 'Open link in incognito window', click: () => createWindow({ incognito: true, url: params.linkURL }) },
      { type: 'separator' },
      { label: 'Copy link address', click: () => clipboard.writeText(params.linkURL) },
      { type: 'separator' }
    );
  }
  if (params.mediaType === 'image' && params.srcURL) {
    items.push(
      { label: 'Open image in new tab', click: () => open(params.srcURL, true) },
      { label: 'Save image as…', click: () => contents.downloadURL(params.srcURL) },
      { label: 'Copy image', click: () => contents.copyImageAt(params.x, params.y) },
      { label: 'Copy image address', click: () => clipboard.writeText(params.srcURL) },
      { type: 'separator' }
    );
  }
  if (params.isEditable) {
    if (params.misspelledWord) {
      params.dictionarySuggestions.slice(0, 4).forEach((s) => items.push({ label: s, click: () => contents.replaceMisspelling(s) }));
      if (params.dictionarySuggestions.length) items.push({ type: 'separator' });
    }
    items.push(
      { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
      { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }, { type: 'separator' }
    );
  } else if (params.selectionText) {
    const text = params.selectionText.trim();
    items.push(
      { role: 'copy' },
      { label: `Search for “${text.slice(0, 30)}${text.length > 30 ? '…' : ''}”`, click: () => send(win, 'command', { cmd: 'search', query: text }) },
      { label: 'Ask Shakti AI about this', click: () => send(win, 'command', { cmd: 'ask', prompt: `Explain this text from the page:\n\n"${text.slice(0, 2000)}"` }) },
      { type: 'separator' }
    );
  }
  if (!params.linkURL && !params.isEditable && !params.selectionText) {
    items.push(
      { label: 'Back', enabled: contents.navigationHistory.canGoBack(), click: () => contents.navigationHistory.goBack() },
      { label: 'Forward', enabled: contents.navigationHistory.canGoForward(), click: () => contents.navigationHistory.goForward() },
      { label: 'Reload', click: () => contents.reload() },
      { type: 'separator' },
      { label: 'Save as…', click: () => saveAs(contents) },
      { label: 'Print…', click: () => contents.print() },
      { label: 'Summarize with Shakti AI', click: () => send(win, 'command', { cmd: 'ask', prompt: 'Summarize this page', send: true }) },
      { type: 'separator' }
    );
  }
  items.push({ label: 'Inspect', click: () => { contents.inspectElement(params.x, params.y); } });
  Menu.buildFromTemplate(items).popup({ window: win });
}

async function saveAs(contents) {
  const win = hostWindowOf(contents);
  const title = (contents.getTitle() || 'page').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 100);
  const res = await dialog.showSaveDialog(win, {
    defaultPath: path.join(downloadsDir(), title + '.html'),
    filters: [{ name: 'Web page, complete', extensions: ['html'] }]
  });
  if (!res.canceled && res.filePath) {
    try { await contents.savePage(res.filePath, 'HTMLComplete'); } catch (e) { dialog.showErrorBox('Save failed', String(e.message || e)); }
  }
}

// Electron reports the home folder when Linux has no XDG download dir set;
// use ~/Downloads then, like Chrome.
function downloadsDir() {
  const dir = app.getPath('downloads');
  return dir === app.getPath('home') ? path.join(dir, 'Downloads') : dir;
}

// =========================================================
// SESSIONS: downloads + permission prompts
// =========================================================
const configuredSessions = new WeakSet();
let downloadSeq = 1;

function configureSession(ses) {
  if (configuredSessions.has(ses)) return;
  configuredSessions.add(ses);
  ses.setSpellCheckerLanguages(['en-US']);

  ses.on('will-download', (_e, item, contents) => {
    const win = contents ? hostWindowOf(contents) : BrowserWindow.getFocusedWindow();
    const id = downloadSeq++;
    // Chrome default: save straight to Downloads, de-duplicating the name.
    const dir = downloadsDir();
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* reported as interrupted */ }
    const parsed = path.parse(item.getFilename() || 'download');
    let target = path.join(dir, parsed.base);
    for (let n = 1; fs.existsSync(target); n++) target = path.join(dir, `${parsed.name} (${n})${parsed.ext}`);
    item.setSavePath(target);

    const report = (state) => send(win, 'download', {
      id,
      state,
      filename: path.basename(item.getSavePath()),
      path: item.getSavePath(),
      url: item.getURL(),
      received: item.getReceivedBytes(),
      total: item.getTotalBytes()
    });
    report('progressing');
    item.on('updated', (_ev, state) => report(state === 'interrupted' ? 'interrupted' : 'progressing'));
    item.once('done', (_ev, state) => report(state));
  });

  ses.setPermissionRequestHandler(async (contents, permission, callback, details) => {
    const always = ['fullscreen', 'clipboard-sanitized-write', 'pointerLock'];
    if (always.includes(permission)) return callback(true);
    const ask = { media: 'use your camera/microphone', geolocation: 'know your location', notifications: 'show notifications', 'clipboard-read': 'see text and images copied to the clipboard', midi: 'use MIDI devices', midiSysex: 'use MIDI devices' };
    if (!ask[permission]) return callback(false);
    const win = hostWindowOf(contents);
    let origin = details.requestingUrl || '';
    try { origin = new URL(origin).host; } catch (e) { /* keep */ }
    const res = await dialog.showMessageBox(win, {
      type: 'question',
      buttons: ['Allow', 'Block'],
      defaultId: 1,
      cancelId: 1,
      title: 'Permission request',
      message: `${origin} wants to ${ask[permission]}`
    });
    callback(res.response === 0);
  });
}

// =========================================================
// IPC
// =========================================================
function ownedGuest(event, id) {
  const guest = webContents.fromId(Number(id));
  if (!guest || guest.isDestroyed() || guest.hostWebContents !== event.sender) return null;
  return guest;
}

ipcMain.handle('window:control', (event, action) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  if (action === 'minimize') win.minimize();
  else if (action === 'maximize') (win.isMaximized() ? win.unmaximize() : win.maximize());
  else if (action === 'close') win.close();
  else if (action === 'fullscreen') win.setFullScreen(!win.isFullScreen());
  return { maximized: win.isMaximized(), fullscreen: win.isFullScreen() };
});

ipcMain.handle('window:new', (_e, opts) => { createWindow(opts || {}); });

ipcMain.handle('tab:attached', (event, id, incognitoPartition) => {
  const guest = ownedGuest(event, id);
  if (!guest) return false;
  configureSession(guest.session);
  return true;
});

ipcMain.handle('tab:action', async (event, id, action, arg) => {
  const guest = ownedGuest(event, id);
  if (!guest) return null;
  switch (action) {
    case 'devtools': guest.isDevToolsOpened() ? guest.closeDevTools() : guest.openDevTools({ mode: 'right' }); return null;
    case 'print': guest.print(); return null;
    case 'save-as': return saveAs(guest);
    case 'hard-reload': guest.reloadIgnoringCache(); return null;
    case 'clear-data': await guest.session.clearStorageData(); await guest.session.clearCache(); return true;
    default: return null;
  }
});

ipcMain.handle('page:run', async (event, id, cmd, args) => {
  const guest = ownedGuest(event, id);
  if (!guest) return { error: 'This tab has no web page.' };
  return pageTools.run(guest, cmd, args || {});
});

ipcMain.handle('shell:show-item', (_e, p) => {
  if (typeof p === 'string' && p.startsWith(downloadsDir())) shell.showItemInFolder(p);
});
ipcMain.handle('shell:open-item', (_e, p) => {
  if (typeof p === 'string' && p.startsWith(downloadsDir())) shell.openPath(p);
});

ipcMain.handle('browser:clear-data', async () => {
  await session.fromPartition(PERSIST_PARTITION).clearStorageData();
  await session.fromPartition(PERSIST_PARTITION).clearCache();
  return true;
});

ipcMain.handle('agent:status', () => agent.status());
ipcMain.handle('agent:set-key', (_e, key) => agent.setKey(key));
ipcMain.handle('agent:turn', (_e, messages) => agent.turn(messages));

// =========================================================
// APP LIFECYCLE
// =========================================================
app.whenReady().then(() => {
  agent.init(app.getPath('userData'));
  configureSession(session.fromPartition(PERSIST_PARTITION));
  buildAppMenu();
  createWindow({ url: urlFromArgv(process.argv) });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('open-url', (event, url) => { // macOS: links opened with Shakti as default browser
  event.preventDefault();
  const win = BrowserWindow.getAllWindows()[0];
  if (win) send(win, 'command', { cmd: 'open-url', url });
  else app.whenReady().then(() => createWindow({ url }));
});

app.on('window-all-closed', () => {
  if (!IS_MAC) app.quit();
});
