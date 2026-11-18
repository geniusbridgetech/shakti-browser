/*
 * SHAKTI BROWSER — page tools for the AI agent
 *
 * Runs inside web pages in an *isolated world*: it shares the page's DOM
 * but not its JavaScript, so page scripts cannot tamper with these
 * functions or see what the agent does.
 */
'use strict';

const ISOLATED_WORLD_ID = 1999;

// This function is serialized and executed in the page. It must be
// self-contained (no closures over this module).
function pageCommand(cmd, args) {
  const INTERACTIVE = 'a[href], button, input:not([type=hidden]), textarea, select, [role=button], [role=link], [role=tab], [role=menuitem], [role=checkbox], [contenteditable=true], summary';
  const state = window.__shaktiAgentState || (window.__shaktiAgentState = { next: 1, map: new WeakMap(), byId: new Map() });

  function visible(el) {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0;
  }
  function label(el) {
    let t = el.getAttribute('aria-label') || el.innerText || el.value || el.getAttribute('placeholder') ||
      el.getAttribute('title') || el.getAttribute('alt') || el.getAttribute('name') || '';
    if (!t) { const img = el.querySelector && el.querySelector('img[alt]'); if (img) t = img.getAttribute('alt'); }
    return String(t).replace(/\s+/g, ' ').trim().slice(0, 100);
  }
  function idFor(el) {
    let id = state.map.get(el);
    if (!id) { id = state.next++; state.map.set(el, id); state.byId.set(id, new WeakRef(el)); }
    return id;
  }
  function byId(id) {
    const ref = state.byId.get(Number(id));
    const el = ref && ref.deref();
    return el && el.isConnected ? el : null;
  }
  function flash(el) {
    const prev = el.style.outline, prevOff = el.style.outlineOffset;
    el.style.outline = '3px solid #FF9933';
    el.style.outlineOffset = '2px';
    setTimeout(() => { el.style.outline = prev; el.style.outlineOffset = prevOff; }, 900);
  }
  function sensitive(el) {
    const hint = `${el.type || ''} ${el.autocomplete || ''} ${el.name || ''} ${el.id || ''}`.toLowerCase();
    return el.type === 'password' || /cc-|card|cvv|cvc|otp|one-time|pin\b|password/.test(hint);
  }

  if (cmd === 'read') {
    const maxChars = args.maxChars || 12000;
    const elements = [];
    for (const el of document.querySelectorAll(INTERACTIVE)) {
      if (elements.length >= 150) break;
      if (!visible(el)) continue;
      const item = { id: idFor(el), tag: el.tagName.toLowerCase(), text: label(el) };
      if (el.tagName === 'A') item.href = el.href;
      if (el.tagName === 'INPUT') item.type = (el.type || 'text').toLowerCase();
      if ((el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && !sensitive(el)) item.value = String(el.value || '').slice(0, 80);
      if (el.tagName === 'SELECT') item.options = Array.from(el.options).slice(0, 20).map((o) => o.text);
      elements.push(item);
    }
    const text = (document.body ? document.body.innerText : '').replace(/\n{3,}/g, '\n\n').trim();
    return {
      url: location.href,
      title: document.title,
      text: text.slice(0, maxChars),
      text_truncated: text.length > maxChars,
      scroll: { y: Math.round(scrollY), height: document.documentElement.scrollHeight, viewport: innerHeight },
      elements
    };
  }

  // Clicks and typing are delivered by the main process as real (trusted)
  // input events; these commands only find, scroll to and prepare the element.
  function centerOf(el) {
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const r = el.getBoundingClientRect();
    const x = Math.round(r.left + Math.min(r.width / 2, Math.max(4, r.width - 4)));
    const y = Math.round(r.top + r.height / 2);
    if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return null;
    return { x, y };
  }

  if (cmd === 'prepare-click') {
    const el = byId(args.element_id);
    if (!el) return { error: `No element with id ${args.element_id}. Call read_page again.` };
    const pt = centerOf(el);
    if (!pt) return { error: 'The element is not on screen.' };
    flash(el);
    return { ok: true, x: pt.x, y: pt.y, label: label(el) };
  }

  if (cmd === 'prepare-type') {
    const el = byId(args.element_id);
    if (!el) return { error: `No element with id ${args.element_id}. Call read_page again.` };
    if (sensitive(el)) return { error: 'Refused: this looks like a password, payment or one-time-code field. Ask the user to fill it in.' };
    centerOf(el);
    flash(el);
    if (el.tagName === 'SELECT') {
      const want = String(args.text).trim().toLowerCase();
      const opt = Array.from(el.options).find((o) => o.text.trim().toLowerCase() === want || o.value === args.text);
      if (!opt) return { error: 'No such option. Options: ' + Array.from(el.options).map((o) => o.text).join(', ') };
      el.value = opt.value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, done: true };
    }
    el.focus();
    // Select existing content so the typed text replaces it.
    if (el.isContentEditable) {
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
    } else if (typeof el.select === 'function') {
      el.select();
    }
    if (document.activeElement !== el && !el.contains(document.activeElement)) return { error: 'Could not focus this element.' };
    return { ok: true };
  }

  if (cmd === 'scroll') {
    const d = args.direction;
    if (d === 'top') scrollTo({ top: 0, behavior: 'smooth' });
    else if (d === 'bottom') scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' });
    else scrollBy({ top: (d === 'up' ? -0.85 : 0.85) * innerHeight, behavior: 'smooth' });
    return { ok: true };
  }

  return { error: 'Unknown command ' + cmd };
}

async function exec(contents, cmd, args) {
  const code = `(${pageCommand.toString()})(${JSON.stringify(cmd)}, ${JSON.stringify(args)})`;
  try {
    const result = await Promise.race([
      contents.executeJavaScriptInIsolatedWorld(ISOLATED_WORLD_ID, [{ code }], true),
      new Promise((resolve) => setTimeout(() => resolve({ error: 'The page did not respond.' }), 10000))
    ]);
    return result == null ? { error: 'No result from the page.' } : result;
  } catch (err) {
    return { error: String(err && err.message || err) };
  }
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

async function run(contents, cmd, args) {
  if (cmd === 'click') {
    const res = await exec(contents, 'prepare-click', args);
    if (res.error) return res;
    const zoom = contents.getZoomFactor() || 1;
    const x = Math.round(res.x * zoom);
    const y = Math.round(res.y * zoom);
    contents.focus();
    contents.sendInputEvent({ type: 'mouseMove', x, y });
    await pause(30);
    contents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    await pause(40);
    contents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    return { ok: true, clicked: res.label };
  }
  if (cmd === 'type') {
    const res = await exec(contents, 'prepare-type', args);
    if (res.error || res.done) return res.error ? res : { ok: true };
    contents.focus();
    await contents.insertText(String(args.text));
    if (args.submit) {
      await pause(50);
      contents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
      contents.sendInputEvent({ type: 'char', keyCode: '\r' });
      contents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
    }
    return { ok: true };
  }
  return exec(contents, cmd, args);
}

module.exports = { run };
