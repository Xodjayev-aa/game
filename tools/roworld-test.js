#!/usr/bin/env node
/* RoWorld-style feature regression test (offline, no network):
 * terrain, 12 AI tribes, Q/E deployment ratio, alliances, SAM/silo,
 * and deterministic real-time ticks across two identical simulations.
 *
 *   node tools/roworld-test.js
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const adminSrc = fs.readFileSync(path.join(ROOT, 'admin.js'), 'utf8');
const gameSrc = fs.readFileSync(path.join(ROOT, 'game.js'), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function canvasStub() {
  const gradient = { addColorStop() {} };
  const base = {
    canvas: { width: 0, height: 0 }, globalAlpha: 1, lineWidth: 1, font: '',
    textAlign: '', textBaseline: '', fillStyle: '', strokeStyle: '', shadowBlur: 0,
    shadowColor: '', lineJoin: '', createLinearGradient: () => gradient,
    measureText: (t) => ({ width: String(t).length * 6 }), getImageData: () => ({ data: [] })
  };
  return new Proxy(base, {
    get(t, k) { return k in t ? t[k] : () => {}; },
    set(t, k, v) { t[k] = v; return true; }
  });
}
function boot() {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => { if (!/Not implemented/.test(e.message)) errors.push(e.message); });
  const dom = new JSDOM(html, {
    url: 'http://localhost:3000/?rf_test=1',
    runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc
  });
  const { window } = dom;
  const contexts = new WeakMap();
  window.HTMLCanvasElement.prototype.getContext = function () {
    if (!contexts.has(this)) contexts.set(this, canvasStub());
    return contexts.get(this);
  };
  window.Element.prototype.getBoundingClientRect = () => ({ left: 0, top: 0, right: 360, bottom: 640, width: 360, height: 640, x: 0, y: 0, toJSON() {} });
  window.scrollTo = () => {};
  delete window.WebSocket; // force the fully offline path
  window.addEventListener('error', (e) => errors.push(e.message));
  window.eval(adminSrc);
  window.eval(gameSrc);
  return { window, errors, $: (id) => window.document.getElementById(id) };
}
const digest = (c) => {
  const m = c.window.__RF_TEST__.state.match;
  return JSON.stringify({
    turn: m.turn, rng: m.rngState, warheads: m.warheads,
    territories: m.territories.map((t) => [t.owner, t.troops, t.fallout, t.defended, t.buildings.city, t.buildings.port, t.buildings.factory, t.buildings.post, t.buildings.sam, t.buildings.silo])
  });
};

(async () => {
  const c = boot();
  const w = c.window;
  await sleep(80);
  const t = w.__RF_TEST__;
  assert.ok(t, 'bootstrapped');

  // 1. World terrain — seeded, all three types, coastal bias toward plains.
  const terrains = new Set(t.map.territories.map((x) => x.terrain));
  assert.deepEqual([...terrains].sort(), ['highlands', 'mountains', 'plains'], 'three terrain types generated');
  assert.ok(t.map.territories.every((x) => x.terrainName && t.TERRAINS[x.terrain]), 'terrain metadata attached');
  const coastPlains = t.map.territories.filter((x) => x.coastal && x.terrain === 'plains').length;
  const inlandPlains = t.map.territories.filter((x) => !x.coastal && x.terrain === 'plains').length;
  assert.ok(coastPlains > 0, 'coastal plains exist for fast expansion');
  assert.ok(t.TERRAINS.mountains.defense > t.TERRAINS.plains.defense, 'mountains defend harder');
  assert.ok(t.TERRAINS.plains.attack > t.TERRAINS.mountains.attack, 'plains attack faster');

  // 2. Big lobbies: 12 AI tribes + 6 structures.
  assert.ok(t.AI_FACTIONS.length >= 12, '12+ AI tribes available');
  assert.deepEqual(Object.keys(t.BUILDINGS), ['city', 'port', 'factory', 'post', 'sam', 'silo'], 'six structures');
  t.startMatch({ seed: 'ROWORLD' });
  assert.equal(t.state.match.territories.every((x) => 'silo' in x.buildings && 'sam' in x.buildings && 'post' in x.buildings), true, 'new building slots');
  t.startMatch({ seed: 'MAXBOTS', bots: 12 });
  assert.equal(t.state.match.factions.length, 13, '1 human + 12 AI tribes');
  assert.ok(t.state.match.territories.filter((x) => x.capital).length >= 10, 'every big-lobby nation gets a capital');

  // Capture must move survivors, not duplicate them; malformed orders must
  // not poison troop counts with NaN. Run multiple deterministic dice streams.
  for (let i = 0; i < 20; i++) {
    t.startMatch({ seed: `COMBAT-${i}`, bots: 2 });
    const from = t.state.match.territories.find((x) => x.owner === t.state.match.localFaction &&
      t.map.adj[x.id].some((id) => t.T(id).owner !== x.owner));
    const to = t.T(t.map.adj[from.id].find((id) => t.T(id).owner !== from.owner));
    from.troops = 100; to.troops = 1; to.defended = 0; to.capital = null;
    const invalid = t.resolveAttack(from.id, to.id, NaN);
    assert.equal(invalid.ok, false, 'invalid attack rejected');
    assert.equal(from.troops, 100, 'invalid attack leaves source intact');
    const result = t.resolveAttack(from.id, to.id, 50);
    assert.equal(result.conquered, true, 'strong force captures region');
    assert.equal(from.troops + to.troops, 100 - result.aLosses, 'survivors are moved, never duplicated');
    assert.equal(from.troops, 50, 'uncommitted garrison stays behind');
    const badTransfer = t.transferTroops(from.id, to.id, NaN);
    assert.equal(badTransfer.ok, false, 'invalid transfer rejected');
    assert.ok(Number.isFinite(from.troops) && Number.isFinite(to.troops), 'garrisons remain finite');
  }

  // Real UI orders preserve territory IDs and the war room is informational.
  t.startMatch({ seed: 'INTEL' });
  const own = t.state.match.territories.find((x) => x.owner === t.state.match.localFaction);
  const defense = t.performAction({ type: 'fortify', id: own.id });
  assert.equal(defense.ok, true, 'fortify command keeps the territory ID');
  assert.equal(own.defended, 2, 'selected region fortified');
  assert.equal(c.$('actionRow').querySelector('[data-action="diplomacy"]').disabled, false, 'diplomacy is available');
  const beforeIntel = digest(c);
  c.$('btnIntel').click();
  assert.match(c.$('modalRoot').textContent, /WORLD STANDINGS/);
  assert.match(c.$('modalRoot').textContent, /WEAKEST LAND FRONTIERS/);
  assert.equal(digest(c), beforeIntel, 'war room does not mutate simulation');
  const frontier = c.$('modalRoot').querySelector('[data-focus-region]');
  if (frontier) {
    const id = frontier.dataset.focusRegion;
    frontier.click();
    assert.equal(t.ui.selected, id, 'frontier shortcut selects region');
  } else c.$('modalRoot').querySelector('[data-modal-close]').click();

  // 3. Q/E deployment ratio + HUD + preset buttons.
  t.startMatch({ seed: 'RATIO' });
  const before = t.deployRatio();
  w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'e', bubbles: true }));
  assert.ok(t.deployRatio() > before, 'E raises deployment');
  w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'q', bubbles: true }));
  assert.equal(t.deployRatio(), before, 'Q lowers it back');
  t.setDeployRatio(0.75, true);
  assert.equal(t.deployRatio(), 0.75);
  assert.equal(c.$('deployValue').textContent, '75%', 'HUD reflects ratio');
  t.setDeployRatio(0.5, true);

  // 4. Alliances: sequenced action, blocks attacks, gives co-op victory path.
  const rival = t.state.match.factions.find((f) => f.id !== t.state.match.localFaction);
  const allyResult = t.performAction({ type: 'alliance', target: rival.id, value: true });
  assert.equal(allyResult.ok, true, 'alliance signed');
  assert.equal(t.areAllied(t.state.match.localFaction, rival.id), true, 'alliance recorded in shared state');
  assert.equal(t.state.match.alliances.length, 1);
  const enemyTerr = t.state.match.territories.find((x) => x.owner === rival.id);
  const myTerr = t.state.match.territories.find((x) => x.owner === t.state.match.localFaction
    && t.map.adj[x.id] && t.map.adj[x.id].includes(enemyTerr.id));
  if (myTerr) {
    const blocked = t.resolveAttack(myTerr.id, enemyTerr.id, myTerr.troops - 1);
    assert.equal(blocked.ok, false, 'allied territory cannot be attacked');
    assert.match(blocked.message, /Allied/);
  }
  t.performAction({ type: 'alliance', target: rival.id, value: false });
  assert.equal(t.state.match.alliances.length, 0, 'alliance can be broken');

  // 5. SAM interception + silo nuclear unlock.
  t.startMatch({ seed: 'DEFENCE' });
  const mine = t.state.match.territories.find((x) => x.owner === t.state.match.localFaction);
  mine.buildings.sam = true;
  t.state.match.turn = 15;
  t.state.match.warheads = 2;
  t.state.wallet.coins = 1000;
  const hit = t.launchNuke(mine.id);
  assert.equal(hit.intercepted, true, 'SAM intercepts a nuclear strike');
  assert.equal(t.T(mine.id).fallout, 0, 'intercepted strike leaves no fallout');
  mine.buildings.silo = true;
  assert.equal(t.nukeUnlocked(), true, 'missile silo unlocks nukes immediately');

  // 6. Real-time mode: two identical simulations replay ticks byte-for-byte.
  const a = boot(), b = boot();
  await sleep(60);
  a.window.__RF_TEST__.startMatch({ seed: 'TICKS', bots: 4, realtime: 'fast' });
  b.window.__RF_TEST__.startMatch({ seed: 'TICKS', bots: 4, realtime: 'fast' });
  const ma = a.window.__RF_TEST__.state.match, mb = b.window.__RF_TEST__.state.match;
  assert.equal(ma.tickMs, 1000, 'blitz tick rate');
  assert.equal(ma.realtime, 'fast');
  assert.equal(digest(a), digest(b), 'identical initial real-time states');
  for (let i = 1; i <= 6; i++) {
    a.window.__RF_TEST__.applyGameAction({ type: 'tick', faction: ma.localFaction }, i);
    b.window.__RF_TEST__.applyGameAction({ type: 'tick', faction: mb.localFaction }, i);
  }
  assert.ok(ma.turn > 1, 'real-time ticks advance the world');
  assert.equal(digest(a), digest(b), 'six AI/economy ticks stay in lockstep');
  assert.ok(a.window.__RF_TEST__.state.match.territories.some((x) => x.troops > 12), 'economy grows continuously');

  // 7. Live local timer actually fires without manual calls.
  const c2 = boot();
  await sleep(60);
  c2.window.__RF_TEST__.startMatch({ seed: 'AUTO', bots: 2, realtime: 'fast' });
  await sleep(1400);
  assert.ok(c2.window.__RF_TEST__.state.match.turn > 1, 'offline real-time timer fires automatically');

  assert.deepEqual(c.errors, [], 'no page errors');
  console.log('✓ RoWorld upgrade test passed — terrain, 12 tribes, Q/E deployment, alliances, SAM/silo, deterministic real-time ticks.');
  process.exit(0);
})().catch((err) => { console.error('✗ RoWorld test failed:', err); process.exit(1); });
