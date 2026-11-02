// SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
// SPDX-License-Identifier: GPL-2.0-only
//
// Pure helpers shared by the capture/viewer renderers (loaded as a classic
// script, sets window.OmniRtcUtil) and the Node tests (CommonJS):
// quality presets, codec ordering, SDP munging, host-only ICE, stats → latency/fps.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.OmniRtcUtil = Object.freeze(api);
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Quality presets. maxBitrate in bits/s.
  const PRESETS = Object.freeze({
    latency: Object.freeze({ scaleResolutionDownBy: 1.5, maxFramerate: 60, maxBitrate: 6000000, degradationPreference: 'maintain-framerate', contentHint: 'motion' }),
    // 'motion', not 'detail': with 'detail' WebRTC keeps resolution and lets the frame rate fall.
    balanced: Object.freeze({ scaleResolutionDownBy: 1, maxFramerate: 60, maxBitrate: 12000000, degradationPreference: 'balanced', contentHint: 'motion' }),
    sharp: Object.freeze({ scaleResolutionDownBy: 1, maxFramerate: 60, maxBitrate: 25000000, degradationPreference: 'maintain-resolution', contentHint: 'text' }),
  });

  const CODEC_ORDER = Object.freeze(['H264', 'VP8']);

  // Codec order for the sender from mediaCapabilities.encodingInfo answers
  // ({ H264: { supported, powerEfficient }, VP8: {...} }). H.264 only when it is encoded in
  // hardware: software H.264 (OpenH264) managed 2-17 fps at 1080p on a real PC and in a
  // test here, where software VP8 kept ~58 fps at 12 ms a frame.
  function chooseCodecOrder(info) {
    const hw = (c) => !!(info && info[c] && info[c].supported && info[c].powerEfficient);
    if (hw('H264')) return { order: ['H264', 'VP8'], why: 'H.264 in hardware' };
    if (hw('VP8')) return { order: ['VP8', 'H264'], why: 'VP8 in hardware' };
    return { order: ['VP8', 'H264'], why: 'no hardware encoder: VP8 in software' };
  }

  // Video codec names in the order of the first m=video line, e.g. ['VP8', 'rtx', 'H264', ...]
  // without rtx/red/ulpfec: the receiver answers in the sender's order.
  function codecOrderFromSdp(sdp) {
    const lines = splitLines(sdp);
    const sec = sections(lines).find((x) => x.kind === 'video');
    if (!sec) return [...CODEC_ORDER];
    const names = {};
    for (let i = sec.start + 1; i < sec.end; i++) {
      const m = /^a=rtpmap:(\d+) ([^/]+)\//.exec(lines[i]);
      if (m) names[m[1]] = m[2];
    }
    const out = [];
    for (const pt of lines[sec.start].split(' ').slice(3)) {
      const n = names[pt];
      if (n && !/^(rtx|red|ulpfec|flexfec-03)$/i.test(n) && !out.some((o) => o.toUpperCase() === n.toUpperCase())) out.push(n);
    }
    return out.length ? out : [...CODEC_ORDER];
  }

  // LAN only: no STUN/TURN, so only host candidates exist; this also drops any
  // srflx/relay/prflx line that might be signalled anyway.
  const RTC_CONFIG = Object.freeze({ iceServers: [], iceCandidatePoolSize: 0, bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require', iceTransportPolicy: 'all' });

  function isHostCandidate(candidate) {
    if (typeof candidate !== 'string' || candidate.length > 1024) return false;
    return /(^|\s)typ\s+host(\s|$)/.test(candidate);
  }

  // H.264 ranking: packetization-mode=1 first, then constrained baseline
  // (42e0xx, widest hardware support), then high (640cxx), then the rest.
  function h264Rank(fmtp) {
    const f = (fmtp || '').toLowerCase();
    let r = 0;
    if (!/packetization-mode=1/.test(f)) r += 10;
    const m = /profile-level-id=([0-9a-f]{6})/.exec(f);
    const p = m ? m[1].slice(0, 4) : '';
    if (p === '42e0') r += 0; else if (p === '640c') r += 1; else if (p === '4d00') r += 2; else r += 3;
    return r;
  }

  // Sort RTCRtpCodecCapability[] (from RTCRtpSender/Receiver.getCapabilities)
  // for setCodecPreferences: H.264, then VP8, then everything else in place.
  // rtx/red/ulpfec stay (they are needed for retransmission and FEC).
  function sortCodecs(codecs, order = CODEC_ORDER) {
    const name = (c) => String(c.mimeType || '').split('/')[1] || '';
    const rank = (c) => {
      const i = order.findIndex((o) => o.toLowerCase() === name(c).toLowerCase());
      return i === -1 ? order.length : i;
    };
    return codecs
      .map((c, i) => ({ c, i }))
      .sort((a, b) => rank(a.c) - rank(b.c)
        || (name(a.c).toUpperCase() === 'H264' && name(b.c).toUpperCase() === 'H264' ? h264Rank(a.c.sdpFmtpLine) - h264Rank(b.c.sdpFmtpLine) : 0)
        || a.i - b.i)
      .map((x) => x.c);
  }

  function splitLines(sdp) { return String(sdp).split(/\r\n|\n/).filter((l, i, a) => !(l === '' && i === a.length - 1)); }
  function joinLines(lines) { return lines.join('\r\n') + '\r\n'; }

  // Index of each media section: [{ start, end, kind }].
  function sections(lines) {
    const out = [];
    lines.forEach((l, i) => {
      if (l.startsWith('m=')) {
        if (out.length) out[out.length - 1].end = i;
        out.push({ start: i, end: lines.length, kind: l.slice(2).split(' ')[0] });
      }
    });
    return out;
  }

  // Reorder the payload types on the m=video line(s): preferred codecs first,
  // each followed by its rtx payload. Nothing is removed.
  function preferCodecsInSdp(sdp, order = CODEC_ORDER) {
    const lines = splitLines(sdp);
    for (const sec of sections(lines)) {
      if (sec.kind !== 'video') continue;
      const mParts = lines[sec.start].split(' ');
      const pts = mParts.slice(3);
      const codecOf = {}; const fmtpOf = {}; const rtxFor = {};
      for (let i = sec.start + 1; i < sec.end; i++) {
        let m = /^a=rtpmap:(\d+) ([^/]+)\//.exec(lines[i]);
        if (m) codecOf[m[1]] = m[2];
        m = /^a=fmtp:(\d+) (.*)$/.exec(lines[i]);
        if (m) {
          fmtpOf[m[1]] = m[2];
          const apt = /apt=(\d+)/.exec(m[2]);
          if (apt && /^rtx$/i.test(codecOf[m[1]] || '')) rtxFor[apt[1]] = m[1];
        }
      }
      // rtpmap may come after fmtp: second pass for rtx.
      for (const pt of pts) {
        const apt = /apt=(\d+)/.exec(fmtpOf[pt] || '');
        if (apt && /^rtx$/i.test(codecOf[pt] || '')) rtxFor[apt[1]] = pt;
      }
      const picked = [];
      for (const name of order) {
        const mine = pts.filter((pt) => (codecOf[pt] || '').toLowerCase() === name.toLowerCase());
        if (name.toUpperCase() === 'H264') mine.sort((a, b) => h264Rank(fmtpOf[a]) - h264Rank(fmtpOf[b]));
        for (const pt of mine) { picked.push(pt); if (rtxFor[pt]) picked.push(rtxFor[pt]); }
      }
      const rest = pts.filter((pt) => !picked.includes(pt));
      lines[sec.start] = mParts.slice(0, 3).concat(picked, rest).join(' ');
    }
    return joinLines(lines);
  }

  // Bandwidth cap for the video section (b=AS in kbit/s, b=TIAS in bit/s).
  function setVideoBitrate(sdp, bitsPerSecond) {
    const lines = splitLines(sdp);
    const secs = sections(lines).filter((s) => s.kind === 'video').reverse();
    for (const sec of secs) {
      for (let i = sec.end - 1; i > sec.start; i--) if (/^b=(AS|TIAS):/.test(lines[i])) lines.splice(i, 1);
      let at = sec.start + 1;
      while (at < lines.length && (lines[at].startsWith('i=') || lines[at].startsWith('c='))) at++;
      lines.splice(at, 0, `b=AS:${Math.round(bitsPerSecond / 1000)}`, `b=TIAS:${Math.round(bitsPerSecond)}`);
    }
    return joinLines(lines);
  }

  // Drop every a=candidate line that is not a host candidate.
  function hostOnlySdp(sdp) {
    return joinLines(splitLines(sdp).filter((l) => !l.startsWith('a=candidate:') || isHostCandidate(l.slice(2))));
  }

  // The codec actually used, e.g. 'H264' (for the log).
  function codecInUse(stats) {
    const list = Array.from(stats);
    const rtp = list.find((s) => (s.type === 'outbound-rtp' || s.type === 'inbound-rtp') && s.kind === 'video' && s.codecId);
    const codec = rtp && list.find((s) => s.id === rtp.codecId);
    return codec ? String(codec.mimeType || '').split('/')[1] || null : null;
  }

  // stats: iterable of RTCStats objects (Array.from(report.values())).
  // prev: the previous return value's .snap (or null).
  // Returns { fps, latencyMs, snap }.
  //   latencyMs ≈ one-way network (rtt/2) + jitter buffer + decode (receiver)
  //               or rtt/2 + encode (sender).
  function summarize(stats, prev) {
    const list = Array.from(stats);
    const byId = new Map(list.map((s) => [s.id, s]));
    let pair = null;
    const transport = list.find((s) => s.type === 'transport' && s.selectedCandidatePairId);
    if (transport) pair = byId.get(transport.selectedCandidatePairId) || null;
    if (!pair) pair = list.find((s) => s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') || null;
    let rtt = pair && typeof pair.currentRoundTripTime === 'number' ? pair.currentRoundTripTime : null;
    if (rtt === null) {
      const rin = list.find((s) => s.type === 'remote-inbound-rtp' && s.kind === 'video' && typeof s.roundTripTime === 'number');
      if (rin) rtt = rin.roundTripTime;
    }
    const inb = list.find((s) => s.type === 'inbound-rtp' && s.kind === 'video');
    const out = list.find((s) => s.type === 'outbound-rtp' && s.kind === 'video');
    const rtp = inb || out;
    const snap = {
      t: rtp && typeof rtp.timestamp === 'number' ? rtp.timestamp : Date.now(),
      frames: rtp ? (inb ? inb.framesDecoded : out.framesEncoded) || 0 : 0,
      jbDelay: inb ? inb.jitterBufferDelay || 0 : 0,
      jbCount: inb ? inb.jitterBufferEmittedCount || 0 : 0,
      codecTime: rtp ? (inb ? inb.totalDecodeTime : out.totalEncodeTime) || 0 : 0,
    };
    let fps = rtp && typeof rtp.framesPerSecond === 'number' ? rtp.framesPerSecond : null;
    let extra = 0;
    if (prev) {
      const dt = (snap.t - prev.t) / 1000;
      const df = snap.frames - prev.frames;
      if (fps === null && dt > 0 && df >= 0) fps = df / dt;
      if (df > 0) extra += Math.max(0, (snap.codecTime - prev.codecTime) / df);
      const dc = snap.jbCount - prev.jbCount;
      if (dc > 0) extra += Math.max(0, (snap.jbDelay - prev.jbDelay) / dc);
    }
    const latencyMs = rtt === null && extra === 0 ? 0 : Math.round(((rtt || 0) / 2 + extra) * 1000);
    return { fps: Math.round(fps || 0), latencyMs, snap };
  }

  // One log line for a failed connection: the addresses each side offered and how the
  // connectivity checks went, e.g.
  // "local udp 192.168.1.5 | remote udp 192.168.1.20,fd00::2 | pairs failed 4 | checks 12 sent, 0 answered"
  function iceSummary(stats) {
    const addrs = (type) => {
      const m = new Map();
      for (const r of stats) {
        if (r.type !== type) continue;
        const k = r.protocol || 'udp';
        if (!m.has(k)) m.set(k, new Set());
        m.get(k).add(String(r.address || r.ip || '?'));
      }
      return [...m].map(([proto, set]) => `${proto} ${[...set].join(',')}`).join(' ') || 'none';
    };
    const states = new Map();
    let sent = 0, answered = 0;
    for (const r of stats) {
      if (r.type !== 'candidate-pair') continue;
      states.set(r.state, (states.get(r.state) || 0) + 1);
      sent += r.requestsSent || 0;
      answered += r.responsesReceived || 0;
    }
    const pairs = [...states].map(([st, n]) => `${st} ${n}`).join(', ') || 'none';
    return `local ${addrs('local-candidate')} | remote ${addrs('remote-candidate')} | pairs ${pairs} | checks ${sent} sent, ${answered} answered`;
  }

  // One log line on where the time goes, every 10 s of a session. Averages since the start.
  // Sender: "send 1920x1080 58fps enc MediaFoundationVideoEncodeAccelerator hw 4.1ms limit none rtt 6ms"
  // Receiver: "recv 1920x1080 59fps dec VideoToolbox hw 2.0ms jitter 18ms dropped 0 lost 0 rtt 6ms"
  function perfLine(stats) {
    const list = Array.from(stats);
    const ms = (total, n) => (n ? `${(1000 * total / n).toFixed(1)}ms` : '?');
    const pair = list.find((r) => r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded');
    const rtt = pair && typeof pair.currentRoundTripTime === 'number' ? ` rtt ${Math.round(pair.currentRoundTripTime * 1000)}ms` : '';
    const out = list.find((r) => r.type === 'outbound-rtp' && r.kind === 'video');
    if (out) {
      return `send ${out.frameWidth || '?'}x${out.frameHeight || '?'} ${Math.round(out.framesPerSecond || 0)}fps`
        + ` enc ${out.encoderImplementation || '?'} ${out.powerEfficientEncoder ? 'hw' : 'sw'} ${ms(out.totalEncodeTime, out.framesEncoded)}`
        + ` limit ${out.qualityLimitationReason || 'none'}${rtt}`;
    }
    const inb = list.find((r) => r.type === 'inbound-rtp' && r.kind === 'video');
    if (inb) {
      return `recv ${inb.frameWidth || '?'}x${inb.frameHeight || '?'} ${Math.round(inb.framesPerSecond || 0)}fps`
        + ` dec ${inb.decoderImplementation || '?'} ${inb.powerEfficientDecoder ? 'hw' : 'sw'} ${ms(inb.totalDecodeTime, inb.framesDecoded)}`
        + ` jitter ${ms(inb.jitterBufferDelay, inb.jitterBufferEmittedCount)} dropped ${inb.framesDropped || 0} lost ${inb.packetsLost || 0}${rtt}`;
    }
    return 'no video yet';
  }

  return { PRESETS, CODEC_ORDER, RTC_CONFIG, isHostCandidate, sortCodecs, preferCodecsInSdp, setVideoBitrate, hostOnlySdp, codecInUse, summarize, h264Rank, iceSummary, perfLine, chooseCodecOrder, codecOrderFromSdp };
}));
