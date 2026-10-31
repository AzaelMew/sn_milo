// ISOLATED, top document only. The iframe runs the native workspace: no assignment/presence APIs or synthetic actions.
(() => {
  'use strict';
  if (window !== window.top || !/^https:\/\/[^/]+$/.test(location.origin)) return;
  // Same-world reinjection must not discard an already-subscribed native workspace.
  if (globalThis.__snMiloInboxOverlay?.active) return;
  const settings = globalThis.__snMiloController;
  if (typeof settings?.subscribe !== 'function') return;
  let unsubscribe = null;
  let host = null, panel = null, toggle = null, frame = null, scanTimer = null;
  let selected = null, status = null, loadTimeout = null;
  let presenceEl = null, menuEl = null, presenceObserver = null, presenceRoot = null, outsideHandler = null, menuSig = '';
  const PRESENCE_LABEL = /^Agent presence state:\s*(\S.*?)\s*$/i;
  const STATE_COLORS = {available:'green', online:'green', offline:'red', busy:'yellow', away:'yellow', wrapup:'yellow'};
  const colorOf = name => (name && STATE_COLORS[name.toLowerCase().replace(/[^a-z]/g, '')]) || 'grey';
  // Native unread count: the selected Inbox's own shadow root announces "N work item(s) in Inbox" for assistive tech.
  // We only read that text (no requests, sound, notifications or storage). Unknown/malformed => no dot.
  const COUNT_TEXT = /^\s*(\d+)\s+work items? in Inbox\s*$/i;
  let countObserver = null, countRoot = null, dotEl = null;
  // Hoisted native popovers (presence, alert settings) are body-level now-popover-panel nodes that inherit our root
  // visibility mask and sit below the fixed Inbox. Raise only panels whose seismic-hoist target-for references a
  // component that lives inside the selected Inbox. Geometry and events stay native; we touch three properties only.
  const POP_PROPS = {visibility: 'visible', position: 'relative', 'z-index': '2147483647'};
  let observer = null, observedDoc = null;
  const raised = new Map();
  function descendants(root, out = []) {
    for (const el of root.querySelectorAll('*')) { out.push(el); if (el.shadowRoot) descendants(el.shadowRoot, out); }
    return out;
  }
  function ownedRefs(inbox) {
    const refs = new Set();
    for (const el of descendants(inbox.shadowRoot || inbox)) {
      const id = el.getAttribute?.('component-id');
      if (id) refs.add(`${el.localName}[component-id="${id}"]`);
    }
    return refs;
  }
  function restorePopovers() {
    for (const [panel, saved] of raised) {
      for (const key of Object.keys(POP_PROPS)) {
        panel.style.removeProperty(key);
        if (saved[key]?.value) panel.style.setProperty(key, saved[key].value, saved[key].priority);
      }
    }
    raised.clear();
  }
  function stopObserving() { observer?.disconnect(); observer = observedDoc = null; restorePopovers(); }
  function raisePopovers() {
    const doc = observedDoc;
    if (!doc?.body || !selected || selected.ownerDocument !== doc) return;
    const refs = ownedRefs(selected);
    for (const panel of doc.body.children) {
      if (panel.localName !== 'now-popover-panel' || raised.has(panel)) continue;
      const targets = descendants(panel).filter(el => el.localName === 'seismic-hoist').map(el => el.getAttribute('target-for'));
      if (!targets.length || !targets.every(t => t && refs.has(t.trim()))) continue;
      const saved = {};
      for (const key of Object.keys(POP_PROPS)) saved[key] = {value: panel.style.getPropertyValue(key), priority: panel.style.getPropertyPriority(key)};
      raised.set(panel, saved);
      css(panel, POP_PROPS);
    }
  }
  function observePopovers(doc) {
    if (observedDoc === doc) return;
    stopObserving();
    const Observer = doc.defaultView?.MutationObserver;
    if (!Observer) return;
    observedDoc = doc;
    observer = new Observer(() => { if (observer) { try { raisePopovers(); } catch {} } });
    observer.observe(doc.documentElement, {childList: true, subtree: true});
  }
  function setBadge(count) {
    if (!toggle || !dotEl) return;
    if (count > 0) {
      dotEl.hidden = false;
      toggle.setAttribute('aria-label', `Inbox, ${count} work ${count === 1 ? 'item' : 'items'}`);
    } else { dotEl.hidden = true; toggle.removeAttribute('aria-label'); }
  }
  function readCount() {
    try {
      const m = COUNT_TEXT.exec(selected?.shadowRoot?.querySelector('.test-announce-work-items')?.textContent ?? '');
      const n = m ? Number(m[1]) : NaN;
      return Number.isSafeInteger(n) ? n : null;
    } catch { return null; }
  }
  const syncBadge = () => { setBadge(countRoot ? readCount() : null); syncPresence(); };
  function stopCount() { countObserver?.disconnect(); countObserver = countRoot = null; setBadge(null); stopPresence(); }
  // ---- Native presence: read the selected Inbox's own presence button label; choices come from its own source list.
  function findPresence() {
    const root = selected?.shadowRoot;
    const comp = root && descendants(root).find(e => e.localName === 'sn-agent-presence-state');
    const croot = comp?.shadowRoot;
    const bar = croot && descendants(croot).find(e => e.localName === 'button' && e.id === 'presenceBar');
    return bar ? {croot, bar} : null;
  }
  function readName(bar) {
    const m = PRESENCE_LABEL.exec(bar.getAttribute('aria-label') ?? '');
    if (!m) return null;
    const shown = descendants(bar).find(e => (e.getAttribute?.('class') || '').split(/\s+/).includes('status'));
    if (shown && shown.textContent.trim().toLowerCase() !== m[1].toLowerCase()) return null;
    return m[1];
  }
  function setPresence(name) {
    if (!presenceEl) return;
    presenceEl.setAttribute('data-state', colorOf(name));
    presenceEl.setAttribute('title', name ?? 'Presence unknown');
    presenceEl.setAttribute('aria-label', name ? `Presence: ${name}. Choose status` : 'Presence unknown. Choose status');
  }
  function stopPresence() {
    presenceObserver?.disconnect(); presenceObserver = presenceRoot = null;
    setPresence(null); closeMenu();
  }
  function syncPresence() {
    if (!presenceEl) return;
    let found = null, name = null;
    try { found = countRoot ? findPresence() : null; name = found ? readName(found.bar) : null; } catch {}
    const root = found?.croot ?? null;
    if (presenceRoot !== root) {
      presenceObserver?.disconnect(); presenceObserver = presenceRoot = null;
      const Observer = root && selected?.ownerDocument.defaultView?.MutationObserver;
      if (Observer) {
        const mine = new Observer(() => { if (presenceObserver === mine) syncPresence(); });
        mine.observe(root, {childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['aria-label']});
        presenceObserver = mine; presenceRoot = root;
      }
    }
    setPresence(name);
    try {
      const w = toggle.getBoundingClientRect().width;
      if (w > 0) { const r = `${12 + Math.round(w) + 8}px`; presenceEl.style.setProperty('right', r); menuEl.style.setProperty('right', r); }
    } catch {}
    if (!menuEl.hidden) renderMenu(false);
  }
  // The native status list lives in the selected Inbox's own presence popover source (present without opening anything).
  function nativeOptions() {
    const root = selected?.shadowRoot;
    if (!root) return [];
    for (const src of descendants(root).filter(e => e.localName === 'sn-presence-popover-content' && e.shadowRoot)) {
      const list = descendants(src.shadowRoot).find(e => e.getAttribute?.('role') === 'listbox' && /^status options$/i.test(e.getAttribute('aria-label') || ''));
      if (!list) continue;
      return descendants(list).filter(e => e.getAttribute?.('role') === 'option').map(li => {
        const label = (li.getAttribute('title') || (li.getAttribute('aria-label') || '').split(',')[0] || li.textContent || '').trim();
        const cls = (li.getAttribute('class') || '').split(/\s+/);
        return {li, label, current: li.getAttribute('selected') !== null || li.getAttribute('aria-selected') === 'true' || cls.includes('is-selected')};
      }).filter(o => o.label);
    }
    return [];
  }
  function note(text) {
    const n = document.createElement('p'); n.setAttribute('role', 'status'); n.setAttribute('class', 'note'); n.textContent = text; return n;
  }
  function renderMenu(force) {
    let opts = []; try { opts = nativeOptions(); } catch {}
    const sig = opts.map(o => `${o.label}|${o.current}`).join(';');
    if (!force && sig === menuSig) return;
    menuSig = sig;
    for (const child of [...menuEl.children]) child.remove();
    if (!opts.length) { menuEl.append(note('Native status list is unavailable.')); return; }
    for (const o of opts) {
      const item = document.createElement('button'); item.type = 'button'; item.setAttribute('role', 'menuitemradio');
      item.setAttribute('aria-checked', String(o.current)); item.setAttribute('class', 'item');
      const orb = document.createElement('span'); orb.setAttribute('class', 'orb'); orb.setAttribute('data-state', colorOf(o.label)); orb.setAttribute('aria-hidden', 'true');
      const text = document.createElement('span'); text.textContent = o.label;
      item.append(orb, text);
      item.addEventListener('click', () => choose(o.label));
      menuEl.append(item);
    }
  }
  function openMenu() {
    renderMenu(true); menuEl.hidden = false; presenceEl.setAttribute('aria-expanded', 'true');
    if (!outsideHandler && document.addEventListener) {
      outsideHandler = e => { if (host && !host.contains(e.target)) closeMenu(); };
      document.addEventListener('pointerdown', outsideHandler, true);
    }
    [...menuEl.children].find(n => n.getAttribute('role') === 'menuitemradio')?.focus?.();
  }
  function closeMenu(focus) {
    if (outsideHandler) { document.removeEventListener?.('pointerdown', outsideHandler, true); outsideHandler = null; }
    if (!menuEl) return;
    menuEl.hidden = true; menuSig = ''; presenceEl?.setAttribute('aria-expanded', 'false');
    if (focus) presenceEl?.focus();
  }
  // Only an explicit click on a menu entry reaches the native option, once. The indicator is never set from here.
  function choose(label) {
    if (!menuEl || menuEl.hidden) return; // a stale handler can never forward a second click
    let opt = null; try { opt = nativeOptions().find(o => o.label === label); } catch {}
    if (!opt) { for (const child of [...menuEl.children]) child.remove(); menuSig = ''; menuEl.append(note('That native status is no longer available.')); return; }
    const wasCurrent = opt.current;
    closeMenu(true);
    if (!wasCurrent) opt.li.click();
  }
  function onMenuKey(e) {
    const entries = [...menuEl.children].filter(n => n.getAttribute('role') === 'menuitemradio');
    const at = entries.indexOf(menuEl.ownerDocument.activeElement);
    if (e.key === 'Escape') { e.preventDefault?.(); closeMenu(true); }
    else if (e.key === 'ArrowDown' && entries.length) { e.preventDefault?.(); entries[(at + 1) % entries.length].focus(); }
    else if (e.key === 'ArrowUp' && entries.length) { e.preventDefault?.(); entries[(at - 1 + entries.length) % entries.length].focus(); }
  }
  function observeCount() {
    const root = selected?.shadowRoot;
    if (!root) { if (countObserver) stopCount(); return; }
    if (countRoot !== root) {
      countObserver?.disconnect(); countObserver = countRoot = null;
      const Observer = selected.ownerDocument.defaultView?.MutationObserver;
      if (Observer) {
        const mine = new Observer(() => { if (countObserver === mine) syncBadge(); });
        mine.observe(root, {childList: true, subtree: true, characterData: true});
        countObserver = mine; countRoot = root;
      }
    }
    syncBadge();
  }
  const css = (node, values) => { for (const [key, value] of Object.entries(values)) node.style.setProperty(key, value, 'important'); };
  function scan() {
    try { isolate(); } catch { unavailable(); return; }
    syncBadge();
  }
  function unavailable() {
    stopCount();
    if (!frame) return;
    frame.style.opacity = '0'; frame.style.pointerEvents = 'none'; frame.inert = true;
    status.hidden = false; status.textContent = 'Inbox unavailable here. Use Open native Inbox above.';
  }
  function onLoad() {
    selected = null; stopObserving(); stopCount();
    frame.style.opacity = '0'; frame.style.pointerEvents = 'none'; frame.inert = true;
    status.hidden = false; status.textContent = 'Loading native Inbox…';
    if (loadTimeout !== null) clearTimeout(loadTimeout);
    loadTimeout = setTimeout(unavailable, 30000);
    scan();
  }
  function isolate() {
    const doc = frame?.contentDocument;
    if (!doc?.documentElement) return;
    // Our inherited visibility mask would hide a newly rendered replacement from computed-style detection.
    // Lift it synchronously for measurement, then restore before the browser can paint.
    const masked = selected?.ownerDocument === doc;
    if (masked) css(doc.documentElement, {visibility:'visible'});
    try { findAndIsolate(doc); }
    finally { if (masked) css(doc.documentElement, {visibility:'hidden'}); }
  }
  function findAndIsolate(doc) {
    const roots = [doc];
    let inbox = null, hiddenFallback = null;
    for (let i = 0; i < roots.length && !inbox; i++) {
      for (const el of roots[i].querySelectorAll('*')) {
        if (el.shadowRoot) roots.push(el.shadowRoot);
        if (el.localName !== 'sn-agent-inbox') continue;
        hiddenFallback = el; // last native candidate; used only when none renders (narrow layouts report 0x0/hidden)
        const rect = el.getBoundingClientRect(), style = doc.defaultView.getComputedStyle(el);
        if (rect.width > 0 && rect.height > 0 && style.display !== 'none' &&
            style.visibility !== 'hidden' && style.visibility !== 'collapse') { inbox = el; break; }
      }
    }
    inbox ||= hiddenFallback;
    if (!inbox) { if (selected?.ownerDocument === doc) unavailable(); else stopCount(); return; }
    // Do not move native nodes or hide siblings: slot projection can render shell siblings elsewhere.
    // Reset containing blocks (including display:contents ancestors) so fixed means iframe viewport.
    for (let node = inbox.parentNode; node; node = node.parentNode || node.host) {
      if (!node.style) continue;
      css(node, {display:'block',position:'relative',width:'100%',height:'100%',
        'min-width':'0','min-height':'0','max-width':'none','max-height':'none',margin:'0',padding:'0',
        inset:'auto',transform:'none',filter:'none',perspective:'none',contain:'none','will-change':'auto',overflow:'hidden'});
    }
    css(doc.documentElement, {visibility:'hidden'});
    css(inbox, {display:'block',visibility:'visible',position:'fixed',inset:'0',width:'100vw',height:'100vh',
      'min-width':'0','min-height':'0','max-width':'none','max-height':'none','z-index':'2147483647'});
    selected = inbox;
    observePopovers(doc); raisePopovers(); observeCount();
    frame.style.opacity = '1'; frame.style.pointerEvents = 'auto'; frame.inert = false; status.hidden = true;
    if (loadTimeout !== null) { clearTimeout(loadTimeout); loadTimeout = null; }
  }
  function mount() {
    if (!controller.active || host) return;
    host = document.createElement('div');
    host.id = 'sn-milo-inbox-overlay';
    const root = host.attachShadow({mode: 'open'});
    const style = document.createElement('style');
    style.textContent = `:host{all:initial;position:fixed;right:12px;bottom:12px;width:0;height:0;z-index:2147483000;font:14px system-ui;color:#eee}*{box-sizing:border-box}button,a{font:inherit}button{cursor:pointer;background:#263c46;color:white;border:1px solid #79939d;border-radius:6px;padding:9px 14px}button.launcher{position:fixed;right:12px;bottom:12px;display:inline-flex;align-items:center;gap:8px;height:40px;padding:0 14px 0 12px;background:#3b1f66;color:#fff;border:1px solid #8c6bd0;border-radius:20px;box-shadow:0 2px 10px #0006;transition:background-color .15s,border-color .15s,box-shadow .15s}button.launcher:hover{background:#4d2a85;border-color:#b79cf0;box-shadow:0 3px 14px #000a}button.launcher:focus-visible{outline:3px solid #d8c8ff;outline-offset:2px;border-color:#d8c8ff}a:focus-visible,button:focus-visible{outline:3px solid #71c9ff;outline-offset:2px}button.launcher svg{display:block;width:20px;height:20px;flex:none}button.launcher span{line-height:1;font-weight:600}button.launcher .dot{position:absolute;top:-2px;right:-2px;box-sizing:content-box;width:8px;height:8px;border:1px solid #fff;border-radius:50%;background:#e5201f;pointer-events:none}button.launcher .dot[hidden]{display:none}button.presence{position:fixed;right:124px;bottom:12px;display:inline-flex;align-items:center;justify-content:center;width:40px;height:40px;padding:0;background:#20272c;border:1px solid #79939d;border-radius:50%;box-shadow:0 2px 10px #0006}button.presence:hover{background:#2c363c;border-color:#b3c5cc}button.presence:focus-visible{outline:3px solid #71c9ff;outline-offset:2px}.orb{display:block;flex:none;width:16px;height:16px;border-radius:50%;border:2px solid #fff;background:#8a949a}button.presence[data-state="green"] .orb{background:#1fbf5b}.item .orb[data-state="green"]{background:#1fbf5b}button.presence[data-state="red"] .orb{background:#e5201f}.item .orb[data-state="red"]{background:#e5201f}button.presence[data-state="yellow"] .orb{background:#f2c200}.item .orb[data-state="yellow"]{background:#f2c200}.menu{position:fixed;right:124px;bottom:60px;min-width:168px;padding:4px;background:#20272c;border:1px solid #71828b;border-radius:8px;box-shadow:0 6px 24px #0008}.menu[hidden]{display:none}.item{display:flex;align-items:center;gap:8px;width:100%;padding:8px 10px;background:transparent;border:0;border-radius:4px;text-align:left}.item:hover{background:#2c363c}.item[aria-checked="true"]{font-weight:700;background:#2c363c}.note{margin:0;padding:8px 10px}section{position:fixed;right:12px;bottom:64px;width:min(360px,calc(100vw - 24px));height:min(560px,calc(100dvh - 76px));background:#20272c;border:1px solid #71828b;border-radius:8px;box-shadow:0 6px 24px #0008;overflow:hidden}section[hidden]{display:none}header{display:flex;align-items:center;justify-content:space-between;padding:8px;gap:8px}iframe{display:block;border:0;width:100%;height:calc(100% - 48px);background:#20272c}a{color:#a7dfff}`;
    toggle = document.createElement('button');
    toggle.type = 'button'; toggle.setAttribute('class', 'launcher');
    const SVG = 'http://www.w3.org/2000/svg';
    const icon = document.createElementNS(SVG, 'svg');
    for (const [k, v] of [['viewBox','0 0 24 24'],['width','20'],['height','20'],['fill','none'],['stroke','currentColor'],
      ['stroke-width','1.8'],['stroke-linecap','round'],['stroke-linejoin','round'],['aria-hidden','true'],['focusable','false']]) icon.setAttribute(k, v);
    const outline = document.createElementNS(SVG, 'path');
    outline.setAttribute('d', 'M4 13l2.5-7.5A2 2 0 0 1 8.4 4h7.2a2 2 0 0 1 1.9 1.5L20 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2zM4 13h4.5a3.5 3.5 0 0 0 7 0H20');
    icon.append(outline);
    const label = document.createElement('span'); label.textContent = 'Inbox';
    dotEl = document.createElement('span'); dotEl.setAttribute('class', 'dot'); dotEl.setAttribute('aria-hidden', 'true'); dotEl.hidden = true;
    toggle.append(icon, label, dotEl);
    presenceEl = document.createElement('button'); presenceEl.type = 'button'; presenceEl.setAttribute('class', 'presence');
    presenceEl.setAttribute('aria-haspopup', 'menu'); presenceEl.setAttribute('aria-expanded', 'false'); presenceEl.setAttribute('aria-controls', 'presence-menu');
    const orb = document.createElement('span'); orb.setAttribute('class', 'orb'); orb.setAttribute('aria-hidden', 'true'); presenceEl.append(orb);
    menuEl = document.createElement('div'); menuEl.id = 'presence-menu'; menuEl.setAttribute('class', 'menu'); menuEl.setAttribute('role', 'menu');
    menuEl.setAttribute('aria-label', 'Choose native status'); menuEl.hidden = true;
    menuEl.addEventListener('keydown', onMenuKey);
    presenceEl.addEventListener('click', () => menuEl.hidden ? openMenu() : closeMenu(true));
    setPresence(null);
    toggle.setAttribute('aria-expanded', 'false'); toggle.setAttribute('aria-controls', 'native-inbox-panel');
    panel = document.createElement('section'); panel.id = 'native-inbox-panel'; panel.hidden = true;
    panel.setAttribute('aria-label', 'Native Inbox');
    const header = document.createElement('header');
    const link = document.createElement('a'); link.textContent = 'Open native Inbox';
    link.href = new URL('/now/cwf/agent/inbox', location.origin).href; link.target = '_blank'; link.rel = 'noopener noreferrer';
    const close = document.createElement('button'); close.type = 'button'; close.textContent = 'Collapse';
    close.addEventListener('click', () => { collapse(); toggle.focus(); });
    toggle.addEventListener('click', () => panel.hidden ? expand() : collapse());
    status = document.createElement('p'); status.setAttribute('role', 'status');
    status.style.cssText = 'position:absolute;top:54px;left:12px;right:12px;padding:12px;pointer-events:none';
        header.append(link, close); panel.append(header, status); root.append(style, panel, toggle, presenceEl, menuEl); document.body.append(host);
    ensureFrame();
  }
  // Eager: the native workspace loads when the feature starts, while the panel stays collapsed.
  function ensureFrame() {
    if (frame) return;
    frame = document.createElement('iframe'); frame.name = 'sn-milo-native-inbox'; frame.setAttribute('data-sn-milo-native-inbox', '');
    // The native document's own frame-buster skips frames whose id is 'testFrame'; any other id makes it call the
    // parent shell router, which navigates the top window to the Inbox. Set before src so it applies at load.
    frame.id = 'testFrame';
    frame.title = 'ServiceNow native Inbox'; frame.src = new URL('/now/cwf/agent/inbox', location.origin).href;
    frame.style.opacity = '0';
    frame.style.pointerEvents = 'none';
    frame.inert = true;
    status.textContent = 'Loading native Inbox…';
    frame.addEventListener('load', onLoad); frame.addEventListener('error', unavailable);
    panel.append(frame);
    loadTimeout = setTimeout(unavailable, 30000);
    scanTimer = setInterval(scan, 1000);
  }
  function expand() {
    ensureFrame();
    panel.hidden = false; toggle.setAttribute('aria-expanded', 'true');
  }
  function collapse() { panel.hidden = true; toggle.setAttribute('aria-expanded', 'false'); }
  function disable() {
    if (scanTimer !== null) { clearInterval(scanTimer); scanTimer = null; }
    if (loadTimeout !== null) { clearTimeout(loadTimeout); loadTimeout = null; }
    stopObserving(); stopCount();
    frame?.removeEventListener('load', onLoad); frame?.removeEventListener('error', unavailable);
    closeMenu(); host?.remove(); host = panel = toggle = frame = selected = status = dotEl = presenceEl = menuEl = null;
  }
  const controller = {active:true, stop() {
    if (!controller.active) return;
    controller.active = false;
    const off = unsubscribe; unsubscribe = null;
    off?.(); disable();
  }};
  globalThis.__snMiloInboxOverlay = controller;
  unsubscribe = settings?.subscribe?.('inbox-overlay', {start: mount, stop(reason) {
    if (reason === 'disabled' || reason === 'mode-change') disable(); else controller.stop();
  }});
})();
