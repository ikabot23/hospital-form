// ==UserScript==
// @name         Travian: hospital shipments -> Google Sheets
// @namespace    travian-sheet-sender
// @version      2.2
// @description  Logs resources you send to an alliance hospital request into the shared sheet, plus a compact floating window with active requests
// @include      https://*.europe.travian.*/*
// @include      https://*.international.travian.*/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      script.google.com
// @connect      script.googleusercontent.com
// @updateURL    https://raw.githubusercontent.com/ikabot23/hospital-form/main/travian-sheet.user.js
// @downloadURL  https://raw.githubusercontent.com/ikabot23/hospital-form/main/travian-sheet.user.js
// ==/UserScript==
(function () {
  'use strict';
  console.log('[Sheet] script loaded (multi-lang v2.2)');

  const WEB_APP = 'https://script.google.com/macros/s/AKfycbxllR_kHm99Df_xNA0PMz5kkVBiqzEjbrlsrRSWIb0zO9Bi7Pmbpg-sZJb9kS0heYFQ7Q/exec';
  const FORM_URL = 'https://ikabot23.github.io/hospital-form';
  const SHOW_PANEL = true;      // false = hide the floating window
  const PANEL_MODE = 'page';    // 'page'  = like ResourceBar+ (absolute in <body>, moves with the page)
                                // 'fixed' = glued to the screen (stays in place while scrolling)

  const clean = s => String(s).replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '').trim();

  let panelApi = null;   // set by the floating window, used to refresh it after a shipment

  function getToken() {
    let t = GM_getValue('token');
    if (!t) {
      t = prompt('Alliance secret code (ask your leader):');
      if (t) GM_setValue('token', t.trim());
    }
    return t;
  }

  function getPlayer() {
    const el = document.querySelector('#sidebarBoxActiveVillage .playerName');
    const fromPage = el && clean(el.textContent);
    if (fromPage) return fromPage;
    let p = GM_getValue('player');
    if (!p) {
      p = prompt('Your in-game nickname (exactly as in the sheet):');
      if (p) GM_setValue('player', p.trim());
    }
    return p;
  }

  function getRecipient() {
    // old browsers do not understand :has(), so the lookup is wrapped in try/catch
    let form = null;
    try {
      form = document.querySelector(
        'form:has(input[name="lumber"]), form:has(input[name="r1"]), .sendResourcesForm, form[name="snd"]'
      );
    } catch (e) {
      const inp = document.querySelector('input[name="lumber"], input[name="r1"]');
      form = inp && inp.closest('form');
    }
    if (form) {
      const link = form.querySelector('a[href*="/profile/"], a[href*="spieler.php"], a[href*="player.php"]');
      if (link) return clean(link.textContent);
    }
    const content = document.querySelector('#content, #center, .contentPage, main') || document.body;
    const candidates = [...content.querySelectorAll('a[href*="/profile/"], a[href*="spieler.php"]')]
      .filter(a => {
        const txt = clean(a.textContent);
        return txt.length > 1 && txt.length < 30 && !a.closest('#sidebarBoxActiveVillage, #sidebarBoxVillagelist, .sidebar');
      });
    if (candidates.length) {
      candidates.sort((a, b) => a.textContent.length - b.textContent.length);
      return clean(candidates[0].textContent);
    }
    return null;
  }

  function getTotal() {
    const val = n => Number(
      (document.querySelector(`input[name="${n}"]`)?.value || '').replace(/\D/g, '')
    ) || 0;
    let total = val('lumber') + val('clay') + val('iron') + val('crop');
    if (total > 0) return total;
    return val('r1') + val('r2') + val('r3') + val('r4');
  }

  function toast(text) {
    const t = document.createElement('div');
    t.textContent = text;
    t.style.cssText = 'position:fixed;bottom:10px;left:10px;z-index:99999;' +
      'background:#222;color:#fff;padding:8px 12px;border-radius:4px;font-size:13px';
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 6000);
  }

  function report(data) {
    const player = getPlayer();
    const token = getToken();
    if (!player || !token) return toast('Sheet: nickname or secret code not set');
    console.log('[Sheet] sending:', player, data);
    GM_xmlhttpRequest({
      method: 'POST',
      url: WEB_APP,
      headers: { 'Content-Type': 'text/plain' },
      data: JSON.stringify({ token, player, ...data }),
      onload: r => {
        const txt = r.responseText.slice(0, 80);
        console.log('[Sheet]', r.status, txt);
        if (txt === 'ok') {
          toast('Sheet: shipment saved');
          if (panelApi) setTimeout(() => panelApi.refresh(true), 1500);   // update the floating window
        } else if (txt === 'forbidden') {
          GM_setValue('token', '');
          toast('Sheet: wrong secret code, you will be asked again on the next shipment');
        } else if (txt === 'player not found') {
          toast('Sheet: your nickname (' + player + ') is not in the list');
        } else if (txt === 'no request') {
          console.log('[Sheet] no request for this recipient, nothing saved');
        } else {
          toast('Sheet: ' + txt);
        }
      },
      onerror: () => toast('Could not reach the sheet')
    });
  }

  // Is this the real "Send" button (not + / -)
  function isSendButton(btn) {
    if (!btn) return false;

    // Classic submit
    if (btn.matches('button[type="submit"], input[type="submit"]')) return true;

    // Common name/id of the send button in Travian
    const name = (btn.getAttribute('name') || '').toLowerCase();
    const id = (btn.id || '').toLowerCase();
    if (name === 's1' || id.includes('enabledbutton') || id.includes('btn_ok')) return true;

    // Button text: not plus/minus and not "cancel"
    const text = clean(btn.textContent || btn.value || '').toLowerCase();
    if (!text) return false;
    if (text === '+' || text === '−' || text === '-' || text === '–') return false;
    if (['cancel', 'отмена', 'annuler', 'abbrechen', 'annulla', 'anuluj', 'zurück', 'back'].some(w => text.includes(w))) {
      return false;
    }

    // A plain type="button" with a very short text is most likely +/-
    if (btn.type === 'button' && text.length <= 2) return false;

    return false; // by default it is not a send button
  }

  // One shipment is recorded once even if both submit and click fire
  let lastKey = '', lastAt = 0;

  function tryReportFromForm(form) {
    if (!form) return;
    const hasResources = form.querySelector(
      'input[name="lumber"], input[name="clay"], input[name="iron"], input[name="crop"], input[name="r1"]'
    );
    if (!hasResources) return;

    const recipient = getRecipient();
    const total = getTotal();
    console.log('[Sheet] recipient:', recipient, 'total:', total);
    if (!recipient || !total) return;

    const key = recipient + '|' + total;
    if (key === lastKey && Date.now() - lastAt < 4000) {
      console.log('[Sheet] duplicate ignored');
      return;
    }
    lastKey = key;
    lastAt = Date.now();

    report({ recipient, total });
  }

  // 1. Main way: the form submit event (language does not matter)
  document.addEventListener('submit', e => {
    const form = e.target;
    if (!(form instanceof HTMLFormElement)) return;
    tryReportFromForm(form);
  }, true);

  // 2. Fallback: a click on the real send button
  document.addEventListener('click', e => {
    const btn = e.target.closest('button, input[type="submit"]');
    if (!btn || !isSendButton(btn)) return;

    const form = btn.closest('form');
    tryReportFromForm(form);
  }, true);

  // Time shown by the game clock (the "9:50:12 (UTC)" box); falls back to the computer clock
  function gameTimeLabel() {
    const RE = /(\d{1,2}):(\d{2})(?::\d{2})?\s*\(?\s*((?:UTC|GMT)(?:\s?[+\-\u2212]\s?\d{1,2}(?::\d{2})?)?)\s*\)?/i;
    let best = null;
    try {
      document.querySelectorAll('div,span,p,td,li').forEach(e => {
        if (e.children.length > 3) return;
        const t = clean(e.textContent);
        if (t.length > 60) return;
        const m = RE.exec(t);
        if (m && (!best || t.length < best.len)) best = { len: t.length, m };
      });
    } catch (e) {}
    if (best) return best.m[1] + ':' + best.m[2] + ' ' + best.m[3].replace(/\s+/g, '').toUpperCase();
    return new Date().toTimeString().slice(0, 5);
  }

  // ================= Floating window with active requests =================
  function initPanel() {
    if (document.getElementById('hospital-panel-host')) return;   // already created (e.g. a second copy of the script)

    const PAGE = PANEL_MODE === 'page';
    const fmt = n => Number(n).toLocaleString('en-US');
    const el = (tag, cls) => { const e = document.createElement(tag); if (cls) e.className = cls; return e; };
    const isActive = r => r.need > 0 && r.need - r.got > 0;

    const host = document.createElement('div');
    host.id = 'hospital-panel-host';
    host.style.cssText = PAGE
      // like ResourceBar+: absolute, page coordinates, negative right margin so the window is never squeezed
      ? 'position:absolute;z-index:5999;left:0;top:0;margin:0 -10000px 0 0;padding:0;border:0;background:none;width:auto;height:auto;'
      : 'position:fixed;z-index:2147483000;left:0;top:0;right:auto;bottom:auto;margin:0;padding:0;border:0;' +
        'background:none;overflow:visible;width:auto;height:auto;max-width:none;max-height:none;';
    const shadow = host.attachShadow({ mode: 'open' });   // game CSS cannot affect the window

    const style = document.createElement('style');
    style.textContent = `
      .box{font:11px/1.3 system-ui,sans-serif;color:#222;background:#f4efe3;border:1px solid #8a7a55;
           border-radius:5px;box-shadow:0 2px 6px rgba(0,0,0,.35);width:220px;overflow:hidden}
      .head{display:flex;align-items:center;gap:2px;padding:3px 6px;background:#5c4a28;color:#fff;
            cursor:move;user-select:none;touch-action:none}
      .ttl{flex:1;min-width:0;line-height:1.2}
      .ttl b{font-size:12px;white-space:nowrap}
      .ttl small{display:block;font-size:9.5px;color:#dccfb2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .head button,.head a.btn{all:unset;cursor:pointer;padding:0 4px;font-size:14px;color:#fff;line-height:1}
      .list{max-height:50vh;overflow:auto;padding:1px 6px}
      .row{padding:3px 0;border-bottom:1px solid #ddd0b8}
      .row:last-child{border-bottom:0}
      .top{display:flex;justify-content:space-between;gap:6px;font-weight:600}
      .name{color:#1f5e9e;text-decoration:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      a.name:hover{text-decoration:underline}
      .bar{height:4px;background:#ddd;border-radius:2px;overflow:hidden;margin:2px 0}
      .bar i{display:block;height:100%;background:#4a7c1f;box-shadow:inset 0 0 0 1px rgba(0,0,0,.25)}
      .sub{font-size:10px;color:#555}
      .msg{padding:6px 0;color:#a33}
      .msg button{margin-top:4px;padding:3px 8px;font-size:11px;cursor:pointer}
      .hide .list{display:none}
    `;

    const box = el('div', 'box');
    const head = el('div', 'head');
    const ttl = el('div', 'ttl');
    const b = el('b'); b.textContent = '🏥 Hospital ';
    const cnt = el('span');            // "[3 requests]"
    b.append(cnt);
    const upd = el('small');           // "updated 9:50 UTC"
    ttl.append(b, upd);
    const btnLog = el('a', 'btn');
    btnLog.textContent = '+'; btnLog.title = 'Log a shipment (form)';
    btnLog.href = FORM_URL; btnLog.target = '_blank'; btnLog.rel = 'noopener';
    const btnRefresh = el('button'); btnRefresh.textContent = '↻'; btnRefresh.title = 'Refresh';
    const btnToggle = el('button'); btnToggle.title = 'Collapse / expand';
    head.append(ttl, btnLog, btnRefresh, btnToggle);
    const list = el('div', 'list');
    box.append(head, list);
    shadow.append(style, box);

    if (PAGE) {
      document.body.appendChild(host);            // exactly like ResourceBar+
    } else {
      document.documentElement.appendChild(host); // directly under <html>, in the browser top layer when supported
      try { host.setAttribute('popover', 'manual'); host.showPopover(); }
      catch (e) { host.removeAttribute('popover'); }
    }

    // ----- position (drag with mouse or finger) -----
    const POS_KEY = 'panelPos_' + PANEL_MODE;   // page and screen coordinates differ, so they are saved separately
    let px = 0, py = 0;
    function place(x, y) {
      const maxX = (PAGE ? Math.max(document.documentElement.scrollWidth, window.innerWidth) : window.innerWidth) - 60;
      const maxY = (PAGE ? Math.max(document.documentElement.scrollHeight, window.innerHeight) : window.innerHeight) - 30;
      px = Math.max(0, Math.min(x, maxX));
      py = Math.max(0, Math.min(y, maxY));
      host.style.left = px + 'px';
      host.style.top = py + 'px';
    }
    let pos = null;
    try { pos = JSON.parse(GM_getValue(POS_KEY, 'null')); } catch (e) {}
    place(pos ? pos.x : window.innerWidth - 240, pos ? pos.y : 110);
    window.addEventListener('resize', () => place(px, py));

    const pt = e => PAGE ? [e.pageX, e.pageY] : [e.clientX, e.clientY];
    let drag = null;
    head.addEventListener('pointerdown', e => {
      if (e.target.closest('button, a')) return;
      const [x, y] = pt(e);
      drag = { dx: x - px, dy: y - py };
      head.setPointerCapture(e.pointerId);
    });
    head.addEventListener('pointermove', e => {
      if (!drag) return;
      const [x, y] = pt(e);
      place(x - drag.dx, y - drag.dy);
    });
    head.addEventListener('pointerup', () => {
      if (!drag) return;
      drag = null;
      GM_setValue(POS_KEY, JSON.stringify({ x: px, y: py }));
    });

    // Screen mode only: keeps the window glued to the screen even if the game's CSS makes "fixed" elements scroll
    if (!PAGE) {
      const pin = () => {
        const r = host.getBoundingClientRect();
        if (!r.width || !host.offsetWidth) return;
        const sx = r.width / host.offsetWidth || 1, sy = r.height / host.offsetHeight || 1;
        const dx = px - r.left, dy = py - r.top;
        if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
        host.style.left = ((parseFloat(host.style.left) || 0) + dx / sx) + 'px';
        host.style.top = ((parseFloat(host.style.top) || 0) + dy / sy) + 'px';
      };
      window.addEventListener('scroll', pin, { passive: true, capture: true });
      window.addEventListener('resize', pin);
      setInterval(pin, 1000);
    }
    console.log('[Sheet] panel mode:', PANEL_MODE,
      '| scrolling element:', document.scrollingElement && document.scrollingElement.tagName);

    // ----- collapse / expand -----
    let collapsed = GM_getValue('panelCollapsed', window.innerWidth < 700);
    function applyCollapsed() {
      box.classList.toggle('hide', !!collapsed);
      btnToggle.textContent = collapsed ? '▾' : '▴';
    }
    function toggle() { collapsed = !collapsed; GM_setValue('panelCollapsed', collapsed); applyCollapsed(); }
    btnToggle.onclick = toggle;
    head.addEventListener('dblclick', e => { if (!e.target.closest('button, a')) toggle(); });
    applyCollapsed();

    // ----- content -----
    function setHeader(d, label) {
      if (d) {
        const n = (d.requests || []).filter(isActive).length;
        cnt.textContent = '[' + n + ' ' + (n === 1 ? 'request' : 'requests') + ']';
      } else {
        cnt.textContent = '';
      }
      upd.textContent = label ? 'updated ' + label : '';
    }

    function showMsg(text, askCode) {
      setHeader(null, '');
      list.textContent = '';
      const m = el('div', 'msg');
      m.textContent = text;
      if (askCode) {
        const bt = el('button');
        bt.textContent = 'Enter secret code';
        bt.onclick = () => { if (getToken()) refresh(true); };
        m.append(document.createElement('br'), bt);
      }
      list.append(m);
    }

    function render(d, label) {
      setHeader(d, label);
      list.textContent = '';
      const active = (d.requests || []).filter(isActive);
      if (!active.length) {
        const m = el('div', 'msg');
        m.style.color = '#555';
        m.textContent = 'No active requests';
        list.append(m);
      }
      active.forEach(r => {
        const left = r.need - r.got;
        const pct = Math.min(99, Math.floor(r.got / r.need * 100));

        const row = el('div', 'row');
        row.title = fmt(r.got) + ' / ' + fmt(r.need);

        const top = el('div', 'top');
        let name;
        if (r.link && /^https?:\/\//i.test(r.link)) {
          name = el('a', 'name');
          name.href = r.link;   // opens the send-resources page
        } else {
          name = el('span', 'name');
        }
        name.textContent = r.name;
        const p = el('span'); p.textContent = pct + '%';
        top.append(name, p);

        const bar = el('div', 'bar');
        const fill = el('i');
        fill.style.width = pct + '%';
        if (r.color) fill.style.background = r.color;
        bar.append(fill);

        const sub = el('div', 'sub');
        sub.textContent = fmt(left) + ' left of ' + fmt(r.need);

        row.append(top, bar, sub);
        list.append(row);
      });
    }

    // ----- data: refreshed every 15 minutes, on own shipment, on expanding, and with the refresh button -----
    const POLL_MS = 15 * 60000;
    const AUTO_GAP = POLL_MS * 0.8;   // automatic refresh only when the data is older than this

    let cachedAt = 0, busy = false, hasData = false, failures = 0;

    function fail(text) {
      failures++;
      if (hasData) upd.textContent = text + ', retrying…';   // keep the last data on screen
      else showMsg(text + ', retrying…');
    }

    // force = refresh now (minGap: but not more often than this many ms); otherwise only if data is old
    function refresh(force, minGap) {
      const token = GM_getValue('token');
      if (!token) { showMsg('Secret code needed', true); return; }
      const gap = force ? (minGap || 0) : AUTO_GAP;
      if (cachedAt && Date.now() - cachedAt < gap) return;
      if (busy) return;
      busy = true;
      GM_xmlhttpRequest({
        method: 'POST',
        url: WEB_APP,
        headers: { 'Content-Type': 'text/plain' },
        data: JSON.stringify({ action: 'data', token }),
        onload: r => {
          busy = false;
          let d;
          try { d = JSON.parse(r.responseText); } catch (e) { return fail('Server busy'); }
          if (d.error) {
            GM_setValue('token', '');
            hasData = false;
            return showMsg('Wrong secret code', true);
          }
          failures = 0;
          cachedAt = Date.now();
          const label = gameTimeLabel();   // time from the game clock
          GM_setValue('panelData', JSON.stringify({ at: cachedAt, label, data: d }));
          hasData = true;
          render(d, label);
        },
        onerror: () => { busy = false; fail('No connection'); }
      });
    }
    btnRefresh.onclick = () => refresh(true);

    // expanding the window refreshes (at most once per 1 minute)
    const OPEN_GAP = 60 * 1000;
    btnToggle.addEventListener('click', () => { if (!collapsed) refresh(true, OPEN_GAP); });
    head.addEventListener('dblclick', e => {
      if (!e.target.closest('button, a') && !collapsed) refresh(true, OPEN_GAP);
    });
    // coming back to the tab: only if the data is older than ~12 min
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
    window.addEventListener('focus', () => refresh());

    // 15-minute loop with a little random spread; after errors it retries sooner (2, 4, 8 ... min)
    function schedule() {
      const wait = failures ? Math.min(120000 * Math.pow(2, failures - 1), POLL_MS) : POLL_MS;
      setTimeout(() => {
        if (!document.hidden) refresh();
        schedule();
      }, wait * (0.9 + Math.random() * 0.2));
    }

    // show the last known data immediately (no waiting on every page change)
    let saved = null;
    try { saved = JSON.parse(GM_getValue('panelData', 'null')); } catch (e) {}
    if (saved && saved.data) {
      cachedAt = saved.at || 0;
      hasData = true;
      render(saved.data, saved.label || new Date(saved.at || Date.now()).toTimeString().slice(0, 5));
    } else if (!GM_getValue('token')) {
      showMsg('Secret code needed', true);
    } else {
      showMsg('Loading…');
    }
    refresh();      // goes out only if the saved data is older than ~12 min
    schedule();

    panelApi = { refresh };
  }

  if (SHOW_PANEL && window.top === window.self) initPanel();
})();
