// SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
// SPDX-License-Identifier: GPL-2.0-only
//
// Hidden capture window (the computer that gains a display): captures exactly
// the virtual monitor and sends it as the WebRTC offerer.
(function () {
  'use strict';
  const U = window.OmniRtcUtil;
  const api = window.omniScreen;
  let pc = null;
  let stream = null;
  let statsTimer = null;
  let prevSnap = null;
  let perfTick = 0;
  let order = U.CODEC_ORDER;
  let encoder = { hardware: false };
  let scale = 1;
  let sender = null;
  let encSnap = null; // { frames, time } at the last step-down check
  let switchedToVp8 = false;
  let encoderLogged = false;
  let pendingIce = [];
  let codecLogged = false;

  const send = (m) => api.send(m);
  const fail = (message) => { send({ type: 'error', message: String(message).slice(0, 300) }); close(); };

  function close() {
    clearInterval(statsTimer); statsTimer = null;
    if (pc) { try { pc.close(); } catch { /* closed */ } pc = null; }
    if (stream) { for (const t of stream.getTracks()) t.stop(); stream = null; }
  }

  async function start(c) {
    const preset = U.PRESETS[c.quality] || U.PRESETS.balanced;
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: c.chromeMediaSourceId,
          // Maximum only: with min = max Chromium may scale every frame to hit the exact size.
          maxWidth: c.width, maxHeight: c.height,
          maxFrameRate: c.refresh,
        },
      },
    });
    const track = stream.getVideoTracks()[0];
    if (!track) throw new Error('no video track');
    try { track.contentHint = preset.contentHint; } catch { /* optional */ }
    track.addEventListener('ended', () => fail('capture ended'));

    pc = new RTCPeerConnection(U.RTC_CONFIG);
    // Still not connected after 8 s: log what has been tried so far, on both computers
    // (the side that gives up first closes before the other can look).
    const slow = pc;
    setTimeout(() => {
      if (pc !== slow || slow.connectionState === 'connected') return;
      slow.getStats().then((r) => send({ type: 'log', message: `ice ${slow.connectionState} after 8s: ${U.iceSummary(Array.from(r.values()))}` })).catch(() => {});
    }, 8000);
    pc.onicecandidate = (e) => {
      if (e.candidate && U.isHostCandidate(e.candidate.candidate)) {
        send({ type: 'signal', kind: 'ice', data: { candidate: e.candidate.candidate, sdpMid: e.candidate.sdpMid, sdpMLineIndex: e.candidate.sdpMLineIndex } });
      }
    };
    pc.onconnectionstatechange = () => {
      const s = pc && pc.connectionState;
      if (s === 'connected') send({ type: 'state', state: 'connected' });
      if (s === 'closed') fail('connection closed');
      else if (s === 'failed') {
        // Say which addresses were tried before giving up (shows up in the app log).
        const p = pc;
        p.getStats().then((r) => send({ type: 'log', message: `ice failed: ${U.iceSummary(Array.from(r.values()))}` }))
          .catch(() => {}).finally(() => fail('connection failed'));
      }
    };

    // Which codec this computer encodes in hardware, and at what frame rate (see chooseEncoder).
    const probes = [];
    for (const codec of ['H264', 'VP8']) {
      for (const fps of [...new Set([c.refresh, 30])]) {
        try {
          const r = await navigator.mediaCapabilities.encodingInfo({ type: 'webrtc', video: { contentType: `video/${codec}`, width: c.width, height: c.height, bitrate: preset.maxBitrate, framerate: fps } });
          probes.push({ codec, fps, supported: !!r.supported, powerEfficient: !!r.powerEfficient });
        } catch { /* not answerable here */ }
      }
    }
    const pick = U.chooseEncoder(probes, c.refresh);
    order = pick.order;
    encoder = pick;
    scale = preset.scaleResolutionDownBy;
    send({ type: 'log', message: `encoder probes ${probes.map((p) => `${p.codec}@${p.fps}:${p.powerEfficient ? 'hw' : p.supported ? 'sw' : 'no'}`).join(' ')}` });
    send({ type: 'log', message: `codec order ${order.join(' > ')} (${pick.why})` });

    const tr = pc.addTransceiver(track, {
      direction: 'sendonly',
      streams: [stream],
      sendEncodings: [{
        maxBitrate: preset.maxBitrate, maxFramerate: Math.min(preset.maxFramerate, c.refresh, pick.maxFramerate), scaleResolutionDownBy: scale,
        priority: 'high', networkPriority: 'high', // DSCP marking: Wi-Fi sends these in its video queue
      }],
    });
    sender = tr.sender;
    try {
      const caps = RTCRtpSender.getCapabilities('video');
      if (caps && tr.setCodecPreferences) tr.setCodecPreferences(U.sortCodecs(caps.codecs, order));
    } catch { /* fall back to SDP munging below */ }
    try {
      const p = tr.sender.getParameters();
      p.degradationPreference = preset.degradationPreference;
      await tr.sender.setParameters(p);
    } catch { /* not supported everywhere */ }

    const offer = await pc.createOffer();
    const sdp = U.withBitrateFloor(U.setVideoBitrate(U.preferCodecsInSdp(U.hostOnlySdp(offer.sdp), order), preset.maxBitrate), preset.maxBitrate / 1000);
    await pc.setLocalDescription({ type: 'offer', sdp });
    send({ type: 'signal', kind: 'offer', data: { type: 'offer', sdp } });

    statsTimer = setInterval(async () => {
      if (!pc) return;
      try {
        const report = await pc.getStats();
        const list = Array.from(report.values());
        const r = U.summarize(list, prevSnap);
        prevSnap = r.snap;
        if (++perfTick % 10 === 0) send({ type: 'log', message: U.perfLine(list) }); // every 10 s
        // H.264 turned out to be software here: switch to VP8 without reconnecting.
        if (!switchedToVp8 && sender) {
          const out = list.find((x) => x.type === 'outbound-rtp' && x.kind === 'video');
          if (U.shouldUseVp8(out, out && list.find((x) => x.id === out.codecId))) {
            switchedToVp8 = true;
            const p = sender.getParameters();
            const vp8 = (p.codecs || []).find((x) => /vp8/i.test(x.mimeType));
            if (vp8 && p.encodings && p.encodings[0]) {
              p.encodings[0].codec = vp8;
              sender.setParameters(p).then(() => {
                encoder = { hardware: false };
                encSnap = null;
                send({ type: 'log', message: `H.264 encoder is software here (${out.encoderImplementation || '?'}): switched to VP8` });
              }).catch((e) => send({ type: 'log', message: `switching to VP8 failed: ${e && e.message ? e.message : e}` }));
            }
          } else if (out && out.framesEncoded >= 10 && !encoderLogged) {
            encoderLogged = true;
            send({ type: 'log', message: `encoder ${out.encoderImplementation || '?'} ${out.powerEfficientEncoder ? 'hardware' : 'software'}` });
          }
        }
        // Every 5 s: software encoding that can't keep up steps the resolution down.
        if (perfTick % 5 === 0) {
          const out = list.find((x) => x.type === 'outbound-rtp' && x.kind === 'video');
          if (out && out.framesEncoded) {
            const avg = encSnap && out.framesEncoded > encSnap.frames ? 1000 * (out.totalEncodeTime - encSnap.time) / (out.framesEncoded - encSnap.frames) : null;
            encSnap = { frames: out.framesEncoded, time: out.totalEncodeTime };
            const next = avg === null ? null : U.nextScale(scale, avg, encoder.hardware || !!out.powerEfficientEncoder);
            if (next && sender) {
              const p = sender.getParameters();
              if (p.encodings && p.encodings[0]) {
                p.encodings[0].scaleResolutionDownBy = next;
                sender.setParameters(p).then(() => { scale = next; send({ type: 'log', message: `encoding ${avg.toFixed(0)}ms a frame in software: resolution / ${next}` }); }).catch(() => {});
              }
            }
          }
        }
        if (!codecLogged) { const codec = U.codecInUse(list); if (codec) { codecLogged = true; send({ type: 'log', message: `codec ${codec}` }); } }
        send({ type: 'stats', fps: r.fps, latencyMs: r.latencyMs });
      } catch { /* closed */ }
    }, 1000);
  }

  async function onSignal(kind, data) {
    if (!pc) return;
    if (kind === 'answer') {
      await pc.setRemoteDescription({ type: 'answer', sdp: U.hostOnlySdp(data.sdp) });
      for (const c of pendingIce.splice(0)) await pc.addIceCandidate(c).catch(() => {});
    } else if (kind === 'ice') {
      if (!U.isHostCandidate(data.candidate)) return;
      if (!pc.remoteDescription) pendingIce.push(data); else await pc.addIceCandidate(data).catch(() => {});
    }
  }

  api.onCommand((cmd) => {
    if (!cmd || typeof cmd !== 'object') return;
    if (cmd.type === 'start') start(cmd).catch((e) => fail(e && e.message ? e.message : e));
    else if (cmd.type === 'signal') onSignal(cmd.kind, cmd.data).catch((e) => fail(e && e.message ? e.message : e));
    else if (cmd.type === 'stop') close();
  });
  window.addEventListener('beforeunload', close);
  send({ type: 'ready' });
}());
