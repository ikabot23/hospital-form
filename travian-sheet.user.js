// ==UserScript==
// @name         Travian: hospital shipments -> Google Sheets
// @namespace    travian-sheet-sender
// @version      1.5
// @description  Logs resources you send to an alliance hospital request into the shared sheet (any game language)
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
  console.log('[Sheet] script loaded v1.5');

  const WEB_APP = 'https://script.google.com/macros/s/AKfycbxllR_kHm99Df_xNA0PMz5kkVBiqzEjbrlsrRSWIb0zO9Bi7Pmbpg-sZJb9kS0heYFQ7Q/exec';

  const BIDI = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
  const clean = s => String(s).replace(BIDI, '').trim();
  const visible = el => !!(el.offsetParent || el.getClientRects().length);

  function getToken() {
    let t = GM_getValue('token');
    if (!t) {
      t = prompt('Alliance secret code (ask your leader):');
      if (t) GM_setValue('token', t.trim());
    }
    return t;
  }

  // Sender nickname: from the right sidebar, otherwise asked once
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

  const RES_SELECTOR = 'input[name="lumber"], input[name="clay"], input[name="iron"], input[name="crop"], ' +
                       'input[name="r1"], input[name="r2"], input[name="r3"], input[name="r4"]';
  const resInput = () => document.querySelector('input[name="lumber"], input[name="r1"]');

  // Recipient coordinates from the X / Y fields (language independent)
  function coord(n) {
    const el = document.querySelector('input[name="' + n + '"]');
    const v = el ? clean(el.value).replace(/[\u2212\u2013]/g, '-') : '';
    return /^-?\d+$/.test(v) ? Number(v) : null;
  }

  // Sum of all four resources from the form fields
  function getTotal() {
    const val = n => Number(
      (document.querySelector('input[name="' + n + '"]')?.value || '').replace(/\D/g, '')
    ) || 0;
    const t = val('lumber') + val('clay') + val('iron') + val('crop');
    return t > 0 ? t : val('r1') + val('r2') + val('r3') + val('r4');
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
        } else if (txt === 'forbidden') {
          GM_setValue('token', '');          // wrong code: ask again next time
          toast('Sheet: wrong secret code, you will be asked again on the next shipment');
        } else if (txt === 'player not found') {
          toast('Sheet: your nickname (' + player + ') is not in the list');
        } else if (txt === 'no request') {
          console.log('[Sheet] no request for these coordinates, nothing saved');
        } else {
          toast('Sheet: ' + txt);
        }
      },
      onerror: () => toast('Could not reach the sheet')
    });
  }

  // The send button, found by its position (works in any language):
  // 1) the first visible button after the "1x / 2x / 3x" delivery radios;
  // 2) if there are no radios: the first button after the resource fields that has a real word
  //    on it (this skips +, -, M, M/2, M/3, =, %, C)
  function sendButton() {
    const buttons = [...document.querySelectorAll('button, input[type="submit"]')].filter(visible);

    const radios = document.querySelectorAll('input[name="deliveries"]');
    if (radios.length) {
      const last = radios[radios.length - 1];
      const b = buttons.find(el => last.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);
      if (b) return b;
    }

    const inputs = document.querySelectorAll(RES_SELECTOR);
    if (!inputs.length) return null;
    const lastInput = inputs[inputs.length - 1];
    return buttons.find(el =>
      (lastInput.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) &&
      /\p{L}{2,}/u.test(clean(el.textContent || el.value || ''))
    ) || null;
  }

  // One shipment is recorded once even if both submit and click fire
  let lastKey = '', lastAt = 0;
  function tryReport(trigger) {
    if (!resInput()) return;
    const total = getTotal();
    const x = coord('x'), y = coord('y');
    console.log('[Sheet] trigger:', trigger, '| x,y:', x, y, '| total:', total);
    if (!total || x === null || y === null) return;

    const key = x + '|' + y + '|' + total;
    if (key === lastKey && Date.now() - lastAt < 4000) {
      console.log('[Sheet] duplicate ignored');
      return;
    }
    lastKey = key;
    lastAt = Date.now();
    report({ x, y, total });
  }

  // 1) real form submit
  document.addEventListener('submit', e => {
    const f = e.target;
    if (f instanceof HTMLFormElement && f.querySelector('input[name="lumber"], input[name="r1"]')) tryReport('submit');
  }, true);

  // 2) click on the send button (the game may not use a real form submit)
  document.addEventListener('click', e => {
    const btn = e.target.closest('button, input[type="submit"], input[type="button"]');
    if (btn && btn === sendButton()) tryReport('click');
  }, true);
})();
