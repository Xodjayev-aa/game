#!/usr/bin/env node
/* Headless smoke test for RoFrontier.
 * Requires jsdom as a dev-only dependency:
 *   npm install --no-save --no-audit --no-fund jsdom
 *   node tools/smoke-test.js
 * It stubs a 2D canvas context, boots the real HTML + JS, then exercises
 * map generation, UI navigation, combat, economy, lobby, store and every
 * owner command through the actual DOM.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

let JSDOM, VirtualConsole;
try { ({ JSDOM, VirtualConsole } = require('jsdom')); }
catch (_) {
  console.error('jsdom not installed. Run: npm install --no-save jsdom');
  process.exit(2);
}

const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const adminSrc = fs.readFileSync(path.join(ROOT, 'admin.js'), 'utf8');
const gameSrc = fs.readFileSync(path.join(ROOT, 'game.js'), 'utf8');
const errors = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const vc = new VirtualConsole();
vc.on('jsdomError', (e) => {
  if (!/Not implemented/.test(e.message)) errors.push(`jsdom: ${e.message}`);
});
vc.on('error', (...args) => errors.push(`console.error: ${args.join(' ')}`));

const dom = new JSDOM(html, {
  url: 'http://localhost:3000/?rf_test=1',
  runScripts: 'outside-only',
  pretendToBeVisual: true,
  virtualConsole: vc
});
const { window } = dom;
const doc = window.document;

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
const contexts = new WeakMap();
window.HTMLCanvasElement.prototype.getContext = function () {
  if (!contexts.has(this)) contexts.set(this, canvasStub());
  return contexts.get(this);
};
window.Element.prototype.getBoundingClientRect = function () {
  return { left: 0, top: 0, right: 360, bottom: 640, width: 360, height: 640, x: 0, y: 0, toJSON() {} };
};
window.scrollTo = () => {};
// Force the offline path so the local lobby simulation is exercised even when
// a real relay happens to be running on localhost during the test.
delete window.WebSocket;
window.addEventListener('error', (e) => errors.push(`window.error: ${e.message}`));
window.addEventListener('unhandledrejection', (e) => errors.push(`unhandled: ${e.reason}`));

const $ = (id) => doc.getElementById(id);
const click = (id) => { const el = $(id); assert.ok(el, `missing #${id}`); el.click(); };
const clickSel = (sel) => { const el = doc.querySelector(sel); assert.ok(el, `missing ${sel}`); el.click(); return el; };
const active = () => doc.querySelector('.screen.active')?.id;
async function runCommand(text) {
  $('adminInput').value = text;
  click('btnAdminRun');
  await sleep(15);
}

(async () => {
  await sleep(60); // DOMContentLoaded
  window.eval(adminSrc);
  window.eval(gameSrc);
  await sleep(60);

  const t = window.__RF_TEST__;
  assert.ok(t, 'game bootstrapped');
  assert.equal(active(), 'screen-title', 'title screen active');
  assert.equal(t.map.territories.length, 75, '75 territories generated');
  assert.ok(t.map.territories.every((x) => x.id && x.neighbors.length >= 0), 'territory ids + adjacency');
  assert.ok(Object.values(t.map.naval).some((lanes) => lanes.length > 0), 'naval lanes exist');
  assert.ok(t.map.territories.every((x) =>
    x.neighbors.every((n) => t.map.adj[n].includes(x.id))), 'adjacency is symmetric');
  assert.ok(window.localStorage.getItem('rofrontier.save.v2'), 'initial save written');

  // Setup + start a campaign.
  click('btnNewCampaign');
  assert.equal(active(), 'screen-setup');
  assert.ok($('setupColor').options.length >= 2, 'colour themes listed');
  assert.ok($('setupSkin').options.length >= 1, 'map skins listed');
  assert.ok($('setupSummary').textContent.includes('regions'), 'briefing summary rendered');
  $('matchSeed').value = '49';
  click('btnStartMatch');
  assert.equal(active(), 'screen-game', 'game screen active after deploy');
  assert.equal(t.state.match.territories.length, 75);
  assert.equal(t.state.match.factions.length, t.state.settings.bots + 1);
  assert.equal(t.state.match.territories.filter((x) => x.owner === 'F0').length, 4, 'human has 4 starting regions');
  assert.ok($('mapLegend').children.length >= 3, 'faction legend rendered');
  assert.ok($('gamePhase').textContent.includes('TURN 1'), 'phase displayed');

  // Combat, transfer, buildings, defence, nuke.
  const human = t.state.match.territories.find((x) => x.owner === 'F0');
  const foe = t.map.adj[human.id].map((id) => t.T(id)).find((x) => x.owner !== 'F0');
  assert.ok(foe, 'adjacent enemy exists');
  human.troops = 60;
  const battle = t.resolveAttack(human.id, foe.id, 55);
  assert.equal(battle.ok, true, 'attack resolves');
  assert.ok(t.state.match.log.length > 1, 'combat logged');

  const a = t.state.match.territories.find((x) => t.map.adj[x.id].length > 1);
  const b = t.T(t.map.adj[a.id][0]);
  a.owner = b.owner = 'F0'; a.troops = 40; b.troops = 5;
  assert.equal(t.transferTroops(a.id, b.id, 10).ok, true, 'transfer works');
  assert.equal(b.troops, 15);

  t.state.wallet.coins = 99999;
  t.state.stats.xp = 1000; // level 7 → all buildings unlocked
  const inland = t.state.match.territories.find((x) => x.owner === 'F0' && !x.buildings.city);
  assert.equal(t.buildStructure(inland.id, 'city').ok, true, 'city built');
  assert.equal(t.buildStructure(inland.id, 'factory').ok, true, 'factory built');
  const coastal = t.state.match.territories.find((x) => x.coastal && x.owner === 'F0');
  assert.equal(t.buildStructure(coastal.id, 'port').ok, true, 'port built');
  assert.equal(t.fortify(inland.id).ok, true, 'fortify works');
  t.state.match.nukeUnlocked = true;
  t.state.match.warheads = 3;
  const nukeTarget = t.state.match.territories.find((x) => x.id !== inland.id && x.owner !== 'F0');
  const strike = t.launchNuke(nukeTarget.id);
  assert.equal(strike.ok, true, 'nuke launches');
  assert.equal(nukeTarget.owner, 'neutral', 'target neutralised');
  assert.equal(nukeTarget.fallout, 4, 'fallout applied');

  // Turn cycle with AI.
  const beforeTurn = t.state.match.turn;
  t.endTurn();
  assert.equal(t.state.match.phase, 'ai', 'AI phase entered');
  await sleep(400 * (t.state.match.factions.length + 2));
  assert.equal(t.state.match.phase, 'player', 'player phase restored');
  assert.equal(t.state.match.turn, beforeTurn + 1, 'turn advanced');

  // Screen navigation.
  for (const name of ['home', 'setup', 'store', 'vault', 'lobby', 'admin', 'home']) {
    const btn = doc.querySelector(`.bottom-nav button[data-nav="${name}"]`);
    assert.ok(btn, `nav button ${name}`);
    btn.click();
    assert.equal(active(), `screen-${name}`, `${name} screen active`);
  }
  assert.ok($('dailyList').children.length === 3, '3 daily challenges');

  // Simulated IAP.
  click('btnNewCampaign'); // no-op navigation guard
  doc.querySelector('.bottom-nav button[data-nav="store"]').click();
  const gemsBefore = t.state.wallet.gems;
  clickSel('[data-buy="iap:iap_pouch"]');
  assert.ok(doc.querySelector('.modal'), 'IAP confirmation modal shown');
  const confirmBtn = Array.from(doc.querySelectorAll('.modal .btn'))
    .find((b) => b.textContent.includes('COMPLETE SIMULATED PURCHASE'));
  assert.ok(confirmBtn, 'simulated purchase confirmation');
  confirmBtn.click();
  assert.equal(t.state.wallet.gems, gemsBefore + 180, 'gems granted by simulated IAP');
  assert.equal(t.state.receipts.length, 1, 'receipt recorded');

  // Vault tabs + daily claim.
  doc.querySelector('.bottom-nav button[data-nav="vault"]').click();
  clickSel('#vaultTabs button[data-tab="skins"]');
  assert.ok($('vaultGrid').children.length >= 6, 'map skins rendered');
  assert.ok($('playtimeList').children.length === 7, 'playtime tiers rendered');
  t.state.daily.items[0].progress = t.state.daily.items[0].goal;
  doc.querySelector('.bottom-nav button[data-nav="home"]').click();
  const claimBtn = doc.querySelector('[data-claim-daily]');
  assert.ok(claimBtn && !claimBtn.disabled, 'daily claim available');
  claimBtn.click();
  assert.equal(t.state.daily.items[0].claimed, true, 'daily reward claimed');

  // Local lobby simulation → real match start.
  doc.querySelector('.bottom-nav button[data-nav="lobby"]').click();
  assert.equal(t.lobby.state.mode, 'sim', 'offline lobby simulation active');
  click('btnCreateRoom');
  await sleep(650);
  assert.ok(t.lobby.state.room, 'room created');
  assert.equal($('roomPanel').hidden, false, 'room panel visible');
  click('btnReady');
  assert.equal(t.lobby.state.ready, true, 'ready toggled');
  $('chatInput').value = 'Hello lobby';
  click('btnChatSend');
  assert.ok($('roomChat').textContent.includes('Hello lobby'), 'chat rendered');
  assert.equal($('btnStartRoom').disabled, false, 'host can start the room');
  click('btnStartRoom');
  await sleep(900);
  assert.equal(t.state.match.mode, 'offline', 'local lobby simulation launches an offline match');
  assert.equal(active(), 'screen-game', 'game launched from lobby');

  // Owner verification + commands.
  doc.querySelector('.bottom-nav button[data-nav="admin"]').click();
  assert.equal($('adminConsole').hidden, true, 'console locked before verification');
  $('ownerIdInput').value = 'WrongName';
  $('ownerKeyInput').value = 'COMEBACK-49-OWNER-2049';
  click('btnOwnerVerify');
  await sleep(30);
  assert.equal($('adminConsole').hidden, true, 'wrong owner ID rejected');
  $('ownerIdInput').value = 'CoMeBacK_49';
  $('ownerKeyInput').value = 'COMEBACK-49-OWNER-2049';
  click('btnOwnerVerify');
  await sleep(40);
  assert.equal($('adminConsole').hidden, false, 'owner console unlocked');
  assert.equal(t.state.profile.name, 'CoMeBacK_49', 'owner identity bound');
  assert.ok(t.admin.isUnlocked(), 'admin session valid');

  const coinsBefore = t.state.wallet.coins, gemsBefore2 = t.state.wallet.gems;
  await runCommand('/help');
  await runCommand('/whoami');
  await runCommand('/give_currency 500');
  assert.equal(t.state.wallet.coins, coinsBefore + 500, '/give_currency coins');
  assert.equal(t.state.wallet.gems, gemsBefore2 + 500, '/give_currency gems');
  await runCommand('/god_mode');
  assert.equal(t.state.match.godMode, true, '/god_mode enabled');
  const t01 = t.T('T01');
  const troopsBefore = t01.troops;
  await runCommand('/spawn_troops T01 250');
  assert.equal(t01.troops, troopsBefore + 250, '/spawn_troops');
  await runCommand('/nuke T07');
  assert.equal(t.T('T07').fallout, 4, '/nuke struck target');
  await runCommand('/set_turn 15');
  assert.equal(t.state.match.turn, 15, '/set_turn');
  await runCommand('/warheads 4');
  assert.equal(t.state.match.warheads, 4, '/warheads');
  await runCommand('/unlock_all');
  assert.ok($('adminLog').textContent.includes('All cosmetics'), '/unlock_all output');
  await runCommand('/reveal');
  await runCommand('/conquer_all');
  assert.equal(active(), 'screen-victory', '/conquer_all triggers victory test');
  assert.equal($('victoryTitle').textContent, 'VICTORY', 'victory title');
  assert.ok(t.state.match.territories.filter((x) => x.owner === 'F0').length >= 60, '80% claimed');
  assert.ok($('victoryStats').textContent.includes('TURNS'), 'victory stats');
  assert.ok($('screen-victory').textContent.includes('Developed by CoMeBacK_49'), 'owner credit');

  // Owner-only cosmetics are now available; reset wipes the save.
  assert.ok(doc.body.innerHTML.includes('Owner'), 'owner branding present');
  await runCommand('/reset_progress --confirm');
  assert.equal(active(), 'screen-title', 'reset returns to title');
  assert.equal(t.state.wallet.gems, 60, 'wallet reset');
  assert.equal(t.state.match, null, 'match cleared');

  await sleep(30);
  dom.window.close();
  if (errors.length) {
    console.error('\nRuntime errors:\n' + errors.join('\n'));
    process.exit(1);
  }
  console.log('✓ RoFrontier smoke test passed — map, UI, combat, economy, lobby, store, owner commands, victory, reset.');
  process.exit(0);
})().catch((err) => {
  console.error('✗ Smoke test failed:', err && err.stack || err);
  if (errors.length) console.error('Runtime errors:\n' + errors.join('\n'));
  try { dom.window.close(); } catch (_) {}
  process.exit(1);
});
