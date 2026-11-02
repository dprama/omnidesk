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
          minWidth: c.width, maxWidth: c.width,
          minHeight: c.height, maxHeight: c.height,
          maxFrameRate: c.refresh,
        },
      },
    });
    const track = stream.getVideoTracks()[0];
    if (!track) throw new Error('no video track');
    try { track.contentHint = preset.contentHint; } catch { /* optional */ }
    track.addEventListener('ended', () => fail('capture ended'));

    pc = new RTCPeerConnection(U.RTC_CONFIG);
    pc.onicecandidate = (e) => {
      if (e.candidate && U.isHostCandidate(e.candidate.candidate)) {
        send({ type: 'signal', kind: 'ice', data: { candidate: e.candidate.candidate, sdpMid: e.candidate.sdpMid, sdpMLineIndex: e.candidate.sdpMLineIndex } });
      }
    };
    pc.onconnectionstatechange = () => {
      const s = pc && pc.connectionState;
      if (s === 'connected') send({ type: 'state', state: 'connected' });
      if (s === 'failed' || s === 'closed') fail(`connection ${s}`);
    };

    const tr = pc.addTransceiver(track, {
      direction: 'sendonly',
      streams: [stream],
      sendEncodings: [{ maxBitrate: preset.maxBitrate, maxFramerate: Math.min(preset.maxFramerate, c.refresh), scaleResolutionDownBy: preset.scaleResolutionDownBy }],
    });
    // H.264 first (hardware encoders), VP8 as fallback.
    try {
      const caps = RTCRtpSender.getCapabilities('video');
      if (caps && tr.setCodecPreferences) tr.setCodecPreferences(U.sortCodecs(caps.codecs));
    } catch { /* fall back to SDP munging below */ }
    try {
      const p = tr.sender.getParameters();
      p.degradationPreference = preset.degradationPreference;
      await tr.sender.setParameters(p);
    } catch { /* not supported everywhere */ }

    const offer = await pc.createOffer();
    const sdp = U.setVideoBitrate(U.preferCodecsInSdp(U.hostOnlySdp(offer.sdp)), preset.maxBitrate);
    await pc.setLocalDescription({ type: 'offer', sdp });
    send({ type: 'signal', kind: 'offer', data: { type: 'offer', sdp } });

    statsTimer = setInterval(async () => {
      if (!pc) return;
      try {
        const report = await pc.getStats();
        const list = Array.from(report.values());
        const r = U.summarize(list, prevSnap);
        prevSnap = r.snap;
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
