/*
 * SHAKTI BROWSER — Shakti AI agent
 *
 * Side panel that can read pages and operate the browser.
 *
 *  - Claude mode: the main process sends each turn to the Claude API with
 *    the browser tools (read_page, navigate, search, click, type_text,
 *    scroll, tabs, history). Tools run here; this file runs the loop.
 *  - Offline mode: a built-in command agent (open / search / summarize /
 *    find / tabs …) that sends nothing anywhere.
 */
(function () {
  'use strict';

  const B = window.ShaktiBrowser;
  const $ = (id) => document.getElementById(id);
  const panel = $('agent-panel');
  const log = $('agent-log');
  const welcome = $('agent-welcome');
  const form = $('agent-form');
  const input = $('agent-text');
  const sendBtn = $('agent-send');
  const modeBadge = $('agent-mode');
  const foot = $('agent-foot');

  const MAX_STEPS = 25;
  let messages = [];      // Claude conversation (append-only; blocks passed back unchanged)
  let running = false;
  let stopRequested = false;

  // =========================================================
  // PANEL
  // =========================================================
  function openPanel(show) {
    panel.hidden = show === undefined ? !panel.hidden : !show;
    B.setAgentButton(!panel.hidden);
    if (!panel.hidden) setTimeout(() => input.focus(), 0);
  }

  $('btn-agent').addEventListener('click', () => openPanel());
  $('agent-close').addEventListener('click', () => openPanel(false));
  $('agent-new').addEventListener('click', () => {
    if (running) stopRequested = true;
    messages = [];
    log.querySelectorAll(':scope > :not(#agent-welcome)').forEach((n) => n.remove());
    welcome.hidden = false;
    input.focus();
  });
  window.addEventListener('shakti:toggle-agent', () => openPanel());
  window.addEventListener('shakti:ask', (e) => {
    openPanel(true);
    const prompt = (e.detail && e.detail.prompt) || '';
    if (!prompt) return;
    if (e.detail.send === false) { input.value = prompt; autosize(); input.focus(); }
    else submit(prompt);
  });

  welcome.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-prompt]');
    if (b) submit(b.dataset.prompt);
  });

  input.addEventListener('input', autosize);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); }
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (running) { stopRequested = true; return; }
    const text = input.value.trim();
    if (text) submit(text);
  });

  function autosize() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 140) + 'px';
  }

  function setRunning(on) {
    running = on;
    stopRequested = false;
    sendBtn.classList.toggle('stop', on);
    sendBtn.title = on ? 'Stop' : 'Send';
    sendBtn.innerHTML = on ? '<svg><use href="#i-stop"/></svg>' : '<svg><use href="#i-send"/></svg>';
  }

  function showMode(a) {
    if (a.available) {
      modeBadge.textContent = 'Claude';
      modeBadge.className = 'agent-mode claude';
      modeBadge.title = a.model;
      foot.textContent = 'Shakti AI uses Claude and can make mistakes. Pages it reads are sent to the Claude API.';
    } else {
      modeBadge.textContent = 'Offline';
      modeBadge.className = 'agent-mode';
      modeBadge.title = a.reason || '';
      foot.textContent = 'Offline agent: runs on this device. ' + (a.reason || '');
    }
  }
  B.config.ready.then(() => showMode(B.config.agent));
  window.addEventListener('shakti:agent-status', (e) => showMode(e.detail));

  // =========================================================
  // RENDERING
  // =========================================================
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // Small, safe markdown subset: paragraphs, lists, **bold**, *italic*, `code`, links.
  function md(text) {
    const inline = (s) => esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" data-link="$2">$1</a>')
      .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" data-link="$2">$2</a>');
    const lines = String(text).split('\n');
    let html = '';
    let list = null;
    for (const raw of lines) {
      const line = raw.trimEnd();
      const ul = line.match(/^\s*[-*•]\s+(.*)/);
      const ol = line.match(/^\s*\d+[.)]\s+(.*)/);
      const h = line.match(/^#{1,4}\s+(.*)/);
      if (ul || ol) {
        const tag = ul ? 'ul' : 'ol';
        if (list !== tag) { if (list) html += `</${list}>`; html += `<${tag}>`; list = tag; }
        html += `<li>${inline((ul || ol)[1])}</li>`;
        continue;
      }
      if (list) { html += `</${list}>`; list = null; }
      if (h) html += `<p><strong>${inline(h[1])}</strong></p>`;
      else if (line.trim()) html += `<p>${inline(line)}</p>`;
    }
    if (list) html += `</${list}>`;
    return html;
  }

  log.addEventListener('click', (e) => {
    const a = e.target.closest('a[data-link]');
    if (!a) return;
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) B.newTab(a.dataset.link); else B.navigate(a.dataset.link);
  });

  function add(node) {
    welcome.hidden = true;
    log.appendChild(node);
    log.scrollTop = log.scrollHeight;
    return node;
  }

  function addUser(text) {
    const d = document.createElement('div');
    d.className = 'msg user';
    d.textContent = text;
    return add(d);
  }

  function addAssistant(text) {
    const d = document.createElement('div');
    d.className = 'msg assistant';
    d.innerHTML = md(text);
    return add(d);
  }

  function addError(text) {
    const d = document.createElement('div');
    d.className = 'msg error';
    d.textContent = text;
    return add(d);
  }

  function addStep(text) {
    const d = document.createElement('div');
    d.className = 'step running';
    d.innerHTML = `<i class="dot"></i><span>${esc(text)}</span>`;
    add(d);
    return {
      done(ok = true, note) {
        d.className = 'step ' + (ok ? 'done' : 'failed');
        if (note) d.querySelector('span').textContent = text + ' — ' + note;
      }
    };
  }

  function addThinking() {
    const d = document.createElement('div');
    d.className = 'thinking';
    d.innerHTML = '<i></i><i></i><i></i>';
    add(d);
    return { remove: () => d.remove() };
  }

  // =========================================================
  // BROWSER TOOLS (shared by Claude and offline modes)
  // =========================================================
  function short(url) { return B.displayUrl(url).slice(0, 60); }

  const tools = {
    async read_page() {
      const tab = B.activeTab();
      if (!tab) return { error: 'No active tab' };
      if (tab.mode === 'internal') {
        return { url: tab.url, title: tab.title, text: '(Shakti Browser internal page — nothing to read. Navigate or search first.)', elements: [] };
      }
      await B.waitForLoad(tab);
      return B.pageRun(tab, 'read', { maxChars: 12000 });
    },
    async navigate({ url }) {
      const target = B.resolveInput(url);
      if (!target || !/^(https?|shakti):/i.test(target)) return { error: 'Unsupported URL' };
      const tab = B.navigate(target);
      await new Promise((r) => setTimeout(r, 300));
      const ok = await B.waitForLoad(tab);
      return { ok, url: tab.url, title: tab.title, note: ok ? undefined : 'Page is still loading or failed to load.' };
    },
    async search({ query }) {
      const tab = B.search(query);
      await new Promise((r) => setTimeout(r, 300));
      const ok = await B.waitForLoad(tab);
      return { ok, url: tab.url, title: tab.title, hint: 'Call read_page to see the results.' };
    },
    async click({ element_id }) {
      const tab = B.activeTab();
      const before = tab && tab.url;
      const res = await B.pageRun(tab, 'click', { element_id });
      if (res && res.error) return res;
      await new Promise((r) => setTimeout(r, 700));
      const now = B.activeTab();
      if (now) await B.waitForLoad(now);
      return Object.assign({}, res, { url: now && now.url, navigated: !!now && (now !== tab || now.url !== before) });
    },
    async type_text({ element_id, text, submit }) {
      const tab = B.activeTab();
      const res = await B.pageRun(tab, 'type', { element_id, text, submit: !!submit });
      if (res && res.error) return res;
      if (submit) {
        await new Promise((r) => setTimeout(r, 700));
        const now = B.activeTab();
        if (now) await B.waitForLoad(now);
        return Object.assign({}, res, { url: now && now.url });
      }
      return res;
    },
    async scroll({ direction }) {
      return B.pageRun(B.activeTab(), 'scroll', { direction });
    },
    async tabs({ action, url, index }) {
      if (action === 'list') return { tabs: B.listTabs() };
      if (action === 'new') {
        const tab = B.newTab(url ? B.resolveInput(url) : undefined);
        await new Promise((r) => setTimeout(r, 300));
        await B.waitForLoad(tab);
        return { ok: true, tabs: B.listTabs() };
      }
      if (action === 'switch') return { ok: B.switchTab(index), tabs: B.listTabs() };
      if (action === 'close') return { ok: B.closeTab(index), tabs: B.listTabs() };
      return { error: 'Unknown action' };
    },
    async history({ action }) {
      if (action === 'back') B.back();
      else if (action === 'forward') B.forward();
      else B.reload();
      await new Promise((r) => setTimeout(r, 300));
      const tab = B.activeTab();
      await B.waitForLoad(tab);
      return { url: tab.url, title: tab.title };
    }
  };

  function describe(name, input) {
    switch (name) {
      case 'read_page': return 'Reading the page';
      case 'navigate': return `Opening ${short(B.resolveInput(input.url) || input.url)}`;
      case 'search': return `Searching “${input.query}”`;
      case 'click': return `Clicking element #${input.element_id}`;
      case 'type_text': return `Typing “${String(input.text).slice(0, 40)}”${input.submit ? ' and submitting' : ''}`;
      case 'scroll': return `Scrolling ${input.direction}`;
      case 'tabs': return input.action === 'list' ? 'Checking open tabs' : `Tabs: ${input.action}${input.url ? ' ' + short(input.url) : ''}`;
      case 'history': return input.action === 'reload' ? 'Reloading' : `Going ${input.action}`;
      default: return name;
    }
  }

  async function runTool(name, input) {
    const step = addStep(describe(name, input || {}));
    try {
      const fn = tools[name];
      const result = fn ? await fn(input || {}) : { error: `Unknown tool ${name}` };
      const failed = !result || !!result.error;
      step.done(!failed, failed && result ? String(result.error).slice(0, 80) : '');
      return result || { error: 'No result' };
    } catch (err) {
      step.done(false, String(err.message || err));
      return { error: String(err.message || err) };
    }
  }

  // =========================================================
  // SUBMIT
  // =========================================================
  async function submit(text) {
    if (running) return;
    input.value = '';
    autosize();
    addUser(text);
    setRunning(true);
    try {
      await B.config.ready;
      if (B.config.agent.available) await runClaude(text);
      else await runOffline(text);
    } catch (err) {
      addError(String(err.message || err));
    } finally {
      setRunning(false);
    }
  }

  // =========================================================
  // CLAUDE MODE — tool-use loop; tools execute here in the browser
  // =========================================================
  async function runClaude(text) {
    const tab = B.activeTab();
    const ctx = tab ? `[Active tab: "${tab.title}" — ${tab.url}]\n\n` : '';
    messages.push({ role: 'user', content: ctx + text });

    for (let step = 0; step < MAX_STEPS; step++) {
      if (stopRequested) { addError('Stopped.'); return; }
      const wait = addThinking();
      let data;
      try {
        data = await window.shakti.agent.turn(messages);
        if (!data || data.error) throw new Error((data && data.error) || 'No response');
      } catch (err) {
        wait.remove();
        addError('Shakti AI could not answer: ' + (err.message || err));
        // Keep the conversation valid: drop the unanswered user turn.
        if (messages.length && messages[messages.length - 1].role === 'user' && step === 0) messages.pop();
        else closeDanglingToolUse('The request failed before this tool ran.');
        return;
      }
      wait.remove();

      const content = Array.isArray(data.content) ? data.content : [];
      messages.push({ role: 'assistant', content });

      for (const block of content) {
        if (block.type === 'text' && block.text && block.text.trim()) addAssistant(block.text);
      }

      if (data.stop_reason === 'refusal') {
        addError('Shakti AI declined this request.');
        return;
      }
      if (data.stop_reason !== 'tool_use') {
        if (data.stop_reason === 'max_tokens') addError('The answer was cut off (too long).');
        return;
      }

      const uses = content.filter((b) => b.type === 'tool_use');
      const results = [];
      for (const use of uses) {
        if (stopRequested) {
          results.push({ type: 'tool_result', tool_use_id: use.id, content: 'Stopped by the user.', is_error: true });
          continue;
        }
        const result = await runTool(use.name, use.input);
        results.push({
          type: 'tool_result',
          tool_use_id: use.id,
          content: JSON.stringify(result),
          is_error: !!(result && result.error)
        });
      }
      messages.push({ role: 'user', content: results });
      if (stopRequested) { addError('Stopped.'); return; }
    }
    addError(`Stopped after ${MAX_STEPS} steps. Ask me to continue if needed.`);
  }

  // If a turn ended with tool_use blocks but no results, add error results
  // so the next request is still a valid conversation.
  function closeDanglingToolUse(reason) {
    const last = messages[messages.length - 1];
    if (!last || last.role !== 'assistant' || !Array.isArray(last.content)) return;
    const uses = last.content.filter((b) => b.type === 'tool_use');
    if (!uses.length) return;
    messages.push({ role: 'user', content: uses.map((u) => ({ type: 'tool_result', tool_use_id: u.id, content: reason, is_error: true })) });
  }

  // =========================================================
  // OFFLINE MODE — built-in command agent
  // =========================================================
  const STOP = new Set('the a an and or of to in on for is are was were be been it this that with as at by from his her their its our your you we they he she i not but have has had will would can could should may also more most such than then there these those which who whom what when where how all any each other some into about over after before between under only very just out up so if no yes do does did'.split(' '));

  function summarize(text, n = 5) {
    const sentences = (text.replace(/\s+/g, ' ').match(/[^.!?।]+[.!?।]+/g) || [])
      .map((s) => s.trim()).filter((s) => s.length > 40 && s.length < 400);
    if (!sentences.length) return [];
    const freq = new Map();
    for (const w of text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || []) {
      if (!STOP.has(w)) freq.set(w, (freq.get(w) || 0) + 1);
    }
    const scored = sentences.map((s, i) => {
      const words = s.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || [];
      const score = words.reduce((a, w) => a + (freq.get(w) || 0), 0) / Math.sqrt(words.length + 1);
      return { s, i, score: score * (i < 3 ? 1.3 : 1) };
    });
    const seen = new Set();
    return scored.sort((a, b) => b.score - a.score)
      .filter((x) => { const k = x.s.slice(0, 50); if (seen.has(k)) return false; seen.add(k); return true; })
      .slice(0, n).sort((a, b) => a.i - b.i).map((x) => x.s);
  }

  async function runOffline(text) {
    const t = text.trim();
    const low = t.toLowerCase();
    let m;

    if ((m = t.match(/^(?:please\s+)?(?:open|go to|goto|visit|navigate to|load|खोलो|खोलें)\s+(.+?)(?:\s+in (?:a )?new tab)?$/i))) {
      const target = m[1].replace(/\s+(website|site|page)$/i, '');
      if (/new tab/i.test(t)) await runTool('tabs', { action: 'new', url: target });
      else await runTool('navigate', { url: /\s/.test(target) ? target : target });
      addAssistant(`Opened **${B.activeTab().title}**.`);
      return;
    }
    if ((m = t.match(/^(?:search(?: the web)?(?: for)?|google|look up|find on (?:the )?web|खोजो|खोजें)\s+(.+)$/i))) {
      await runTool('search', { query: m[1] });
      addAssistant(`Here are the results for **${m[1]}**.`);
      return;
    }
    if (/^(new tab|open (a )?new tab)$/i.test(low)) { await runTool('tabs', { action: 'new' }); addAssistant('Opened a new tab.'); return; }
    if (/^close (this |the )?tab$/i.test(low)) { const i = B.listTabs().findIndex((x) => x.active); await runTool('tabs', { action: 'close', index: i }); addAssistant('Closed the tab.'); return; }
    if (/^(go )?back$/i.test(low)) { await runTool('history', { action: 'back' }); addAssistant('Went back.'); return; }
    if (/^(go )?forward$/i.test(low)) { await runTool('history', { action: 'forward' }); addAssistant('Went forward.'); return; }
    if (/^(reload|refresh)( (the )?page)?$/i.test(low)) { await runTool('history', { action: 'reload' }); addAssistant('Reloaded.'); return; }
    if ((m = low.match(/^scroll (up|down|to (?:the )?(top|bottom))/))) {
      await runTool('scroll', { direction: m[2] || m[1] });
      addAssistant('Done.');
      return;
    }
    if (/^(list |show )?(my )?(open )?tabs$/i.test(low)) {
      const r = await runTool('tabs', { action: 'list' });
      addAssistant(r.tabs.map((x) => `- ${x.active ? '**' : ''}${x.title}${x.active ? '**' : ''} — ${short(x.url)}`).join('\n'));
      return;
    }

    if (/summar|key points|tl;?dr|सारांश|what is this page|about this page/i.test(low)) {
      const page = await runTool('read_page', {});
      if (page.error) { addAssistant(page.error); return; }
      const pts = summarize(page.text || '', /key points/i.test(low) ? 6 : 5);
      if (!pts.length) { addAssistant(`I couldn't find enough text to summarize on **${page.title}**.`); return; }
      addAssistant(`**${page.title}**\n\n${pts.map((p) => '- ' + p).join('\n')}\n\n*Offline extractive summary. Connect Claude for real answers.*`);
      return;
    }
    if ((m = t.match(/^(?:find|where is|locate)\s+["“]?(.+?)["”]?(?:\s+(?:on|in) (?:this|the) page)?$/i))) {
      const page = await runTool('read_page', {});
      if (page.error) { addAssistant(page.error); return; }
      const q = m[1].toLowerCase();
      const hits = (page.text || '').split(/\n+/).filter((l) => l.toLowerCase().includes(q)).slice(0, 5);
      const links = (page.elements || []).filter((el) => el.text.toLowerCase().includes(q)).slice(0, 5);
      if (!hits.length && !links.length) { addAssistant(`I couldn't find “${m[1]}” on this page.`); return; }
      let out = hits.length ? `Found “${m[1]}”:\n${hits.map((h) => '- ' + h.slice(0, 200)).join('\n')}` : '';
      if (links.length) out += `\n\nMatching links:\n${links.filter((l) => l.href).map((l) => `- [${l.text || l.href}](${l.href})`).join('\n')}`;
      addAssistant(out.trim());
      return;
    }
    if (/^(show |list )?(the )?links/i.test(low)) {
      const page = await runTool('read_page', {});
      if (page.error) { addAssistant(page.error); return; }
      const links = (page.elements || []).filter((e) => e.href && e.text).slice(0, 15);
      addAssistant(links.length ? links.map((l) => `- [${l.text}](${l.href})`).join('\n') : 'No links found.');
      return;
    }

    // Anything else: treat it as a web search.
    await runTool('search', { query: t });
    addAssistant(`I'm in **offline mode**, so I searched the web for that.\n\nI understand commands like: *open wikipedia.org*, *search RISC-V news*, *summarize this page*, *find "admission" on this page*, *list tabs*, *go back*.\n\nFor the full AI agent, add a Claude API key in **Settings**.`);
  }
})();
