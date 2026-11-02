// SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
// SPDX-License-Identifier: GPL-2.0-only
//
// Feedback: Bug / Idea / Thank you, a required message, and an opt-in "Include system info"
// that shows exactly what feedback.systemInfo() returns before anything is sent.
// Sending opens a pre-filled GitHub issue in the browser (feedback.send).

import { h, setText } from '../shell/dom.js';
import { icon } from '../shell/icons.js';
import { scene } from '../art/index.js';


const errText = (e) => (e && e.message) || 'Something went wrong. Try again.';
const KINDS = [
  ['bug', 'Bug', 'What happened, and what did you expect instead?'],
  ['idea', 'Idea', 'What would make OmniDesk better for you?'],
  ['thanks', 'Thank you', 'Say hi. We read every message.'],
];
const MAX = 4000;

export default {
  id: 'feedback', label: 'Feedback', tab: 'Feedback', group: 'more', accent: 'var(--c-fb)', icon: 'feedback',

  mount(el, api, shell) {
    let alive = true;
    let kind = 'bug';
    let message = '';
    let withInfo = false;
    let info = null;           // feedback.systemInfo() result
    let infoErr = '';
    let busy = false;

    const sceneHost = h('div.lh-scene', { 'aria-hidden': 'true' });
    const kick = h('span.kick', null, h('i', { 'aria-hidden': 'true' }), 'Write to us');
    const sInfo = h('dd', null, 'Not included');
    el.replaceChildren(h('header.lh', null,
      h('div', null, kick, h('h1', null, 'Feedback'),
        h('p.sub', null, 'Found a bug, have an idea, or want to say thanks? It goes straight to the people who build OmniDesk.'),
        h('dl.stats', null,
          h('div', null, h('dt', null, 'Sent as'), h('dd', null, 'A GitHub issue')),
          h('div', null, h('dt', null, 'System info'), sInfo))),
      sceneHost));
    const sc = scene('feedback-note', sceneHost, { accent: 'var(--c-fb)', reducedMotion: shell.reducedMotion });
    const body = h('div');
    el.append(body);

    function renderForm() {
      setText(kick.lastChild, 'Write to us');
      const seg = h('div.seg', { role: 'group', 'aria-label': 'Feedback type', id: 'fb-kind' });
      const ta = h('textarea.textarea', { id: 'fb-msg', maxlength: String(MAX), 'aria-required': 'true', 'aria-describedby': 'fb-err' });
      ta.value = message;
      const setKind = (k) => {
        kind = k;
        for (const b of seg.children) b.setAttribute('aria-pressed', String(b.dataset.k === k));
        ta.placeholder = KINDS.find((x) => x[0] === k)[2];
      };
      for (const [k, label] of KINDS) {
        const b = h('button', { type: 'button', 'data-k': k, 'aria-pressed': 'false' }, label);
        b.addEventListener('click', () => setKind(k));
        seg.append(b);
      }
      setKind(kind);
      const err = h('p.err', { id: 'fb-err', role: 'alert', hidden: true });
      const count = h('div.count', { 'aria-hidden': 'true' }, `${message.length} / ${MAX}`);
      ta.addEventListener('input', () => {
        message = ta.value;
        setText(count, `${message.length} / ${MAX}`);
        if (!err.hidden && message.trim()) { err.hidden = true; ta.removeAttribute('aria-invalid'); }
      });

      const cb = h('input', { type: 'checkbox', id: 'fb-sys', 'aria-controls': 'fb-sysinfo' });
      cb.checked = withInfo;
      const sysBox = h('div', { id: 'fb-sysinfo' });
      const renderInfo = () => {
        setText(sInfo, withInfo ? 'Included' : 'Not included');
        if (!withInfo) { sysBox.replaceChildren(); return; }
        if (infoErr) { sysBox.replaceChildren(h('p.err', { role: 'alert' }, infoErr)); return; }
        if (!info) { sysBox.replaceChildren(h('p.hint', null, 'Reading system info…')); return; }
        sysBox.replaceChildren(
          h('p.hint.sys-cap', null, 'This is exactly what gets attached. No names, emails or device names.'),
          h('pre.sysinfo', { tabindex: '0', 'aria-label': 'System info that will be attached' }, JSON.stringify(info, null, 2)));
      };
      cb.addEventListener('change', async () => {
        withInfo = cb.checked;
        renderInfo();
        if (withInfo && !info) {
          infoErr = '';
          try { info = await api.feedback.systemInfo(); } catch (e) { infoErr = errText(e); }
          if (alive && withInfo) renderInfo();
        }
      });
      renderInfo();

      const send = h('button.btn.btn-primary', { type: 'submit' }, icon('arrow'), 'Send feedback');
      const form = h('form', { novalidate: '' },
        h('span.lab', { id: 'fb-kind-l' }, 'Type'), seg,
        h('div.field', null, h('label', { for: 'fb-msg' }, 'Message'), ta, count, err),
        h('label.check', { for: 'fb-sys' }, cb,
          h('span', null, h('b', null, 'Include system info'),
            h('span.d', null, 'Helps us reproduce bugs. You see exactly what is attached before sending.'))),
        sysBox,
        h('div.btns', null, send),
        h('p.hint', null, 'Sending opens a pre-filled GitHub issue in your browser. Nothing is posted until you submit it there.'));
      seg.setAttribute('aria-labelledby', 'fb-kind-l');
      seg.removeAttribute('aria-label');
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (busy) return;
        if (!message.trim()) {
          err.textContent = 'Write a few words first.';
          err.hidden = false;
          ta.setAttribute('aria-invalid', 'true');
          ta.focus();
          return;
        }
        if (withInfo && !info) {
          err.textContent = infoErr ? 'System info could not be read. Untick it to send without it.' : 'Wait a moment while the system info loads.';
          err.hidden = false;
          return;
        }
        busy = true;
        send.disabled = true;
        setText(send.lastChild, 'Opening GitHub…');
        try {
          await api.feedback.send({ kind, message: message.trim(), includeSystemInfo: withInfo });
          if (!alive) return;
          busy = false;
          renderSent();
        } catch (ex) {
          if (!alive) return;
          busy = false;
          send.disabled = false;
          setText(send.lastChild, 'Send feedback');
          err.textContent = errText(ex);
          err.hidden = false;
        }
      });

      body.replaceChildren(h('section.card.fb-card', { 'aria-label': 'Write feedback' }, form));
    }

    function renderSent() {
      setText(kick.lastChild, 'Sent');
      const again = h('button.btn', { type: 'button' }, 'Write another');
      again.addEventListener('click', () => {
        message = ''; withInfo = false;
        renderForm();
        const t = body.querySelector('textarea');
        if (t) t.focus();
      });
      const label = KINDS.find((k) => k[0] === kind)[1];
      const card = h('section.card.thanks', { role: 'status', tabindex: '-1' }, icon('check'),
        h('h2', null, 'Opened a pre-filled GitHub issue in your browser'),
        h('p', null, `${label} · ${message.trim().length} characters · system info ${withInfo ? 'included' : 'not included'}. Check it there and press Submit new issue. Thank you for writing.`),
        h('div.btns', null, again));
      body.replaceChildren(card);
      card.focus();
    }

    renderForm();

    return () => {
      alive = false;
      sc.stop();
    };
  },
};
