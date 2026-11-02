// SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
// SPDX-License-Identifier: GPL-2.0-only
'use strict';

// JSON messages framed with a 4-byte big-endian length prefix.

function encode(obj, max) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  if (body.length > max) throw Object.assign(new Error(`message is ${body.length} bytes, the limit is ${max}`), { code: 'too-large' });
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length);
  return Buffer.concat([head, body]);
}

// Calls onMessage(obj) per frame; onError(err) on an oversized or bad frame
// (the caller should then drop the connection). Returns the 'data' handler.
function decoder(max, onMessage, onError) {
  let buf = Buffer.alloc(0);
  let dead = false;
  return (chunk) => {
    if (dead) return;
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    while (buf.length >= 4) {
      const len = buf.readUInt32BE(0);
      if (len > max) { dead = true; onError(Object.assign(new Error('frame too large'), { code: 'too-large' })); return; }
      if (buf.length < 4 + len) return;
      const body = buf.subarray(4, 4 + len);
      buf = buf.subarray(4 + len);
      let msg;
      try { msg = JSON.parse(body.toString('utf8')); } catch { dead = true; onError(Object.assign(new Error('bad frame'), { code: 'bad-frame' })); return; }
      if (!msg || typeof msg !== 'object' || Array.isArray(msg)) { dead = true; onError(Object.assign(new Error('bad frame'), { code: 'bad-frame' })); return; }
      onMessage(msg);
      if (dead) return;
    }
  };
}

module.exports = { encode, decoder };
