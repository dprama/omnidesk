// SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
// SPDX-License-Identifier: GPL-2.0-only
//
// Hidden capture window (the computer that shares its camera): opens the
// camera once and sends it to each watcher as a separate WebRTC offerer.
(function () {
  'use strict';
  const U = window.OmniRtcUtil;
  const api = window.omniCamera;
  const peers = new Map(); // sessionId -> { pc, pendingIce }
  let stream = null;

  const send = (m) => api.send(m);

  function explain(e) {
    const name = e && e.name;
    if (name === 'NotAllowedError' || name === 'SecurityError') return 'OmniDesk isn\'t allowed to use the camera.';
    if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No camera was found on this computer.';
    if (name === 'NotReadableError' || name === 'AbortError') return 'The camera is in use by another app.';
    return `The camera could not start: ${e && e.message ? e.message : e}`;
  }

  function removeSession(id) {
    const s = peers.get(id);
    if (!s) return;
    peers.delete(id);
    try { s.pc.close(); } catch { /* closed */ }
  }

  function closeAll() {
    for (const id of [...peers.keys()]) removeSession(id);
    if (stream) { for (const t of stream.getTracks()) t.stop(); stream = null; }
  }

  async function startCamera() {
    if (stream) { send({ type: 'camera', ok: true }); return; }
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } },
      });
    } catch (e) { send({ type: 'error', message: explain(e) }); return; }
    const track = stream.getVideoTracks()[0];
    if (!track) { send({ type: 'error', message: 'No camera was found on this computer.' }); closeAll(); return; }
    track.addEventListener('ended', () => { send({ type: 'error', message: 'The camera was disconnected.' }); closeAll(); });
    send({ type: 'camera', ok: true });
  }

  async function addSession(id) {
    if (!stream || peers.has(id)) return;
    const pc = new RTCPeerConnection(U.RTC_CONFIG);
    const s = { pc, pendingIce: [] };
    peers.set(id, s);
    const fail = (message) => { send({ type: 'session-error', sessionId: id, message: String(message).slice(0, 300) }); removeSession(id); };
    pc.onicecandidate = (e) => {
      if (e.candidate && U.isHostCandidate(e.candidate.candidate)) {
        send({ type: 'signal', sessionId: id, kind: 'ice', data: { candidate: e.candidate.candidate, sdpMid: e.candidate.sdpMid, sdpMLineIndex: e.candidate.sdpMLineIndex } });
      }
    };
    pc.onconnectionstatechange = () => {
      const st = pc.connectionState;
      if (st === 'connected') send({ type: 'state', sessionId: id, state: 'connected' });
      if ((st === 'failed' || st === 'closed') && peers.get(id) === s) fail(`connection ${st}`);
    };
    try {
      const track = stream.getVideoTracks()[0];
      try { track.contentHint = 'motion'; } catch { /* optional */ }
      const tr = pc.addTransceiver(track, { direction: 'sendonly', streams: [stream], sendEncodings: [{ maxBitrate: 2500000, maxFramerate: 30 }] });
      try {
        const caps = RTCRtpSender.getCapabilities('video');
        if (caps && tr.setCodecPreferences) tr.setCodecPreferences(U.sortCodecs(caps.codecs));
      } catch { /* SDP order below */ }
      const offer = await pc.createOffer();
      const sdp = U.setVideoBitrate(U.preferCodecsInSdp(U.hostOnlySdp(offer.sdp)), 2500000);
      await pc.setLocalDescription({ type: 'offer', sdp });
      send({ type: 'signal', sessionId: id, kind: 'offer', data: { type: 'offer', sdp } });
    } catch (e) { fail(e && e.message ? e.message : e); }
  }

  async function onSignal(id, kind, data) {
    const s = peers.get(id);
    if (!s) return;
    if (kind === 'answer') {
      await s.pc.setRemoteDescription({ type: 'answer', sdp: U.hostOnlySdp(data.sdp) });
      for (const c of s.pendingIce.splice(0)) await s.pc.addIceCandidate(c).catch(() => {});
    } else if (kind === 'ice') {
      if (!U.isHostCandidate(data.candidate)) return;
      if (!s.pc.remoteDescription) s.pendingIce.push(data); else await s.pc.addIceCandidate(data).catch(() => {});
    }
  }

  api.onCommand((cmd) => {
    if (!cmd || typeof cmd !== 'object') return;
    if (cmd.type === 'start') startCamera();
    else if (cmd.type === 'add') addSession(String(cmd.sessionId));
    else if (cmd.type === 'remove') removeSession(String(cmd.sessionId));
    else if (cmd.type === 'signal') onSignal(String(cmd.sessionId), cmd.kind, cmd.data).catch((e) => send({ type: 'session-error', sessionId: cmd.sessionId, message: String(e && e.message ? e.message : e).slice(0, 300) }));
    else if (cmd.type === 'stop') closeAll();
  });
  window.addEventListener('beforeunload', closeAll);
  send({ type: 'ready' });
}());
