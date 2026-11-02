// SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
// SPDX-License-Identifier: GPL-2.0-only
'use strict';

// Builds a pre-filled GitHub "new issue" URL. No server, no account.

const KINDS = { bug: { label: 'bug', prefix: 'Bug' }, idea: { label: 'enhancement', prefix: 'Idea' }, thanks: { label: 'thanks', prefix: 'Thanks' } };
const MAX_URL = 7500; // GitHub refuses very long URLs

function formatSystemInfo(info) {
  const mons = (info.monitors || []).map((r) => `[${r.x},${r.y},${r.w}x${r.h}]`).join('');
  return [
    '### System info',
    '',
    `- OS: ${info.os} ${info.osVersion} (${info.arch})`,
    `- OmniDesk: ${info.appVersion}`,
    `- Engine: ${info.engineVersion || 'not found'}`,
    `- Monitors: ${mons || 'unknown'}`,
    `- Devices: ${info.devices}`,
  ].join('\n');
}

function buildIssueUrl({ repoUrl, kind, message, includeSystemInfo, systemInfo }) {
  const k = KINDS[kind];
  if (!k) throw Object.assign(new Error('bad kind'), { code: 'bad-args' });
  const base = String(repoUrl || 'https://github.com/dprama/omnidesk').replace(/\/+$/, '');
  const u = new URL(`${base}/issues/new`);
  if (u.protocol !== 'https:' || u.hostname !== 'github.com') throw Object.assign(new Error('bad repo'), { code: 'bad-repo' });
  const text = String(message || '').trim();
  const firstLine = text.split(/\r?\n/)[0].slice(0, 70) || k.prefix;
  const tail = includeSystemInfo && systemInfo ? `\n\n${formatSystemInfo(systemInfo)}` : '';
  let body = text + tail;
  const make = (b) => {
    const url = new URL(u);
    url.searchParams.set('title', `[${k.prefix}] ${firstLine}`);
    url.searchParams.set('labels', k.label);
    url.searchParams.set('body', b);
    return url.toString();
  };
  let url = make(body);
  if (url.length > MAX_URL) {
    const over = url.length - MAX_URL;
    const cut = Math.max(0, text.length - Math.ceil(over / 3) - 40);
    url = make(`${text.slice(0, cut)}\n\n…(shortened)${tail}`);
  }
  return url;
}

module.exports = { buildIssueUrl, formatSystemInfo, KINDS };
