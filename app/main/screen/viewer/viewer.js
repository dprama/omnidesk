// SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
// SPDX-License-Identifier: GPL-2.0-only
//
// Full-screen viewer (the laptop that becomes a screen): WebRTC answerer.
// Esc twice / Ctrl+Alt+Shift+Q are handled in the main process.
(function () {
  'use strict';
  const U = window.OmniRtcUtil;
  const api = window.omniScreen;
  const video = document.getElementById('screen');
  const hint = document.getElementById('hint');
  let pc = null;
  let statsTimer = null;
  let prevSnap = null;
  const pendingIce = [];
  let playing = false;

  const send = (m) => api.send(m);
  const fail = (message) => { send({ type: 'error', message: String(message).slice(0, 300) }); close(); };

  function close() {
    clearInterval(statsTimer); statsTimer = null;
    if (pc) { try { pc.close(); } catch { /* closed */ } pc = null; }
    video.srcObject = null;
  }

  function start() {
    pc = new RTCPeerConnection(U.RTC_CONFIG);
    pc.onicecandidate = (e) => {
      if (e.candidate && U.isHostCandidate(e.candidate.candidate)) {
        send({ type: 'signal', kind: 'ice', data: { candidate: e.candidate.candidate, sdpMid: e.candidate.sdpMid, sdpMLineIndex: e.candidate.sdpMLineIndex } });
      }
    };
    pc.onconnectionstatechange = () => {
      const s = pc && pc.connectionState;
      if (s === 'closed') fail('connection closed');
      else if (s === 'failed') {
        // Say which addresses were tried before giving up (shows up in the app log).
        const p = pc;
        p.getStats().then((r) => send({ type: 'log', message: `ice failed: ${U.iceSummary(Array.from(r.values()))}` }))
          .catch(() => {}).finally(() => fail('connection failed'));
      }
    };
    pc.ontrack = (e) => {
      // Lowest possible playout delay: this is a live desktop, not a film.
      try { if ('jitterBufferTarget' in e.receiver) e.receiver.jitterBufferTarget = 0; } catch { /* optional */ }
      try { e.receiver.playoutDelayHint = 0; } catch { /* optional */ }
      video.srcObject = e.streams && e.streams[0] ? e.streams[0] : new MediaStream([e.track]);
      video.play().catch(() => {});
    };
    video.addEventListener('playing', () => {
      if (playing) return;
      playing = true;
      send({ type: 'state', state: 'playing', width: video.videoWidth, height: video.videoHeight });
      setTimeout(() => hint.classList.add('gone'), 2500);
    });
    statsTimer = setInterval(async () => {
      if (!pc) return;
      try {
        const r = U.summarize(Array.from((await pc.getStats()).values()), prevSnap);
        prevSnap = r.snap;
        send({ type: 'stats', fps: r.fps, latencyMs: r.latencyMs });
      } catch { /* closed */ }
    }, 1000);
  }

  async function onSignal(kind, data) {
    if (!pc) start();
    if (kind === 'offer') {
      await pc.setRemoteDescription({ type: 'offer', sdp: U.hostOnlySdp(data.sdp) });
      for (const t of pc.getTransceivers()) {
        try {
          const caps = RTCRtpReceiver.getCapabilities('video');
          if (caps && t.setCodecPreferences) t.setCodecPreferences(U.sortCodecs(caps.codecs));
        } catch { /* SDP order from the offer is used */ }
      }
      const answer = await pc.createAnswer();
      const sdp = U.preferCodecsInSdp(U.hostOnlySdp(answer.sdp));
      await pc.setLocalDescription({ type: 'answer', sdp });
      send({ type: 'signal', kind: 'answer', data: { type: 'answer', sdp } });
      for (const c of pendingIce.splice(0)) await pc.addIceCandidate(c).catch(() => {});
    } else if (kind === 'ice') {
      if (!U.isHostCandidate(data.candidate)) return;
      if (!pc.remoteDescription) pendingIce.push(data); else await pc.addIceCandidate(data).catch(() => {});
    }
  }

  api.onCommand((cmd) => {
    if (!cmd || typeof cmd !== 'object') return;
    if (cmd.type === 'start') { if (!pc) start(); } else if (cmd.type === 'signal') onSignal(cmd.kind, cmd.data).catch((e) => fail(e && e.message ? e.message : e));
    else if (cmd.type === 'stop') close();
  });
  window.addEventListener('beforeunload', close);
  send({ type: 'ready' });
}());
