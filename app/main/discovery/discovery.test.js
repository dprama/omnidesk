// SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
// SPDX-License-Identifier: GPL-2.0-only
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const linktype = require('./linktype');
const discovery = require('./index');
const identity = require('../pairing/identity');
const { fakeDevice, waitFor } = require('../pairing/testutil');

const fx = (f) => fs.readFileSync(path.join(__dirname, 'fixtures', f), 'utf8');

test('macOS networksetup output → link types', () => {
  assert.deepEqual(linktype.parseMacHardwarePorts(fx('networksetup-listallhardwareports.txt')), {
    bridge0: 'usb', // Thunderbolt Bridge
    en0: 'wifi',
    en1: 'usb', // Thunderbolt 1 (bridge member)
    en2: 'usb',
    en5: 'ethernet',
    en6: 'usb', // USB 10/100/1000 LAN
    en7: 'ethernet', // Thunderbolt Ethernet adapter is plain Ethernet
    en8: 'bluetooth', // Bluetooth PAN
    en9: 'usb', // iPhone USB
    en10: 'usb', // Apple Mobile Device Ethernet
  });
});

test('Windows Get-NetAdapter (JSON) → link types', () => {
  assert.deepEqual(linktype.parseWindowsAdapters(fx('get-netadapter.json')), {
    'Wi-Fi': 'wifi',
    Ethernet: 'ethernet',
    'Ethernet 2': 'usb', // Realtek USB GbE
    'Ethernet 3': 'usb', // Remote NDIS
    'Bluetooth Network Connection': 'bluetooth', // Bluetooth Device (Personal Area Network)
    'Ethernet 4': 'usb', // Thunderbolt(TM) Networking
    'Ethernet 5': 'usb', // Apple Mobile Device Ethernet
  });
  // a single adapter comes back as an object, not an array
  assert.deepEqual(linktype.parseWindowsAdapters('{"Name":"Wi-Fi","InterfaceDescription":"Killer Wireless","MediaType":"Native 802.11"}'), { 'Wi-Fi': 'wifi' });
});

test('Windows Get-NetAdapter (table) → link types', () => {
  assert.deepEqual(linktype.parseWindowsAdapters(fx('get-netadapter-table.txt')), {
    'Wi-Fi': 'wifi', Ethernet: 'ethernet', 'Ethernet 2': 'usb', 'Bluetooth Network Connection': 'bluetooth',
  });
});

test('Linux sysfs facts → link types', () => {
  assert.equal(linktype.classifyLinux({ name: 'wlp2s0', wireless: true }), 'wifi');
  assert.equal(linktype.classifyLinux({ name: 'bnep0' }), 'bluetooth');
  assert.equal(linktype.classifyLinux({ name: 'enx001122', devicePath: '/sys/devices/pci0000:00/usb1/1-1' }), 'usb');
  assert.equal(linktype.classifyLinux({ name: 'enp3s0', devicePath: '/sys/devices/pci0000:00/0000:03:00.0' }), 'ethernet');
});

test('interface list skips loopback / internal / tunnels', () => {
  const l = discovery.listInterfaces({
    lo0: [{ family: 'IPv4', address: '127.0.0.1', netmask: '255.0.0.0', internal: true }],
    en0: [{ family: 'IPv6', address: 'fe80::1' }, { family: 'IPv4', address: '192.168.1.5', netmask: '255.255.255.0', internal: false }],
    utun3: [{ family: 'IPv4', address: '10.8.0.2', netmask: '255.255.255.0', internal: false }],
    bridge0: [{ family: 4, address: '169.254.10.2', netmask: '255.255.0.0', internal: false }],
  });
  assert.deepEqual(l.map((i) => i.name), ['en0', 'bridge0']);
  assert.equal(discovery.ifaceFor(l, '169.254.99.1').name, 'bridge0');
  assert.equal(discovery.ifaceFor(l, '10.0.0.1'), null);
});

// In-memory multicast bus standing in for multicast-dns.
function bus() {
  const socks = [];
  return {
    socks,
    factory: (opts) => {
      const s = new EventEmitter();
      s.opts = opts;
      s.sent = [];
      s.respond = (res, cb) => { s.sent.push(res); cb && cb(); };
      s.query = (q, cb) => { s.sent.push(q); cb && cb(); };
      s.destroy = () => {};
      socks.push(s);
      return s;
    },
  };
}

function peerResponse(fp, name, address, ttl = 120) {
  const id = fp.slice(0, 20);
  const inst = `${id}._omnidesk._tcp.local`;
  return {
    answers: [
      { name: '_omnidesk._tcp.local', type: 'PTR', ttl, data: inst },
      { name: inst, type: 'TXT', ttl, data: discovery.encodeTxt({ v: 1, id, fp, name, os: 'windows', osVersion: '11', arch: 'x64', pairingPort: 24802, peerPort: 24803, enginePort: 24800 }) },
      { name: `${id}.local`, type: 'A', ttl, data: address },
    ],
  };
}

test('discovery: advertises, finds unpaired peers, picks link per interface', async () => {
  const dev = fakeDevice('disc');
  try {
    const b = bus();
    const d = discovery.createDiscovery({
      log: dev.log, engine: dev.engine, devices: dev.devices, mdnsFactory: b.factory, autoStart: false, platform: 'darwin',
      networkInterfaces: () => ({
        en0: [{ family: 'IPv4', address: '192.168.1.5', netmask: '255.255.255.0', internal: false }],
        bridge0: [{ family: 'IPv4', address: '169.254.10.2', netmask: '255.255.0.0', internal: false }],
        en8: [{ family: 'IPv4', address: '172.20.10.3', netmask: '255.255.255.240', internal: false }],
      }),
      detectLinks: async () => linktype.parseMacHardwarePorts(fx('networksetup-listallhardwareports.txt')),
    });
    await d._rescan();
    assert.equal(b.socks.length, 3);
    assert.ok(b.socks.every((s) => s.opts.bind === '0.0.0.0'));

    // We announce ourselves with our own address per interface.
    const me = identity.loadIdentity(dev.engine);
    const ann = b.socks[0].sent.find((m) => m.answers);
    const txt = discovery.decodeTxt(ann.answers.find((r) => r.type === 'TXT').data);
    assert.equal(txt.id, me.id);
    assert.equal(txt.fp, me.fingerprint);
    assert.equal(txt.name, 'Device disc');
    assert.equal(txt.pairingport, '24802');
    assert.equal(txt.peerport, '24803');
    assert.equal(txt.engineport, '24800');
    assert.equal(ann.answers.find((r) => r.type === 'SRV').data.port, 24802);
    assert.equal(ann.answers.find((r) => r.type === 'A').data, '192.168.1.5');

    let found = null;
    d.onFound((l) => { found = l; });
    assert.deepEqual(found, []);

    const fp = 'c'.repeat(64);
    const id = fp.slice(0, 20);
    d._onResponse(peerResponse(fp, 'PC', '192.168.1.20'), { address: '192.168.1.20' });
    assert.equal(found.length, 1);
    assert.equal(found[0].id, id);
    assert.equal(found[0].paired, false);
    assert.deepEqual(found[0].link, { type: 'wifi', pingMs: null, available: ['wifi'] });

    // Same peer over a Thunderbolt bridge and Bluetooth PAN: USB wins.
    d._onResponse(peerResponse(fp, 'PC', '169.254.10.9'), { address: '169.254.10.9' });
    d._onResponse(peerResponse(fp, 'PC', '172.20.10.4'), { address: '172.20.10.4' });
    assert.deepEqual(d.linkFor(id), { type: 'usb', available: ['usb', 'wifi', 'bluetooth'], address: '169.254.10.9' });
    await d.setLink(id, 'bluetooth');
    assert.deepEqual(d.linkFor(id), { type: 'bluetooth', available: ['usb', 'wifi', 'bluetooth'], address: '172.20.10.4' });
    await assert.rejects(d.setLink(id, 'ethernet'), (e) => e.code === 'link-unavailable');
    assert.equal(d.lookup(id).pairingPort, 24802);
    assert.equal(d.lookup(id).fingerprint, fp);

    // Once trusted it is no longer "found" (it is a paired device).
    identity.addTrusted(dev.engine.paths.trustedServers, fp);
    identity.addTrusted(dev.engine.paths.trustedClients, fp);
    d.refresh();
    assert.deepEqual(found, []);
    assert.ok(d.linkFor(id)); // main still pings it through linkFor

    // Our own announcement echoed back is ignored; bad TXT is ignored.
    d._onResponse(peerResponse(me.fingerprint, 'me', '192.168.1.5'), { address: '192.168.1.5' });
    d._onResponse(peerResponse('d'.repeat(64), 'x', '10.9.9.9'), { address: '10.9.9.9' }); // not on our subnets
    assert.equal(d.linkFor(me.id), null);

    // Queries for our service are answered on the matching interface.
    const before = b.socks[2].sent.length;
    d._onQuery({ questions: [{ name: '_omnidesk._tcp.local', type: 'PTR' }] }, { address: '172.20.10.4' });
    const reply = b.socks[2].sent[before];
    assert.equal(reply.answers.find((r) => r.type === 'A').data, '172.20.10.3');

    // Goodbye (ttl 0) removes the link.
    d._onResponse(peerResponse(fp, 'PC', '172.20.10.4', 0), { address: '172.20.10.4' });
    assert.deepEqual(d.linkFor(id).available, ['usb', 'wifi']);
    d.stop();
  } finally { dev.cleanup(); }
});

test('discovery against real multicast-dns sockets starts and stops', { skip: !process.env.OMNIDESK_MDNS_TEST }, async () => {
  const dev = fakeDevice('mdns');
  const d = discovery.createDiscovery({ log: dev.log, engine: dev.engine });
  await waitFor(() => dev.log.lines.some((l) => l.startsWith('mdns on')), 8000);
  d.stop();
  dev.cleanup();
});
