/*
 * SHAKTI BROWSER — browser UI (renderer)
 *
 * Every web tab is a Chromium <webview>. Internal pages (new tab, history,
 * bookmarks, downloads, settings, about) are drawn here. Exposes
 * window.ShaktiBrowser for the AI agent (agent.js).
 */
(function () {
  'use strict';

  const native = window.shakti;
  const params = new URLSearchParams(location.search);
  const PLATFORM = params.get('platform') || 'linux';
  const IS_MAC = PLATFORM === 'darwin';
  const INCOGNITO = params.get('incognito') === '1';
  const PARTITION = INCOGNITO ? `shakti-incognito-${Date.now()}` : 'persist:shakti';
  const MOD = IS_MAC ? '⌘' : 'Ctrl+';

  document.body.classList.add('platform-' + PLATFORM);
  if (INCOGNITO) {
    document.documentElement.setAttribute('data-incognito', '');
    document.getElementById('incognito-badge').hidden = false;
  }

  // =========================================================
  // STORAGE (incognito windows read but never write browsing data)
  // =========================================================
  const PREFIX = 'shakti-browser:';
  const store = {
    get(key, fallback) {
      try {
        const v = localStorage.getItem(PREFIX + key);
        return v == null ? fallback : JSON.parse(v);
      } catch (e) { return fallback; }
    },
    set(key, value, { always = false } = {}) {
      if (INCOGNITO && !always) return;
      try { localStorage.setItem(PREFIX + key, JSON.stringify(value)); } catch (e) { /* ignore */ }
    }
  };

  const SEARCH_ENGINES = {
    google: { name: 'Google', url: 'https://www.google.com/search?q=%s' },
    duckduckgo: { name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=%s' },
    bing: { name: 'Bing', url: 'https://www.bing.com/search?q=%s' },
    brave: { name: 'Brave Search', url: 'https://search.brave.com/search?q=%s' },
    wikipedia: { name: 'Wikipedia', url: 'https://en.wikipedia.org/w/index.php?search=%s' }
  };

  const DEFAULT_BOOKMARKS = [
    { title: 'Google', url: 'https://www.google.com/' },
    { title: 'YouTube', url: 'https://www.youtube.com/' },
    { title: 'Wikipedia', url: 'https://en.wikipedia.org/' },
    { title: 'ISRO', url: 'https://www.isro.gov.in/' },
    { title: 'GitHub', url: 'https://github.com/' }
  ];

  const DEFAULT_TILES = [
    { title: 'Google', url: 'https://www.google.com/' },
    { title: 'YouTube', url: 'https://www.youtube.com/' },
    { title: 'Gmail', url: 'https://mail.google.com/' },
    { title: 'Wikipedia', url: 'https://en.wikipedia.org/' },
    { title: 'WhatsApp', url: 'https://web.whatsapp.com/' },
    { title: 'ISRO', url: 'https://www.isro.gov.in/' },
    { title: 'DigiLocker', url: 'https://www.digilocker.gov.in/' },
    { title: 'GitHub', url: 'https://github.com/' },
    { title: 'News', url: 'https://news.google.com/' },
    { title: 'Maps', url: 'https://www.google.com/maps' }
  ];

  const settings = Object.assign({
    searchEngine: 'google',
    theme: 'system',
    showBookmarksBar: true,
    showHomeButton: true,
    homePage: 'shakti://newtab',
    restoreSession: true
  }, store.get('settings', {}));

  let bookmarks = store.get('bookmarks', null) || DEFAULT_BOOKMARKS.slice();
  let historyLog = store.get('history', []);
  let tiles = store.get('tiles', null) || DEFAULT_TILES.slice();

  const saveSettings = () => store.set('settings', settings, { always: true });
  const saveBookmarks = () => store.set('bookmarks', bookmarks, { always: true });
  const saveHistory = () => store.set('history', historyLog.slice(0, 5000));
  const saveTiles = () => store.set('tiles', tiles, { always: true });

  const config = { agent: { available: false, reason: 'Checking…' }, ready: null };
  config.ready = native.agent.status().then((s) => { config.agent = s; return config; }).catch(() => config);

  // =========================================================
  // DOM HELPERS
  // =========================================================
  const $ = (id) => document.getElementById(id);
  const tabsEl = $('tabs');
  const viewsEl = $('views');
  const omnibox = $('omnibox');
  const omniInput = $('omnibox-input');
  const omniSuggest = $('omni-suggest');
  const siteInfo = $('site-info');
  const btnBack = $('btn-back');
  const btnForward = $('btn-forward');
  const btnReload = $('btn-reload');
  const btnStar = $('btn-star');
  const menu = $('menu');
  const bookmarksBar = $('bookmarks-bar');

  const loadingBar = document.createElement('div');
  loadingBar.className = 'loading-bar';
  viewsEl.appendChild(loadingBar);

  const statusBubble = document.createElement('div');
  statusBubble.className = 'status-bubble';
  statusBubble.hidden = true;
  viewsEl.appendChild(statusBubble);

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  const svg = (id) => `<svg><use href="#${id}"/></svg>`;

  const LETTER_COLORS = ['#ff9933', '#138808', '#4f6bed', '#e8567b', '#00897b', '#8e24aa', '#f4511e', '#3949ab'];
  function letterIcon(text) {
    const clean = String(text || '?').replace(/^www\./, '').trim();
    const ch = (clean[0] || '?').toUpperCase();
    let h = 0;
    for (const c of clean) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return `<span class="fav-letter" style="background:${LETTER_COLORS[h % LETTER_COLORS.length]}">${escapeHtml(ch)}</span>`;
  }
  function faviconHtml(url, title, src) {
    let host = '';
    try { host = new URL(url).hostname; } catch (e) { /* ignore */ }
    if (!host) return letterIcon(title || url);
    const icon = src || `https://${host}/favicon.ico`;
    return `<img src="${escapeHtml(icon)}" alt="" referrerpolicy="no-referrer" data-fallback="${escapeHtml(letterIcon(host))}">`;
  }
  // CSP forbids inline onerror handlers: swap broken favicons here.
  document.addEventListener('error', (e) => {
    const img = e.target;
    if (img && img.tagName === 'IMG' && img.dataset && img.dataset.fallback !== undefined) img.outerHTML = img.dataset.fallback;
  }, true);

  // =========================================================
  // URL HELPERS
  // =========================================================
  const isInternal = (url) => /^shakti:\/\//i.test(url || '');

  function searchUrl(query) {
    const engine = SEARCH_ENGINES[settings.searchEngine] || SEARCH_ENGINES.google;
    return engine.url.replace('%s', encodeURIComponent(query));
  }

  function resolveInput(text) {
    const t = String(text || '').trim();
    if (!t) return null;
    if (isInternal(t)) return t.toLowerCase();
    if (/^(chrome|about|edge|brave):\/{0,2}/i.test(t) && !/^about:blank$/i.test(t)) return 'shakti://' + t.replace(/^[a-z]+:\/{0,2}/i, '');
    if (/^(https?|file):\/\//i.test(t) || /^about:blank$/i.test(t)) return t;
    if (/^(localhost|\d{1,3}(\.\d{1,3}){3}|\[[0-9a-f:]+\])(:\d+)?(\/.*)?$/i.test(t)) return 'http://' + t;
    if (!/\s/.test(t) && /^[^\s/]+\.[a-z]{2,}\.?(:\d+)?([/?#].*)?$/i.test(t)) return 'https://' + t;
    return searchUrl(t);
  }

  function displayUrl(url) {
    if (!url || isInternal(url)) return url || '';
    try {
      const u = new URL(url);
      if (!/^https?:$/.test(u.protocol)) return url;
      const s = u.host + (u.pathname === '/' ? '' : u.pathname) + u.search + u.hash;
      return s.replace(/^www\./, '');
    } catch (e) { return url; }
  }

  // =========================================================
  // TABS
  // =========================================================
  let tabs = [];
  let activeId = null;
  let tabSeq = 1;
  const closedTabs = [];

  const activeTab = () => tabs.find((t) => t.id === activeId) || null;

  function createTab(url, { activate = true, index } = {}) {
    const tab = {
      id: tabSeq++,
      url: '',
      title: 'New Tab',
      favicon: null,
      loading: false,
      mode: 'internal', // 'internal' | 'web'
      internalEl: null,
      wv: null,
      wcId: null,
      ready: false,
      queuedUrl: null,
      errorEl: null,
      zoom: 1,
      internalBack: null, // internal page the first web page was opened from
      forwardToWeb: false,
      backToWeb: false,
      loadWaiters: []
    };
    if (typeof index === 'number') tabs.splice(index, 0, tab); else tabs.push(tab);
    navigate(tab, url || settings.homePage || 'shakti://newtab');
    if (activate) switchTo(tab.id); else renderTabs();
    persistSession();
    return tab;
  }

  function closeTab(id) {
    const idx = tabs.findIndex((t) => t.id === id);
    if (idx < 0) return;
    const [tab] = tabs.splice(idx, 1);
    if (tab.url && !INCOGNITO) closedTabs.push({ url: tab.url, index: idx });
    if (tab.wv) tab.wv.remove();
    if (tab.internalEl) tab.internalEl.remove();
    if (tab.errorEl) tab.errorEl.remove();
    tab.loadWaiters.splice(0).forEach((fn) => fn(false));
    if (!tabs.length) {
      persistSession();
      native.window.control('close');
      return;
    }
    if (activeId === id) switchTo(tabs[Math.min(idx, tabs.length - 1)].id);
    else renderTabs();
    persistSession();
  }

  function reopenClosedTab() {
    const last = closedTabs.pop();
    if (last) createTab(last.url, { index: Math.min(last.index, tabs.length) });
  }

  function showTabView(tab) {
    const show = tab.id === activeId;
    if (tab.wv) tab.wv.classList.toggle('active', show && tab.mode === 'web');
    if (tab.internalEl) tab.internalEl.classList.toggle('active', show && tab.mode === 'internal');
    if (tab.errorEl) tab.errorEl.hidden = !(show && tab.mode === 'web');
  }

  function switchTo(id) {
    const prev = activeTab();
    if (prev && prev.id !== id) closeFind();
    activeId = id;
    tabs.forEach(showTabView);
    renderTabs();
    updateToolbar();
    const tab = activeTab();
    if (!tab) return;
    if (tab.mode === 'internal' && tab.url === 'shakti://newtab') {
      const box = tab.internalEl && tab.internalEl.querySelector('.ntp-search input');
      if (box) setTimeout(() => box.focus(), 0);
    } else if (tab.mode === 'web' && tab.wv) {
      setTimeout(() => tab.wv.focus(), 0);
    }
  }

  function renderTabs() {
    tabsEl.innerHTML = '';
    const narrow = tabs.length > 9;
    tabs.forEach((tab) => {
      const el = document.createElement('div');
      el.className = 'tab' + (tab.id === activeId ? ' active' : '') + (narrow ? ' narrow' : '');
      el.setAttribute('role', 'tab');
      el.title = tab.title;
      let icon;
      if (tab.loading) icon = '<div class="spinner"></div>';
      else if (tab.mode === 'internal') icon = tab.url === 'shakti://newtab' ? '' : svg(internalIcon(tab.url));
      else if (tab.favicon) icon = `<img src="${escapeHtml(tab.favicon)}" alt="" data-fallback="${escapeHtml(svg('i-globe'))}">`;
      else icon = svg('i-globe');
      el.innerHTML = `<span class="tab-icon">${icon}</span><span class="tab-title">${escapeHtml(tab.title)}</span><button class="tab-close" title="Close tab" aria-label="Close tab">${svg('i-close')}</button><span class="corner-r"></span>`;
      el.addEventListener('mousedown', (e) => {
        if (e.button === 1) { e.preventDefault(); closeTab(tab.id); return; }
        if (e.button === 0 && !e.target.closest('.tab-close')) switchTo(tab.id);
      });
      el.querySelector('.tab-close').addEventListener('click', (e) => { e.stopPropagation(); closeTab(tab.id); });
      // Drag to reorder
      el.draggable = true;
      el.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/shakti-tab', String(tab.id)); e.dataTransfer.effectAllowed = 'move'; });
      el.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('text/shakti-tab')) e.preventDefault(); });
      el.addEventListener('drop', (e) => {
        const fromId = Number(e.dataTransfer.getData('text/shakti-tab'));
        const from = tabs.findIndex((t) => t.id === fromId);
        const to = tabs.indexOf(tab);
        if (from < 0 || from === to) return;
        const [moved] = tabs.splice(from, 1);
        tabs.splice(to, 0, moved);
        renderTabs();
        persistSession();
      });
      tabsEl.appendChild(el);
    });
  }

  function internalIcon(url) {
    if (url.includes('history')) return 'i-history';
    if (url.includes('bookmarks')) return 'i-star-filled';
    if (url.includes('settings')) return 'i-settings';
    if (url.includes('downloads')) return 'i-download';
    return 'i-info';
  }

  function persistSession() {
    store.set('session', tabs.map((t) => t.url).filter((u) => u && u !== 'about:blank'));
  }

  // =========================================================
  // NAVIGATION
  // =========================================================
  function navigate(tab, rawUrl) {
    const url = resolveInput(rawUrl);
    if (!url) return;
    tab.loadWaiters.splice(0).forEach((fn) => fn(false));

    if (isInternal(url)) {
      tab.backToWeb = tab.mode === 'web' && !!tab.wv;
      tab.forwardToWeb = false;
      showInternal(tab, url);
      return;
    }

    if (tab.mode === 'internal') tab.internalBack = tab.url || null;
    tab.forwardToWeb = false;
    tab.backToWeb = false;
    tab.mode = 'web';
    tab.url = url;
    tab.title = displayUrl(url);
    tab.loading = true;
    hideError(tab);
    if (!tab.wv) createWebview(tab, url);
    else if (tab.ready) tab.wv.loadURL(url).catch(() => { /* reported via did-fail-load */ });
    else tab.queuedUrl = url;
    showTabView(tab);
    if (tab.id === activeId) { startLoadingBar(); updateToolbar(); }
    renderTabs();
    persistSession();
  }

  function showInternal(tab, url) {
    tab.mode = 'internal';
    tab.url = url;
    tab.loading = false;
    tab.favicon = null;
    if (!tab.internalEl) {
      tab.internalEl = document.createElement('div');
      tab.internalEl.className = 'view internal';
      viewsEl.appendChild(tab.internalEl);
    }
    renderInternal(tab);
    showTabView(tab);
    renderTabs();
    if (tab.id === activeId) { updateToolbar(); stopLoadingBar(); }
    tab.loadWaiters.splice(0).forEach((fn) => fn(true));
    persistSession();
  }

  function showWeb(tab) {
    tab.mode = 'web';
    tab.url = tab.wv.getURL();
    tab.title = tab.wv.getTitle() || displayUrl(tab.url);
    showTabView(tab);
    renderTabs();
    if (tab.id === activeId) updateToolbar();
  }

  function createWebview(tab, url) {
    const wv = document.createElement('webview');
    wv.className = 'view';
    wv.setAttribute('partition', PARTITION);
    wv.setAttribute('allowpopups', '');
    wv.setAttribute('webpreferences', 'contextIsolation=yes, sandbox=yes');
    wv.setAttribute('src', url);
    tab.wv = wv;

    wv.addEventListener('dom-ready', () => {
      if (!tab.ready) {
        tab.ready = true;
        tab.wcId = wv.getWebContentsId();
        native.tab.attached(tab.wcId);
        if (tab.queuedUrl) { const q = tab.queuedUrl; tab.queuedUrl = null; wv.loadURL(q).catch(() => {}); }
      }
      if (tab.zoom !== 1) wv.setZoomFactor(tab.zoom);
    });
    wv.addEventListener('did-start-loading', () => {
      tab.loading = true;
      renderTabs();
      if (tab.id === activeId) { startLoadingBar(); updateToolbar(); }
    });
    wv.addEventListener('did-stop-loading', () => {
      tab.loading = false;
      renderTabs();
      if (tab.id === activeId) { stopLoadingBar(); updateToolbar(); }
      if (tab.mode === 'web') recordHistory(tab.url, tab.title);
      tab.loadWaiters.splice(0).forEach((fn) => fn(true));
    });
    wv.addEventListener('did-navigate', (e) => {
      if (tab.mode !== 'web') return;
      tab.url = e.url;
      tab.favicon = null;
      hideError(tab);
      if (tab.id === activeId) updateToolbar();
      persistSession();
    });
    wv.addEventListener('did-navigate-in-page', (e) => {
      if (!e.isMainFrame || tab.mode !== 'web') return;
      tab.url = e.url;
      if (tab.id === activeId) updateToolbar();
      recordHistory(tab.url, tab.title);
      persistSession();
    });
    wv.addEventListener('page-title-updated', (e) => {
      if (tab.mode !== 'web') return;
      tab.title = e.title || displayUrl(tab.url);
      renderTabs();
      if (tab.id === activeId) document.title = `${tab.title} - Shakti Browser`;
      if (historyLog[0] && historyLog[0].url === tab.url) { historyLog[0].title = tab.title; saveHistory(); }
    });
    wv.addEventListener('page-favicon-updated', (e) => {
      tab.favicon = (e.favicons || [])[0] || null;
      renderTabs();
    });
    wv.addEventListener('did-fail-load', (e) => {
      if (!e.isMainFrame || e.errorCode === -3) return; // -3 = aborted (e.g. a new navigation)
      showError(tab, e.validatedURL || tab.url, e.errorCode, e.errorDescription);
    });
    wv.addEventListener('render-process-gone', () => {
      tab.loading = false;
      showError(tab, tab.url, 'crashed', 'Something went wrong while displaying this web page.');
    });
    wv.addEventListener('update-target-url', (e) => {
      if (tab.id !== activeId) return;
      statusBubble.textContent = e.url || '';
      statusBubble.hidden = !e.url;
    });
    wv.addEventListener('found-in-page', (e) => {
      if (tab.id !== activeId) return;
      const r = e.result || {};
      if (r.finalUpdate !== false) $('find-count').textContent = r.matches ? `${r.activeMatchOrdinal}/${r.matches}` : '0/0';
    });
    wv.addEventListener('enter-html-full-screen', () => document.body.classList.add('page-fullscreen'));
    wv.addEventListener('leave-html-full-screen', () => document.body.classList.remove('page-fullscreen'));

    viewsEl.appendChild(wv);
  }

  function showError(tab, url, code, description) {
    tab.loading = false;
    hideError(tab);
    const el = document.createElement('div');
    el.className = 'error-page';
    let host = url;
    try { host = new URL(url).host || url; } catch (e) { /* keep */ }
    const crashed = code === 'crashed';
    const offline = /INTERNET_DISCONNECTED/.test(description || '');
    const title = crashed ? 'Aw, Snap!' : offline ? 'No internet' : 'This site can’t be reached';
    const detail = crashed ? description
      : offline ? 'Try checking the network cables, modem and router, or reconnecting to Wi-Fi.'
        : `<strong>${escapeHtml(host)}</strong> took too long to respond or refused the connection.`;
    el.innerHTML = `<main>${svg(crashed ? 'i-warn' : 'i-globe')}<h1>${title}</h1><p>${detail}</p><code>${escapeHtml(String(description || ''))}${typeof code === 'number' ? ` (${code})` : ''}</code><div><button>Reload</button></div></main>`;
    el.querySelector('button').addEventListener('click', () => { hideError(tab); navigate(tab, url); });
    tab.errorEl = el;
    viewsEl.appendChild(el);
    showTabView(tab);
    renderTabs();
    if (tab.id === activeId) { stopLoadingBar(); updateToolbar(); }
    tab.loadWaiters.splice(0).forEach((fn) => fn(false));
  }

  function hideError(tab) {
    if (tab.errorEl) { tab.errorEl.remove(); tab.errorEl = null; }
  }

  function canGoBack(tab) {
    if (!tab) return false;
    if (tab.mode === 'internal') return tab.backToWeb;
    return (tab.ready && tab.wv.canGoBack()) || !!tab.internalBack;
  }
  function canGoForward(tab) {
    if (!tab) return false;
    if (tab.mode === 'internal') return tab.forwardToWeb;
    return tab.ready && tab.wv.canGoForward();
  }

  function goBack(tab = activeTab()) {
    if (!tab) return false;
    if (tab.mode === 'internal') {
      if (!tab.backToWeb) return false;
      tab.backToWeb = false;
      showWeb(tab);
      return true;
    }
    if (tab.ready && tab.wv.canGoBack()) { hideError(tab); tab.wv.goBack(); return true; }
    if (tab.internalBack) {
      const url = tab.internalBack;
      showInternal(tab, url);
      tab.forwardToWeb = true;
      updateToolbar();
      return true;
    }
    return false;
  }
  function goForward(tab = activeTab()) {
    if (!tab) return false;
    if (tab.mode === 'internal') {
      if (!tab.forwardToWeb) return false;
      tab.forwardToWeb = false;
      showWeb(tab);
      return true;
    }
    if (tab.ready && tab.wv.canGoForward()) { hideError(tab); tab.wv.goForward(); return true; }
    return false;
  }
  function reload(tab = activeTab(), hard = false) {
    if (!tab) return;
    if (tab.mode === 'internal') { renderInternal(tab); return; }
    if (tab.loading && tab.ready) { tab.wv.stop(); return; }
    if (tab.errorEl) { navigate(tab, tab.url); return; }
    if (!tab.ready) return;
    if (hard) native.tab.action(tab.wcId, 'hard-reload'); else tab.wv.reload();
  }

  function waitForLoad(tab, timeout = 25000) {
    if (!tab || !tab.loading) return new Promise((r) => setTimeout(() => r(true), 50));
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), timeout);
      tab.loadWaiters.push((ok) => { clearTimeout(t); resolve(ok); });
    });
  }

  let loadTimer = null;
  function startLoadingBar() {
    clearTimeout(loadTimer);
    loadingBar.style.transition = 'none';
    loadingBar.style.opacity = '1';
    loadingBar.style.width = '0';
    requestAnimationFrame(() => {
      loadingBar.style.transition = 'width 8s cubic-bezier(.1,.7,.2,1), opacity .3s';
      loadingBar.style.width = '85%';
    });
  }
  function stopLoadingBar() {
    loadingBar.style.transition = 'width .2s, opacity .4s .2s';
    loadingBar.style.width = '100%';
    loadingBar.style.opacity = '0';
  }

  function recordHistory(url, title) {
    if (INCOGNITO || !url || isInternal(url) || !/^https?:/i.test(url)) return;
    const last = historyLog[0];
    if (last && last.url === url) { last.title = title || last.title; last.time = Date.now(); }
    else historyLog.unshift({ url, title: title || displayUrl(url), time: Date.now() });
    if (historyLog.length > 5000) historyLog.length = 5000;
    saveHistory();
  }

  // =========================================================
  // ZOOM
  // =========================================================
  const ZOOM_LEVELS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];
  function setZoom(tab, factor) {
    if (!tab || tab.mode !== 'web' || !tab.ready) return;
    tab.zoom = factor;
    tab.wv.setZoomFactor(factor);
    updateToolbar();
  }
  function zoomStep(dir) {
    const tab = activeTab();
    if (!tab) return;
    const cur = tab.zoom;
    const next = dir > 0 ? ZOOM_LEVELS.find((z) => z > cur + 0.001) : [...ZOOM_LEVELS].reverse().find((z) => z < cur - 0.001);
    if (next) setZoom(tab, next);
  }

  // =========================================================
  // FIND IN PAGE
  // =========================================================
  const findbar = $('findbar');
  const findInput = $('find-input');
  function openFind() {
    const tab = activeTab();
    if (!tab || tab.mode !== 'web' || !tab.ready) return;
    findbar.hidden = false;
    findInput.focus();
    findInput.select();
    if (findInput.value) tab.wv.findInPage(findInput.value);
  }
  function closeFind() {
    if (findbar.hidden) return;
    findbar.hidden = true;
    $('find-count').textContent = '';
    const tab = activeTab();
    if (tab && tab.ready) tab.wv.stopFindInPage('clearSelection');
  }
  function findNext(forward = true) {
    const tab = activeTab();
    if (!tab || !tab.ready || !findInput.value) return;
    tab.wv.findInPage(findInput.value, { forward, findNext: true });
  }
  findInput.addEventListener('input', () => {
    const tab = activeTab();
    if (!tab || !tab.ready) return;
    if (findInput.value) tab.wv.findInPage(findInput.value);
    else { tab.wv.stopFindInPage('clearSelection'); $('find-count').textContent = ''; }
  });
  findInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); findNext(!e.shiftKey); }
    if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
  });
  $('find-next').addEventListener('click', () => findNext(true));
  $('find-prev').addEventListener('click', () => findNext(false));
  $('find-close').addEventListener('click', closeFind);

  // =========================================================
  // TOOLBAR & OMNIBOX
  // =========================================================
  function updateToolbar() {
    const tab = activeTab();
    if (!tab) return;
    btnBack.disabled = !canGoBack(tab);
    btnForward.disabled = !canGoForward(tab);
    btnReload.innerHTML = svg(tab.loading ? 'i-stop' : 'i-reload');
    btnReload.title = tab.loading ? 'Stop loading this page' : 'Reload this page';
    $('btn-home').hidden = !settings.showHomeButton;

    if (document.activeElement !== omniInput) {
      omniInput.value = tab.url === 'shakti://newtab' ? '' : displayUrl(tab.url);
    }
    omniInput.placeholder = `Search ${(SEARCH_ENGINES[settings.searchEngine] || SEARCH_ENGINES.google).name} or type a URL`;

    siteInfo.className = 'omni-chip';
    if (tab.mode === 'internal') {
      siteInfo.classList.add('internal');
      siteInfo.innerHTML = tab.url === 'shakti://newtab' ? svg('i-search') : `${svg('i-sparkle')}<span>Shakti</span>`;
      siteInfo.title = 'Shakti Browser page';
    } else if (/^https:/i.test(tab.url)) {
      siteInfo.classList.add('secure');
      siteInfo.innerHTML = svg('i-lock');
      siteInfo.title = 'Connection is secure';
    } else if (/^http:/i.test(tab.url)) {
      siteInfo.innerHTML = `${svg('i-info')}<span>Not secure</span>`;
      siteInfo.title = 'Your connection to this site is not secure';
    } else {
      siteInfo.innerHTML = svg('i-info');
      siteInfo.title = '';
    }

    const starred = bookmarks.some((b) => b.url === tab.url);
    btnStar.classList.toggle('starred', starred);
    btnStar.innerHTML = svg(starred ? 'i-star-filled' : 'i-star');
    btnStar.style.visibility = tab.mode === 'internal' ? 'hidden' : 'visible';

    const zoomChip = $('zoom-chip');
    const z = tab.mode === 'web' ? tab.zoom : 1;
    zoomChip.hidden = Math.abs(z - 1) < 0.001;
    zoomChip.textContent = Math.round(z * 100) + '%';
    $('menu-zoom-val').textContent = Math.round(z * 100) + '%';

    document.title = tab.title ? `${tab.title} - Shakti Browser` : 'Shakti Browser';
  }

  let suggestions = [];
  let selected = -1;

  function buildSuggestions(text) {
    const q = text.trim().toLowerCase();
    if (!q) return [];
    const out = [];
    const resolved = resolveInput(text);
    const engine = SEARCH_ENGINES[settings.searchEngine] || SEARCH_ENGINES.google;
    const isSearch = resolved === searchUrl(text.trim());
    if (!isSearch) out.push({ kind: 'url', main: displayUrl(resolved), url: resolved, icon: 'i-globe' });
    out.push({ kind: 'search', main: text.trim(), sub: `— ${engine.name} Search`, url: searchUrl(text.trim()), icon: 'i-search' });
    out.push({ kind: 'ai', main: `Ask Shakti AI: “${text.trim()}”`, prompt: text.trim(), icon: 'i-sparkle' });

    const seen = new Set(out.map((s) => s.url));
    const pool = bookmarks.map((b) => ({ ...b, icon: 'i-star-filled' })).concat(historyLog.map((h) => ({ ...h, icon: 'i-history' })));
    for (const item of pool) {
      if (out.length >= 8) break;
      if (seen.has(item.url)) continue;
      if ((item.title || '').toLowerCase().includes(q) || item.url.toLowerCase().includes(q)) {
        seen.add(item.url);
        out.push({ kind: 'url', main: item.title || displayUrl(item.url), sub: displayUrl(item.url), url: item.url, icon: item.icon });
      }
    }
    return out;
  }

  function renderSuggestions() {
    if (!suggestions.length) { omnibox.classList.remove('open'); return; }
    omnibox.classList.add('open');
    omniSuggest.innerHTML = suggestions.map((s, i) => `
      <div class="suggest-item ${s.kind === 'ai' ? 'ai' : ''} ${i === selected ? 'selected' : ''}" data-i="${i}" role="option">
        ${svg(s.icon)}<span class="s-main">${escapeHtml(s.main)}</span>${s.sub ? `<span class="s-url">${escapeHtml(s.sub)}</span>` : ''}
      </div>`).join('');
  }

  function acceptSuggestion(s) {
    closeSuggest();
    omniInput.blur();
    if (s.kind === 'ai') { window.dispatchEvent(new CustomEvent('shakti:ask', { detail: { prompt: s.prompt, send: true } })); return; }
    const tab = activeTab();
    if (tab) navigate(tab, s.url);
  }

  function closeSuggest() {
    suggestions = [];
    selected = -1;
    omnibox.classList.remove('open');
  }

  // Select-all on focus; swallow the first mouseup so the click doesn't
  // collapse the selection (typing right away then replaces the text).
  let selectOnMouseUp = false;
  omniInput.addEventListener('focus', () => { omnibox.classList.add('focused'); omniInput.select(); selectOnMouseUp = true; });
  omniInput.addEventListener('mouseup', (e) => {
    if (selectOnMouseUp && omniInput.selectionStart === omniInput.selectionEnd) { e.preventDefault(); omniInput.select(); }
    selectOnMouseUp = false;
  });
  omniInput.addEventListener('blur', () => {
    omnibox.classList.remove('focused');
    setTimeout(() => { closeSuggest(); updateToolbar(); }, 150);
  });
  omniInput.addEventListener('input', () => {
    suggestions = buildSuggestions(omniInput.value);
    selected = suggestions.length ? 0 : -1;
    renderSuggestions();
  });
  omniInput.addEventListener('keydown', (e) => {
    selectOnMouseUp = false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!suggestions.length) return;
      e.preventDefault();
      selected = (selected + (e.key === 'ArrowDown' ? 1 : -1) + suggestions.length) % suggestions.length;
      renderSuggestions();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const text = omniInput.value;
      // Alt+Enter opens in a new tab, like Chrome
      if (e.altKey && text.trim()) { closeSuggest(); omniInput.blur(); createTab(resolveInput(text)); return; }
      if (selected >= 0 && suggestions[selected] && suggestions[selected].kind !== 'search') acceptSuggestion(suggestions[selected]);
      else if (text.trim()) acceptSuggestion({ kind: 'url', url: resolveInput(text) });
    } else if (e.key === 'Escape') {
      closeSuggest();
      updateToolbar();
      omniInput.select();
    }
  });
  omniSuggest.addEventListener('mousedown', (e) => {
    const item = e.target.closest('.suggest-item');
    if (item) { e.preventDefault(); acceptSuggestion(suggestions[Number(item.dataset.i)]); }
  });

  btnBack.addEventListener('click', () => goBack());
  btnForward.addEventListener('click', () => goForward());
  btnReload.addEventListener('click', (e) => reload(activeTab(), e.shiftKey));
  $('btn-home').addEventListener('click', () => { const t = activeTab(); if (t) navigate(t, settings.homePage || 'shakti://newtab'); });
  $('btn-newtab').addEventListener('click', () => createTab());
  $('tabstrip').addEventListener('dblclick', (e) => {
    if (!IS_MAC && e.target.closest('.tabstrip-drag, .tabs') && !e.target.closest('.tab')) native.window.control('maximize');
  });
  btnStar.addEventListener('click', toggleBookmark);
  $('zoom-chip').addEventListener('click', () => setZoom(activeTab(), 1));
  siteInfo.addEventListener('click', () => {
    const t = activeTab();
    if (!t || t.mode === 'internal') return;
    toast(/^https:/i.test(t.url) ? `Connection to ${displayUrl(t.url).split('/')[0]} is secure` : 'Your connection to this site is not secure');
  });

  function toggleBookmark() {
    const t = activeTab();
    if (!t || t.mode === 'internal') return;
    const i = bookmarks.findIndex((b) => b.url === t.url);
    if (i >= 0) { bookmarks.splice(i, 1); toast('Bookmark removed'); }
    else { bookmarks.push({ title: t.title || displayUrl(t.url), url: t.url }); toast('Bookmark added'); }
    saveBookmarks();
    renderBookmarksBar();
    updateToolbar();
  }

  // =========================================================
  // WINDOW CONTROLS (Windows / Linux; macOS uses native traffic lights)
  // =========================================================
  document.querySelectorAll('#window-controls button').forEach((b) => {
    b.addEventListener('click', () => native.window.control(b.dataset.win));
  });
  native.window.onState((s) => {
    if ('maximized' in s) {
      $('btn-maximize').innerHTML = svg(s.maximized ? 'i-restore' : 'i-max');
      $('btn-maximize').title = s.maximized ? 'Restore' : 'Maximize';
    }
    if ('fullscreen' in s) document.body.classList.toggle('fullscreen', s.fullscreen);
  });

  // =========================================================
  // BOOKMARKS BAR
  // =========================================================
  function renderBookmarksBar() {
    bookmarksBar.classList.toggle('hidden', !settings.showBookmarksBar);
    bookmarksBar.innerHTML = '';
    bookmarks.forEach((b) => {
      const btn = document.createElement('button');
      btn.className = 'bm';
      btn.title = `${b.title}\n${b.url}`;
      btn.innerHTML = `${faviconHtml(b.url, b.title)}<span>${escapeHtml(b.title)}</span>`;
      btn.addEventListener('click', (e) => {
        if (e.ctrlKey || e.metaKey) createTab(b.url, { activate: false });
        else { const t = activeTab(); if (t) navigate(t, b.url); }
      });
      btn.addEventListener('auxclick', (e) => { if (e.button === 1) createTab(b.url, { activate: false }); });
      bookmarksBar.appendChild(btn);
    });
  }

  // =========================================================
  // DOWNLOADS
  // =========================================================
  const downloads = new Map();
  native.onDownload((d) => {
    const isNew = !downloads.has(d.id);
    downloads.set(d.id, d);
    $('btn-downloads').hidden = false;
    $('dl-ring').classList.toggle('active', [...downloads.values()].some((x) => x.state === 'progressing'));
    if (isNew) toast(`Downloading ${d.filename}…`);
    if (d.state === 'completed') toast(`Downloaded ${d.filename}`);
    if (d.state === 'interrupted' || d.state === 'cancelled') toast(`Download failed: ${d.filename}`);
    tabs.filter((t) => t.mode === 'internal' && t.url === 'shakti://downloads').forEach(renderInternal);
  });
  $('btn-downloads').addEventListener('click', () => openInternal('downloads'));

  function formatBytes(n) {
    if (!n) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB'];
    const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
    return (n / Math.pow(1024, i)).toFixed(i ? 1 : 0) + ' ' + u[i];
  }

  // =========================================================
  // INTERNAL PAGES
  // =========================================================
  function renderInternal(tab) {
    const page = tab.url.replace(/^shakti:\/\//, '').replace(/\/.*$/, '') || 'newtab';
    const el = tab.internalEl;
    const renderers = { newtab: renderNewTab, history: renderHistory, bookmarks: renderBookmarksPage, downloads: renderDownloads, settings: renderSettings, about: renderAbout };
    (renderers[page] || renderNotFound)(el, tab);
    if (tab.id === activeId) updateToolbar();
    renderTabs();
  }

  function renderNewTab(el, tab) {
    tab.title = INCOGNITO ? 'New Incognito tab' : 'New Tab';
    if (INCOGNITO) {
      el.innerHTML = `<div class="ntp-incognito">${svg('i-incognito')}<h1>You’ve gone Incognito</h1>
        <p>Others who use this device won’t see your activity. Shakti Browser won’t save your browsing history, cookies and site data, or information entered in forms. These are deleted when you close this window.</p>
        <p>Your activity might still be visible to websites you visit, your employer or school, and your internet service provider.</p>
        <form class="ntp-search" style="margin-top:28px">${svg('i-search')}<input type="text" placeholder="Search or type a URL" autocomplete="off"></form></div>`;
      const f = el.querySelector('form');
      f.addEventListener('submit', (e) => { e.preventDefault(); const v = f.querySelector('input').value; if (v.trim()) navigate(tab, v); });
      if (tab.id === activeId) setTimeout(() => f.querySelector('input').focus(), 0);
      return;
    }
    el.innerHTML = `
      <div class="ntp">
        <div class="ntp-logo" aria-label="Shakti"><span>S</span><span>h</span><span>a</span><span>k</span><span>t</span><span>i</span></div>
        <div class="ntp-sub">Browse faster with a built-in AI agent</div>
        <form class="ntp-search">
          ${svg('i-search')}
          <input type="text" placeholder="Search ${escapeHtml((SEARCH_ENGINES[settings.searchEngine] || SEARCH_ENGINES.google).name)} or type a URL" aria-label="Search" autocomplete="off">
          <button type="button" class="ntp-ask" title="Ask Shakti AI">${svg('i-sparkle')}Ask AI</button>
        </form>
        <div class="ntp-tiles"></div>
        <div class="ntp-foot">Shakti Browser</div>
      </div>`;
    const form = el.querySelector('form');
    const input = form.querySelector('input');
    form.addEventListener('submit', (e) => { e.preventDefault(); if (input.value.trim()) navigate(tab, input.value); });
    form.querySelector('.ntp-ask').addEventListener('click', () => {
      window.dispatchEvent(new CustomEvent('shakti:ask', { detail: { prompt: input.value.trim(), send: !!input.value.trim() } }));
    });
    const grid = el.querySelector('.ntp-tiles');
    tiles.slice(0, 10).forEach((t, i) => {
      const b = document.createElement('div');
      b.className = 'ntp-tile';
      b.tabIndex = 0;
      b.title = t.url;
      b.innerHTML = `<span class="tile-icon">${faviconHtml(t.url, t.title)}</span><span class="tile-label">${escapeHtml(t.title)}</span><button class="tile-remove" title="Remove">${svg('i-close')}</button>`;
      b.addEventListener('click', (e) => {
        if (e.target.closest('.tile-remove')) { tiles.splice(i, 1); saveTiles(); renderNewTab(el, tab); return; }
        navigate(tab, t.url);
      });
      b.addEventListener('keydown', (e) => { if (e.key === 'Enter') navigate(tab, t.url); });
      grid.appendChild(b);
    });
    if (tiles.length < 10) {
      const add = document.createElement('div');
      add.className = 'ntp-tile';
      add.tabIndex = 0;
      add.innerHTML = `<span class="tile-icon">${svg('i-plus')}</span><span class="tile-label">Add shortcut</span>`;
      add.addEventListener('click', () => addShortcutForm(el, tab));
      grid.appendChild(add);
    }
    if (tab.id === activeId) setTimeout(() => input.focus(), 0);
  }

  // prompt() is not available in Electron, so shortcuts use a small inline form.
  function addShortcutForm(el, tab) {
    const box = document.createElement('form');
    box.className = 'icard';
    box.style.cssText = 'margin-top:16px;padding:16px;display:flex;flex-direction:column;gap:8px;width:min(420px,100%)';
    box.innerHTML = `<strong>Add shortcut</strong>
      <input class="isearch" style="margin:0" name="name" placeholder="Name" required>
      <input class="isearch" style="margin:0" name="url" placeholder="URL" required>
      <div style="display:flex;gap:8px;justify-content:flex-end"><button type="button" class="ibtn" data-cancel>Cancel</button><button class="ibtn">Done</button></div>`;
    el.querySelector('.ntp').insertBefore(box, el.querySelector('.ntp-foot'));
    box.querySelector('[name=name]').focus();
    box.querySelector('[data-cancel]').addEventListener('click', () => box.remove());
    box.addEventListener('submit', (e) => {
      e.preventDefault();
      const url = resolveInput(box.url.value);
      if (!url || isInternal(url)) return;
      tiles.push({ title: box.name.value.trim() || displayUrl(url), url });
      saveTiles();
      renderNewTab(el, tab);
    });
  }

  function dayLabel(ts) {
    const d = new Date(ts);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const diff = Math.round((today - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86400000);
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Yesterday';
    return d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  }

  function renderHistory(el, tab) {
    tab.title = 'History';
    el.innerHTML = `<div class="ipage"><h1>${svg('i-history')}History</h1>
      <input class="isearch" type="search" placeholder="Search history">
      <div class="hist"></div>
      <p style="margin-top:20px"><button class="ibtn danger" data-act="clear">Clear browsing data</button></p></div>`;
    const list = el.querySelector('.hist');
    const search = el.querySelector('.isearch');
    function draw() {
      const q = search.value.trim().toLowerCase();
      const items = historyLog.filter((h) => !q || (h.title || '').toLowerCase().includes(q) || h.url.toLowerCase().includes(q));
      if (!items.length) { list.innerHTML = `<div class="icard"><div class="empty">${INCOGNITO ? 'History isn’t saved in Incognito windows.' : 'Pages you visit will appear here.'}</div></div>`; return; }
      const groups = new Map();
      items.slice(0, 500).forEach((h) => {
        const k = dayLabel(h.time);
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(h);
      });
      list.innerHTML = '';
      groups.forEach((rows, label) => {
        const h2 = document.createElement('h2'); h2.textContent = label; list.appendChild(h2);
        const card = document.createElement('div'); card.className = 'icard';
        rows.forEach((h) => {
          const row = document.createElement('div');
          row.className = 'irow';
          row.innerHTML = `<span class="time">${new Date(h.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>${faviconHtml(h.url, h.title)}
            <div class="grow"><div class="ttl">${escapeHtml(h.title)}</div><div class="sub">${escapeHtml(displayUrl(h.url))}</div></div>
            <button class="icon-btn small" title="Remove from history">${svg('i-close')}</button>`;
          row.querySelector('.ttl').addEventListener('click', (e) => (e.ctrlKey || e.metaKey) ? createTab(h.url, { activate: false }) : navigate(tab, h.url));
          row.querySelector('button').addEventListener('click', () => { historyLog = historyLog.filter((x) => x !== h); saveHistory(); draw(); });
          card.appendChild(row);
        });
        list.appendChild(card);
      });
    }
    search.addEventListener('input', draw);
    el.querySelector('[data-act=clear]').addEventListener('click', async () => {
      if (!confirm('Clear browsing history, cookies, site data and cached files?')) return;
      historyLog = []; saveHistory();
      await native.clearData();
      draw();
      toast('Browsing data cleared');
    });
    draw();
  }

  function renderBookmarksPage(el, tab) {
    tab.title = 'Bookmarks';
    el.innerHTML = `<div class="ipage"><h1>${svg('i-star-filled')}Bookmarks</h1>
      <input class="isearch" type="search" placeholder="Search bookmarks"><div class="icard bms"></div></div>`;
    const card = el.querySelector('.bms');
    const search = el.querySelector('.isearch');
    function draw() {
      const q = search.value.trim().toLowerCase();
      const items = bookmarks.filter((b) => !q || b.title.toLowerCase().includes(q) || b.url.toLowerCase().includes(q));
      if (!items.length) { card.innerHTML = `<div class="empty">No bookmarks. Press ${MOD}D or the ☆ in the address bar to add one.</div>`; return; }
      card.innerHTML = '';
      items.forEach((b) => {
        const row = document.createElement('div');
        row.className = 'irow';
        row.innerHTML = `${faviconHtml(b.url, b.title)}<div class="grow"><div class="ttl">${escapeHtml(b.title)}</div><div class="sub">${escapeHtml(b.url)}</div></div>
          <button class="icon-btn small" data-a="up" title="Move up">${svg('i-up')}</button>
          <button class="icon-btn small" data-a="del" title="Delete">${svg('i-close')}</button>`;
        row.querySelector('.ttl').addEventListener('click', () => navigate(tab, b.url));
        row.querySelector('.ttl').addEventListener('dblclick', () => {
          const input = document.createElement('input');
          input.className = 'isearch';
          input.style.margin = '0';
          input.value = b.title;
          row.querySelector('.ttl').replaceWith(input);
          input.focus();
          const commit = () => { if (input.value.trim()) b.title = input.value.trim(); saveBookmarks(); renderBookmarksBar(); draw(); };
          input.addEventListener('keydown', (e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') draw(); });
          input.addEventListener('blur', commit);
        });
        row.querySelector('[data-a=up]').addEventListener('click', () => {
          const i = bookmarks.indexOf(b);
          if (i > 0) { bookmarks.splice(i, 1); bookmarks.splice(i - 1, 0, b); saveBookmarks(); renderBookmarksBar(); draw(); }
        });
        row.querySelector('[data-a=del]').addEventListener('click', () => {
          bookmarks = bookmarks.filter((x) => x !== b); saveBookmarks(); renderBookmarksBar(); draw();
        });
        card.appendChild(row);
      });
    }
    search.addEventListener('input', draw);
    draw();
    el.querySelector('.ipage').insertAdjacentHTML('beforeend', '<p class="sub" style="margin-top:12px">Double-click a bookmark name to rename it.</p>');
  }

  function renderDownloads(el, tab) {
    tab.title = 'Downloads';
    const items = [...downloads.values()].reverse();
    el.innerHTML = `<div class="ipage"><h1>${svg('i-download')}Downloads</h1><div class="icard dls"></div></div>`;
    const card = el.querySelector('.dls');
    if (!items.length) { card.innerHTML = '<div class="empty">Files you download appear here.</div>'; return; }
    items.forEach((d) => {
      const row = document.createElement('div');
      row.className = 'irow';
      const pct = d.total ? Math.round((d.received / d.total) * 100) : 0;
      const status = d.state === 'completed' ? formatBytes(d.total || d.received)
        : d.state === 'progressing' ? `${formatBytes(d.received)} of ${d.total ? formatBytes(d.total) : '?'}`
          : d.state === 'cancelled' ? 'Cancelled' : 'Failed';
      row.innerHTML = `${svg('i-download')}<div class="grow"><div class="ttl">${escapeHtml(d.filename)}</div>
        <div class="sub">${escapeHtml(status)} · ${escapeHtml(displayUrl(d.url))}</div>
        ${d.state === 'progressing' ? `<div class="dl-bar"><i style="width:${pct}%"></i></div>` : ''}
        ${d.state === 'completed' ? '<div style="margin-top:4px"><button class="linkbtn" data-a="open">Open</button><button class="linkbtn" data-a="show">Show in folder</button></div>' : ''}</div>`;
      const open = row.querySelector('[data-a=open]');
      if (open) open.addEventListener('click', () => native.shell.openItem(d.path));
      const show = row.querySelector('[data-a=show]');
      if (show) show.addEventListener('click', () => native.shell.showItem(d.path));
      card.appendChild(row);
    });
  }

  function renderSettings(el, tab) {
    tab.title = 'Settings';
    const engineOpts = Object.entries(SEARCH_ENGINES).map(([k, v]) => `<option value="${k}" ${settings.searchEngine === k ? 'selected' : ''}>${v.name}</option>`).join('');
    el.innerHTML = `<div class="ipage"><h1>${svg('i-settings')}Settings</h1>
      <h2>Shakti AI</h2>
      <div class="icard">
        <div class="irow"><div class="grow"><div class="ai-status">Checking…</div><div class="sub ai-detail"></div></div></div>
        <form class="irow ai-key-form"><div class="grow">Claude API key<div class="sub">Get one at console.anthropic.com. Stored on this device${''}.</div></div>
          <input type="password" name="key" placeholder="sk-ant-…" autocomplete="off" style="width:220px"><button class="ibtn">Save</button></form>
        <div class="irow"><div class="grow sub" style="white-space:normal">With a key, your request and the text of pages the agent reads are sent to the Claude API to answer you. Without one, the offline agent runs only on this device and sends nothing.</div><button class="ibtn danger" data-act="remove-key">Remove key</button></div>
      </div>
      <h2>Search engine</h2>
      <div class="icard"><div class="irow"><div class="grow">Search engine used in the address bar</div><select data-s="searchEngine">${engineOpts}</select></div></div>
      <h2>Appearance</h2>
      <div class="icard">
        <div class="irow"><div class="grow">Theme</div><select data-s="theme">
          <option value="system" ${settings.theme === 'system' ? 'selected' : ''}>Device</option>
          <option value="light" ${settings.theme === 'light' ? 'selected' : ''}>Light</option>
          <option value="dark" ${settings.theme === 'dark' ? 'selected' : ''}>Dark</option></select></div>
        <div class="irow"><div class="grow">Show home button</div><label class="toggle"><input type="checkbox" data-s="showHomeButton" ${settings.showHomeButton ? 'checked' : ''}><span></span></label></div>
        <div class="irow"><div class="grow">Show bookmarks bar</div><label class="toggle"><input type="checkbox" data-s="showBookmarksBar" ${settings.showBookmarksBar ? 'checked' : ''}><span></span></label></div>
      </div>
      <h2>On startup</h2>
      <div class="icard">
        <div class="irow"><div class="grow">Continue where you left off</div><label class="toggle"><input type="checkbox" data-s="restoreSession" ${settings.restoreSession ? 'checked' : ''}><span></span></label></div>
        <div class="irow"><div class="grow">Home page</div><input type="text" class="isearch" style="margin:0;width:260px;border-radius:4px" data-s="homePage" value="${escapeHtml(settings.homePage)}"></div>
      </div>
      <h2>Privacy and security</h2>
      <div class="icard">
        <div class="irow"><div class="grow">Clear browsing data<div class="sub">History, cookies, site data and cached files</div></div><button class="ibtn danger" data-act="clear">Clear data</button></div>
        <div class="irow"><div class="grow">Reset bookmarks and shortcuts<div class="sub">Restore the defaults</div></div><button class="ibtn danger" data-act="reset">Reset</button></div>
      </div>
    </div>`;
    el.querySelectorAll('[data-s]').forEach((input) => {
      input.addEventListener('change', () => {
        const key = input.dataset.s;
        settings[key] = input.type === 'checkbox' ? input.checked : input.value;
        if (key === 'homePage') settings.homePage = resolveInput(input.value) || 'shakti://newtab';
        saveSettings();
        applyTheme();
        renderBookmarksBar();
        updateToolbar();
        toast('Settings saved');
      });
    });
    el.querySelector('[data-act=clear]').addEventListener('click', async () => {
      if (!confirm('Clear browsing history, cookies, site data and cached files?')) return;
      historyLog = []; saveHistory();
      await native.clearData();
      toast('Browsing data cleared');
    });
    el.querySelector('[data-act=reset]').addEventListener('click', () => {
      if (!confirm('Reset bookmarks and new tab shortcuts to the defaults?')) return;
      bookmarks = DEFAULT_BOOKMARKS.slice(); tiles = DEFAULT_TILES.slice();
      saveBookmarks(); saveTiles(); renderBookmarksBar(); toast('Bookmarks and shortcuts reset');
    });

    const keyForm = el.querySelector('.ai-key-form');
    keyForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const key = keyForm.key.value.trim();
      if (!key) return;
      const s = await native.agent.setKey(key);
      keyForm.key.value = '';
      config.agent = s;
      window.dispatchEvent(new CustomEvent('shakti:agent-status', { detail: s }));
      drawStatus();
      toast(s.error || 'Claude API key saved');
    });
    el.querySelector('[data-act=remove-key]').addEventListener('click', async () => {
      const s = await native.agent.setKey('');
      config.agent = s;
      window.dispatchEvent(new CustomEvent('shakti:agent-status', { detail: s }));
      drawStatus();
      toast('API key removed');
    });

    function drawStatus() {
      const a = config.agent;
      el.querySelector('.ai-status').innerHTML = a.available
        ? `<span class="status-dot on"></span>Claude agent is on (${escapeHtml(a.model)})`
        : '<span class="status-dot off"></span>Offline agent (built-in commands only)';
      el.querySelector('.ai-detail').textContent = a.available
        ? `Key from ${a.source === 'settings' ? 'Settings' : 'the ANTHROPIC_API_KEY environment variable'}${a.source === 'settings' && !a.encrypted ? ' · this system has no keychain, so it is stored unencrypted' : ''}`
        : (a.reason || '');
    }
    config.ready.then(drawStatus);
  }

  function renderAbout(el, tab) {
    tab.title = 'About Shakti Browser';
    const ua = navigator.userAgent.match(/Chrome\/([\d.]+)/);
    el.innerHTML = `<div class="ipage"><h1>${svg('i-info')}About Shakti Browser</h1>
      <div class="icard">
        <div class="irow"><img src="../assets/icon.png" alt="" style="width:48px;height:48px;border-radius:12px"><div class="grow"><div style="font-size:16px;font-weight:500">Shakti Browser</div><div class="sub">Chromium ${escapeHtml(ua ? ua[1] : '')} · ${escapeHtml(PLATFORM)}</div></div></div>
        <div class="irow"><div class="grow sub" style="white-space:normal">A fast browser for Windows, macOS and Linux with tabs, bookmarks, history, downloads, Incognito windows and Shakti AI — an agent that can read pages, research across sites and carry out tasks for you.</div></div>
        <div class="irow"><div class="grow">Keyboard shortcuts</div></div>
        <div class="irow"><div class="grow sub" style="white-space:normal">${MOD}T new tab · ${MOD}W close tab · ${MOD}Shift+T reopen tab · ${MOD}N new window · ${MOD}Shift+N Incognito · ${MOD}L address bar · ${MOD}F find · ${MOD}D bookmark · ${MOD}${IS_MAC ? 'Y' : 'H'} history · ${MOD}J downloads · ${MOD}E Shakti AI · ${MOD}+/− zoom</div></div>
      </div></div>`;
  }

  function renderNotFound(el, tab) {
    tab.title = 'Page not found';
    el.innerHTML = `<div class="ipage"><h1>${svg('i-info')}This page doesn’t exist</h1><p class="sub">Try shakti://newtab, shakti://history, shakti://bookmarks, shakti://downloads, shakti://settings or shakti://about.</p></div>`;
  }

  // =========================================================
  // MENU, THEME, TOAST
  // =========================================================
  menu.querySelectorAll('kbd[data-k]').forEach((k) => {
    let key = k.dataset.k;
    if (IS_MAC && key === 'H') key = 'Y';
    if (IS_MAC && key === 'Shift+I') { k.textContent = '⌥⌘I'; return; }
    k.textContent = IS_MAC ? '⌘' + key.replace('Shift+', '⇧') : 'Ctrl+' + key;
  });
  $('btn-menu').addEventListener('click', (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; updateToolbar(); });
  document.addEventListener('mousedown', (e) => { if (!menu.hidden && !e.target.closest('#menu, #btn-menu')) menu.hidden = true; });
  window.addEventListener('blur', () => { menu.hidden = true; });
  menu.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-cmd]');
    if (!b) return;
    if (!b.hasAttribute('data-keep')) menu.hidden = true;
    runCommand(b.dataset.cmd);
  });

  function openInternal(page) {
    const url = 'shakti://' + page;
    const existing = tabs.find((t) => t.url === url);
    if (existing) { switchTo(existing.id); renderInternal(existing); return; }
    const cur = activeTab();
    if (cur && cur.url === 'shakti://newtab') navigate(cur, url);
    else createTab(url);
  }

  function webAction(action) {
    const t = activeTab();
    if (t && t.mode === 'web' && t.ready) native.tab.action(t.wcId, action);
  }

  function runCommand(cmd, payload = {}) {
    const tab = activeTab();
    switch (cmd) {
      case 'new-tab': createTab(); break;
      case 'new-window': native.window.newWindow({}); break;
      case 'new-incognito': native.window.newWindow({ incognito: true }); break;
      case 'close-tab': if (tab) closeTab(tab.id); break;
      case 'reopen-tab': reopenClosedTab(); break;
      case 'focus-omnibox': omniInput.focus(); omniInput.select(); break;
      case 'reload': reload(); break;
      case 'hard-reload': reload(tab, true); break;
      case 'back': goBack(); break;
      case 'forward': goForward(); break;
      case 'bookmark': toggleBookmark(); break;
      case 'history': openInternal('history'); break;
      case 'downloads': openInternal('downloads'); break;
      case 'bookmarks': openInternal('bookmarks'); break;
      case 'settings': openInternal('settings'); break;
      case 'about': openInternal('about'); break;
      case 'toggle-bookmarks-bar': settings.showBookmarksBar = !settings.showBookmarksBar; saveSettings(); renderBookmarksBar(); break;
      case 'toggle-agent': window.dispatchEvent(new CustomEvent('shakti:toggle-agent')); break;
      case 'find': openFind(); break;
      case 'print': webAction('print'); break;
      case 'save-as': webAction('save-as'); break;
      case 'devtools': webAction('devtools'); break;
      case 'zoom-in': zoomStep(1); break;
      case 'zoom-out': zoomStep(-1); break;
      case 'zoom-reset': setZoom(tab, 1); break;
      case 'fullscreen': native.window.control('fullscreen'); break;
      case 'next-tab':
      case 'prev-tab': {
        if (!tabs.length) break;
        const i = tabs.findIndex((t) => t.id === activeId);
        switchTo(tabs[(i + (cmd === 'next-tab' ? 1 : -1) + tabs.length) % tabs.length].id);
        break;
      }
      case 'tab-last': if (tabs.length) switchTo(tabs[tabs.length - 1].id); break;
      case 'escape':
        if (!findbar.hidden) closeFind();
        else if (tab && tab.loading && tab.ready) tab.wv.stop();
        break;
      case 'open-url':
        if (payload.newWindow) native.window.newWindow({ url: payload.url, incognito: INCOGNITO });
        else createTab(payload.url, { activate: !payload.background, index: tabs.indexOf(tab) + 1 });
        break;
      case 'search': createTab(searchUrl(payload.query), { index: tabs.indexOf(tab) + 1 }); break;
      case 'ask': window.dispatchEvent(new CustomEvent('shakti:ask', { detail: { prompt: payload.prompt, send: payload.send !== false } })); break;
      default:
        if (/^tab-[1-8]$/.test(cmd)) { const t = tabs[Number(cmd.slice(4)) - 1]; if (t) switchTo(t.id); }
    }
  }
  native.onCommand(({ cmd, ...payload }) => runCommand(cmd, payload));

  // Escape inside the UI (main process leaves it to us)
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!menu.hidden) { menu.hidden = true; return; }
      if (!findbar.hidden && document.activeElement !== findInput) closeFind();
    }
  });

  function applyTheme() {
    if (INCOGNITO || settings.theme === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', settings.theme);
  }

  let toastTimer = null;
  function toast(text) {
    const t = $('toast');
    t.textContent = text;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
  }

  // =========================================================
  // START
  // =========================================================
  applyTheme();
  renderBookmarksBar();
  updateToolbar();

  const startUrl = params.get('url');
  const session = (!INCOGNITO && settings.restoreSession) ? store.get('session', []) : [];
  if (startUrl) createTab(startUrl);
  else if (session.length) session.slice(0, 30).forEach((u, i) => createTab(u, { activate: i === 0 }));
  else createTab('shakti://newtab');

  // =========================================================
  // PUBLIC API (used by agent.js)
  // =========================================================
  window.ShaktiBrowser = {
    config,
    incognito: INCOGNITO,
    activeTab,
    listTabs: () => tabs.map((t, i) => ({ index: i, title: t.title, url: t.url, active: t.id === activeId })),
    newTab: (url) => createTab(url || 'shakti://newtab', { index: tabs.indexOf(activeTab()) + 1 }),
    switchTab: (index) => { if (tabs[index]) { switchTo(tabs[index].id); return true; } return false; },
    closeTab: (index) => { if (tabs[index] && tabs.length > 1) { closeTab(tabs[index].id); return true; } return false; },
    navigate: (url) => { const t = activeTab(); if (t) navigate(t, url); return t; },
    search: (q) => { const t = activeTab(); if (t) navigate(t, searchUrl(q)); return t; },
    back: () => goBack(),
    forward: () => goForward(),
    reload: () => reload(),
    waitForLoad,
    pageRun: async (tab, cmd, args) => {
      if (!tab || tab.mode !== 'web') return { error: 'This tab shows a Shakti Browser page, not a website. Navigate or search first.' };
      if (!tab.ready) await waitForLoad(tab);
      if (!tab.wcId) return { error: 'The page is not ready yet.' };
      return native.page.run(tab.wcId, cmd, args);
    },
    resolveInput,
    displayUrl,
    toast,
    setAgentButton: (on) => $('btn-agent').classList.toggle('active', on)
  };
})();
