#!/usr/bin/env node
/* Two-client integration test for the real lockstep multiplayer mesh.
 * Boots two independent jsdom "devices", connects both to the bundled
 * /ws relay, creates + joins a room, starts a match, and verifies that a
 * sequenced attack and a full AI turn replay identically on both clients.
 *
 *   node server.js 3100 &
 *   node tools/multiplayer-test.js 3100
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.argv[2] || 3100);
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const adminSrc = fs.readFileSync(path.join(ROOT, 'admin.js'), 'utf8');
const gameSrc = fs.readFileSync(path.join(ROOT, 'game.js'), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function canvasStub() {
  const gradient = { addColorStop() {} };
  const base = {
    canvas: { width: 0, height: 0 },
    globalAlpha: 1, lineWidth: 1, font: '', textAlign: '', textBaseline: '',
    fillStyle: '', strokeStyle: '', shadowBlur: 0, shadowColor: '', lineJoin: '',
    createLinearGradient: () => gradient,
    measureText: (t) => ({ width: String(t).length * 6 }),
    getImageData: () => ({ data: [] })
  };
  return new Proxy(base, {
    get(t, k) { return k in t ? t[k] : () => {}; },
    set(t, k, v) { t[k] = v; return true; }
  });
}

function boot(label) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => { if (!/Not implemented/.test(e.message)) errors.push(`jsdom: ${e.message}`); });
  vc.on('error', (...a) => errors.push(`console.error: ${a.join(' ')}`));
  const dom = new JSDOM(html, {
    url: `http://localhost:${PORT}/?rf_test=1`,
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    virtualConsole: vc
  });
  const { window } = dom;
  const contexts = new WeakMap();
  window.HTMLCanvasElement.prototype.getContext = function () {
    if (!contexts.has(this)) contexts.set(this, canvasStub());
    return contexts.get(this);
  };
  window.Element.prototype.getBoundingClientRect = () => ({ left: 0, top: 0, right: 360, bottom: 640, width: 360, height: 640, x: 0, y: 0, toJSON() {} });
  window.scrollTo = () => {};
  // Node 22 exposes an RFC6455 WebSocket globally. Do NOT load free-relay.js:
  // the public brokers are intentionally out of scope for this local test.
  window.WebSocket = globalThis.WebSocket;
  window.addEventListener('error', (e) => errors.push(`window.error: ${e.message}`));
  window.addEventListener('unhandledrejection', (e) => errors.push(`unhandled: ${e.reason}`));
  window.eval(adminSrc);
  window.eval(gameSrc);
  return { window, dom, errors, label, $: (id) => window.document.getElementById(id) };
}

const digest = (c) => {
  const m = c.window.__RF_TEST__.state.match;
  assert.ok(m, `${c.label}: match exists`);
  return JSON.stringify({
    seed: m.seed, turn: m.turn, seq: m.seq, rngState: m.rngState,
    warheads: m.warheads, nukeUnlocked: m.nukeUnlocked, alliances: (m.alliances || []).slice().sort(), realtime: m.realtime,
    factions: m.factions.map((f) => [f.id, f.name, f.eliminated, f.coins]),
    territories: m.territories.map((t) => [t.id, t.owner, t.troops, t.fallout, t.defended, t.terrain, t.buildings.city, t.buildings.port, t.buildings.factory, t.buildings.post, t.buildings.sam, t.buildings.silo]),
    matchStats: m.matchStats
  });
};

async function waitFor(label, fn, ms = 6000) {
  const started = Date.now();
  while (Date.now() - started < ms) {
    if (fn()) return;
    await sleep(60);
  }
  throw new Error(`timeout waiting for ${label}`);
}

(async () => {
  const A = boot('A'), B = boot('B');
  await sleep(150);
  await waitFor('both relays online', () =>
    ['ws', 'mesh'].includes(A.window.__RF_TEST__.lobby.state.mode) &&
    ['ws', 'mesh'].includes(B.window.__RF_TEST__.lobby.state.mode));
  assert.equal(A.window.__RF_TEST__.lobby.state.mode, 'ws', 'A uses bundled relay');
  assert.equal(B.window.__RF_TEST__.lobby.state.mode, 'ws', 'B uses bundled relay');

  // Host creates a room.
  A.$('btnCreateRoom').click();
  await waitFor('host room created', () => !!A.window.__RF_TEST__.lobby.state.room);
  const code = A.window.__RF_TEST__.lobby.state.room.code;
  assert.ok(/^[A-Z0-9]{6}$/.test(code), '6-character room code');
  assert.equal(A.window.__RF_TEST__.lobby.state.host, true, 'A is host');

  // Second device joins by code.
  B.$('roomCodeInput').value = code;
  B.$('btnJoinRoom').click();
  await waitFor('B joined the real room', () =>
    (A.window.__RF_TEST__.lobby.state.room?.players || []).length === 2 &&
    (B.window.__RF_TEST__.lobby.state.room?.players || []).some((p) => p.id === B.window.__RF_TEST__.lobby.selfId) &&
    B.window.__RF_TEST__.lobby.state.room.host === A.window.__RF_TEST__.lobby.selfId);
  assert.equal(B.window.__RF_TEST__.lobby.state.host, false, 'B is not host');

  // Chat travels device → device.
  B.$('chatInput').value = 'Hello from device B';
  B.$('btnChatSend').click();
  await waitFor('chat delivered to A', () =>
    A.window.__RF_TEST__.lobby.state.messages.some((m) => m.text === 'Hello from device B'));

  // Host starts a real shared match.
  A.$('btnStartRoom').click();
  await waitFor('both matches started', () =>
    A.window.__RF_TEST__.state.match?.mode === 'online' &&
    B.window.__RF_TEST__.state.match?.mode === 'online' &&
    A.window.__RF_TEST__.state.match?.seq === 0 &&
    B.window.__RF_TEST__.state.match?.seq === 0);
  const mA = A.window.__RF_TEST__.state.match;
  const mB = B.window.__RF_TEST__.state.match;
  assert.equal(mA.seed, mB.seed, 'identical world seed');
  assert.equal(mA.factions.length, mB.factions.length, 'identical faction count');
  assert.notEqual(mA.localFaction, mB.localFaction, 'each device controls a different human faction');
  assert.ok(mA.factions.some((f) => f.isAI), 'AI bots fill empty seats');
  assert.equal(digest(A), digest(B), 'initial battlefields are byte-identical');
  const seats = A.window.__RF_TEST__.lobby.state.room.seats;
  assert.equal(seats.length, 2, 'two human seats');

  // A sequenced attack from A must replay identically on B.
  const tA = A.window.__RF_TEST__;
  const mine = tA.state.match.territories.filter((x) => x.owner === tA.state.match.localFaction && x.troops > 3);
  let order = null;
  for (const from of mine) {
    const target = (tA.map.adj[from.id] || []).map((id) => tA.T(id)).find((x) => x && x.owner !== from.owner);
    if (target) { order = { type: 'attack', from: from.id, to: target.id, troops: from.troops - 1 }; break; }
  }
  assert.ok(order, 'found a legal attack for the test');
  const r = tA.performAction(order);
  assert.equal(r.queued, true, 'attack was sequenced by the host');
  await waitFor('attack applied on both devices', () =>
    A.window.__RF_TEST__.state.match.seq === 1 && B.window.__RF_TEST__.state.match.seq === 1);
  assert.equal(digest(A), digest(B), 'battlefields still identical after dice combat');

  // Diplomacy is a sequenced order too — both devices must see the pact.
  const aSeat = seats.find((s) => s.id === A.window.__RF_TEST__.lobby.selfId);
  const bSeat = seats.find((s) => s.id === B.window.__RF_TEST__.lobby.selfId);
  const aFaction = `F${seats.indexOf(aSeat)}`, bFaction = `F${seats.indexOf(bSeat)}`;
  A.window.__RF_TEST__.performAction({ type: 'alliance', target: bFaction, value: true });
  await waitFor('alliance replicated', () =>
    A.window.__RF_TEST__.state.match.seq === 2 && B.window.__RF_TEST__.state.match.seq === 2);
  assert.equal(A.window.__RF_TEST__.areAllied(aFaction, bFaction), true, 'host allied');
  assert.equal(B.window.__RF_TEST__.areAllied(aFaction, bFaction), true, 'peer allied');
  assert.equal(digest(A), digest(B), 'alliance state identical');

  // A deterministic real-time tick (economy + AI ops) also stays in lockstep.
  A.window.__RF_TEST__.performAction({ type: 'tick' });
  await waitFor('tick replicated', () =>
    A.window.__RF_TEST__.state.match.seq === 3 && B.window.__RF_TEST__.state.match.seq === 3);
  assert.equal(digest(A), digest(B), 'real-time tick identical on both devices');

  // A full AI turn (scheduled timers + reinforcements) must also stay in sync.
  const beforeTurn = A.window.__RF_TEST__.state.match.turn;
  A.window.__RF_TEST__.performAction({ type: 'end_turn' });
  await waitFor('turn advanced on both devices', () =>
    A.window.__RF_TEST__.state.match.turn > beforeTurn &&
    B.window.__RF_TEST__.state.match.turn > beforeTurn, 9000);
  assert.equal(digest(A), digest(B), 'battlefields identical after AI turn + round income');

  // Region IDs must survive intent de-duplication, and all replicas must
  // validate against the same match treasury, not either device's wallet.
  const tB = B.window.__RF_TEST__;
  const site = tB.state.match.territories.find((x) => x.owner === tB.state.match.localFaction);
  assert.ok(site, 'peer owns a region');
  tB.state.wallet.coins = 0;
  const beforeSeq = tB.state.match.seq;
  tB.performAction({ type: 'build', id: site.id, key: 'city' });
  await waitFor('peer construction replicated', () => tA.state.match.seq === beforeSeq + 1 && tB.state.match.seq === beforeSeq + 1);
  assert.equal(tB.T(site.id).buildings.city, true, 'build targets the selected territory despite an empty profile wallet');
  assert.equal(tA.T(site.id).buildings.city, true, 'host sees the same structure');
  assert.equal(digest(A), digest(B), 'treasury and board stay in sync after construction');
  const fortSeq = tB.state.match.seq;
  tB.performAction({ type: 'fortify', id: site.id });
  await waitFor('fortification replicated', () => tA.state.match.seq === fortSeq + 1 && tB.state.match.seq === fortSeq + 1);
  assert.equal(tB.T(site.id).defended, 2, 'fortify targets the selected territory');
  assert.equal(digest(A), digest(B), 'fortification and treasury stay in sync');

  // A disconnected client must never mutate a shared match locally.
  const net = tB.lobby;
  const wsReady = net.wsReady, mqttReady = net.mqttReady;
  net.wsReady = net.mqttReady = false;
  const frozen = digest(B), seq = tB.state.match.seq;
  const rejected = tB.performAction({ type: 'fortify', id: site.id });
  assert.equal(rejected.ok, false, 'disconnected command rejected');
  assert.equal(digest(B), frozen, 'disconnected board unchanged');
  assert.equal(tB.state.match.seq, seq, 'disconnected sequence unchanged');
  net.wsReady = wsReady; net.mqttReady = mqttReady;

  // Snapshot resync: rebuild B from the host's authoritative state.
  const snap = A.window.__RF_TEST__.lobby.getSnapshot();
  B.window.__RF_TEST__.applyRemoteSnapshot(snap);
  assert.equal(digest(A), digest(B), 'late-joiner snapshot reproduces the host state');

  assert.deepEqual(A.errors, [], 'A page errors');
  assert.deepEqual(B.errors, [], 'B page errors');
  console.log(`✓ RoFrontier multiplayer test passed — room ${code}, 2 human seats, ${mA.factions.length - 2} bots, lockstep attack + alliance + tick + AI turn + resync.`);
  A.window.close(); B.window.close();
  process.exit(0);
})().catch((err) => {
  console.error('✗ multiplayer test failed:', err);
  process.exit(1);
});
