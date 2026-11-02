// SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
// SPDX-License-Identifier: GPL-2.0-only
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const U = require('./viewer/rtc-util');

// Trimmed Chromium offer: VP8 96 (rtx 97), VP9 98 (rtx 99), H264 baseline pm=0 100 (rtx 101),
// H264 baseline pm=1 102 (rtx 103), H264 high pm=1 104 (rtx 105), red 106, ulpfec 107.
const OFFER = [
  'v=0', 'o=- 1 2 IN IP4 127.0.0.1', 's=-', 't=0 0', 'a=group:BUNDLE 0',
  'm=video 9 UDP/TLS/RTP/SAVPF 96 97 98 99 100 101 102 103 104 105 106 107',
  'c=IN IP4 0.0.0.0',
  'a=rtpmap:96 VP8/90000', 'a=rtpmap:97 rtx/90000', 'a=fmtp:97 apt=96',
  'a=rtpmap:98 VP9/90000', 'a=rtpmap:99 rtx/90000', 'a=fmtp:99 apt=98',
  'a=rtpmap:100 H264/90000', 'a=fmtp:100 level-asymmetry-allowed=1;packetization-mode=0;profile-level-id=42e01f',
  'a=rtpmap:101 rtx/90000', 'a=fmtp:101 apt=100',
  'a=rtpmap:102 H264/90000', 'a=fmtp:102 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f',
  'a=rtpmap:103 rtx/90000', 'a=fmtp:103 apt=102',
  'a=rtpmap:104 H264/90000', 'a=fmtp:104 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=640c1f',
  'a=rtpmap:105 rtx/90000', 'a=fmtp:105 apt=104',
  'a=rtpmap:106 red/90000', 'a=rtpmap:107 ulpfec/90000',
  'a=candidate:1 1 udp 2122260223 192.168.1.20 50000 typ host generation 0',
  'a=candidate:2 1 udp 1686052607 81.2.3.4 50000 typ srflx raddr 192.168.1.20 rport 50000',
  'a=candidate:3 1 udp 41885439 9.9.9.9 3478 typ relay raddr 81.2.3.4 rport 50000',
].join('\r\n') + '\r\n';

const mLine = (sdp) => sdp.split('\r\n').find((l) => l.startsWith('m=video'));

test('preferCodecsInSdp: H.264 (pm=1 baseline, then high, then pm=0) with rtx, then VP8, rest kept', () => {
  const out = U.preferCodecsInSdp(OFFER);
  assert.equal(mLine(out), 'm=video 9 UDP/TLS/RTP/SAVPF 102 103 104 105 100 101 96 97 98 99 106 107');
  assert.equal(out.split('\r\n').length, OFFER.split('\r\n').length, 'no lines added or removed');
  assert.ok(out.endsWith('\r\n'));
});

test('preferCodecsInSdp: VP8 fallback when no H.264 is offered', () => {
  const noH264 = OFFER.replace(/ 100 101 102 103 104 105/, '').split('\r\n').filter((l) => !/:(10[0-5]) /.test(l)).join('\r\n');
  assert.equal(mLine(U.preferCodecsInSdp(noH264)), 'm=video 9 UDP/TLS/RTP/SAVPF 96 97 98 99 106 107');
});

test('preferCodecsInSdp leaves audio sections alone', () => {
  const sdp = 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111 0\r\na=rtpmap:111 opus/48000/2\r\n' + OFFER.split('\r\n').slice(5).join('\r\n');
  const out = U.preferCodecsInSdp(sdp);
  assert.ok(out.includes('m=audio 9 UDP/TLS/RTP/SAVPF 111 0'));
  assert.ok(mLine(out).startsWith('m=video 9 UDP/TLS/RTP/SAVPF 102 103'));
});

test('hostOnlySdp drops srflx and relay candidates', () => {
  const out = U.hostOnlySdp(OFFER);
  assert.ok(out.includes('typ host'));
  assert.ok(!out.includes('typ srflx'));
  assert.ok(!out.includes('typ relay'));
  assert.ok(U.isHostCandidate('candidate:1 1 udp 2122260223 abcd-1234.local 50000 typ host generation 0'));
  assert.ok(!U.isHostCandidate('candidate:2 1 udp 1 1.2.3.4 1 typ srflx raddr 0.0.0.0 rport 0'));
  assert.ok(!U.isHostCandidate(null));
});

test('setVideoBitrate inserts b=AS/b=TIAS after c= and replaces old ones', () => {
  const once = U.setVideoBitrate(OFFER, 12000000);
  const lines = once.split('\r\n');
  const c = lines.indexOf('c=IN IP4 0.0.0.0');
  assert.equal(lines[c + 1], 'b=AS:12000');
  assert.equal(lines[c + 2], 'b=TIAS:12000000');
  const twice = U.setVideoBitrate(once, 6000000);
  assert.equal((twice.match(/b=AS:/g) || []).length, 1);
  assert.ok(twice.includes('b=AS:6000'));
});

test('sortCodecs for setCodecPreferences', () => {
  const caps = [
    { mimeType: 'video/VP8' }, { mimeType: 'video/rtx' }, { mimeType: 'video/VP9', sdpFmtpLine: 'profile-id=0' },
    { mimeType: 'video/H264', sdpFmtpLine: 'packetization-mode=0;profile-level-id=42e01f' },
    { mimeType: 'video/H264', sdpFmtpLine: 'packetization-mode=1;profile-level-id=640c1f' },
    { mimeType: 'video/H264', sdpFmtpLine: 'packetization-mode=1;profile-level-id=42e01f' },
    { mimeType: 'video/red' }, { mimeType: 'video/ulpfec' },
  ];
  const out = U.sortCodecs(caps).map((c) => `${c.mimeType} ${c.sdpFmtpLine || ''}`.trim());
  assert.deepEqual(out, [
    'video/H264 packetization-mode=1;profile-level-id=42e01f',
    'video/H264 packetization-mode=1;profile-level-id=640c1f',
    'video/H264 packetization-mode=0;profile-level-id=42e01f',
    'video/VP8', 'video/rtx', 'video/VP9 profile-id=0', 'video/red', 'video/ulpfec',
  ]);
});

test('presets: latency scales down, sharp keeps resolution, all 60 fps, LAN-only config', () => {
  assert.ok(U.PRESETS.latency.scaleResolutionDownBy > 1);
  assert.ok(U.PRESETS.latency.maxBitrate < U.PRESETS.balanced.maxBitrate && U.PRESETS.balanced.maxBitrate < U.PRESETS.sharp.maxBitrate);
  for (const p of Object.values(U.PRESETS)) assert.equal(p.maxFramerate, 60);
  assert.equal(U.PRESETS.sharp.degradationPreference, 'maintain-resolution');
  assert.deepEqual(U.RTC_CONFIG.iceServers, []);
});

test('summarize: receiver latency = rtt/2 + jitter buffer + decode; fps', () => {
  const mk = (t, frames, jb, jbn, dec) => [
    { id: 'T', type: 'transport', selectedCandidatePairId: 'CP' },
    { id: 'CP', type: 'candidate-pair', currentRoundTripTime: 0.004, nominated: true, state: 'succeeded' },
    { id: 'IN', type: 'inbound-rtp', kind: 'video', timestamp: t, framesDecoded: frames, jitterBufferDelay: jb, jitterBufferEmittedCount: jbn, totalDecodeTime: dec, codecId: 'C' },
    { id: 'C', type: 'codec', mimeType: 'video/H264' },
  ];
  const a = U.summarize(mk(1000, 0, 0, 0, 0), null);
  // next second: 60 frames, each 20 ms in jitter buffer and 3 ms decode
  const b = U.summarize(mk(2000, 60, 1.2, 60, 0.18), a.snap);
  assert.equal(b.fps, 60);
  assert.equal(b.latencyMs, 2 + 20 + 3);
  assert.equal(U.codecInUse(mk(0, 0, 0, 0, 0)), 'H264');
});

test('summarize: sender uses framesPerSecond and remote-inbound rtt fallback', () => {
  const r = U.summarize([
    { id: 'O', type: 'outbound-rtp', kind: 'video', timestamp: 5, framesPerSecond: 58, framesEncoded: 10, totalEncodeTime: 0 },
    { id: 'R', type: 'remote-inbound-rtp', kind: 'video', roundTripTime: 0.01 },
  ], null);
  assert.equal(r.fps, 58);
  assert.equal(r.latencyMs, 5);
});

test('iceSummary: addresses offered and connectivity checks, for the failure log', () => {
  const { iceSummary } = require('./viewer/rtc-util');
  const line = iceSummary([
    { type: 'local-candidate', protocol: 'udp', address: '192.168.1.5' },
    { type: 'local-candidate', protocol: 'udp', address: '192.168.1.5' },
    { type: 'remote-candidate', protocol: 'udp', address: '192.168.1.20' },
    { type: 'remote-candidate', protocol: 'tcp', address: 'fd00::2' },
    { type: 'candidate-pair', state: 'failed', requestsSent: 7, responsesReceived: 0 },
    { type: 'candidate-pair', state: 'failed', requestsSent: 5 },
    { type: 'inbound-rtp' },
  ]);
  assert.equal(line, 'local udp 192.168.1.5 | remote udp 192.168.1.20 tcp fd00::2 | pairs failed 2 | checks 12 sent, 0 answered');
  assert.equal(iceSummary([]), 'local none | remote none | pairs none | checks 0 sent, 0 answered');
});
