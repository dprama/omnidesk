// SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
// SPDX-License-Identifier: GPL-2.0-only
//
// Small camera viewer (the computer that watches): WebRTC answerer.
// Closing the window stops watching (handled in the main process).
(function () {
  'use strict';
  const U = window.OmniRtcUtil;
  const api = window.omniCamera;
  const video = document.getElementById('cam');
  const hint = document.getElementById('hint');
  let pc = null;
  const pendingIce = [];
  let playing = false;

  const send = (m) => api.send(m);
  const fail = (message) => { send({ type: 'error', message: String(message).slice(0, 300) }); close(); };

  function close() {
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
      if (s === 'failed' || s === 'closed') fail(`connection ${s}`);
    };
    pc.ontrack = (e) => {
      video.srcObject = e.streams && e.streams[0] ? e.streams[0] : new MediaStream([e.track]);
      video.play().catch(() => {});
    };
  }

  video.addEventListener('playing', () => {
    if (playing) return;
    playing = true;
    send({ type: 'state', state: 'playing', width: video.videoWidth, height: video.videoHeight });
    setTimeout(() => hint.classList.add('gone'), 1500);
  });

  async function onSignal(kind, data) {
    if (!pc) start();
    if (kind === 'offer') {
      await pc.setRemoteDescription({ type: 'offer', sdp: U.hostOnlySdp(data.sdp) });
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
    if (cmd.type === 'start') {
      if (typeof cmd.title === 'string') hint.textContent = `Connecting to ${cmd.title.slice(0, 60)}…`;
      if (!pc) start();
    } else if (cmd.type === 'signal') onSignal(cmd.kind, cmd.data).catch((e) => fail(e && e.message ? e.message : e));
    else if (cmd.type === 'stop') close();
  });
  window.addEventListener('beforeunload', close);
  send({ type: 'ready' });
}());
