// SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
// SPDX-License-Identifier: GPL-2.0-only
//
// Tip: a one-time tip jar. Picks an amount and opens the tip page in the browser
// (tip.open); no payment is handled inside OmniDesk.

import { h, setText } from '../shell/dom.js';
import { icon } from '../shell/icons.js';
import { scene } from '../art/index.js';


const errText = (e) => (e && e.message) || 'Something went wrong. Try again.';
const AMOUNTS = [3, 5, 10];
const money = (n) => (Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`);

export default {
  id: 'tip', label: 'Tip', tab: 'Tip', group: 'more', accent: 'var(--c-tip)', icon: 'tip',

  mount(el, api, shell) {
    let alive = true;
    let amount = 5;
    let custom = '';
    let busy = false;

    const sceneHost = h('div.lh-scene', { 'aria-hidden': 'true' });
    const h1 = h('h1', null, 'Leave a tip');
    const sub = h('p.sub', null, 'OmniDesk is free and open source. If it saves you a cable, a keyboard or a little sanity, you can say thanks once.');
    el.replaceChildren(h('header.lh', null,
      h('div', null, h('span.kick', null, h('i', { 'aria-hidden': 'true' }), 'Tip jar'), h1, sub,
        h('dl.stats', null,
          h('div', null, h('dt', null, 'One time'), h('dd', null, 'No subscription')),
          h('div', null, h('dt', null, 'Paid in'), h('dd', null, 'Your browser')))),
      sceneHost));
    const sc = scene('tip-jar', sceneHost, { accent: 'var(--c-tip)', reducedMotion: shell.reducedMotion });
    const body = h('div');
    el.append(body);

    const value = () => {
      if (!custom) return amount;
      const n = Number(custom);
      return Number.isFinite(n) ? Math.round(n * 100) / 100 : NaN;
    };

    function renderForm(errMsg = '') {
      const btns = AMOUNTS.map((v) => {
        const b = h('button', { type: 'button', 'aria-pressed': String(!custom && amount === v) }, `$${v}`);
        b.addEventListener('click', () => {
          amount = v; custom = '';
          inp.value = '';
          for (const x of btns) x.setAttribute('aria-pressed', String(x === b));
          clearErr();
          sync();
        });
        return b;
      });
      const inp = h('input.input', { type: 'text', inputmode: 'decimal', id: 'tip-custom', placeholder: '7', autocomplete: 'off',
        'aria-describedby': 'tip-err' });
      inp.value = custom;
      const err = h('p.err', { id: 'tip-err', role: 'alert', hidden: !errMsg }, errMsg);
      if (errMsg) inp.setAttribute('aria-invalid', 'true');
      const go = h('button.btn.btn-primary', { type: 'submit' });
      const clearErr = () => { err.hidden = true; inp.removeAttribute('aria-invalid'); };
      function sync() {
        const v = value();
        go.disabled = busy;
        setText(go, busy ? 'Opening the tip page…' : Number.isFinite(v) && v > 0 ? `Leave a ${money(v)} tip` : 'Leave a tip');
      }
      inp.addEventListener('input', () => {
        const clean = inp.value.replace(/[^0-9.]/g, '').replace(/(\..*)\./g, '$1').slice(0, 7);
        if (clean !== inp.value) inp.value = clean;
        custom = clean;
        for (const x of btns) x.setAttribute('aria-pressed', String(!custom && Number(x.textContent.slice(1)) === amount));
        clearErr();
        sync();
      });
      const form = h('form', { novalidate: '' },
        h('div.amts', { role: 'group', 'aria-label': 'Tip amount' }, btns),
        h('div.field', null, h('label', { for: 'tip-custom' }, 'Or your own amount'), h('div.money', null, h('span', { 'aria-hidden': 'true' }, '$'), inp), err),
        h('div.btns', null, go));
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (busy) return;
        const v = value();
        if (!Number.isFinite(v) || v < 1 || v > 1000) {
          err.textContent = 'Pick an amount between $1 and $1000.';
          err.hidden = false;
          inp.setAttribute('aria-invalid', 'true');
          inp.focus();
          return;
        }
        busy = true; sync();
        try {
          await api.tip.open(v);
          if (!alive) return;
          busy = false;
          renderThanks(v);
        } catch (ex) {
          if (!alive) return;
          busy = false; sync();
          err.textContent = errText(ex);
          err.hidden = false;
          go.focus();
        }
      });
      sync();
      setText(h1, 'Leave a tip');
      body.replaceChildren(h('section.card.tip-card', { 'aria-labelledby': 'tip-h' },
        h('h2', { id: 'tip-h' }, 'Pick an amount'),
        h('p.hint', null, 'Any amount helps. It goes to the people who build and test OmniDesk.'),
        form,
        h('p.hint.safe', null, icon('lock'), 'OmniDesk never sees your card. The tip page opens in your browser and handles the payment there.')));
    }

    function renderThanks(v) {
      setText(h1, 'Thank you');
      const back = h('button.btn', { type: 'button' }, 'Back to the tip jar');
      back.addEventListener('click', () => { renderForm(); const b = body.querySelector('.amts button[aria-pressed="true"]') || body.querySelector('button'); if (b) b.focus(); });
      const card = h('section.card.thanks', { role: 'status', tabindex: '-1' }, icon('tip'),
        h('h2', null, `${money(v)}, thank you. Truly.`),
        h('p', null, 'Your browser opened the tip page. Finish there; nothing was charged inside OmniDesk. Small tools are made by people, and this made our week.'),
        h('div.btns', null, back));
      body.replaceChildren(card);
      card.focus();
      shell.toast('Opened the tip page in your browser');
    }

    renderForm();

    return () => {
      alive = false;
      sc.stop();
    };
  },
};
