// ==UserScript==
// @name         Travian: hospital shipments -> Google Sheets
// @namespace    travian-sheet-sender
// @version      1.9
// @description  Logs resources you send to an alliance hospital request into the shared sheet, plus a floating window with active requests
// @include      https://*.travian.*/*
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
  console.log('[Sheet] script loaded (multi-lang v1.9)');

  const WEB_APP = 'https://script.google.com/macros/s/AKfycbxllR_kHm99Df_xNA0PMz5kkVBiqzEjbrlsrRSWIb0zO9Bi7Pmbpg-sZJb9kS0heYFQ7Q/exec';
  const FORM_URL = 'https://ikabot23.github.io/hospital-form';
  const SHOW_PANEL = true;   // false = hide the floating window

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

  // ================= Floating window with active requests =================
  function initPanel() {
    if (document.getElementById('hospital-panel-host')) return;   // already created (e.g. a second copy of the script)

    const fmt = n => Number(n).toLocaleString('en-US');
    const el = (tag, cls) => { const e = document.createElement(tag); if (cls) e.className = cls; return e; };

    const host = document.createElement('div');
    host.id = 'hospital-panel-host';
    host.style.cssText = 'position:fixed;z-index:2147483000;left:0;top:0;';
    const shadow = host.attachShadow({ mode: 'open' });   // game CSS cannot affect the window

    const style = document.createElement('style');
    style.textContent = `
      .box{font:12px/1.35 system-ui,sans-serif;color:#222;background:#f4efe3;border:1px solid #8a7a55;
           border-radius:6px;box-shadow:0 2px 8px rgba(0,0,0,.35);width:250px;overflow:hidden}
      .head{display:flex;align-items:center;gap:6px;padding:5px 8px;background:#5c4a28;color:#fff;
            cursor:move;user-select:none;touch-action:none}
      .head b{flex:1;font-size:12px}
      .head button{all:unset;cursor:pointer;padding:0 5px;font-size:14px;color:#fff}
      .list{max-height:60vh;overflow:auto;padding:2px 8px}
      .row{padding:5px 0;border-bottom:1px solid #ddd0b8}
      .row:last-child{border-bottom:0}
      .top{display:flex;justify-content:space-between;gap:6px;font-weight:600}
      .name{color:#1f5e9e;text-decoration:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      a.name:hover{text-decoration:underline}
      .bar{height:6px;background:#ddd;border-radius:3px;overflow:hidden;margin:3px 0}
      .bar i{display:block;height:100%;background:#4a7c1f;box-shadow:inset 0 0 0 1px rgba(0,0,0,.25)}
      .sub{font-size:11px;color:#555}
      .foot{display:flex;justify-content:space-between;padding:3px 8px 5px;font-size:10px;color:#666;border-top:1px solid #ddd0b8}
      .foot a{color:#1f5e9e}
      .msg{padding:8px 0;color:#a33}
      .msg button{margin-top:6px;padding:4px 8px;font-size:12px;cursor:pointer}
      .hide .list,.hide .foot{display:none}
    `;

    const box = el('div', 'box');
    const head = el('div', 'head');
    const title = el('b'); title.textContent = '🏥 Hospital requests';
    const btnRefresh = el('button'); btnRefresh.textContent = '↻'; btnRefresh.title = 'Refresh';
    const btnToggle = el('button'); btnToggle.title = 'Collapse / expand';
    head.append(title, btnRefresh, btnToggle);
    const list = el('div', 'list');
    const foot = el('div', 'foot');
    const stamp = el('span');
    const formLink = el('a');
    formLink.href = FORM_URL; formLink.target = '_blank'; formLink.rel = 'noopener'; formLink.textContent = 'Log shipment';
    foot.append(stamp, formLink);
    box.append(head, list, foot);
    shadow.append(style, box);
    (document.body || document.documentElement).appendChild(host);

    // ----- position (drag with mouse or finger) -----
    let px = 0, py = 0;
    function place(x, y) {
      px = Math.max(0, Math.min(x, window.innerWidth - 60));
      py = Math.max(0, Math.min(y, window.innerHeight - 30));
      host.style.left = px + 'px';
      host.style.top = py + 'px';
    }
    let pos = null;
    try { pos = JSON.parse(GM_getValue('panelPos', 'null')); } catch (e) {}
    place(pos ? pos.x : window.innerWidth - 270, pos ? pos.y : 110);
    window.addEventListener('resize', () => place(px, py));

    let drag = null;
    head.addEventListener('pointerdown', e => {
      if (e.target.closest('button')) return;
      const r = host.getBoundingClientRect();
      drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      head.setPointerCapture(e.pointerId);
    });
    head.addEventListener('pointermove', e => { if (drag) place(e.clientX - drag.dx, e.clientY - drag.dy); });
    head.addEventListener('pointerup', () => {
      if (!drag) return;
      drag = null;
      GM_setValue('panelPos', JSON.stringify({ x: px, y: py }));
    });

    // ----- collapse / expand -----
    let collapsed = GM_getValue('panelCollapsed', window.innerWidth < 700);
    function applyCollapsed() {
      box.classList.toggle('hide', !!collapsed);
      btnToggle.textContent = collapsed ? '▾' : '▴';
    }
    function toggle() { collapsed = !collapsed; GM_setValue('panelCollapsed', collapsed); applyCollapsed(); }
    btnToggle.onclick = toggle;
    head.addEventListener('dblclick', e => { if (!e.target.closest('button')) toggle(); });
    applyCollapsed();

    // ----- content -----
    function showMsg(text, askCode) {
      list.textContent = '';
      const m = el('div', 'msg');
      m.textContent = text;
      if (askCode) {
        const b = el('button');
        b.textContent = 'Enter secret code';
        b.onclick = () => { if (getToken()) refresh(true); };
        m.append(document.createElement('br'), b);
      }
      list.append(m);
    }

    function render(d, at) {
      list.textContent = '';
      const active = (d.requests || []).filter(r => r.need > 0 && r.need - r.got > 0);
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
      stamp.textContent = 'Updated ' + new Date(at || Date.now()).toTimeString().slice(0, 5);
    }

    // ----- data: cached between pages, polled gently so that 60+ players do not overload Apps Script -----
    const POLL_SECONDS = 90;          // base interval (the real one is randomised by about +-20%)
    const IDLE_MINUTES = 10;          // no mouse / keyboard / touch for this long = stop polling
    const MAX_BACKOFF_SECONDS = 300;  // after errors the interval grows up to this

    let cachedAt = 0, busy = false, hasData = false, failures = 0, lastActive = Date.now();
    ['mousemove', 'keydown', 'pointerdown', 'touchstart', 'scroll'].forEach(ev =>
      window.addEventListener(ev, () => { lastActive = Date.now(); }, { passive: true, capture: true }));
    const isIdle = () => Date.now() - lastActive > IDLE_MINUTES * 60000;
    const staleMs = () => (POLL_SECONDS - 10) * 1000;

    function fail(text) {
      failures++;
      if (hasData) stamp.textContent = text + ', retrying…';   // keep the last data on screen
      else showMsg(text + ', retrying…');
    }

    function refresh(force) {
      const token = GM_getValue('token');
      if (!token) { showMsg('Secret code needed', true); return; }
      if (!force && cachedAt && Date.now() - cachedAt < staleMs()) return;
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
          GM_setValue('panelData', JSON.stringify({ at: cachedAt, data: d }));
          hasData = true;
          render(d, cachedAt);
        },
        onerror: () => { busy = false; fail('No connection'); }
      });
    }
    btnRefresh.onclick = () => refresh(true);

    // opening the collapsed window or returning to the tab refreshes only if the data is old enough
    btnToggle.addEventListener('click', () => { if (!collapsed) refresh(); });
    head.addEventListener('dblclick', e => { if (!e.target.closest('button') && !collapsed) refresh(); });
    document.addEventListener('visibilitychange', () => { if (!document.hidden && !collapsed) refresh(); });
    window.addEventListener('focus', () => { if (!collapsed) refresh(); });

    // poll loop: random jitter, backs off after errors, skips hidden / collapsed / idle states
    function schedule() {
      const base = POLL_SECONDS * 1000;
      const wait = Math.min(base * Math.pow(2, failures), MAX_BACKOFF_SECONDS * 1000);
      setTimeout(() => {
        if (!document.hidden && !collapsed && !isIdle()) refresh();
        schedule();
      }, wait * (0.8 + Math.random() * 0.4));
    }

    // show the last known data immediately (no waiting on every page change)
    let saved = null;
    try { saved = JSON.parse(GM_getValue('panelData', 'null')); } catch (e) {}
    if (saved && saved.data) {
      cachedAt = saved.at || 0;
      hasData = true;
      render(saved.data, saved.at);
    } else if (!GM_getValue('token')) {
      showMsg('Secret code needed', true);
    } else {
      showMsg('Loading…');
    }
    if (!collapsed) refresh();   // only goes out if the data is older than ~80 s
    schedule();

    panelApi = { refresh };
  }

  if (SHOW_PANEL && window.top === window.self) initPanel();
})();
