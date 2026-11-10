#!/usr/bin/env node
/* Protocol test for free-relay.js without any external network.
 * A tiny in-process MQTT 3.1.1 broker (CONNACK / SUBACK / PUBLISH echo)
 * validates our hand-rolled packet encoder and decoder end to end:
 * two independent clients subscribe to one room topic, one publishes,
 * the other receives the exact JSON payload.
 *
 *   node tools/free-relay-test.js
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const src = fs.readFileSync(path.join(path.resolve(__dirname, '..'), 'free-relay.js'), 'utf8');
const decoder = new TextDecoder();
const sockets = [];

function readLen(bytes, offset) {
  let value = 0, multiplier = 1, i = offset, digit;
  do { digit = bytes[i++]; value += (digit & 127) * multiplier; multiplier *= 128; } while ((digit & 128) !== 0);
  return [value, i];
}
function parse(bytes) {
  const type = bytes[0] >> 4;
  const [len, start] = readLen(bytes, 1);
  return { type, body: bytes.subarray(start, start + len) };
}
function packet(header, body) {
  const lenBytes = [];
  let n = body.length;
  do { let d = n % 128; n = Math.floor(n / 128); if (n) d |= 0x80; lenBytes.push(d); } while (n);
  return new Uint8Array([header, ...lenBytes, ...body]);
}

class MockSocket {
  constructor(url, protocol) {
    this.url = url; this.protocol = protocol; this.readyState = 0;
    this.binaryType = 'arraybuffer'; this.listeners = {}; this.topic = null;
    sockets.push(this);
  }
  addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn); }
  emit(name, ev) { (this.listeners[name] || []).forEach((fn) => fn(ev)); }
  open() {
    this.readyState = 1;
    this.emit('open', {});
  }
  send(raw) {
    const bytes = new Uint8Array(raw.buffer || raw, raw.byteOffset || 0, raw.byteLength ?? raw.length);
    const msg = parse(bytes);
    if (msg.type === 1) { // CONNECT → CONNACK (success, session present = 0)
      setTimeout(() => this.deliver(packet(0x20, [0x00, 0x00])), 0);
    } else if (msg.type === 8) { // SUBSCRIBE → SUBACK
      const id = [msg.body[0], msg.body[1]];
      const topicLen = (msg.body[2] << 8) | msg.body[3];
      this.topic = decoder.decode(msg.body.subarray(4, 4 + topicLen));
      setTimeout(() => this.deliver(packet(0x90, [...id, 0x00])), 0);
    } else if (msg.type === 3) { // PUBLISH → fan out to all subscribers
      const topicLen = (msg.body[0] << 8) | msg.body[1];
      const topic = decoder.decode(msg.body.subarray(2, 2 + topicLen));
      const echo = packet(0x30, Array.from(msg.body));
      sockets.forEach((s) => { if (s.topic === topic && s.readyState === 1) setTimeout(() => s.deliver(echo), 0); });
    }
  }
  deliver(bytes) { this.emit('message', { data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }); }
  close() { this.readyState = 3; this.emit('close', {}); }
}

const sandbox = {
  window: { WebSocket: MockSocket },
  WebSocket: MockSocket,
  TextEncoder, TextDecoder,
  Math, JSON, setTimeout, clearTimeout, setInterval, clearInterval, console
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(src, sandbox);
const FreeRelay = sandbox.window.RoFrontierFreeRelay;
assert.ok(FreeRelay, 'free relay class exported');
assert.ok(FreeRelay.brokers.length >= 2, 'multiple free public brokers configured');
assert.ok(FreeRelay.brokers.every((u) => u.startsWith('wss://')), 'all brokers use secure WebSockets');

(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const received = [];
  const a = new FreeRelay({ onMessage: () => {}, onStatus: () => {} });
  const b = new FreeRelay({ onMessage: (msg) => received.push(msg), onStatus: () => {} });
  a.connect(); b.connect();
  sockets.forEach((s) => s.open());
  a.subscribe('ABC123');
  b.subscribe('ABC123');
  await sleep(30);
  assert.equal(a.connected, true, 'client A CONNACK accepted');
  assert.equal(b.connected, true, 'client B CONNACK accepted');
  assert.equal(a.topic, 'rofrontier/v1/ABC123', 'topic namespaced to game version + room');

  const payload = { kind: 'game_action', seq: 7, action: { type: 'attack', from: 'T01', to: 'T07', troops: 9 }, from: 'A' };
  assert.equal(a.publish(payload), true, 'publish accepted');
  await sleep(30);
  assert.equal(received.length, 1, 'one message delivered to the peer');
  assert.equal(received[0].action.to, 'T07', 'payload decoded intact');
  assert.equal(received[0].from, 'A', 'sender id preserved');
  assert.equal(received[0].mid, undefined, 'no phantom fields added');

  // A different room code must not receive another room's traffic.
  const otherReceived = [];
  const other = new FreeRelay({ onMessage: (msg) => otherReceived.push(msg), onStatus: () => {} });
  other.connect();
  sockets[sockets.length - 1].open();
  other.subscribe('ZZZ999');
  await sleep(20);
  a.publish({ kind: 'chat', text: 'room only' });
  await sleep(30);
  assert.ok(received.some((m) => m.text === 'room only'), 'same-room peer receives the chat');
    assert.equal(otherReceived.length, 0, 'different room receives nothing');
  [a, b, other].forEach((r) => r.close());
  console.log('✓ RoFrontier free-relay protocol test passed — MQTT CONNECT/SUBSCRIBE/PUBLISH, room isolation, no network needed.');


})().catch((err) => { console.error('✗ free-relay test failed:', err); process.exit(1); });
