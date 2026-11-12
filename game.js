/* ============================================================
   RoFrontier — Global Conquest  (game.js)
   A complete mobile-first, offline-first grand-strategy PWA.
   Developed by CoMeBacK_49.

   Sections
     1. Utilities & constants        7. Combat, buildings, nukes
     2. Persistent state             8. AI commanders & turn cycle
     3. World generation             9. Screens & UI rendering
     4. Canvas renderer             10. Online lobby (WebSocket)
     5. Touch / pointer controls    11. Owner API + console wiring
     6. Game lifecycle              12. Boot, PWA, timers
   ============================================================ */
(() => {
  'use strict';

  /* ───────────────────────── 1. UTILITIES ───────────────────────── */
  const $ = (id) => document.getElementById(id);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const fmt = (n) => Math.floor(n).toLocaleString('en-US');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const uid = (prefix = 'id') => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const HUMAN = 'F0';
  const me = () => (state.match && state.match.localFaction) || HUMAN;
  const acting = () => (state.match && state.match.actingFaction) || me();
  // Deterministic gameplay RNG. Every client in a shared match executes the
  // exact same command sequence, so dice/AI rolls must never use Math.random().
  function grng() {
    const m = state.match;
    if (!m) return Math.random();
    const x = (m.rngState = ((m.rngState || 1) + 0x6D2B79F5) | 0);
    let t = Math.imul(x ^ (x >>> 15), 1 | x);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  const isShared = () => !!(state.match && state.match.mode === 'online');
  const isLocalActor = () => acting() === me();
  // Multiplayer treasuries are part of the replicated match, not the local profile.
  function battleCoins(fid = acting()) {
    if (!isShared()) return state.wallet.coins;
    const f = state.match.factions.find((x) => x.id === fid);
    return f ? (Number.isFinite(f.coins) ? f.coins : 300) : 0;
  }
  function spendBattleCoins(amount) {
    if (battleCoins() < amount) return false;
    if (isShared()) {
      const f = state.match.factions.find((x) => x.id === acting());
      f.coins = battleCoins() - amount;
    } else state.wallet.coins -= amount;
    return true;
  }
  const NEUTRAL = 'neutral';
  const SAVE_KEY = 'rofrontier.save.v2';
  const VERSION = '1.3.0';

  function hashSeed(str) {
    let h = 2166136261;
    for (let i = 0; i < String(str).length; i++) {
      h ^= String(str).charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }
  function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function shuffle(arr, rnd) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
  function dateKey(d = new Date()) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  function minutes(ms) { return Math.floor(ms / 60000); }
  function playtimeLabel(ms) {
    const m = minutes(ms);
    return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
  }

  function loadJSON(key, fallback) {
    try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; }
    catch (_) { return fallback; }
  }
  function storeJSON(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; }
    catch (err) { toast('Storage full — progress may not save.', 'error'); return false; }
  }

  /* ───────────────────────── CATALOGUES ─────────────────────────── */
  const COLOR_THEMES = [
    { id: 'azure', name: 'Azure Dominion', primary: '#3d9be9', light: '#8fd0ff', dark: '#1b5b96', unlock: { type: 'free' } },
    { id: 'crimson', name: 'Crimson Legion', primary: '#e2505e', light: '#ff9aa5', dark: '#8c2634', unlock: { type: 'free' } },
    { id: 'jade', name: 'Jade Coalition', primary: '#38c48a', light: '#8cf0c2', dark: '#1b7551', unlock: { type: 'coins', cost: 600 } },
    { id: 'violet', name: 'Void Sovereignty', primary: '#9a6ef0', light: '#d0b6ff', dark: '#57349c', unlock: { type: 'gems', cost: 60 } },
    { id: 'solar', name: 'Solar Empire', primary: '#f2a93b', light: '#ffd98a', dark: '#a46312', unlock: { type: 'milestone', id: 'victor' } },
    { id: 'obsidian', name: 'Obsidian Pact', primary: '#6d829e', light: '#b5c6da', dark: '#31445c', unlock: { type: 'gems', cost: 120 } },
    { id: 'owner', name: "Owner's Gold", primary: '#f5be4a', light: '#ffe6ac', dark: '#96600d', unlock: { type: 'owner' } }
  ];

  const MAP_SKINS = [
    { id: 'classic', name: 'Command Table', desc: 'Deep navy tactical chart.', ocean: '#08182b', ocean2: '#0b223a', sea: '#0c2036', land: '#223c59', line: 'rgba(120,180,225,.14)', neutral: '#4a5b70', text: '#eaf3ff', unlock: { type: 'free' } },
    { id: 'midnight', name: 'Midnight Ops', desc: 'Violet night-vision palette.', ocean: '#0d0b20', ocean2: '#191036', sea: '#150f2c', land: '#2c2350', line: 'rgba(180,150,255,.15)', neutral: '#544a76', text: '#eee6ff', unlock: { type: 'playtime', tier: 't5' } },
    { id: 'satellite', name: 'Satellite View', desc: 'Green reconnaissance overlay.', ocean: '#06201f', ocean2: '#0a2d28', sea: '#0a2a27', land: '#1d4b3c', line: 'rgba(120,230,180,.16)', neutral: '#3f6a56', text: '#dfffee', unlock: { type: 'playtime', tier: 't60' } },
    { id: 'sandstorm', name: 'Sandstorm', desc: 'Warm desert campaign map.', ocean: '#241a12', ocean2: '#392719', sea: '#2e2015', land: '#6b5132', line: 'rgba(255,210,150,.16)', neutral: '#7d6a4f', text: '#fff1da', unlock: { type: 'coins', cost: 900 } },
    { id: 'neon', name: 'Neon Grid', desc: 'Cyberpunk frontier glow.', ocean: '#080a1c', ocean2: '#121033', sea: '#0d0b28', land: '#252052', line: 'rgba(86,220,226,.24)', neutral: '#463b7a', text: '#dcffff', unlock: { type: 'playtime', tier: 't300' } },
    { id: 'aurora', name: 'Aurora', desc: 'Polar light show, owner QA favourite.', ocean: '#041a24', ocean2: '#0a3040', sea: '#072534', land: '#155263', line: 'rgba(99,230,164,.2)', neutral: '#326a75', text: '#e2fff6', unlock: { type: 'gems', cost: 180 } }
  ];

  const ARMY_ICONS = [
    { id: 'infantry', name: 'Infantry', glyph: '▲', desc: 'Classic triangular division marker.', unlock: { type: 'free' } },
    { id: 'shield', name: 'Aegis', glyph: '⬟', desc: 'Hexagonal armoured crest.', unlock: { type: 'coins', cost: 400 } },
    { id: 'bolt', name: 'Blitz', glyph: 'ϟ', desc: 'Lightning assault badge.', unlock: { type: 'playtime', tier: 't30' } },
    { id: 'skull', name: 'Reavers', glyph: '☠', desc: 'Feared shock-troop insignia.', unlock: { type: 'milestone', id: 'warmonger' } },
    { id: 'crown', name: 'Royalty', glyph: '♛', desc: 'Imperial guard crown.', unlock: { type: 'gems', cost: 90 } },
    { id: 'owner', name: 'Owner Star', glyph: '★', desc: 'Exclusive CoMeBacK_49 command star.', unlock: { type: 'owner' } }
  ];

  const VICTORY_ANIMS = [
    { id: 'confetti', name: 'Confetti Storm', glyph: '✦', desc: 'Golden confetti rain.', unlock: { type: 'free' } },
    { id: 'fireworks', name: 'Fireworks', glyph: '✧', desc: 'Bursting shells over the map.', unlock: { type: 'coins', cost: 700 } },
    { id: 'rays', name: 'Victory Rays', glyph: '✧', desc: 'Rotating radiant beams.', unlock: { type: 'milestone', id: 'victor' } },
    { id: 'pulse', name: 'Pulse Wave', glyph: '◎', desc: 'Expanding energy rings.', unlock: { type: 'gems', cost: 75 } },
    { id: 'owner', name: 'Owner Eclipse', glyph: '★', desc: 'Gold-and-cyan owner-only finale.', unlock: { type: 'owner' } }
  ];

  const BADGES = [
    { id: 'none', name: 'No Badge', glyph: '·', desc: 'Clean command profile.', unlock: { type: 'free' } },
    { id: 'bronze', name: 'Bronze Star', glyph: '◈', desc: 'Awarded for your first conquest.', unlock: { type: 'milestone', id: 'first_blood' } },
    { id: 'silver', name: 'Silver Wreath', glyph: '◇', desc: 'Awarded for 10 built structures.', unlock: { type: 'milestone', id: 'architect' } },
    { id: 'gold', name: 'Gold Laurel', glyph: '★', desc: 'Awarded for a campaign victory.', unlock: { type: 'milestone', id: 'victor' } },
    { id: 'nuclear', name: 'Fallout Seal', glyph: '☢', desc: 'Awarded for launching a nuke.', unlock: { type: 'milestone', id: 'nuclear' } },
    { id: 'veteran', name: 'Veteran', glyph: '⚑', desc: 'Five hours of dedicated service.', unlock: { type: 'playtime', tier: 't300' } }
  ];

  const COSMETICS = { colors: COLOR_THEMES, skins: MAP_SKINS, icons: ARMY_ICONS, victories: VICTORY_ANIMS, badges: BADGES };
  const CATALOG_LABELS = { colors: 'Nation colors', skins: 'Map skins', icons: 'Army icons', victories: 'Victory animations', badges: 'Unit badges' };

  const TRAITS = [
    { id: 'recruit', name: 'Rapid Mobilisation', glyph: '⚙', desc: 'Factories produce +1 extra troop each turn.' },
    { id: 'defense', name: 'Fortified Doctrine', glyph: '⬟', desc: '+10% defence on every territory you hold.' },
    { id: 'attack', name: 'Blitzkrieg', glyph: '⚔', desc: '+8% attack strength on every assault.' }
  ];

  const PLAYTIME_TIERS = [
    { id: 't5', minutes: 5, name: 'First Deployment', rewards: [{ type: 'skins', id: 'midnight' }] },
    { id: 't15', minutes: 15, name: 'Seasoned Staff', rewards: [{ type: 'trait', id: 'recruit' }, { coins: 100 }] },
    { id: 't30', minutes: 30, name: 'Campaign Veteran', rewards: [{ type: 'icons', id: 'bolt' }, { gems: 10 }] },
    { id: 't60', minutes: 60, name: 'World Watcher', rewards: [{ type: 'skins', id: 'satellite' }, { coins: 250 }] },
    { id: 't120', minutes: 120, name: 'Grand Strategist', rewards: [{ type: 'trait', id: 'defense' }, { gems: 25 }] },
    { id: 't300', minutes: 300, name: 'Five-Hour Commander', rewards: [{ type: 'skins', id: 'neon' }, { type: 'badges', id: 'veteran' }] },
    { id: 't600', minutes: 600, name: 'RoFrontier Legend', rewards: [{ type: 'trait', id: 'attack' }, { gems: 100 }] }
  ];

  const ACHIEVEMENTS = [
    { id: 'first_blood', name: 'First Blood', glyph: '⚔', desc: 'Conquer your first territory.', reward: { coins: 80 } },
    { id: 'empire', name: 'Empire Builder', glyph: '⬡', desc: 'Hold 20 territories at once.', reward: { gems: 15 } },
    { id: 'warmonger', name: 'Warmonger', glyph: '☠', desc: 'Conquer 50 territories in total.', reward: { coins: 300 } },
    { id: 'victor', name: 'World Conqueror', glyph: '★', desc: 'Win a campaign.', reward: { gems: 30 } },
    { id: 'architect', name: 'Architect', glyph: '⚙', desc: 'Construct 10 structures.', reward: { coins: 200 } },
    { id: 'nuclear', name: 'Fallout', glyph: '☢', desc: 'Launch a nuclear strike.', reward: { gems: 20 } },
    { id: 'admiral', name: 'Admiral', glyph: '⚓', desc: 'Win a naval assault.', reward: { coins: 150 } },
    { id: 'collector', name: 'Collector', glyph: '✦', desc: 'Own 8 cosmetic items.', reward: { gems: 20 } },
    { id: 'loyal', name: 'Career Officer', glyph: '⚑', desc: 'Play 40 turns in total.', reward: { coins: 250 } }
  ];

  // RoWorld-style terrain: where you spawn really matters. Plains expand
  // fast, mountains are natural fortresses, highlands sit in between.
  const TERRAINS = {
    plains: { name: 'Plains', attack: 1.10, defense: 1.00, recruit: 1, tint: 'rgba(120,230,160,.075)', glyph: '≡' },
    highlands: { name: 'Highlands', attack: 1.00, defense: 1.12, recruit: 0, tint: 'rgba(235,195,120,.075)', glyph: '≋' },
    mountains: { name: 'Mountains', attack: 0.90, defense: 1.32, recruit: 0, tint: 'rgba(205,220,245,.11)', glyph: '▲' }
  };
  const TERRAIN_ORDER = ['plains', 'highlands', 'mountains'];

  const BUILDINGS = {
    city: { name: 'City', glyph: '▣', cost: 120, desc: '+6 Battle Coins and +1 recruit every tick.', level: 1 },
    port: { name: 'Port', glyph: '⚓', cost: 100, desc: 'Unlocks naval troop transport across sea lanes. +2 coins/tick.', level: 2, coastal: true },
    factory: { name: 'Factory', glyph: '⚙', cost: 150, desc: '+2 recruits every tick (faster army growth).', level: 3 },
    post: { name: 'Defense Post', glyph: '⬟', cost: 90, desc: '+25% permanent defence against any assault.', level: 2 },
    sam: { name: 'SAM Site', glyph: '△', cost: 220, desc: 'Intercepts one nuclear strike on this region or its neighbours.', level: 4 },
    silo: { name: 'Missile Silo', glyph: '⌂', cost: 300, desc: 'Unlocks nuclear weapons immediately and adds +2 warheads.', level: 5 }
  };
  const emptyBuildings = () => ({ city: false, port: false, factory: false, post: false, sam: false, silo: false });
  const DEPLOY_STEPS = [0.1, 0.25, 0.5, 0.75, 0.9];
  const REALTIME = {
    off: { label: 'Turn-based', tickMs: 0 },
    normal: { label: 'Real-time · 2s', tickMs: 2000 },
    fast: { label: 'Blitz · 1s', tickMs: 1000 }
  };
  const DEFEND_COST = 40;
  const NUKE_COIN_COST = 180;

  const DIFFICULTY = {
    easy: { label: 'Recruit', aggression: 0.65, income: 0.8, attacks: 1, neutral: 2, threshold: 1.5 },
    normal: { label: 'Commander', aggression: 1, income: 1, attacks: 2, neutral: 3, threshold: 1.25 },
    hard: { label: 'Warlord', aggression: 1.2, income: 1.3, attacks: 3, neutral: 4, threshold: 1.1 },
    insane: { label: 'Legend', aggression: 1.45, income: 1.6, attacks: 4, neutral: 5, threshold: 1.0 }
  };

  const AI_FACTIONS = [
    { name: 'Crimson Legion', color: '#e2505e', light: '#ff9aa5' },
    { name: 'Vesper Pact', color: '#38c48a', light: '#8cf0c2' },
    { name: 'Iron Dominion', color: '#9a6ef0', light: '#d0b6ff' },
    { name: 'Solar Khanate', color: '#f2a93b', light: '#ffd98a' },
    { name: 'Obsidian Court', color: '#6d829e', light: '#b5c6da' },
    { name: 'Frostbound Clans', color: '#7fd8f0', light: '#c6f1ff' },
    { name: 'Sable Confederacy', color: '#c77dff', light: '#e9c4ff' },
    { name: 'Amber Coalition', color: '#ffb347', light: '#ffdda1' },
    { name: 'Verdant Alliance', color: '#79d67d', light: '#c2f2c4' },
    { name: 'Ashen Directorate', color: '#a8a1b8', light: '#ded9e8' },
    { name: 'Tideborn tribes', color: '#4fc3c7', light: '#a6ecee' },
    { name: 'Highland Reaches', color: '#d98a8a', light: '#f2c4c4' }
  ];

  const DAILY_POOL = [
    { id: 'd_conquer', title: 'Frontier Push', event: 'conquer', goal: 3, icon: '⚔', desc: 'Conquer 3 territories', reward: { coins: 150, gems: 10 } },
    { id: 'd_build', title: 'War Economy', event: 'build', goal: 2, icon: '⚙', desc: 'Construct 2 structures', reward: { coins: 120, gems: 8 } },
    { id: 'd_turn', title: 'Staff Meeting', event: 'turn', goal: 5, icon: '◎', desc: 'Play 5 turns', reward: { coins: 100, gems: 6 } },
    { id: 'd_nuke', title: 'Deterrence Test', event: 'nuke', goal: 1, icon: '☢', desc: 'Launch 1 nuclear strike', reward: { coins: 220, gems: 18 } },
    { id: 'd_wins', title: 'Campaign Trail', event: 'win', goal: 1, icon: '★', desc: 'Win 1 match', reward: { coins: 300, gems: 25 } },
    { id: 'd_naval', title: 'Amphibious', event: 'naval', goal: 1, icon: '⚓', desc: 'Complete 1 naval assault', reward: { coins: 160, gems: 12 } },
    { id: 'd_conquer_big', title: 'Blitzkrieg', event: 'conquer', goal: 8, icon: '✦', desc: 'Conquer 8 territories', reward: { coins: 400, gems: 35 } },
    { id: 'd_turn_big', title: 'Long Campaign', event: 'turn', goal: 12, icon: '◇', desc: 'Play 12 turns', reward: { coins: 260, gems: 20 } }
  ];

  const SHOP = {
    iap: [
      { id: 'iap_handful', name: 'Handful of Gems', gems: 60, price: '$0.99', glyph: '◆' },
      { id: 'iap_pouch', name: 'Gem Pouch', gems: 180, price: '$2.99', glyph: '◆◆', featured: true },
      { id: 'iap_vault', name: 'Commander Vault', gems: 500, price: '$6.99', glyph: '◆◆◆' },
      { id: 'iap_empire', name: 'Empire Reserve', gems: 1400, price: '$14.99', glyph: '♛', featured: true }
    ],
    coins: [
      { id: 'coins_small', name: 'Supply Crate', coins: 400, gems: 20, glyph: '▣' },
      { id: 'coins_med', name: 'Treasury Wagon', coins: 1200, gems: 50, glyph: '▤' },
      { id: 'coins_big', name: 'War Chest', coins: 3000, gems: 110, glyph: '◆' }
    ],
    supplies: [
      { id: 'warhead', name: 'Nuclear Warhead', desc: 'Adds 1 warhead to the active campaign.', coins: 260, gems: 35, glyph: '☢' },
      { id: 'reinforce', name: 'Reinforcement Drop', desc: '+40 troops on your capital (needs a match).', coins: 180, glyph: '⚑' },
      { id: 'shield', name: 'Shield Protocols', desc: 'Fortify your capital for 3 turns.', coins: 150, glyph: '⬟' },
      { id: 'xp', name: 'Field Manual', desc: '+120 commander XP (faster unlocks).', coins: 220, glyph: '▤' }
    ],
    bundles: [
      { id: 'bundle_void', name: 'Void Bundle', desc: 'Void Sovereignty colour + Owner-grade XP.', gems: 90, items: ['colors:violet'], glyph: '✧' },
      { id: 'bundle_desert', name: 'Desert Bundle', desc: 'Sandstorm map + Fireworks victory.', gems: 120, items: ['skins:sandstorm', 'victories:fireworks'], glyph: '◇' },
      { id: 'bundle_royal', name: 'Royal Bundle', desc: 'Royalty army icon + Pulse Wave.', gems: 140, items: ['icons:crown', 'victories:pulse'], glyph: '♛' }
    ]
  };

  const REGION_NAMES = [
    'Aurora Basin', 'Ironvale', 'Cinder Reach', 'Northwatch', 'Silver March', 'Ember Coast', 'Kestrel Bay', 'Frosthold',
    'Verdant Plain', 'Greyfen', 'Highspire', 'Dawnridge', 'Sable Wood', 'Stormhaven', 'Amber Fields', 'Whitecrag',
    'Redstone', 'Duskwater', 'Thornfield', 'Eagle Nest', 'Coldharbour', 'Sunspire', 'Blackmoor', 'Riverbend',
    'Golden Steppe', 'Mistral Point', 'Onyx Gorge', 'Lantern Isle', 'Cobalt Reach', 'Ashfall', 'Meridian',
    'Tidewatch', 'Crownhaven', 'Wolfpine', 'Saltmarsh', 'Brimstone', 'Skyfall', 'Deepford', 'Ivory Cape',
    'Ravenswatch', 'Copper Hills', 'Nightshade', 'Bastion Prime', 'Windward', 'Lonepeak', 'Driftwood',
    'Starfall', 'Pale Horizon', 'Thundercliff', 'Marrowlands', 'Gilded Port', 'Wintergate', 'Sunken Vale',
    'Granite Bay', 'New Avalon', 'Crimson Delta', 'Orchard Reach', 'Shatterstone', 'Beacon Hill', 'Longwater',
    'Southmoor', 'Halcyon', 'Vigil Keep', 'Tempest Shore', 'Farwatch', 'Old Terrace', 'Zephyr Fields',
    'Ironcross', 'Quartz Ridge', 'Ebon Ford', 'Harbour Light', 'Sable Dunes', 'Northgate', 'Ardent Plains',
    'Cloudbreak', 'Fernhollow', 'Basalt Flats', 'Morrow Bay', 'Cinder Hollow', 'Wyrmsgate'
  ];

  /* ───────────────────────── 2. STATE ───────────────────────────── */
  function defaultState() {
    return {
      version: VERSION,
      profile: { name: 'Commander', owner: false, createdAt: Date.now() },
      settings: { difficulty: 'normal', bots: 3, reduceMotion: false, autoSave: true, wsUrl: '', deployRatio: 0.5, realtime: 'off' },
      wallet: { gems: 60, coins: 500 },
      cosmetics: {
        owned: ['colors:azure', 'colors:crimson', 'skins:classic', 'icons:infantry', 'victories:confetti', 'badges:none'],
        equipped: { colors: 'azure', skins: 'classic', icons: 'infantry', victories: 'confetti', badges: 'none' }
      },
      stats: {
        xp: 0, matches: 0, wins: 0, losses: 0, conquests: 0, turns: 0, buildings: 0,
        nukes: 0, naval: 0, playtimeMs: 0, lastActive: Date.now()
      },
      achievements: [],
      playtime: { claimed: [] },
      daily: { date: '', items: [], freeGemsClaimed: false },
      receipts: [], warheadsBank: 0,
      match: null
    };
  }

  let state = loadJSON(SAVE_KEY, null);
  if (!state || state.version !== VERSION) state = defaultState();
  // forward-compatible defaults for older saves
  const defaults = defaultState();
  state.settings = Object.assign(defaults.settings, state.settings || {});
  state.stats = Object.assign(defaults.stats, state.stats || {});
  state.wallet = Object.assign(defaults.wallet, state.wallet || {});
  state.cosmetics = Object.assign(defaults.cosmetics, state.cosmetics || {});
  state.cosmetics.equipped = Object.assign(defaults.cosmetics.equipped, state.cosmetics.equipped || {});
  state.cosmetics.owned = Array.isArray(state.cosmetics.owned) ? state.cosmetics.owned : defaults.cosmetics.owned.slice();
  state.daily = Object.assign(defaults.daily, state.daily || {});
  state.playtime = Object.assign({ claimed: [] }, state.playtime || {});
  state.achievements = Array.isArray(state.achievements) ? state.achievements : [];
  state.receipts = Array.isArray(state.receipts) ? state.receipts : [];
  state.warheadsBank = Number(state.warheadsBank) || 0;

  let admin = null;
  let map = null;                 // static world geometry
  let canvas = null, g = null;    // map canvas & context
  let victoryCanvas = null, vg = null;
  let lobby = null;
  let ui = { screen: 'title', vaultTab: 'colors', selected: null, target: null, inspect: null, lastTap: null, commandOpen: false, pending: null };
  let view = { w: 0, h: 0, dpr: 1, scale: 0.5, x: 0, y: 0, initialized: false, minScale: 0.18, maxScale: 2.6 };
  let particles = [];
  let victoryParticles = [];
  let victoryKind = 'confetti';
  let aiTimers = [];
  let toastTimer = 0;
  let lastFrame = 0;

  const T = (id) => state.match ? state.match.territories.find((t) => t.id === id) : null;
  const theme = () => COLOR_THEMES.find((c) => c.id === state.cosmetics.equipped.colors) || COLOR_THEMES[0];
  const skin = () => MAP_SKINS.find((s) => s.id === state.cosmetics.equipped.skins) || MAP_SKINS[0];
  const armyIcon = () => ARMY_ICONS.find((i) => i.id === state.cosmetics.equipped.icons) || ARMY_ICONS[0];
  const level = () => Math.min(50, 1 + Math.floor(state.stats.xp / 150));
  const isOwnerProfile = () => String(state.profile.name).toLowerCase() === 'comeback_49';

  function save() {
    if (!state.settings.autoSave) return;
    const snapshot = { ...state, match: serializeMatch(state.match) };
    storeJSON(SAVE_KEY, snapshot);
  }

  function serializeMatch(match) {
    if (!match) return null;
    return {
      id: match.id, seed: match.seed, mode: match.mode, difficulty: match.difficulty,
      turn: match.turn, phase: match.phase, over: match.over, winner: match.winner,
      adminTest: match.adminTest, factions: match.factions, warheads: match.warheads,
      nukeUnlocked: match.nukeUnlocked, godMode: match.godMode, godFaction: match.godFaction,
      localFaction: match.localFaction, rngState: match.rngState, seq: match.seq || 0,
      alliances: (match.alliances || []).slice(), realtime: match.realtime || 'off', tickMs: match.tickMs || 0,
      room: match.room || null, log: match.log.slice(-40), matchStats: match.matchStats,
      territories: match.territories.map((t) => ({
        id: t.id, o: t.owner, t: t.troops, b: t.buildings, f: t.fallout,
        d: t.defended, c: t.capital
      }))
    };
  }

  function hydrateMatch(raw) {
    if (!raw) return null;
    map = generateMap(raw.seed);
    const byId = new Map(raw.territories.map((t) => [t.id, t]));
    const match = {
      id: raw.id, seed: raw.seed, mode: raw.mode, difficulty: raw.difficulty,
      turn: raw.turn, phase: raw.phase === 'ai' ? 'player' : raw.phase,
      over: raw.over, winner: raw.winner, adminTest: raw.adminTest,
      factions: raw.factions, warheads: raw.warheads || 0,
      nukeUnlocked: !!raw.nukeUnlocked, godMode: !!raw.godMode,
      godFaction: raw.godFaction || null, localFaction: raw.localFaction || HUMAN,
      rngState: raw.rngState || hashSeed(String(raw.seed) + '|rng'), seq: raw.seq || 0,
      alliances: raw.alliances || [], realtime: raw.realtime || 'off', tickMs: raw.tickMs || 0,
      room: raw.room || null, actingFaction: null,
      log: raw.log || [], matchStats: raw.matchStats || { conquests: 0, buildings: 0, nukes: 0, naval: 0, kills: 0 },
      territories: map.territories.map((geom) => {
        const d = byId.get(geom.id) || {};
        return {
          ...geom,
          owner: d.o || NEUTRAL,
          troops: d.t || 3,
          buildings: { ...emptyBuildings(), ...(d.b || {}) },
          fallout: d.f || 0,
          defended: d.d || 0,
          capital: d.c || null
        };
      })
    };
    return match;
  }

  // World hydration is deferred to init(), after all map constants exist.

  /* ───────────────────── 3. WORLD GENERATION ────────────────────── */
  const COLS = 17, ROWS = 11, HEX_R = 44;
  const HEX_W = Math.sqrt(3) * HEX_R;
  const CONTINENTS = [
    { id: 'NA', name: 'North Ameria', bonus: 3, poly: [[0.5, 0.5], [4.2, 0.5], [5.2, 1.5], [5.4, 3.4], [4.3, 4.4], [3.6, 5.2], [2.9, 4.3], [2.1, 3.9], [1.3, 3.1], [0.5, 2.4]] },
    { id: 'SA', name: 'South Ameria', bonus: 2, poly: [[3.6, 5.7], [5.1, 5.7], [6.1, 6.7], [5.9, 8.5], [5.1, 10.2], [4.2, 10.3], [3.6, 8.6], [3.3, 7.1]] },
    { id: 'GL', name: 'Frostholm', bonus: 1, poly: [[5.8, 0.2], [7.2, 0.2], [7.4, 1.5], [6.1, 1.6]] },
    { id: 'EU', name: 'Europa', bonus: 2, poly: [[8.0, 0.8], [10.4, 0.8], [11.0, 2.0], [10.2, 3.4], [8.7, 3.4], [7.8, 2.1]] },
    { id: 'AF', name: 'Afrika', bonus: 3, poly: [[7.8, 4.0], [10.3, 4.0], [11.0, 5.2], [10.4, 7.6], [9.3, 9.4], [8.4, 9.0], [7.7, 7.2], [7.5, 5.4]] },
    { id: 'AS', name: 'Asia Major', bonus: 5, poly: [[11.0, 0.7], [16.4, 0.7], [16.6, 3.2], [15.5, 4.3], [14.0, 4.6], [12.8, 3.7], [11.4, 3.6], [10.8, 2.3]] },
    { id: 'OC', name: 'Oceania', bonus: 2, poly: [[13.6, 7.3], [16.4, 7.0], [16.6, 9.3], [15.0, 10.0], [13.7, 9.0]] }
  ];

  function pointInPoly(x, y, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i], [xj, yj] = poly[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  function hexPoints(cx, cy, r) {
    const pts = [];
    for (let i = 0; i < 6; i++) {
      const a = (Math.PI / 180) * (60 * i - 90);
      pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
    return pts;
  }
  function hexCenter(col, row) {
    return { x: 70 + HEX_W * (col + (row & 1 ? 0.5 : 0)), y: 70 + HEX_R * 1.5 * row };
  }
  function oddRNeighbors(col, row) {
    const even = (row & 1) === 0;
    const offsets = even
      ? [[-1, -1], [0, -1], [-1, 0], [1, 0], [-1, 1], [0, 1]]
      : [[0, -1], [1, -1], [-1, 0], [1, 0], [0, 1], [1, 1]];
    return offsets.map(([dc, dr]) => [col + dc, row + dr])
      .filter(([c, r]) => c >= 0 && c < COLS && r >= 0 && r < ROWS);
  }

  function generateMap(seedStr) {
    const seed = typeof seedStr === 'number' ? seedStr : hashSeed(seedStr || '49');
    const rnd = mulberry32(seed);
    const cells = [];
    const keyToId = new Map();
    const names = shuffle(REGION_NAMES, rnd);
    const territories = [];

    for (let row = 0; row < ROWS; row++) {
      for (let col = 0; col < COLS; col++) {
        const { x, y } = hexCenter(col, row);
        const continent = CONTINENTS.find((c) => pointInPoly(col, row, c.poly));
        const cell = { col, row, cx: x, cy: y, land: !!continent, continent: continent ? continent.id : null, id: null };
        cells.push(cell);
        keyToId.set(`${col},${row}`, cell);
        if (continent) {
          const id = `T${String(territories.length + 1).padStart(2, '0')}`;
          cell.id = id;
          territories.push({
            id, name: names[territories.length % names.length],
            col, row, cx: x, cy: y, continent: continent.id,
            continentName: continent.name, coastal: false,
            neighbors: [], naval: [], poly: hexPoints(x, y, HEX_R * 0.97)
          });
        }
      }
    }
    const byId = new Map(territories.map((t) => [t.id, t]));
    const adj = {};
    territories.forEach((t) => {
      adj[t.id] = [];
      oddRNeighbors(t.col, t.row).forEach(([c, r]) => {
        const cell = keyToId.get(`${c},${r}`);
        if (!cell) return;
        if (cell.land) adj[t.id].push(cell.id);
        else t.coastal = true;
      });
    });
    // Ensure symmetric land adjacency.
    territories.forEach((t) => adj[t.id].forEach((n) => {
      if (!adj[n].includes(t.id)) adj[n].push(t.id);
    }));

    // Naval lanes: BFS across water hexes from every coastal territory.
    const naval = {};
    territories.forEach((t) => { naval[t.id] = []; });
    const coastal = territories.filter((t) => t.coastal);
    coastal.forEach((start) => {
      const frontier = [{ col: start.col, row: start.row, d: 0 }];
      const seen = new Set([`${start.col},${start.row}`]);
      const found = new Map();
      while (frontier.length) {
        const cur = frontier.shift();
        if (cur.d >= 7) continue;
        oddRNeighbors(cur.col, cur.row).forEach(([c, r]) => {
          const key = `${c},${r}`;
          if (seen.has(key)) return;
          const cell = keyToId.get(key);
          if (!cell) return;
          seen.add(key);
          if (cell.land) {
            if (cell.id !== start.id && byId.get(cell.id).coastal) found.set(cell.id, cur.d + 1);
          } else {
            frontier.push({ col: c, row: r, d: cur.d + 1 });
          }
        });
      }
      naval[start.id] = Array.from(found.entries())
        .map(([id, dist]) => ({ id, dist }))
        .sort((a, b) => a.dist - b.dist)
        .slice(0, 14);
    });

    territories.forEach((t) => {
      t.neighbors = adj[t.id];
      t.naval = naval[t.id];
      // Coasts are more likely to be open plains — a good spawn accelerates
      // early expansion. Everything is derived from the world seed so every
      // device in an online match generates byte-identical terrain.
      const roll = rnd();
      const plainsCut = t.coastal ? 0.72 : 0.52;
      t.terrain = roll < plainsCut ? 'plains' : roll < plainsCut + 0.28 ? 'highlands' : 'mountains';
      t.terrainName = TERRAINS[t.terrain].name;
    });

    return {
      seed: seedStr, cells, territories, adj, naval, byId,
      width: 140 + HEX_W * (COLS + 0.5),
      height: 140 + HEX_R * 1.5 * (ROWS - 1) + HEX_R * 2,
      R: HEX_R
    };
  }

  function factionColor(fid) {
    if (fid === NEUTRAL) return skin().neutral;
    const f = state.match && state.match.factions.find((x) => x.id === fid);
    return f ? f.color : '#607086';
  }
  function factionName(fid) {
    if (fid === NEUTRAL) return 'Neutral';
    const f = state.match && state.match.factions.find((x) => x.id === fid);
    return f ? f.name : 'Unknown';
  }

  /* ───────────────────── 4. CANVAS RENDERER ─────────────────────── */
  function resizeCanvas(forceFit = false) {
    if (!canvas || !g) return;
    const wrap = $('mapWrap');
    const rect = wrap.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return; // hidden game screen
    view.w = rect.width;
    view.h = rect.height;
    view.dpr = Math.min(2.5, window.devicePixelRatio || 1);
    canvas.width = Math.round(view.w * view.dpr);
    canvas.height = Math.round(view.h * view.dpr);
    if (!view.initialized || forceFit) {
      fitMap(false);
      view.initialized = true;
    }
    draw();
  }

  function fitMap(zoomIn = false) {
    if (!map) return;
    const s = Math.min(view.w / map.width, view.h / map.height) * 0.96;
    view.minScale = s * 0.75;
    view.scale = zoomIn ? clamp(s * 1.9, 0.32, 1.3) : s;
    view.x = (view.w - map.width * view.scale) / 2;
    view.y = (view.h - map.height * view.scale) / 2;
  }
  function zoomAt(factor, sx, sy) {
    const old = view.scale;
    const next = clamp(old * factor, view.minScale, view.maxScale);
    if (next === old) return;
    const wx = (sx - view.x) / old, wy = (sy - view.y) / old;
    view.scale = next;
    view.x = sx - wx * next;
    view.y = sy - wy * next;
  }
  function worldToScreen(x, y) { return { x: view.x + x * view.scale, y: view.y + y * view.scale }; }
  function screenToWorld(x, y) { return { x: (x - view.x) / view.scale, y: (y - view.y) / view.scale }; }
  function focusOn(t, targetScale) {
    if (!t) return;
    if (targetScale) view.scale = clamp(targetScale, view.minScale, view.maxScale);
    view.x = view.w / 2 - t.cx * view.scale;
    view.y = view.h / 2 - t.cy * view.scale;
  }

  function hexPath(ctx, pts) {
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.closePath();
  }

  function draw() {
    if (!g || !map || !view.w) return;
    const sk = skin();
    g.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
    g.clearRect(0, 0, view.w, view.h);
    const bg = g.createLinearGradient(0, 0, 0, view.h);
    bg.addColorStop(0, sk.ocean);
    bg.addColorStop(1, sk.ocean2);
    g.fillStyle = bg;
    g.fillRect(0, 0, view.w, view.h);

    g.save();
    g.translate(view.x, view.y);
    g.scale(view.scale, view.scale);

    // Ocean hex tiles (subtle grid so panning reads as a globe).
    g.lineWidth = 1.1;
    g.strokeStyle = sk.line;
    map.cells.filter((c) => !c.land).forEach((c) => {
      const pts = hexPoints(c.cx, c.cy, HEX_R * 0.95);
      hexPath(g, pts);
      g.fillStyle = sk.sea;
      g.fill();
      g.stroke();
    });

    // Sea lanes from a selected port territory.
    const sel = ui.selected ? T(ui.selected) : null;
    if (sel && sel.buildings.port && map.naval[sel.id]) {
      g.save();
      g.setLineDash([7, 7]);
      g.lineWidth = 2.2;
      g.strokeStyle = 'rgba(86,220,226,.55)';
      map.naval[sel.id].slice(0, 8).forEach((lane) => {
        const dest = T(lane.id);
        if (!dest) return;
        g.beginPath(); g.moveTo(sel.cx, sel.cy); g.lineTo(dest.cx, dest.cy); g.stroke();
      });
      g.restore();
    }

    const now = performance.now();
    // Predicted order marker — cleared as soon as the sequenced delta lands.
    if (ui.pending && ui.pending.id && now - ui.pending.at < 1200) {
      const pt = T(ui.pending.id);
      if (pt) {
        const k = (now - ui.pending.at) / 1200;
        g.save();
        g.setLineDash([6, 6]);
        g.lineWidth = 3;
        g.strokeStyle = `rgba(245,190,74,${0.85 - k * 0.6})`;
        g.beginPath(); g.arc(pt.cx, pt.cy, HEX_R * (0.5 + k * 0.7), 0, Math.PI * 2); g.stroke();
        g.restore();
      }
    } else if (ui.pending) ui.pending = null;
    // Territory polygons.
    state.match && state.match.territories.forEach((t) => {
      const color = factionColor(t.owner);
      const isSel = ui.selected === t.id;
      const isTarget = ui.target === t.id;
      const isInspect = ui.inspect === t.id;
      const reachable = sel && (isAdjacent(sel.id, t.id).ok) && t.id !== sel.id;
      hexPath(g, t.poly);
      const grad = g.createLinearGradient(t.cx, t.cy - HEX_R, t.cx, t.cy + HEX_R);
      grad.addColorStop(0, color);
      grad.addColorStop(1, shade(color, -0.35));
      g.fillStyle = grad;
      g.globalAlpha = t.fallout > 0 ? 0.55 : 0.93;
      g.fill();
      g.globalAlpha = 1;
      // Terrain overlay: plains read green, highlands amber, mountains cold.
      hexPath(g, t.poly);
      g.fillStyle = terrainOf(t).tint;
      g.fill();
      g.lineJoin = 'round';
      g.lineWidth = isSel ? 5 : isTarget ? 4 : reachable ? 3 : 1.6;
      g.strokeStyle = isSel ? '#f5be4a'
        : isTarget ? (t.owner === me() ? '#56dce2' : '#ff6473')
          : reachable ? (t.owner === me() ? 'rgba(86,220,226,.8)' : 'rgba(255,100,115,.8)')
            : 'rgba(4,10,18,.75)';
      if (isSel) { g.shadowColor = '#f5be4a'; g.shadowBlur = 18; }
      g.stroke();
      g.shadowBlur = 0;

      if (isInspect && !isSel && !isTarget) {
        g.lineWidth = 2; g.strokeStyle = '#ffffff'; g.globalAlpha = .65; g.stroke(); g.globalAlpha = 1;
      }
      if (t.fallout > 0) {
        g.fillStyle = 'rgba(180,255,90,.10)';
        hexPath(g, t.poly); g.fill();
      }
      if (state.match.godMode && t.owner === me()) {
        g.lineWidth = 2;
        g.strokeStyle = `rgba(245,190,74,${0.55 + 0.35 * Math.sin(now / 300)})`;
        hexPath(g, t.poly); g.stroke();
      }
    });

    // Particles in world space.
    particles = particles.filter((p) => now - p.start < p.life);
    particles.forEach((p) => {
      const k = (now - p.start) / p.life;
      g.globalAlpha = 1 - k;
      if (p.type === 'ring') {
        g.beginPath(); g.arc(p.x, p.y, 10 + k * p.size, 0, Math.PI * 2);
        g.lineWidth = 5 * (1 - k); g.strokeStyle = p.color; g.stroke();
      } else if (p.type === 'spark') {
        const x = p.x + Math.cos(p.angle) * k * p.size;
        const y = p.y + Math.sin(p.angle) * k * p.size;
        g.beginPath(); g.arc(x, y, p.r * (1 - k), 0, Math.PI * 2);
        g.fillStyle = p.color; g.fill();
      } else if (p.type === 'flash') {
        g.beginPath(); g.arc(p.x, p.y, p.size * (1 - k), 0, Math.PI * 2);
        g.fillStyle = p.color; g.fill();
      }
      g.globalAlpha = 1;
    });
    g.restore();

    // Screen-space labels stay legible at every zoom level.
    if (state.match) {
      const badgeR = clamp(9 + view.scale * 10, 10, 17);
      const fontSize = clamp(9 + view.scale * 6, 9, 13);
      state.match.territories.forEach((t) => {
        const p = worldToScreen(t.cx, t.cy);
        if (p.x < -40 || p.x > view.w + 40 || p.y < -40 || p.y > view.h + 40) return;
        const color = factionColor(t.owner);
        g.beginPath(); g.arc(p.x, p.y, badgeR, 0, Math.PI * 2);
        g.fillStyle = 'rgba(5,12,22,.86)'; g.fill();
        g.lineWidth = 2; g.strokeStyle = color; g.stroke();
        g.textAlign = 'center'; g.textBaseline = 'middle';
        g.font = `700 ${fontSize}px system-ui, sans-serif`;
        g.fillStyle = '#f4f9ff';
        g.fillText(String(t.troops > 9999 ? '∞' : t.troops), p.x, p.y + 1);
        // small army icon above the counter
        g.font = `${Math.max(8, fontSize - 2)}px system-ui, sans-serif`;
        g.fillStyle = color;
        g.fillText(armyIcon().glyph, p.x, p.y - badgeR - 5);

        // structure glyphs along the top edge of the hex
        const structs = [];
        if (t.buildings.city) structs.push('▣');
        if (t.buildings.port) structs.push('⚓');
        if (t.buildings.factory) structs.push('⚙');
        if (t.buildings.post) structs.push('⬟');
        if (t.buildings.sam) structs.push('△');
        if (t.buildings.silo) structs.push('⌂');
        if (t.capital) structs.push('★');
        if (t.fallout > 0) structs.push('☢');
        if (t.defended > 0) structs.push('⬟');
        if (structs.length) {
          g.font = '10px system-ui, sans-serif';
          g.fillStyle = t.fallout > 0 ? '#c9ff7a' : '#f5be4a';
          g.fillText(structs.join(''), p.x, p.y - badgeR - 17);
        }
      });
    }

    // Floating combat text.
    particles.filter((p) => p.type === 'text').forEach((p) => {
      const k = (now - p.start) / p.life;
      const pos = worldToScreen(p.x, p.y - k * 30);
      g.globalAlpha = 1 - k;
      g.font = '800 15px system-ui, sans-serif';
      g.textAlign = 'center';
      g.fillStyle = p.color;
      g.fillText(p.text, pos.x, pos.y);
      g.globalAlpha = 1;
    });
  }

  function shade(hex, amount) {
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || '#445566');
    if (!m) return hex;
    const f = (v) => clamp(Math.round(parseInt(v, 16) * (1 + amount)), 0, 255);
    return `rgb(${f(m[1])},${f(m[2])},${f(m[3])})`;
  }

  function spawnParticles(t, kind, color) {
    if (state.settings.reduceMotion) return;
    const now = performance.now();
    if (kind === 'nuke') {
      particles.push({ type: 'flash', x: t.cx, y: t.cy, size: HEX_R * 2.2, color: 'rgba(255,240,180,.85)', start: now, life: 500 });
      particles.push({ type: 'ring', x: t.cx, y: t.cy, size: HEX_R * 3.4, color: '#ff9d5c', start: now, life: 900 });
      for (let i = 0; i < 22; i++) {
        particles.push({ type: 'spark', x: t.cx, y: t.cy, angle: (Math.PI * 2 * i) / 22, size: HEX_R * 2.5, r: 5, color: i % 2 ? '#ffce6a' : '#ff6473', start: now, life: 800 });
      }
    } else {
      particles.push({ type: 'ring', x: t.cx, y: t.cy, size: HEX_R * 1.6, color: color || '#ffd97e', start: now, life: 600 });
      for (let i = 0; i < 8; i++) {
        particles.push({ type: 'spark', x: t.cx, y: t.cy, angle: Math.random() * Math.PI * 2, size: HEX_R, r: 3, color: color || '#f5be4a', start: now, life: 550 });
      }
    }
  }
  function floatText(t, text, color) {
    if (state.settings.reduceMotion) return;
    particles.push({ type: 'text', x: t.cx, y: t.cy, text, color: color || '#f5be4a', start: performance.now(), life: 1100 });
  }

  /* ──────────────── 5. TOUCH / POINTER CONTROLS ─────────────────── */
  const pointers = new Map();
  let gesture = null;
  let longPressTimer = null;

  function setupCanvasInput() {
    canvas.addEventListener('pointerdown', (e) => {
      canvas.setPointerCapture?.(e.pointerId);
      const rect = canvas.getBoundingClientRect();
      const p = { x: e.clientX - rect.left, y: e.clientY - rect.top, sx: e.clientX - rect.left, sy: e.clientY - rect.top, t: performance.now() };
      pointers.set(e.pointerId, p);
      if (pointers.size === 1) {
        gesture = { mode: 'pan', start: p, last: { x: p.x, y: p.y }, moved: false, scale: view.scale, world: screenToWorld(p.x, p.y) };
        const world = screenToWorld(p.x, p.y);
        const hit = hitTest(world);
        clearTimeout(longPressTimer);
        longPressTimer = setTimeout(() => {
          if (gesture && !gesture.moved && hit && hit.owner === me() && state.match && !state.match.over) {
            quickDefend(hit.id);
            if (navigator.vibrate) navigator.vibrate(25);
          }
        }, 620);
      } else if (pointers.size === 2) {
        clearTimeout(longPressTimer);
        const [a, b] = Array.from(pointers.values());
        gesture = {
          mode: 'pinch', dist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
          scale: view.scale,
          center: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
          world: screenToWorld((a.x + b.x) / 2, (a.y + b.y) / 2)
        };
      }
    });

    canvas.addEventListener('pointermove', (e) => {
      const p = pointers.get(e.pointerId);
      if (!p) return;
      const rect = canvas.getBoundingClientRect();
      p.x = e.clientX - rect.left; p.y = e.clientY - rect.top;
      if (!gesture) return;
      if (gesture.mode === 'pan' && pointers.size === 1) {
        const dx = p.x - gesture.last.x, dy = p.y - gesture.last.y;
        if (Math.hypot(p.x - gesture.start.sx, p.y - gesture.start.sy) > 9) {
          gesture.moved = true;
          clearTimeout(longPressTimer);
        }
        if (gesture.moved) { view.x += dx; view.y += dy; fadeHint(); }
        gesture.last = { x: p.x, y: p.y };
      } else if (gesture.mode === 'pinch' && pointers.size >= 2) {
        const [a, b] = Array.from(pointers.values());
        const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
        const center = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const next = clamp(gesture.scale * (dist / gesture.dist), view.minScale, view.maxScale);
        view.scale = next;
        view.x = center.x - gesture.world.x * next;
        view.y = center.y - gesture.world.y * next;
        gesture.center = center;
        fadeHint();
      }
    });

    const endPointer = (e) => {
      const p = pointers.get(e.pointerId);
      const wasSingle = pointers.size === 1;
      pointers.delete(e.pointerId);
      clearTimeout(longPressTimer);
      if (wasSingle && p && gesture && gesture.mode === 'pan' && !gesture.moved && performance.now() - p.t < 500) {
        handleTap(screenToWorld(p.x, p.y));
      }
      if (pointers.size === 0) gesture = null;
      else if (pointers.size === 1) {
        const only = Array.from(pointers.values())[0];
        gesture = { mode: 'pan', start: { ...only, sx: only.x, sy: only.y }, last: { x: only.x, y: only.y }, moved: true, scale: view.scale };
      }
    };
    canvas.addEventListener('pointerup', endPointer);
    canvas.addEventListener('pointercancel', endPointer);
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      zoomAt(e.deltaY < 0 ? 1.12 : 0.89, e.clientX - rect.left, e.clientY - rect.top);
      fadeHint();
    }, { passive: false });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  function fadeHint() {
    const hint = $('mapHint');
    if (hint) hint.classList.add('faded');
  }

  function hitTest(world) {
    if (!map) return null;
    let best = null, bestD = Infinity;
    for (const t of map.territories) {
      const dx = world.x - t.cx, dy = world.y - t.cy;
      const d = dx * dx + dy * dy;
      if (d < bestD && pointInPoly(world.x, world.y, t.poly)) { best = t; bestD = d; }
    }
    return best ? T(best.id) : null;
  }

  function handleTap(world) {
    const t = hitTest(world);
    if (!t) { ui.target = null; renderGame(); return; }
    if (!state.match || state.match.over || state.match.phase !== 'player') { openInfoModal(t.id); return; }
    const owned = t.owner === me();
    const last = ui.lastTap;
    ui.lastTap = { id: t.id, time: performance.now() };
    if (last && last.id === t.id && performance.now() - last.time < 340 && ui.selected && ui.selected !== t.id) {
      const link = isAdjacent(ui.selected, t.id);
      if (link.ok) { owned ? openTransferModal() : openAttackModal(); return; }
    }

    if (!ui.selected) {
      if (owned) { ui.selected = t.id; ui.target = null; ui.inspect = null; toast(`${t.name} selected · ${t.troops} troops`); }
      else { ui.inspect = t.id; ui.selected = null; ui.target = null; openInfoModal(t.id); }
    } else if (t.id === ui.selected) {
      ui.target = null; openInfoModal(t.id);
    } else if (owned && !isAdjacent(ui.selected, t.id).ok) {
      ui.selected = t.id; ui.target = null; ui.inspect = null;
      toast(`Source: ${t.name}`, 'success');
    } else {
      ui.target = t.id; ui.inspect = null;
      const link = isAdjacent(ui.selected, t.id);
      if (!link.ok) toast(`${t.name} is out of reach — build a Port for sea lanes`, 'error');
      else toast(owned ? `Transfer route → ${t.name}` : `Target locked → ${t.name}`, 'success');
    }
    renderGame();
  }

  /* ───────────────── 6. GAME LIFECYCLE / ECONOMY ────────────────── */
  function startMatch(opts = {}) {
    clearAiTimers();
    const seed = String(opts.seed ?? $('matchSeed').value ?? '49').trim() || '49';
    const diff = opts.difficulty || state.settings.difficulty;
    const shared = opts.mode === 'online';
    const botCount = clamp(Number(state.settings.bots) || 3, 1, 12);
    map = generateMap(seed);
    const rnd = mulberry32(hashSeed(seed + '|start'));

    const th = theme();
    // Offline: one human nation + AI rivals. Online: every room member is a
    // real faction (competitive), with optional AI bots filling extra seats.
    const seats = (Array.isArray(opts.seats) && opts.seats.length)
      ? opts.seats
      : [{ name: th.name, color: th.primary, light: th.light }];
    const localSeat = clamp(Number(opts.localSeat) || 0, 0, seats.length - 1);
    const aiBots = clamp(Number(opts.bots ?? botCount) || 0, 0, 12);
    const factions = seats.map((s, i) => ({
      id: `F${i}`, name: s.name, color: s.color, light: s.light || s.color,
      isAI: false, eliminated: false, coins: 300
    }));
    for (let i = 0; i < aiBots; i++) {
      const f = AI_FACTIONS[i % AI_FACTIONS.length];
      factions.push({
        id: `F${seats.length + i}`, name: f.name, color: f.color, light: f.light,
        isAI: true, eliminated: false, coins: 300
      });
    }

    const territories = map.territories.map((geom) => ({
      ...geom,
      owner: NEUTRAL,
      troops: 2 + (DIFFICULTY[diff]?.neutral || 3) + Math.floor(rnd() * 3),
      buildings: emptyBuildings(),
      fallout: 0, defended: 0, capital: null
    }));

    // Spread capital starts across the globe.
    const ids = shuffle(territories.map((t) => t.id), rnd);
    // With 20 factions on 75 regions the classic 4-region start would run
    // out of land; scale the beachhead so every nation still gets a capital.
    const per = clamp(Math.floor(ids.length / Math.max(1, factions.length)), 1, 4);
    factions.forEach((f, fi) => {
      for (let k = 0; k < per; k++) {
        const id = ids[fi * per + k];
        if (!id) continue;
        const t = territories.find((x) => x.id === id);
        t.owner = f.id;
        t.troops = k === 0 ? 12 : 6;
        if (k === 0) t.capital = f.id;
      }
    });

    state.match = {
      id: shared ? `net-${seed}` : uid('match'), seed, mode: opts.mode || 'offline', difficulty: diff,
      turn: 1, phase: 'player', over: false, winner: null, adminTest: false,
      factions, warheads: shared ? 1 : 1 + (state.warheadsBank || 0), nukeUnlocked: false,
      godMode: false, godFaction: null, localFaction: `F${localSeat}`,
      actingFaction: null, seq: 0, rngState: hashSeed(seed + '|rng'),
      room: opts.room || null,
      alliances: [], realtime: opts.realtime || state.settings.realtime || 'off',
      tickMs: (REALTIME[opts.realtime || state.settings.realtime] || REALTIME.off).tickMs,
      lastTickAt: 0,
      log: [], matchStats: { conquests: 0, buildings: 0, nukes: 0, naval: 0, kills: 0 },
      territories
    };
    state.warheadsBank = 0;
    state.stats.matches++;
    ui.selected = null; ui.target = null; ui.inspect = null;
    addLog(`Campaign ${seed} deployed · ${factions.length - 1} rivals · ${DIFFICULTY[diff].label} AI · ${REALTIME[state.match.realtime]?.label || 'Turn-based'}.`);
    ensureDaily(); save();
    showScreen('game');
    const capital = territories.find((t) => t.capital === me());
    view.initialized = true;
    focusOn(capital, Math.max(0.44, Math.min(view.w / map.width, view.h / map.height) * 2));
  }

  function applyRemoteSnapshot(snap) {
    if (!snap || !snap.seed) return;
    clearAiTimers();
    const match = hydrateMatch(snap);
    if (!match) return;
    const room = match.room || (lobby && lobby.state.room) || null;
    const seats = room && Array.isArray(room.seats) ? room.seats : [];
    const idx = seats.findIndex((x) => x.id === (lobby && lobby.selfId));
    match.localFaction = `F${idx >= 0 ? idx : 0}`;
    match.over = false;
    match.winner = null;
    match.adminTest = false;
    match.phase = 'player';
    match.actingFaction = null;
    state.match = match;
    if (lobby) {
      lobby.matchRoomCode = room && room.code ? room.code : lobby.topicCode;
      lobby.hostSeq = Math.max(lobby.hostSeq || 0, match.seq || 0);
    }
    ui.selected = null; ui.target = null; ui.inspect = null;
    save();
    showScreen('game');
    renderGame(); renderHeader(); checkVictory();
    toast('Battlefield synchronised with the host.', 'success');
  }

  function addLog(text) {
    if (!state.match) return;
    state.match.log.push({ text, turn: state.match.turn, ts: isShared() ? (state.match.seq || 0) * 1000 : Date.now() });
    if (state.match.log.length > 60) state.match.log.shift();
  }

  function isAdjacent(fromId, toId) {
    if (!state.match || !map) return { ok: false };
    if (fromId === toId) return { ok: false };
    if (state.match.godMode) return { ok: true, kind: 'god' };
    const from = T(fromId), to = T(toId);
    if (!from || !to) return { ok: false };
    if ((map.adj[fromId] || []).includes(toId)) return { ok: true, kind: 'land' };
    if (from.buildings.port && to.coastal && (map.naval[fromId] || []).some((n) => n.id === toId)) {
      return { ok: true, kind: 'naval' };
    }
    return { ok: false };
  }

  function resolveTerritory(raw) {
    if (!state.match) return null;
    const q = String(raw || '').trim().toLowerCase();
    if (!q) return null;
    return state.match.territories.find((t) => t.id.toLowerCase() === q || `t${q}` === t.id.toLowerCase())
      || state.match.territories.find((t) => t.name.toLowerCase() === q)
      || state.match.territories.find((t) => t.name.toLowerCase().includes(q))
      || null;
  }

  function ownedCount(fid) { return state.match ? state.match.territories.filter((t) => t.owner === fid).length : 0; }
  function terrainOf(t) { return (t && TERRAINS[t.terrain]) || TERRAINS.plains; }
  function allianceKey(a, b) { return [a, b].sort().join('|'); }
  function areAllied(a, b) {
    if (!a || !b || a === b || a === NEUTRAL || b === NEUTRAL) return false;
    return !!(state.match && (state.match.alliances || []).includes(allianceKey(a, b)));
  }
  function setAlliance(a, b, on) {
    const match = state.match;
    if (!match || !a || !b || a === b) return { ok: false, message: 'Invalid alliance.' };
    if (!match.factions.some((f) => f.id === a) || !match.factions.some((f) => f.id === b)) {
      return { ok: false, message: 'Unknown nation.' };
    }
    const key = allianceKey(a, b);
    match.alliances = match.alliances || [];
    const had = match.alliances.includes(key);
    if (on && !had) match.alliances.push(key);
    if (!on && had) match.alliances = match.alliances.filter((k) => k !== key);
    addLog(on && !had ? `⚑ ${factionName(a)} and ${factionName(b)} signed an alliance.`
      : !on && had ? `⚑ ${factionName(a)} broke the alliance with ${factionName(b)}.` : 'Alliance unchanged.');
    save(); renderGame();
    return { ok: true, allied: on, message: on && !had ? 'Alliance signed — trade routes are open.' : 'Alliance status updated.' };
  }
  function totalTerritories() { return state.match ? state.match.territories.length : 0; }
  function hasTrait(id) {
    return PLAYTIME_TIERS.some((tier) => state.playtime.claimed.includes(tier.id)
      && tier.rewards.some((r) => r.type === 'trait' && r.id === id));
  }

  /* ────────────── 7. COMBAT, BUILDINGS, NUKES ───────────────────── */
  function defenseMultiplier(t) {
    let m = 1;
    if (t.defended > 0) m += 0.35;
    if (t.capital) m += 0.12;
    if (t.buildings.city) m += 0.1;
    if (t.buildings.post) m += 0.25;
    m *= terrainOf(t).defense;
    if (!isShared() && t.owner === me() && hasTrait('defense')) m += 0.1;
    return m;
  }
  function attackMultiplier(fid) { return !isShared() && fid === me() && hasTrait('attack') ? 1.08 : 1; }

  function estimateOdds(fromId, toId, committed) {
    const from = T(fromId), to = T(toId);
    if (!from || !to) return 50;
    const a = committed * attackMultiplier(from.owner) * terrainOf(from).attack;
    const d = to.troops * defenseMultiplier(to);
    return clamp(Math.round(50 + (a - d) * 4), 3, 97);
  }

  function resolveAttack(fromId, toId, committed, opts = {}) {
    const match = state.match;
    if (!match || match.over) return { ok: false, message: 'No active campaign.' };
    const from = T(fromId), to = T(toId);
    if (!from || !to) return { ok: false, message: 'Invalid territory.' };
    const actor = opts.attacker || acting();
    if (from.owner !== actor) return { ok: false, message: 'You do not own the source.' };
    if (to.owner === from.owner) return { ok: false, message: 'Use transfer for your own regions.' };
    if (areAllied(from.owner, to.owner)) return { ok: false, message: 'Allied nation — break the alliance in Diplomacy first.' };
    const link = isAdjacent(fromId, toId);
    if (!link.ok && !opts.force) return { ok: false, message: 'Target is not adjacent (build a Port for sea lanes).' };
    committed = clamp(Math.floor(committed), 1, from.troops - 1);
    if (from.troops < 2) return { ok: false, message: 'Not enough troops to attack.' };

    const beforeDefender = to.owner;
    let atk = committed, def = to.troops;
    const defMul = defenseMultiplier(to);
    const atkMul = attackMultiplier(from.owner);
    const virtualDef = Math.max(1, Math.round(def * defMul));
    let aLosses = 0, dLosses = 0;
    while (atk > 0 && virtualDef - dLosses > 0) {
      const aRolls = Array.from({ length: Math.min(3, atk) }, () => Math.floor(grng() * 6) + 1).sort((x, y) => y - x);
      const dRolls = Array.from({ length: Math.min(2, virtualDef - dLosses) }, () => Math.floor(grng() * 6) + 1).sort((x, y) => y - x);
      for (let i = 0; i < Math.min(aRolls.length, dRolls.length); i++) {
        // attacker advantage from traits / difficulty
        const aVal = aRolls[i] * atkMul * terrainOf(from).attack * (opts.attacker ? DIFFICULTY[match.difficulty].aggression : 1);
        if (aVal > dRolls[i]) { dLosses++; } else { aLosses++; atk--; }
      }
      if (aRolls.length === 0 || dRolls.length === 0) break;
      if (aLosses + dLosses > 500) break; // safety valve for extreme stacks
    }
    const defRemaining = Math.max(0, def - Math.min(def, Math.round(dLosses / defMul)));
    const fromLosses = committed - atk;
    from.troops -= fromLosses;

    // God mode: the owner's regions can never be taken.
    if (defRemaining <= 0 && match.godMode && beforeDefender === match.godFaction) {
      to.troops = Math.max(1, Math.round(from.troops / 2));
      addLog(`GOD MODE absorbed an assault on ${to.name}.`);
      floatText(to, 'SHIELDED', '#f5be4a');
      save(); renderGame();
      return { ok: true, conquered: false, godShield: true, message: 'God mode prevented the loss.' };
    }

    let conquered = false;
    if (defRemaining <= 0) {
      conquered = true;
      const prevOwner = to.owner;
      to.owner = from.owner;
      to.troops = Math.max(1, atk);
      to.defended = 0;
      to.capital = to.capital === prevOwner ? null : to.capital;
      if (prevOwner !== NEUTRAL) {
        const victim = match.factions.find((f) => f.id === prevOwner);
        if (victim && ownedCount(prevOwner) === 0) victim.eliminated = true;
      }
      if (link.kind === 'naval') match.matchStats.naval++;
      match.matchStats.conquests++;
      match.matchStats.kills += fromLosses + dLosses;
      if (actor === me()) {
        if (link.kind === 'naval') { trackEvent('naval'); state.stats.naval++; }
        state.stats.conquests++;
        state.wallet.coins += 18;
        state.stats.xp += 25;
        trackEvent('conquer');
        checkAchievements();
      }
      addLog(`${factionName(from.owner)} captured ${to.name} (${link.kind === 'naval' ? 'naval assault' : 'land assault'}).`);
      floatText(to, 'CAPTURED', '#63e6a4');
      spawnParticles(to, 'capture', factionColor(from.owner));
    } else {
      to.troops = defRemaining;
      addLog(`${factionName(from.owner)} assaulted ${to.name} and lost ${fromLosses} troops (${defRemaining} defenders remain).`);
      floatText(to, `−${dLosses}`, '#ff9aa5');
      spawnParticles(to, 'battle', '#ff6473');
    }
    save(); renderGame(); checkVictory();
    return { ok: true, conquered, aLosses: fromLosses, dLosses, defenderLeft: to.troops, link: link.kind };
  }

  function transferTroops(fromId, toId, amount) {
    const from = T(fromId), to = T(toId);
    if (!from || !to || from.owner !== acting() || to.owner !== acting()) return { ok: false, message: 'Both regions must be yours.' };
    if (!isAdjacent(fromId, toId).ok) return { ok: false, message: 'No route between those regions.' };
    amount = clamp(Math.floor(amount), 1, from.troops - 1);
    if (from.troops < 2) return { ok: false, message: 'Not enough troops to transfer.' };
    from.troops -= amount; to.troops += amount;
    addLog(`Moved ${amount} troops from ${from.name} to ${to.name}.`);
    floatText(to, `+${amount}`, '#56dce2');
    save(); renderGame();
    return { ok: true, amount };
  }

  function buildStructure(id, key) {
    const match = state.match;
    const t = T(id), spec = BUILDINGS[key];
    if (!t || !spec) return { ok: false, message: 'Unknown structure.' };
    if (t.owner !== acting()) return { ok: false, message: 'You can only build on your own territory.' };
    if (!buildingUnlocked(spec)) return { ok: false, message: `Locked — reach ${isShared() ? 'turn ' + spec.level * 2 : 'commander level ' + spec.level}.` };
    if (spec.coastal && !t.coastal) return { ok: false, message: 'Ports require a coastal region.' };
    if (t.buildings[key]) return { ok: false, message: `${spec.name} already built here.` };
    if (!spendBattleCoins(spec.cost)) return { ok: false, message: `Need ${spec.cost} Battle Coins.` };
    t.buildings[key] = true;
    if (key === 'silo') { match.warheads += 2; match.nukeUnlocked = true; }
    state.match.matchStats.buildings++;
    if (isLocalActor()) { state.stats.buildings++; state.stats.xp += 8; trackEvent('build'); }
    addLog(`${spec.name} constructed in ${t.name}.`);
    spawnParticles(t, 'capture', '#f5be4a');
    if (isLocalActor()) checkAchievements();
    save(); renderGame(); renderHeader();
    return { ok: true, message: `${spec.name} online in ${t.name}.` };
  }

  function fortify(id, free = false, turns = 2) {
    const t = T(id);
    if (!t || t.owner !== acting()) return { ok: false, message: 'You can only defend your own territory.' };
    if (!free && !spendBattleCoins(DEFEND_COST)) return { ok: false, message: `Need ${DEFEND_COST} Battle Coins.` };
    t.defended = Math.max(t.defended, turns);
    addLog(`${t.name} fortified (+35% defence for ${turns} turns).`);
    floatText(t, 'FORTIFIED', '#56dce2');
    save(); renderGame(); renderHeader();
    return { ok: true, message: `${t.name} fortified.` };
  }
  function quickDefend(id) {
    const r = performAction({ type: 'fortify', id });
    toast(r.message, r.ok ? 'success' : 'error');
  }

  function nukeUnlocked() {
    if (!state.match) return false;
    const actor = acting();
    const hasSilo = state.match.territories.some((t) => t.owner === actor && t.buildings.silo);
    return state.match.nukeUnlocked || hasSilo || state.match.turn >= 12 || (!isShared() && level() >= 5);
  }
  function buildingUnlocked(spec) {
    return isShared() ? state.match.turn >= spec.level * 2 : level() >= spec.level;
  }
  function launchNuke(id, opts = {}) {
    const match = state.match;
    if (!match || match.over) return { ok: false, message: 'No active campaign.' };
    const target = T(id) || resolveTerritory(id);
    if (!target) return { ok: false, message: `Territory "${id}" not found. Try /reveal.` };
    if (!opts.admin && !nukeUnlocked()) return { ok: false, message: 'Nukes unlock at commander level 5 or turn 12.' };
    if (!opts.free) {
      if (match.warheads < 1) return { ok: false, message: 'No warheads available.' };
      if (!spendBattleCoins(NUKE_COIN_COST)) return { ok: false, message: `Launch requires ${NUKE_COIN_COST} Battle Coins.` };
      match.warheads = Math.max(0, match.warheads - 1);
    }
    // Surface-to-air missiles shield the target AND its neighbours.
    const shield = [target, ...(map.adj[target.id] || []).map((x) => T(x)).filter(Boolean)]
      .find((v) => v.buildings.sam);
    if (shield && !opts.admin) {
      addLog(`△ SAM battery at ${shield.name} intercepted the strike on ${target.name}.`);
      floatText(target, 'INTERCEPTED', '#56dce2');
      save(); renderGame();
      return { ok: true, intercepted: true, target: `${target.name} (${target.id})`, detail: `SAM at ${shield.name} intercepted the warhead.` };
    }
    const victims = [target, ...(map.adj[target.id] || []).map((x) => T(x)).filter(Boolean)];
    victims.forEach((v, i) => {
      if (i === 0) {
        if (match.godMode && v.owner === match.godFaction && !opts.admin) {
          v.troops = Math.max(v.troops, 100);
          addLog(`GOD MODE shielded ${v.name} from the strike.`);
          return;
        }
        v.owner = NEUTRAL;
        v.troops = 1;
        v.buildings = emptyBuildings();
        v.defended = 0;
        v.capital = null;
        v.fallout = 4;
      } else {
        v.troops = Math.max(1, Math.floor(v.troops * 0.45));
        v.fallout = Math.max(v.fallout, 2);
      }
    });
    match.factions.forEach((f) => { if (ownedCount(f.id) === 0) f.eliminated = true; });
    match.matchStats.nukes++;
    if (isLocalActor()) { state.stats.nukes++; state.stats.xp += 20; trackEvent('nuke'); checkAchievements(); }
    addLog(`☢ NUCLEAR STRIKE on ${target.name} — blast radius: ${victims.length} regions, 4 turns of fallout.`);
    spawnParticles(target, 'nuke');
    floatText(target, '☢ STRIKE', '#ff9d5c');
    if (navigator.vibrate) navigator.vibrate([40, 40, 90]);
    save(); renderGame(); renderHeader(); checkVictory();
    return { ok: true, target: `${target.name} (${target.id})`, detail: `${victims.length} regions affected; target reduced to neutral fallout.` };
  }

  function conquerAll() {
    const match = state.match;
    if (!match || match.over) return { ok: false, message: 'No active campaign. Start a match first.', count: 0, percent: 0 };
    const targetCount = Math.ceil(totalTerritories() * 0.8);
    const claimant = acting();
    const sorted = match.territories.slice().sort((a, b) => (a.owner === claimant ? -1 : 1) - (b.owner === claimant ? -1 : 1));
    let changed = 0;
    sorted.forEach((t, i) => {
      if (ownedCount(claimant) >= targetCount) return;
      if (t.owner !== claimant) {
        t.owner = claimant; changed++;
        t.troops = Math.max(t.troops, 14);
        t.fallout = 0; t.defended = 0;
      }
    });
    match.adminTest = true;
    addLog(`[OWNER DECREE] /conquer_all claimed ${changed} regions (80% victory test).`);
    state.stats.xp += 100;
    save(); renderGame(); checkVictory(true);
    return { ok: true, count: ownedCount(claimant), percent: Math.round((ownedCount(claimant) / totalTerritories()) * 100), changed };
  }

  /* ───────────────── 8. AI & TURN CYCLE ─────────────────────────── */
  function clearAiTimers() { aiTimers.forEach(clearTimeout); aiTimers = []; }

  function beginRound() {
    const match = state.match;
    if (!match || match.over) return;
    match.turn++;
    const diff = DIFFICULTY[match.difficulty] || DIFFICULTY.normal;
    const continentGroups = {};
    map.territories.forEach((t) => { (continentGroups[t.continent] ||= []).push(t.id); });

    match.factions.forEach((f) => {
      const owned = match.territories.filter((t) => t.owner === f.id);
      const continentBonus = {};
      Object.entries(continentGroups).forEach(([cid, ids]) => {
        if (ids.length && ids.every((id) => T(id).owner === f.id)) continentBonus[cid] = CONTINENTS.find((c) => c.id === cid).bonus;
      });
      owned.forEach((t) => {
        if (t.fallout > 0) { t.fallout--; }
        else {
          let n = 1 + (t.capital === f.id ? 1 : 0) + (t.buildings.city ? 1 : 0)
            + (t.buildings.factory ? 2 : 0) + terrainOf(t).recruit
            + (continentBonus[t.continent] ? 1 : 0);
          if (f.isAI) n = Math.max(1, Math.round(n * diff.income));
          if (!isShared() && f.id === me() && hasTrait('recruit') && t.buildings.factory) n += 1;
          if (match.godMode && f.id === match.godFaction) n = Math.max(n, 9999 - t.troops);
          t.troops = Math.min(999999, t.troops + n);
        }
        if (t.defended > 0) t.defended--;
      });
      if (isShared() || f.id === me()) {
        const cities = owned.filter((t) => t.buildings.city).length;
        const ports = owned.filter((t) => t.buildings.port).length;
        const allies = (match.alliances || []).filter((k) => k.split('|').includes(f.id)).length;
        const income = 12 + owned.length * 2 + cities * 6 + ports * 2 + allies * 8 + (match.godMode && f.id === match.godFaction ? 500 : 0);
        if (isShared()) f.coins = battleCoins(f.id) + income;
        else state.wallet.coins += income;
        if (f.id !== me()) return;
        state.stats.turns++;
        state.stats.xp += 12;
        trackEvent('turn');
        checkAchievements();
        addLog(isShared() ? `Turn ${match.turn}: reinforcements deployed.` : `Turn ${match.turn}: +${income} Battle Coins, reinforcements deployed.`);
      }
    });

    if (!match.nukeUnlocked && ((!isShared() && level() >= 5) || match.turn >= 12)) {
      match.nukeUnlocked = true;
      match.warheads += 1;
      addLog('☢ Nuclear programme online — warheads are now available.');
      toast('☢ Nuclear weapons unlocked!', 'success');
    } else if (match.nukeUnlocked && match.turn % 6 === 0) {
      match.warheads += 1;
      addLog('Warhead production complete: +1 ☢');
    }
    match.phase = 'player';
    ensureDaily(); save(); renderGame(); renderHeader();
    checkVictory();
  }

  function aiTakeTurn(fid, maxOps) {
    const match = state.match;
    if (!match || match.over) return;
    const diff = DIFFICULTY[match.difficulty] || DIFFICULTY.normal;
    const owned = match.territories.filter((t) => t.owner === fid);
    if (!owned.length) return;
    const options = [];
    owned.forEach((from) => {
      if (from.troops < 4) return;
      const targets = new Set([...(map.adj[from.id] || []), ...((from.buildings.port && (map.naval[from.id] || []).map((n) => n.id)) || [])]);
      targets.forEach((id) => {
        const to = T(id);
        if (!to || to.owner === fid || areAllied(fid, to.owner)) return;
        const need = to.troops * defenseMultiplier(to) * diff.threshold;
        if (from.troops - 1 < need) return;
        const value = (from.troops - 1 - need) + (to.capital ? 4 : 0)
          + (to.buildings.city ? 2 : 0) + (to.owner === NEUTRAL ? 1.5 : 0) + grng() * 2;
        options.push({ from: from.id, to: id, score: value });
      });
      // AI also uses sea lanes when it controls a port, and may build one.
      if (!from.buildings.port && from.coastal && match.turn > 4 && grng() < 0.12) from.buildings.port = true;
      if (!from.buildings.factory && match.turn > 3 && grng() < 0.08) from.buildings.factory = true;
    });
    options.sort((a, b) => b.score - a.score);
    let attacks = 0;
    const opCap = maxOps === undefined ? diff.attacks : maxOps;
    for (const opt of options) {
      if (attacks >= opCap) break;
      const from = T(opt.from);
      if (!from || from.owner !== fid || from.troops < 2) continue;
      const res = resolveAttack(opt.from, opt.to, from.troops - 1, { attacker: fid });
      if (res.ok) attacks++;
      if (state.match.over) return;
    }
    // Late-game AI nuclear deterrence on harder settings.
    if (match.turn > 14 && ['hard', 'insane'].includes(match.difficulty) && grng() < 0.22) {
      const humanIds = match.factions.filter((f) => !f.isAI).map((f) => f.id);
      const strongest = match.territories.filter((t) => humanIds.includes(t.owner)).sort((a, b) => b.troops - a.troops)[0];
      if (strongest) {
        strongest.troops = Math.max(1, Math.floor(strongest.troops * 0.4));
        strongest.fallout = 2;
        addLog(`${factionName(fid)} launched a tactical strike on ${strongest.name}!`);
        spawnParticles(strongest, 'nuke');
      }
    }
    if (attacks) addLog(`${factionName(fid)} launched ${attacks} operation${attacks > 1 ? 's' : ''}.`);
    else addLog(`${factionName(fid)} regrouped and reinforced.`);
  }

  /* Real-time mode: one sequenced tick, identical on every device.
     The host emits these at a fixed interval; offline a local timer does
     the same. Only small command packets travel over the network — never
     a full world snapshot — which keeps 20 nations smooth on a phone. */
  function realtimeTick() {
    const match = state.match;
    if (!match || match.over) return { ok: true };
    const diff = DIFFICULTY[match.difficulty] || DIFFICULTY.normal;
    match.turn++;
    const ownedByFaction = {};
    match.territories.forEach((t) => {
      (ownedByFaction[t.owner] ||= []).push(t);
      if (t.fallout > 0) { t.fallout--; return; }
      if (t.owner === NEUTRAL) return;
      let n = 1 + (t.capital === t.owner ? 1 : 0) + (t.buildings.city ? 1 : 0)
        + (t.buildings.factory ? 2 : 0) + terrainOf(t).recruit;
      const f = match.factions.find((x) => x.id === t.owner);
      if (f && f.isAI) n = Math.max(1, Math.round(n * diff.income));
      if (match.godMode && t.owner === match.godFaction) n = Math.max(n, 9999 - t.troops);
      t.troops = Math.min(999999, t.troops + n);
      if (t.defended > 0) t.defended--;
    });
    // AI tribes act on the same tick — deterministic grng(), no local timers.
    match.factions.filter((f) => f.isAI && !f.eliminated).forEach((f) => {
      if (!match.over) aiTakeTurn(f.id, match.tickMs <= 1000 ? 1 : 2);
    });
    if (isShared()) match.factions.forEach((f) => {
      const owned = ownedByFaction[f.id] || [];
      if (!owned.length) return;
      const allies = (match.alliances || []).filter((k) => k.split('|').includes(f.id)).length;
      const cities = owned.filter((t) => t.buildings.city).length;
      const ports = owned.filter((t) => t.buildings.port).length;
      f.coins = battleCoins(f.id) + 6 + owned.length + allies * 4 + cities * 6 + ports * 2;
    });
    const owned = ownedByFaction[me()] || [];
    if (owned.length) {
      const allies = (match.alliances || []).filter((k) => k.split('|').includes(me())).length;
      const income = 6 + owned.length + allies * 4 + owned.filter((t) => t.buildings.city).length * 6 + owned.filter((t) => t.buildings.port).length * 2;
      if (!isShared()) state.wallet.coins += income;
      state.stats.turns++;
      state.stats.xp += 4;
      trackEvent('turn');
      checkAchievements();
    }
    if (!match.nukeUnlocked && match.turn >= 12) {
      match.nukeUnlocked = true;
      match.warheads += 1;
      addLog('☢ Nuclear programme online — warheads are now available.');
    } else if (match.nukeUnlocked && match.turn % 10 === 0) {
      match.warheads += 1;
    }
    match.phase = 'player';
    ensureDaily(); save(); renderGame(); renderHeader(); checkVictory();
    return { ok: true };
  }

  function endTurn() {
    const match = state.match;
    if (!match || match.over || match.phase !== 'player') return;
    clearAiTimers();
    match.phase = 'ai';
    ui.selected = null; ui.target = null; ui.inspect = null;
    addLog('Enemy commands are moving…');
    renderGame(); save();
    const aiFactions = match.factions.filter((f) => f.isAI && !f.eliminated);
    aiFactions.forEach((f, i) => {
      aiTimers.push(setTimeout(() => {
        if (!state.match || state.match !== match || match.over) return;
        aiTakeTurn(f.id);
        renderGame();
        if (navigator.vibrate) navigator.vibrate(10);
      }, 320 * (i + 1)));
    });
    aiTimers.push(setTimeout(() => {
      if (state.match !== match || match.over) return;
      beginRound();
      toast(`Turn ${match.turn} · your move`, 'success');
    }, 320 * (aiFactions.length + 1) + 120));
    return { ok: true };
  }

  /* ─────────── SHARED-MATCH LOCKSTEP COMMAND LAYER ───────────
     Every order is a small action object. Offline it is applied instantly;
     in an online match it is sequenced by the relay and replayed identically
     on every device (deterministic RNG, no hidden local advantages).        */
  function performAction(action, opts = {}) {
    const match = state.match;
    if (!match || match.over) return { ok: false, message: 'No active campaign.' };
    const full = { ...action, intentId: uid('a'), faction: action.faction || acting(), by: (lobby && lobby.selfId) || 'local' };
    if (isShared() && !opts.remote) {
      if (!lobby || !lobby.state.room) return { ok: false, message: 'Room unavailable. Rejoin to continue.' };
      if (lobby.sendGameIntent(full)) {
        // Client-side prediction: mark the target instantly so the tap feels
        // immediate; authoritative state arrives as a sequenced delta.
        ui.pending = { id: full.to || full.id || null, at: performance.now() };
        renderGame();
        return { ok: true, queued: true, message: 'Order broadcast to all commanders.' };
      }
      return { ok: false, message: 'Connection lost. Orders are paused until the relay reconnects.' };
    }
    return applyGameAction(full);
  }

  function applyGameAction(action, seq) {
    const match = state.match;
    if (!match || match.over) return { ok: false, message: 'No active campaign.' };
    if (seq !== undefined) {
      if (seq <= (match.seq || 0)) return { ok: true, duplicate: true };
      if (seq > (match.seq || 0) + 1) {
        if (lobby) lobby.requestGameState();
        return { ok: true, buffered: true };
      }
    }
    match.actingFaction = action.faction || me();
    let result;
    switch (action.type) {
      case 'attack': result = resolveAttack(action.from, action.to, action.troops); break;
      case 'transfer': result = transferTroops(action.from, action.to, action.amount); break;
      case 'build': result = buildStructure(action.id, action.key); break;
      case 'fortify': result = fortify(action.id); break;
      case 'nuke': result = launchNuke(action.id); break;
      case 'end_turn': result = endTurn(); break;
      case 'tick': result = realtimeTick(); break;
      case 'alliance': result = setAlliance(action.faction, action.target, !!action.value); break;
      case 'admin_nuke': result = launchNuke(action.id, { admin: true, free: true }); break;
      case 'admin_conquer': result = conquerAll(); break;
      case 'admin_spawn': result = applySpawnTroops(action.id, action.amount); break;
      case 'admin_god': {
        const on = !!action.value;
        match.godMode = on;
        match.godFaction = on ? (action.faction || me()) : null;
        if (on) match.territories.filter((t) => t.owner === match.godFaction).forEach((t) => { t.troops = Math.max(t.troops, 9999); });
        addLog(`[OWNER] God mode ${on ? 'enabled' : 'disabled'}.`);
        result = { ok: true };
        break;
      }
      case 'admin_turn':
        match.turn = action.n;
        if (action.n >= 12) match.nukeUnlocked = true;
        addLog(`[OWNER] Turn set to ${action.n}.`);
        result = { ok: true };
        break;
      case 'admin_warheads':
        match.warheads = action.n;
        match.nukeUnlocked = true;
        result = { ok: true };
        break;
      case 'admin_end':
        showVictory(action.outcome);
        result = { ok: true };
        break;
      default: result = { ok: false, message: `Unknown order: ${action.type}` };
    }
    match.actingFaction = null;
    ui.pending = null;
    match.seq = seq === undefined ? (match.seq || 0) + 1 : seq;
    save();
    return result || { ok: true };
  }

  function checkVictory(force = false) {
    const match = state.match;
    if (!match || match.over) return;
    const mine = ownedCount(me());
    const total = totalTerritories();
    // In a shared match every other faction (human or AI) is a rival.
    const rivals = match.factions.filter((f) => f.id !== me() && !areAllied(me(), f.id) && ownedCount(f.id) > 0);
    const alliedLand = match.factions.filter((f) => f.id !== me() && areAllied(me(), f.id))
      .reduce((n, f) => n + ownedCount(f.id), 0);
    let outcome = null;
    if (mine === 0) outcome = 'defeat';
    else if ((mine + alliedLand) / total >= 0.8 || rivals.length === 0 || force && mine / total >= 0.8) outcome = 'victory';
    else {
      const dominant = match.factions.find((f) => f.id !== me() && ownedCount(f.id) / total >= 0.8);
      if (dominant) outcome = 'defeat';
    }
    if (outcome) showVictory(outcome);
  }

  function showVictory(outcome) {
    const match = state.match;
    if (!match || match.over) return;
    match.over = true;
    match.winner = outcome === 'victory' ? me() : 'rival';
    const win = outcome === 'victory';
    const gems = win ? 60 + Math.min(40, match.turn) : 10;
    const coins = win ? 250 + match.turn * 12 : 80;
    const xp = win ? 150 : 40;
    state.wallet.gems += gems;
    state.wallet.coins += coins;
    state.stats.xp += xp;
    state.stats[win ? 'wins' : 'losses']++;
    if (win) trackEvent('win');
    checkAchievements();
    ensureDaily(); save();

    const sec = $('screen-victory');
    sec.classList.toggle('defeat', !win);
    $('victoryEmblem').textContent = win ? '★' : '☠';
    $('victoryEyebrow').textContent = match.adminTest ? 'OWNER VICTORY TEST · 80% DOMINATION' : (win ? 'WORLD DOMINATION' : 'CAMPAIGN LOST');
    $('victoryTitle').textContent = win ? 'VICTORY' : 'DEFEAT';
    $('victorySub').textContent = win
      ? `${factionName(me())} controls the world. Developed by CoMeBacK_49.`
      : 'Your banner has fallen. Regroup and try a new strategy.';
    $('victoryStats').innerHTML = `
      <div><b>${match.turn}</b><small>TURNS</small></div>
      <div><b>${ownedCount(me())}/${totalTerritories()}</b><small>REGIONS</small></div>
      <div><b>${match.matchStats.conquests}</b><small>CONQUESTS</small></div>`;
    $('victoryRewards').innerHTML = `
      <span>◆ +${gems} GEMS</span><span>◉ +${coins} COINS</span><span>✦ +${xp} XP</span>`;
    showScreen('victory');
    startVictoryAnimation(win ? state.cosmetics.equipped.victories : 'defeat');
  }

  /* ────────────── PROGRESSION / REWARDS / CHALLENGES ─────────────── */
  function ensureDaily() {
    const key = dateKey();
    if (state.daily.date === key && state.daily.items.length) return;
    const rnd = mulberry32(hashSeed('daily-' + key));
    const items = shuffle(DAILY_POOL, rnd).slice(0, 3).map((it) => ({ ...it, progress: 0, claimed: false }));
    state.daily = { date: key, items, freeGemsClaimed: false };
    save();
  }
  function trackEvent(name, amount = 1) {
    ensureDaily();
    let changed = false;
    state.daily.items.forEach((it) => {
      if (it.event === name && !it.claimed) {
        it.progress = Math.min(it.goal, it.progress + amount);
        changed = true;
      }
    });
    if (changed) save();
  }
  function claimDaily(id) {
    const it = state.daily.items.find((x) => x.id === id);
    if (!it || it.claimed || it.progress < it.goal) return;
    it.claimed = true;
    state.wallet.coins += it.reward.coins;
    state.wallet.gems += it.reward.gems;
    state.stats.xp += 20;
    toast(`Challenge complete: +${it.reward.coins} coins, +${it.reward.gems} gems`, 'success');
    save(); refreshAll();
  }

  function ownedKeys() {
    const set = new Set(state.cosmetics.owned || []);
    Object.entries(COSMETICS).forEach(([type, list]) => list.forEach((item) => {
      const u = item.unlock || { type: 'free' };
      if (u.type === 'free') set.add(`${type}:${item.id}`);
      if (u.type === 'milestone' && state.achievements.includes(u.id)) set.add(`${type}:${item.id}`);
      if (u.type === 'playtime' && state.playtime.claimed.includes(u.tier)) set.add(`${type}:${item.id}`);
      if (u.type === 'owner' && isOwnerProfile()) set.add(`${type}:${item.id}`);
    }));
    return set;
  }
  function isOwned(type, id) { return ownedKeys().has(`${type}:${id}`); }
  function unlock(type, id) {
    const key = `${type}:${id}`;
    if (state.cosmetics.owned.includes(key)) return { ok: true, message: 'Already owned.' };
    const item = COSMETICS[type].find((x) => x.id === id);
    if (!item) return { ok: false, message: 'Item not found.' };
    const u = item.unlock || { type: 'free' };
    if (u.type === 'owner') return { ok: false, message: 'Exclusive to CoMeBacK_49.' };
    if (u.type === 'milestone' || u.type === 'playtime') return { ok: false, message: 'Unlocked automatically by play milestones.' };
    if (u.type === 'coins') {
      if (state.wallet.coins < u.cost) return { ok: false, message: `Need ${u.cost} Battle Coins.` };
      state.wallet.coins -= u.cost;
    }
    if (u.type === 'gems') {
      if (state.wallet.gems < u.cost) return { ok: false, message: `Need ${u.cost} Gems.` };
      state.wallet.gems -= u.cost;
    }
    state.cosmetics.owned.push(key);
    checkAchievements(); save(); refreshAll();
    return { ok: true, message: `${item.name} unlocked!` };
  }
  function equip(type, id) {
    if (!isOwned(type, id)) return { ok: false, message: 'Locked item.' };
    state.cosmetics.equipped[type] = id;
    if (type === 'colors' && state.match) {
      const f = state.match.factions.find((x) => x.id === me());
      const th = theme();
      if (f) { f.name = th.name; f.color = th.primary; f.light = th.light; }
    }
    save(); refreshAll();
    return { ok: true, message: `${COSMETICS[type].find((x) => x.id === id).name} equipped.` };
  }

  function checkAchievements() {
    const s = state.stats;
    const conditions = {
      first_blood: s.conquests >= 1,
      empire: state.match && ownedCount(me()) >= 20,
      warmonger: s.conquests >= 50,
      victor: s.wins >= 1,
      architect: s.buildings >= 10,
      nuclear: s.nukes >= 1,
      admiral: s.naval >= 1,
      collector: ownedKeys().size >= 8,
      loyal: s.turns >= 40
    };
    let changed = false;
    ACHIEVEMENTS.forEach((a) => {
      if (!state.achievements.includes(a.id) && conditions[a.id]) {
        state.achievements.push(a.id);
        if (a.reward.coins) state.wallet.coins += a.reward.coins;
        if (a.reward.gems) state.wallet.gems += a.reward.gems;
        toast(`★ Achievement: ${a.name}`, 'success');
        changed = true;
      }
    });
    if (changed) save();
  }

  function claimPlaytime(tierId) {
    const tier = PLAYTIME_TIERS.find((t) => t.id === tierId);
    if (!tier || state.playtime.claimed.includes(tierId)) return;
    if (minutes(state.stats.playtimeMs) < tier.minutes) return;
    state.playtime.claimed.push(tierId);
    tier.rewards.forEach((r) => {
      if (r.coins) state.wallet.coins += r.coins;
      if (r.gems) state.wallet.gems += r.gems;
      if (r.type && r.type !== 'trait') {
        const key = `${r.type}:${r.id}`;
        if (!state.cosmetics.owned.includes(key)) state.cosmetics.owned.push(key);
      }
    });
    const desc = tier.rewards.map((r) => r.type === 'trait' ? TRAITS.find((t) => t.id === r.id).name : COSMETICS[r.type]?.find((x) => x.id === r.id)?.name || `${r.coins || r.gems} ${r.coins ? 'coins' : 'gems'}`).join(', ');
    toast(`✦ Reward claimed: ${desc}`, 'success');
    checkAchievements(); save(); refreshAll();
  }

  function tickPlaytime() {
    const now = Date.now();
    const delta = clamp(now - (state.stats.lastActive || now), 0, 30000);
    state.stats.lastActive = now;
    if (document.visibilityState === 'visible') {
      state.stats.playtimeMs += delta;
      if ((toastTimer++ % 6) === 0) save();
      if (ui.screen === 'home' || ui.screen === 'vault') renderPlaytimeBits();
    }
  }

  /* ───────────────────── 9. UI / SCREENS ────────────────────────── */
  function showScreen(name) {
    ui.screen = name;
    document.body.dataset.screen = name;
    $$('.screen').forEach((sec) => sec.classList.toggle('active', sec.id === `screen-${name}`));
    $('topBar').hidden = name === 'title' || name === 'victory';
    $('bottomNav').hidden = ['title', 'game', 'victory'].includes(name);
    document.body.classList.toggle('toast-active', name === 'game' && $('toastStack').children.length > 0);
    $$('.bottom-nav button').forEach((b) => b.classList.toggle('active', b.dataset.nav === name));
    if (name === 'game') {
      resizeCanvas();
      $('mapHint').classList.remove('faded');
      setTimeout(fadeHint, 6500);
      renderGame();
    }
    renderScreen(name);
    window.scrollTo(0, 0);
  }
  function renderScreen(name) {
    renderHeader();
    switch (name) {
      case 'home': renderHome(); break;
      case 'setup': renderSetup(); break;
      case 'store': renderStore(); break;
      case 'vault': renderVault(); break;
      case 'lobby': renderLobby(); break;
      case 'admin': renderAdmin(); break;
      case 'game': renderGame(); break;
      case 'title': renderTitle(); break;
    }
  }
  function refreshAll() {
    renderHeader();
    renderScreen(ui.screen);
    draw();
  }

  function renderTitle() {
    const active = state.match && !state.match.over;
    $('btnPlayLabel').textContent = active ? 'CONTINUE CAMPAIGN' : 'PLAY NOW';
  }

  function renderHeader() {
    $('gemCount').textContent = fmt(state.wallet.gems);
    $('coinCount').textContent = fmt(state.wallet.coins);
    $('levelChip').textContent = level();
    const net = $('netBadge');
    const online = navigator.onLine !== false;
    const lobbyMode = lobby ? lobby.state.mode : 'sim';
    const live = lobbyMode === 'ws' || lobbyMode === 'mesh';
    net.classList.toggle('offline', !online);
    net.classList.toggle('online', online && live);
    $('netLabel').textContent = !online ? 'OFFLINE MODE'
      : live ? (lobbyMode === 'mesh' ? 'PUBLIC RELAY' : 'RELAY ONLINE')
        : 'OFFLINE READY';
  }

  function renderHome() {
    $('homeGreeting').textContent = `Welcome, ${state.profile.name}`;
    $('homeLevel').textContent = level();
    const xpInLevel = state.stats.xp % 150;
    $('xpLabel').textContent = `${xpInLevel} / 150 XP`;
    $('xpBar').style.width = `${(xpInLevel / 150) * 100}%`;
    const nextUnlock = level() < 2 ? 'Ports at level 2' : level() < 3 ? 'Factories at level 3'
      : level() < 5 ? 'Nuclear programme at level 5' : 'All strategic options unlocked';
    $('xpNext').textContent = `Next unlock: ${nextUnlock}`;
    $('statMatches').textContent = fmt(state.stats.matches);
    $('statWins').textContent = fmt(state.stats.wins);
    $('statTerritories').textContent = fmt(state.stats.conquests);
    $('statPlaytime').textContent = playtimeLabel(state.stats.playtimeMs);

    const active = state.match && !state.match.over;
    $('continueTitle').textContent = active
      ? `Campaign · ${state.match.mode === 'online' ? 'Online lobby' : 'Offline'} · Turn ${state.match.turn}`
      : state.match ? 'Campaign complete' : 'No active campaign';
    $('continueSub').textContent = active
      ? `${ownedCount(me())} regions held · ${state.match.factions.length - 1} rivals · ${DIFFICULTY[state.match.difficulty].label} AI`
      : 'Start a new conquest against AI commanders';
    $('btnContinue').textContent = active ? 'RESUME' : 'NEW GAME';

    ensureDaily();
    $('dailyList').innerHTML = state.daily.items.map((it) => {
      const done = it.progress >= it.goal;
      return `<div class="list-item ${it.claimed ? 'done' : ''}">
        <span class="list-badge">${it.icon}</span>
        <div class="grow"><strong>${esc(it.title)}</strong><small>${esc(it.desc)} · ◆ ${it.reward.gems} · ◉ ${it.reward.coins}</small>
          <div class="mini-bar"><i style="width:${Math.min(100, (it.progress / it.goal) * 100)}%"></i></div></div>
        <button class="btn btn-sm ${done && !it.claimed ? 'btn-primary' : 'btn-ghost'}" data-claim-daily="${it.id}" ${done && !it.claimed ? '' : 'disabled'}>${it.claimed ? '✓' : `${it.progress}/${it.goal}`}</button>
      </div>`;
    }).join('');
    renderPlaytimeBits();
  }

  function renderPlaytimeBits() {
    const mins = minutes(state.stats.playtimeMs);
    const next = PLAYTIME_TIERS.find((t) => !state.playtime.claimed.includes(t.id)) || PLAYTIME_TIERS[PLAYTIME_TIERS.length - 1];
    const prev = PLAYTIME_TIERS[PLAYTIME_TIERS.indexOf(next) - 1];
    const from = prev ? prev.minutes : 0;
    const pct = clamp(((mins - from) / Math.max(1, next.minutes - from)) * 100, 0, 100);
    $('playtimeNext').textContent = `Next: ${next.name} (${next.minutes} min)`;
    $('playtimeLabel').textContent = `${mins} / ${next.minutes} min`;
    $('playtimeBar').style.width = `${pct}%`;
    $('playtimePreview').innerHTML = next.rewards.map((r) => {
      const label = r.type === 'trait' ? TRAITS.find((x) => x.id === r.id).name
        : COSMETICS[r.type]?.find((x) => x.id === r.id)?.name || `${r.coins || r.gems} ${r.coins ? 'Coins' : 'Gems'}`;
      return `<span class="reward-tag">✦ ${esc(label)}</span>`;
    }).join('');
    if ($('vaultPlaytime')) $('vaultPlaytime').textContent = playtimeLabel(state.stats.playtimeMs);
    if ($('vaultPlaytimeBar')) $('vaultPlaytimeBar').style.width = `${pct}%`;
  }

  function renderSetup() {
    const colorSel = $('setupColor');
    const skinSel = $('setupSkin');
    const owned = ownedKeys();
    colorSel.innerHTML = COLOR_THEMES.filter((c) => owned.has(`colors:${c.id}`))
      .map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
    skinSel.innerHTML = MAP_SKINS.filter((s) => owned.has(`skins:${s.id}`))
      .map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
    colorSel.value = state.cosmetics.equipped.colors;
    skinSel.value = state.cosmetics.equipped.skins;
    $$('#difficultyGroup button').forEach((b) => b.classList.toggle('active', b.dataset.difficulty === state.settings.difficulty));
    $$('#speedGroup button').forEach((b) => b.classList.toggle('active', b.dataset.speed === (state.settings.realtime || 'off')));
    $('botRange').value = state.settings.bots;
    $('botCount').textContent = state.settings.bots;
    $('profileName').value = state.profile.name;
    const diff = DIFFICULTY[state.settings.difficulty];
    $('setupSummary').innerHTML = `
      <div><small>WORLD</small><b>${map ? map.territories.length : 0} regions · 7 continents</b></div>
      <div><small>RIVALS</small><b>${state.settings.bots} AI factions</b></div>
      <div><small>DIFFICULTY</small><b>${diff.label} · ${diff.attacks} ops/turn</b></div>
      <div><small>BATTLE SPEED</small><b>${(REALTIME[state.settings.realtime] || REALTIME.off).label}</b></div>
      <div><small>DEPLOYMENT</small><b>${Math.round(deployRatio() * 100)}% · Q / E</b></div>
      <div><small>STARTING ARSENAL</small><b>1 ☢ warhead · ${fmt(state.wallet.coins)} coins</b></div>`;
  }

  function shopCard(item, kind, extra = {}) {
    const price = item.price ? `<span class="price">${item.price}</span>`
      : item.gems ? `<span class="price gem">◆ ${item.gems}</span>`
        : `<span class="price">◉ ${item.coins || ''}</span>`;
    return `<div class="shop-card ${item.featured ? 'featured' : ''}">
      <div class="shop-art ${extra.art || ''}">${item.glyph || '◆'}</div>
      <strong>${esc(item.name)}</strong>
      <small>${esc(item.desc || (item.gems ? `+${item.gems} Gems (simulated IAP)` : `+${fmt(item.coins || 0)} Battle Coins`))}</small>
      <div class="price-row">${price}<button class="btn ${extra.primary ? 'btn-primary' : 'btn-ghost'}" data-buy="${kind}:${item.id}" type="button">${extra.button || 'GET'}</button></div>
    </div>`;
  }

  function renderStore() {
    $('iapGrid').innerHTML = SHOP.iap.map((x) => shopCard(x, 'iap', { art: 'gem', primary: true, button: 'BUY' })).join('');
    $('coinGrid').innerHTML = SHOP.coins.map((x) => shopCard({
      ...x, desc: `+${fmt(x.coins)} Battle Coins`, price: `◆ ${x.gems} Gems`
    }, 'coins', { art: 'coin' })).join('');
    $('supplyGrid').innerHTML = SHOP.supplies.map((x) => shopCard({
      ...x, price: `◉ ${x.coins}`, desc: `${x.desc}${x.gems ? ` Or ◆ ${x.gems} Gems.` : ''}`
    }, 'supply', { art: 'war' })).join('');
    $('bundleGrid').innerHTML = SHOP.bundles.map((x) => shopCard({ ...x, gems: x.gems }, 'bundle', { art: 'gem', primary: true })).join('');
    $('btnFreeGems').disabled = state.daily.freeGemsClaimed;
    $('btnFreeGems').textContent = state.daily.freeGemsClaimed ? 'CLAIMED TODAY ✓' : 'CLAIM +15 ◆';
  }

  function renderVault() {
    $$('#vaultTabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === ui.vaultTab));
    const tab = ui.vaultTab;
    const owned = ownedKeys();
    let html = '';
    if (tab === 'traits') {
      html = TRAITS.map((tr) => {
        const active = hasTrait(tr.id);
        const tier = PLAYTIME_TIERS.find((t) => t.rewards.some((r) => r.type === 'trait' && r.id === tr.id));
        return `<div class="vault-card ${active ? 'equipped' : 'locked'}">
          <div class="vault-preview">${tr.glyph}</div><strong>${esc(tr.name)}</strong>
          <small>${esc(tr.desc)}</small>
          <button class="btn btn-ghost" disabled>${active ? '✓ ACTIVE (PASSIVE)' : `PLAYTIME ${tier.minutes} MIN`}</button></div>`;
      }).join('');
    } else {
      const list = COSMETICS[tab] || [];
      html = list.map((item) => {
        const key = `${tab}:${item.id}`;
        const isEquipped = state.cosmetics.equipped[tab] === item.id;
        const has = owned.has(key);
        const u = item.unlock || { type: 'free' };
        let req = 'Available';
        if (u.type === 'coins') req = `◉ ${u.cost} Battle Coins`;
        if (u.type === 'gems') req = `◆ ${u.cost} Gems`;
        if (u.type === 'milestone') req = `Achievement: ${ACHIEVEMENTS.find((a) => a.id === u.id)?.name || u.id}`;
        if (u.type === 'playtime') req = `Playtime: ${PLAYTIME_TIERS.find((t) => t.id === u.tier)?.minutes} min`;
        if (u.type === 'owner') req = 'Exclusive: CoMeBacK_49';
        let preview;
        if (tab === 'colors') preview = `<div class="swatch-row"><i style="background:${item.dark}"></i><i style="background:${item.primary}"></i><i style="background:${item.light}"></i></div>`;
        else if (tab === 'skins') preview = `<div style="width:100%;height:100%;border-radius:10px;background:linear-gradient(135deg,${item.ocean},${item.land},${item.ocean2})"></div>`;
        else preview = item.glyph;
        const button = isEquipped ? '<button class="btn btn-ghost" disabled>✓ EQUIPPED</button>'
          : has ? `<button class="btn btn-primary" data-equip="${tab}:${item.id}">EQUIP</button>`
            : (u.type === 'coins' || u.type === 'gems')
              ? `<button class="btn btn-ghost" data-unlock="${tab}:${item.id}">UNLOCK · ${req}</button>`
              : `<button class="btn btn-ghost" disabled>⌘ ${req}</button>`;
        return `<div class="vault-card ${isEquipped ? 'equipped' : has ? '' : 'locked'}">
          <div class="vault-preview">${preview}</div><strong>${esc(item.name)}</strong>
          <small>${esc(item.desc || '')}<br>${has ? '✓ Owned' : esc(req)}</small>${button}</div>`;
      }).join('');
    }
    $('vaultGrid').innerHTML = html;
    renderPlaytimeBits();
    $('playtimeList').innerHTML = PLAYTIME_TIERS.map((tier) => {
      const claimed = state.playtime.claimed.includes(tier.id);
      const unlocked = minutes(state.stats.playtimeMs) >= tier.minutes;
      const labels = tier.rewards.map((r) => r.type === 'trait' ? TRAITS.find((x) => x.id === r.id).name
        : COSMETICS[r.type]?.find((x) => x.id === r.id)?.name || `${r.coins || r.gems} ${r.coins ? 'coins' : 'gems'}`).join(' · ');
      return `<div class="list-item ${claimed ? 'done' : unlocked ? '' : 'locked'}">
        <span class="list-badge">${claimed ? '✓' : unlocked ? '✦' : '◎'}</span>
        <div class="grow"><strong>${esc(tier.name)} · ${tier.minutes} min</strong><small>${esc(labels)}</small></div>
        <button class="btn btn-sm ${unlocked && !claimed ? 'btn-primary' : 'btn-ghost'}" data-claim-playtime="${tier.id}" ${unlocked && !claimed ? '' : 'disabled'}>${claimed ? '✓' : 'CLAIM'}</button></div>`;
    }).join('');
    $('achievementList').innerHTML = ACHIEVEMENTS.map((a) => {
      const got = state.achievements.includes(a.id);
      return `<div class="list-item ${got ? 'done' : 'locked'}"><span class="list-badge">${got ? a.glyph : '⌘'}</span>
        <div class="grow"><strong>${esc(a.name)}</strong><small>${esc(a.desc)} · ◆ ${a.reward.gems || 0} / ◉ ${a.reward.coins || 0}</small></div>
        <b style="font-size:11px;color:${got ? 'var(--green)' : 'var(--muted-2)'}">${got ? 'UNLOCKED' : 'LOCKED'}</b></div>`;
    }).join('');
  }

  function renderGame() {
    updateDeployUI();
    if (!state.match) return;
    const match = state.match;
    $('btnEndTurn').innerHTML = match.tickMs > 0 ? 'FORCE TICK <span>▶</span>' : 'END TURN <span>▶</span>';
    const mine = ownedCount(me());
    const troops = match.territories.filter((t) => t.owner === me()).reduce((a, t) => a + t.troops, 0);
    $('gamePhase').textContent = match.over ? 'CAMPAIGN COMPLETE'
      : match.tickMs > 0 ? `LIVE T${match.turn} · ${(REALTIME[match.realtime] || REALTIME.off).label}`
        : match.phase === 'ai' ? `TURN ${match.turn} · ENEMY MOVES`
          : `TURN ${match.turn} · YOUR MOVE`;
    $('gameSummary').textContent = `${mine}/${totalTerritories()} regions · ${fmt(troops)} troops · ${isShared() ? '◉ ' + fmt(battleCoins(me())) + ' treasury' : DIFFICULTY[match.difficulty].label + ' AI'}`;
    $('warheadChip').innerHTML = `☢ <b>${match.warheads}</b>`;
    $('btnCommand').hidden = !(admin && admin.isUnlocked());

    const t = ui.selected ? T(ui.selected) : ui.target ? T(ui.target) : ui.inspect ? T(ui.inspect) : null;
    const card = $('selectionCard');
    if (t) {
      card.hidden = false;
      const structs = Object.entries(t.buildings).filter(([, v]) => v).map(([k]) => `${BUILDINGS[k].glyph} ${BUILDINGS[k].name}`);
      if (t.capital) structs.unshift('★ Capital');
      if (t.fallout > 0) structs.push(`☢ Fallout ${t.fallout}`);
      if (t.defended > 0) structs.push(`⬟ Fortified ${t.defended}`);
      card.innerHTML = `<div class="sel-title" style="color:${factionColor(t.owner)}">${esc(t.name)}<span class="sel-id">${t.id}</span></div>
        <div class="sel-line"><span>Owner</span><b>${esc(factionName(t.owner))}</b></div>
        <div class="sel-line"><span>Troops</span><b>${fmt(t.troops)}</b></div>
        <div class="sel-line"><span>Continent</span><b>${esc(t.continentName)}</b></div>
        <div class="sel-line"><span>Routes</span><b>${(map.adj[t.id] || []).length} land${t.coastal ? ` · ${(map.naval[t.id] || []).length} sea` : ''}</b></div>
        <div class="sel-tags">${(structs.length ? structs : ['No structures']).map((s) => `<span class="mini-tag">${esc(s)}</span>`).join('')}</div>`;
    } else card.hidden = true;

    const latest = match.log[match.log.length - 1];
    if (latest) { $('eventTicker').hidden = false; $('eventTicker').textContent = latest.text; }
    else $('eventTicker').hidden = true;

    $('mapLegend').innerHTML = match.factions.slice(0, 8).map((f) =>
      `<div class="legend-row"><i class="legend-swatch" style="background:${f.color}"></i>${esc(f.name)} ${ownedCount(f.id)}</div>`).join('')
      + (match.factions.length > 8 ? `<div class="legend-row">+${match.factions.length - 8} more nations</div>` : '')
      + `<div class="legend-row"><i class="legend-swatch" style="background:${skin().neutral}"></i>Neutral ${ownedCount(NEUTRAL)}</div>`;

    const sel = ui.selected ? T(ui.selected) : null;
    const target = ui.target ? T(ui.target) : null;
    const link = sel && target ? isAdjacent(sel.id, target.id) : { ok: false };
    const canAttack = !!(sel && target && sel.owner === me() && target.owner !== me() && link.ok && sel.troops > 1 && !match.over && match.phase === 'player');
    const canTransfer = !!(sel && target && sel.owner === me() && target.owner === me() && link.ok && sel.troops > 1 && !match.over && match.phase === 'player');
    const canBuild = !!(sel && sel.owner === me() && !match.over);
    const canDefend = canBuild && match.phase === 'player';
    const canNuke = !!(match && !match.over && nukeUnlocked() && match.warheads > 0 && battleCoins(me()) >= NUKE_COIN_COST && (target || sel));
    const buttons = { attack: canAttack, transfer: canTransfer, defend: canDefend, build: canBuild, nuke: canNuke, info: !!(sel || target || ui.inspect), diplomacy: !match.over };
    $$('#actionRow .action').forEach((b) => {
      const a = b.dataset.action;
      b.disabled = !buttons[a];
      b.classList.toggle('hot', a === 'attack' && canAttack || a === 'nuke' && canNuke);
    });
    $('btnEndTurn').disabled = match.over || match.phase !== 'player';

    let title = 'Select a territory', sub = 'Your empire awaits orders, Commander.';
    if (sel && target) {
      title = `${sel.name} → ${target.name}`;
      sub = link.ok
        ? (canAttack ? `⚔ Assault available${link.kind === 'naval' ? ' via sea lane' : ''} · ${target.troops} defenders`
          : canTransfer ? '⇄ Transfer troops between your regions' : 'Choose an action below')
        : 'No route — move adjacent or build a Port for naval transport';
    } else if (sel) {
      title = `${sel.name} · ${sel.troops} troops`;
      sub = 'Tap an adjacent region to attack or transfer. Long-press to fortify.';
    } else if (ui.inspect) {
      title = `${T(ui.inspect)?.name || 'Region'} · ${factionName(T(ui.inspect)?.owner)}`;
      sub = 'Select one of your own regions to issue orders.';
    }
    if (match.godMode) sub = 'ϟ GOD MODE ACTIVE · ' + sub;
    $('actionTitle').textContent = title;
    $('actionSub').textContent = sub;
    draw();
  }

  function renderAdmin() {
    const unlocked = admin && admin.isUnlocked();
    $('adminLocked').hidden = !!unlocked;
    $('adminConsole').hidden = !unlocked;
    if (!unlocked) return;
    const match = state.match;
    $('adminStatus').innerHTML = `
      <div><small>IDENTITY</small><b>CoMeBacK_49 · OWNER</b></div>
      <div><small>SESSION</small><b>VERIFIED / EXCLUSIVE</b></div>
      <div><small>GOD MODE</small><b class="${match && match.godMode ? '' : 'warn'}">${match && match.godMode ? 'ENABLED' : 'DISABLED'}</b></div>
      <div><small>ACTIVE MATCH</small><b class="warn">${match ? `#${match.id.slice(-6)} · T${match.turn}` : 'NONE'}</b></div>
      <div><small>WALLET</small><b>◆ ${fmt(state.wallet.gems)} / ◉ ${fmt(state.wallet.coins)}</b></div>
      <div><small>REGIONS</small><b>${match ? ownedCount(me()) + '/' + totalTerritories() : '—'}</b></div>`;
    const log = $('adminLog');
    log.innerHTML = admin.logs.map((e) => `<div class="t-${e.type}">${esc(e.text)}</div>`).join('');
    log.scrollTop = log.scrollHeight;
    $('adminQuick').innerHTML = admin.getQuickCommands().map((c) => `<button class="quick-cmd" data-cmd="${esc(c)}" type="button">${esc(c)}</button>`).join('');
  }

  function renderLobby() {
    if (!lobby) return;
    const s = lobby.state;
    const live = s.mode === 'ws' || s.mode === 'mesh';
    const modeLabel = { ws: 'RELAY ONLINE', mesh: 'PUBLIC RELAY', sim: 'LOCAL SIM', connecting: 'CONNECTING', offline: 'OFFLINE' }[s.mode] || s.mode.toUpperCase();
    const pill = $('lobbyStatusPill');
    pill.textContent = modeLabel;
    pill.className = `status-pill ${live ? 'online' : s.mode === 'sim' ? 'sim' : s.mode === 'offline' ? 'offline' : ''}`;
    $('lobbyStatus').textContent = live
      ? `● ${s.mode === 'mesh' ? 'Free public relay' : esc(s.url || 'relay')} · real cross-device rooms`
      : s.mode === 'sim' ? '● Relay unavailable — local lobby simulation (offline safe)'
        : s.mode === 'connecting' ? '● Opening WebSocket…' : '● Offline — local lobby simulation';
    $('wsUrl').value = state.settings.wsUrl || '';

    const room = s.room;
    $('lobbyJoinCard').hidden = !!room;
    $('roomPanel').hidden = !room;
    if (!room) return;
    $('roomCode').textContent = room.code;
    $('roomMeta').innerHTML = `<span class="mini-tag">${room.players.length}/${room.max} players</span>
      <span class="mini-tag">${esc(DIFFICULTY[room.difficulty]?.label || room.difficulty)}</span>
      <span class="mini-tag">${esc((REALTIME[room.speed] || REALTIME.off).label)}</span>
      <span class="mini-tag">${room.host === s.selfId ? '♛ You are host' : 'Host controls start'}</span>`;
    $('roomPlayerCount').textContent = `${room.players.length} / ${room.max}`;
    $('roomPlayerList').innerHTML = room.players.map((p) => `<div class="list-item">
      <span class="player-avatar" style="color:${p.color || '#56dce2'}">${esc(String(p.name || '?').slice(0, 1).toUpperCase())}</span>
      <div class="grow"><strong>${esc(p.name)}${p.id === s.selfId ? ' (you)' : ''}</strong><small>${p.bot ? 'AI lobby bot' : 'Commander'} ${room.host === p.id ? '· HOST' : ''}</small></div>
      <span class="ready-tag ${p.ready ? '' : 'wait'}">${p.ready ? 'READY' : 'WAITING'}</span></div>`).join('');
    const me = room.players.find((p) => p.id === s.selfId);
    $('btnReady').textContent = me && me.ready ? 'NOT READY' : 'READY ✓';
    $('btnReady').disabled = false;
    $('btnStartRoom').disabled = room.host !== s.selfId;
    $('btnStartRoom').textContent = room.host === s.selfId ? 'START MATCH' : 'HOST ONLY';
    $('roomChat').innerHTML = s.messages.slice(-30).map((m) => m.system
      ? `<p class="sys">● ${esc(m.text)}</p>`
      : `<p><b>${esc(m.name)}:</b> ${esc(m.text)}</p>`).join('');
    $('roomChat').scrollTop = $('roomChat').scrollHeight;
  }

  /* ──────────────── DEPLOYMENT RATIO (RoWorld Q/E) ───────────────── */
  function deployRatio() { return clamp(Number(state.settings.deployRatio) || 0.5, 0.1, 0.9); }
  function setDeployRatio(v, quiet = false) {
    const next = clamp(Math.round(v * 100) / 100, 0.1, 0.9);
    state.settings.deployRatio = next;
    save();
    updateDeployUI();
    const slider = document.getElementById('atkSlider');
    if (slider) {
      slider.value = String(Math.max(1, Math.floor(Number(slider.max) * next)));
      slider.dispatchEvent(new Event('input'));
    }
    $$('[data-ratio]').forEach((b) => b.classList.toggle('active', Math.abs(Number(b.dataset.ratio) - next) < 0.001));
    if (!quiet) toast(`Deployment ${Math.round(next * 100)}% · Q / E to adjust`, 'success');
  }
  function stepDeployRatio(delta) { setDeployRatio(deployRatio() + delta); }
  function updateDeployUI() {
    const el = $('deployValue');
    if (el) el.textContent = `${Math.round(deployRatio() * 100)}%`;
  }

  /* ───────────────────── MODALS & TOASTS ────────────────────────── */
  function toast(message, type = '') {
    const stack = $('toastStack');
    const node = document.createElement('div');
    node.className = `toast ${type}`;
    node.textContent = message;
    stack.appendChild(node);
    if (ui.screen === 'game') document.body.classList.add('toast-active');
    setTimeout(() => {
      node.style.opacity = '0';
      node.style.transition = 'opacity .3s';
      setTimeout(() => {
        node.remove();
        if (!stack.children.length) document.body.classList.remove('toast-active');
      }, 320);
    }, 2300);
    while (stack.children.length > 2) stack.firstChild.remove();
  }

  function openModal({ title, sub = '', html = '', actions = [], wide = false }) {
    const root = $('modalRoot');
    root.innerHTML = `<div class="modal-backdrop"><div class="modal" role="dialog" aria-modal="true" ${wide ? 'style="max-width:620px"' : ''}>
      <button class="icon-btn modal-close" data-modal-close type="button" aria-label="Close">✕</button>
      <h2>${title}</h2>${sub ? `<p class="modal-sub">${sub}</p>` : ''}
      <div class="modal-body">${html}</div>
      <div class="modal-actions"></div></div></div>`;
    const modal = root.querySelector('.modal');
    const actionsEl = root.querySelector('.modal-actions');
    const close = () => { root.innerHTML = ''; };
    root.querySelector('[data-modal-close]').addEventListener('click', close);
    root.querySelector('.modal-backdrop').addEventListener('click', (e) => {
      if (e.target.classList.contains('modal-backdrop')) close();
    });
    actions.forEach((a) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `btn ${a.kind || 'btn-ghost'} ${a.full === false ? '' : 'full'}`;
      b.textContent = a.label;
      b.disabled = !!a.disabled;
      b.addEventListener('click', () => a.onClick ? a.onClick(close, modal) : close());
      actionsEl.appendChild(b);
    });
    return { close, modal };
  }

  function openAttackModal() {
    const sel = T(ui.selected), target = T(ui.target);
    if (!sel || !target) return;
    const max = Math.max(1, sel.troops - 1);
    const def = Math.round(target.troops * defenseMultiplier(target));
    const { modal } = openModal({
      title: `⚔ Assault ${esc(target.name)}`,
      sub: `From ${esc(sel.name)} (${sel.id}) across a ${isAdjacent(sel.id, target.id).kind === 'naval' ? 'naval sea lane' : 'land border'} · defenders: ${fmt(target.troops)} (effective ${fmt(def)}).`,
      html: `<div class="slider-row"><input type="range" id="atkSlider" min="1" max="${max}" value="${Math.max(1, Math.floor(max * deployRatio()))}"><span class="slider-value" id="atkValue">${Math.max(1, Math.floor(max * deployRatio()))}</span></div>
        <div class="ratio-row">${DEPLOY_STEPS.map((r) => `<button type="button" data-ratio="${r}" class="${Math.abs(r - deployRatio()) < 0.001 ? 'active' : ''}">${Math.round(r * 100)}%</button>`).join('')}</div>
        <div class="odds-box"><span>Victory chance</span><b id="atkOdds">—</b></div>
        <div class="odds-box" style="margin-top:8px"><span>Terrain</span><b>${esc(sel.terrainName || 'Plains')} → ${esc(target.terrainName || 'Plains')}</b></div>
        <p class="hint">Deployment ratio is shared across your armies — press <b>Q</b> / <b>E</b> to cycle 10%…90% without opening this dialog. Plains attack faster, mountains defend harder.</p>`,
      actions: [
        { label: 'LAUNCH ASSAULT', kind: 'btn-primary', onClick: (close) => {
            const n = Number($('atkSlider').value);
            const r = performAction({ type: 'attack', from: sel.id, to: target.id, troops: n });
            close();
            if (!r.ok) return toast(r.message, 'error');
            if (r.queued) { ui.target = null; renderGame(); return toast('Assault order sent to all commanders.', 'success'); }
            if (r.godShield) return toast('God mode absorbed the counterattack.', 'success');
            toast(r.conquered ? `⚑ ${target.name} captured!` : `Assault repelled — ${r.defenderLeft} defenders remain.`, r.conquered ? 'success' : 'error');
            ui.target = null; renderGame();
          } },
        { label: 'CANCEL', kind: 'btn-ghost', onClick: (close) => close() }
      ]
    });
    const slider = modal.querySelector('#atkSlider');
    $$('[data-ratio]', modal).forEach((b) => b.addEventListener('click', () => setDeployRatio(Number(b.dataset.ratio), true)));
    const update = () => {
      modal.querySelector('#atkValue').textContent = slider.value;
      modal.querySelector('#atkOdds').textContent = `${estimateOdds(sel.id, target.id, Number(slider.value))}%`;
    };
    slider.addEventListener('input', update); update();
  }

  function openTransferModal() {
    const sel = T(ui.selected), target = T(ui.target);
    if (!sel || !target) return;
    const max = Math.max(1, sel.troops - 1);
    const { modal } = openModal({
      title: `⇄ Transfer troops`,
      sub: `${esc(sel.name)} (${sel.id}) → ${esc(target.name)} (${target.id})`,
      html: `<div class="slider-row"><input type="range" id="trSlider" min="1" max="${max}" value="${Math.max(1, Math.floor(max / 2))}"><span class="slider-value" id="trValue">${Math.max(1, Math.floor(max / 2))}</span></div>`,
      actions: [
        { label: 'MOVE TROOPS', kind: 'btn-primary', onClick: (close) => {
            const r = performAction({ type: 'transfer', from: sel.id, to: target.id, amount: Number($('trSlider').value) });
            close();
            toast(r.queued ? 'Transfer order sent.' : r.ok ? `Moved ${r.amount} troops to ${target.name}` : r.message, r.ok ? 'success' : 'error');
            ui.target = null; renderGame();
          } },
        { label: 'CANCEL', kind: 'btn-ghost', onClick: (close) => close() }
      ]
    });
    const slider = modal.querySelector('#trSlider');
    slider.addEventListener('input', () => { modal.querySelector('#trValue').textContent = slider.value; });
  }

  function openBuildModal() {
    const t = T(ui.selected);
    if (!t) return;
    const rows = Object.entries(BUILDINGS).map(([key, b]) => {
      const locked = !buildingUnlocked(b);
      const coast = b.coastal && !t.coastal;
      const built = t.buildings[key];
      const disabled = locked || coast || built || battleCoins(me()) < b.cost;
      const note = built ? 'BUILT' : locked ? (isShared() ? `TURN ${b.level * 2}` : `LEVEL ${b.level}`) : coast ? 'COASTAL ONLY' : `◉ ${b.cost}`;
      return `<button class="modal-action" data-build="${key}" ${disabled ? 'disabled' : ''}>
        <i>${b.glyph}</i><span class="grow"><strong>${b.name}</strong><small>${b.desc}</small></span><span class="price">${note}</span></button>`;
    }).join('');
    const { modal } = openModal({
      title: `⚙ Build in ${esc(t.name)}`,
      sub: `Commander level ${level()} · Balance: ◉ ${fmt(battleCoins(me()))} Battle Coins${isShared() ? ' (match treasury)' : ''} · ${t.id} ${t.coastal ? '· coastal' : '· inland'}`,
      html: `<div class="modal-actions">${rows}</div><p class="hint">Cities raise income, Ports unlock naval transport across sea lanes, Factories accelerate recruitment.</p>`,
      actions: [{ label: 'CLOSE', onClick: (close) => close() }]
    });
    $$('[data-build]', modal).forEach((b) => b.addEventListener('click', () => {
      const r = performAction({ type: 'build', id: t.id, key: b.dataset.build });
      toast(r.message, r.ok ? 'success' : 'error');
      if (r.ok) b.disabled = true;
    }));
  }

  function openInfoModal(id) {
    const t = T(id);
    if (!t) return;
    const structs = Object.entries(t.buildings).filter(([, v]) => v).map(([k]) => BUILDINGS[k].name);
    openModal({
      title: `${esc(t.name)} <span style="font:11px var(--mono);color:var(--muted-2)">${t.id}</span>`,
      sub: `${esc(t.continentName)} · ${t.coastal ? 'Coastal region' : 'Inland region'}`,
      html: `<div class="odds-box"><span>Owner</span><b style="color:${factionColor(t.owner)}">${esc(factionName(t.owner))}${areAllied(me(), t.owner) ? ' ⚑ ALLIED' : ''}</b></div>
        <div class="odds-box" style="margin-top:8px"><span>Terrain</span><b>${esc(t.terrainName || 'Plains')} · ×${terrainOf(t).attack.toFixed(2)} attack / ×${terrainOf(t).defense.toFixed(2)} defence</b></div>
        <div class="odds-box" style="margin-top:8px"><span>Garrison</span><b>${fmt(t.troops)} troops</b></div>
        <div class="odds-box" style="margin-top:8px"><span>Structures</span><b>${structs.length ? esc(structs.join(', ')) : 'None'}</b></div>
        <div class="odds-box" style="margin-top:8px"><span>Routes</span><b>${(map.adj[t.id] || []).length} land / ${(map.naval[t.id] || []).length} sea</b></div>
        <div class="odds-box" style="margin-top:8px"><span>Status</span><b>${t.fallout ? `☢ fallout ${t.fallout}` : t.defended ? '⬟ fortified' : 'Clear'}</b></div>
        <p class="hint">Owner console tip: <code>/spawn_troops ${t.id} 100</code> or <code>/nuke ${t.id}</code>.</p>`,
      actions: [{ label: 'CLOSE', kind: 'btn-primary', onClick: (close) => close() }]
    });
  }

  function openNukeModal() {
    const t = T(ui.target) || T(ui.selected) || resolveTerritory(ui.inspect);
    if (!t) return;
    openModal({
      title: `☢ Nuclear strike: ${esc(t.name)}`,
      sub: `Target ${t.id} · ${esc(factionName(t.owner))} · ${fmt(t.troops)} troops. Blast also hits ${(map.adj[t.id] || []).length} adjacent regions.`,
      html: `<div class="notice"><b>LAUNCH COST</b><span>1 warhead (you have ${state.match.warheads}) + ◉ ${NUKE_COIN_COST} Battle Coins. The target becomes neutral with 4 turns of fallout; neighbours lose 55% of their garrison.</span></div>`,
      actions: [
        { label: 'CONFIRM STRIKE', kind: 'btn-danger', onClick: (close) => {
            const r = performAction({ type: 'nuke', id: t.id });
            close();
            toast(r.queued ? '☢ Strike order sent to all commanders.' : r.ok ? `☢ ${r.target} struck — ${r.detail}` : r.message, r.ok ? 'success' : 'error');
            ui.target = null; renderGame();
          } },
        { label: 'CANCEL', kind: 'btn-ghost', onClick: (close) => close() }
      ]
    });
  }

  function openDiplomacyModal() {
    const match = state.match;
    if (!match) return;
    const rows = match.factions.filter((f) => f.id !== me()).map((f) => {
      const allied = areAllied(me(), f.id);
      return `<div class="diplomacy-row">
        <i class="swatch" style="background:${f.color}"></i>
        <div class="grow"><strong>${esc(f.name)} <small>${f.isAI ? 'AI tribe' : 'Commander'}</small></strong>
        <small>${ownedCount(f.id)} regions · ${allied ? '⚑ Alliance active · trade income' : 'Open to negotiations'}</small></div>
        <button type="button" class="${allied ? 'break' : ''}" data-ally="${f.id}" data-on="${allied ? '0' : '1'}">${allied ? 'BREAK' : 'ALLY'}</button>
      </div>`;
    }).join('');
    const { modal } = openModal({
      title: '⚑ Diplomacy & Alliances',
      sub: 'Allied nations cannot attack each other and share passive trade income. A shared 80% map also wins the campaign.',
      html: `<div class="diplomacy-list">${rows || '<p class="hint">No rivals in this campaign.</p>'}</div>
        <p class="hint">In online matches every pact is sequenced by the host and replayed on all devices. Press D to reopen.</p>`,
      actions: [{ label: 'CLOSE', kind: 'btn-primary', onClick: (close) => close() }]
    });
    $$('[data-ally]', modal).forEach((b) => b.addEventListener('click', () => {
      const r = performAction({ type: 'alliance', target: b.dataset.ally, value: b.dataset.on === '1' });
      toast(r.message, r.ok ? 'success' : 'error');
      modal.querySelector('[data-modal-close]')?.click();
      setTimeout(openDiplomacyModal, 60);
    }));
  }

  // Read-only intelligence is calculated from the live board and never changes
  // the simulation, so it is equally useful offline and in online matches.
  function openWarRoom() {
    const match = state.match;
    if (!match) return;
    const rows = match.factions.map((f) => {
      const regions = match.territories.filter((t) => t.owner === f.id);
      return { f, count: regions.length, troops: regions.reduce((n, t) => n + t.troops, 0) };
    }).sort((a, b) => b.count - a.count || b.troops - a.troops || a.f.id.localeCompare(b.f.id));
    const mine = match.territories.filter((t) => t.owner === me());
    const frontiers = mine.filter((t) => (map.adj[t.id] || []).some((id) => {
      const other = T(id);
      return other && other.owner !== me() && !areAllied(me(), other.owner);
    })).sort((a, b) => a.troops - b.troops || a.id.localeCompare(b.id));
    const list = rows.map(({ f, count, troops }, i) => `<div class="intel-row">
      <span class="intel-rank">${i + 1}</span><i class="legend-swatch" style="background:${esc(f.color)}"></i>
      <span class="grow"><strong>${esc(f.name)}${f.id === me() ? ' · YOU' : ''}</strong><small>${f.isAI ? 'AI tribe' : 'Commander'}${areAllied(me(), f.id) && f.id !== me() ? ' · Allied' : ''}</small></span>
      <span class="intel-score"><b>${count} regions</b><small>${fmt(troops)} troops</small></span></div>`).join('');
    const borders = frontiers.slice(0, 6).map((t) => `<button type="button" class="intel-frontier" data-focus-region="${esc(t.id)}"><span>${esc(t.name)} <small>${esc(t.terrainName)}</small></span><b>${fmt(t.troops)} troops ↗</b></button>`).join('');
    const { modal, close } = openModal({ title: '◉ War Room', sub: `Live intelligence · Turn ${match.turn} · ${match.territories.length} regions`, wide: true,
      html: `<h3 class="intel-heading">WORLD STANDINGS</h3><div class="intel-list">${list}</div><h3 class="intel-heading">YOUR WEAKEST LAND FRONTIERS</h3><p class="hint">Tap a region to locate it. Naval threats are not included.</p><div class="intel-list">${borders || '<p class="hint">No exposed land borders.</p>'}</div>`,
      actions: [{ label: 'BACK TO MAP', kind: 'btn-primary' }] });
    $$('[data-focus-region]', modal).forEach((button) => button.addEventListener('click', () => {
      const t = T(button.dataset.focusRegion);
      if (!t) return;
      ui.selected = t.id; ui.target = ui.inspect = null;
      close(); focusOn(t, Math.max(view.scale, 0.8)); renderGame();
    }));
  }

  function openHelpModal() {
    openModal({
      title: 'Field Manual',
      sub: 'Everything you need to conquer the world.',
      html: `<ul class="help-list">
        <li><b>Move:</b> drag to pan, pinch or use ✚/− to zoom, ⊙ to fit the whole world. Tap a territory to select it, then tap a neighbour for orders.</li>
        <li><b>Deployment ratio:</b> press <b>Q</b> / <b>E</b> (or the 10/25/50/75/90% presets) to set how much of a garrison each assault commits. Rapid cycling through weak tribes is the fastest early expansion.</li>
        <li><b>Terrain:</b> <b>Plains</b> give +10% attack and +1 recruit; <b>Highlands</b> add +12% defence; <b>Mountains</b> add +32% defence but −10% attack. Coastal regions are more likely to be plains, so spawn near water.</li>
        <li><b>Infrastructure:</b> Cities (income), Ports (sea lanes), Factories (recruits), <b>Defense Posts</b> (+25% permanent defence), <b>SAM Sites</b> (intercept nuclear strikes on themselves and neighbours), <b>Missile Silos</b> (instant nuke unlock +2 warheads).</li>
        <li><b>Real-time mode:</b> choose REAL-TIME 2s or BLITZ 1s at setup. The world ticks continuously — economy, AI attacks and reinforcements — with every tick sequenced by the host so online play stays perfectly in sync. Space forces a tick; turn-based mode is still available.</li>
        <li><b>War room:</b> tap ◉ or press I for standings, troop totals and your weakest land frontiers. Tap a frontier to focus it on the map.</li>
        <li><b>Diplomacy:</b> press <b>D</b> or tap Allies. Pacts block attacks between signatories, add passive trade income and allow a shared 80% map victory in co-op.</li>
        <li><b>Transfer / Defend:</b> move troops between connected owned regions; long-press one of your regions (or tap ⬟) to fortify it for +35% defence.</li>
        <li><b>Late game:</b> nuclear weapons unlock at level 5, turn 12, or immediately with a Missile Silo. Fallout blocks recruitment for several turns; SAM batteries counter strikes.</li>
        <li><b>Progress:</b> earn Gems and Battle Coins from matches, daily challenges, playtime rewards and the simulated store. Everything is saved locally in <code>localStorage</code>.</li>
        <li><b>Offline / online:</b> installed campaigns and the local lobby simulation work with no network. Online rooms use the included <code>server.js</code> relay or a free public MQTT relay — no account, no paid server. Share a room code to play with real people; AI bots fill empty seats.</li>
        <li><b>Owner:</b> CoMeBacK_49 has an exclusive developer console. Tap the title footer 5 times, or use <code>&gt;_</code> in a match. Commands: <code>/give_currency</code>, <code>/nuke</code>, <code>/conquer_all</code>, <code>/god_mode</code>, <code>/spawn_troops</code>, <code>/help</code>.</li>
      </ul>`,
      actions: [{ label: 'UNDERSTOOD', kind: 'btn-primary', onClick: (close) => close() }]
    });
  }

  function openSettingsModal() {
    openModal({
      title: 'Settings',
      sub: `RoFrontier v${VERSION} · Developed by CoMeBacK_49`,
      html: `<label class="field-label" for="setName">COMMANDER NAME</label>
        <input class="input" id="setName" value="${esc(state.profile.name)}" maxlength="20">
        <p class="hint">Changing the name away from <b>CoMeBacK_49</b> locks the owner console automatically.</p>
        <label class="field-label" for="setWs">WEBSOCKET RELAY URL</label>
        <input class="input" id="setWs" value="${esc(state.settings.wsUrl || '')}" placeholder="wss://your-relay/ws">
        <div class="modal-actions" style="margin-top:14px">
          <button class="modal-action" data-set="motion"><i>✧</i><span class="grow"><strong>Reduced motion</strong><small>Disable particle effects</small></span><span class="price">${state.settings.reduceMotion ? 'ON' : 'OFF'}</span></button>
          <button class="modal-action" data-set="autosave"><i>▣</i><span class="grow"><strong>Auto-save</strong><small>Persist progress to localStorage</small></span><span class="price">${state.settings.autoSave ? 'ON' : 'OFF'}</span></button>
          <button class="modal-action" data-set="help"><i>▤</i><span class="grow"><strong>Field manual</strong><small>Rules, controls and commands</small></span><span class="price">→</span></button>
          <button class="modal-action" data-set="owner"><i>⌘</i><span class="grow"><strong>Owner console</strong><small>Exclusive to CoMeBacK_49</small></span><span class="price">${admin && admin.isUnlocked() ? 'UNLOCKED' : 'LOCKED'}</span></button>
        </div>`,
      actions: [
        { label: 'SAVE SETTINGS', kind: 'btn-primary', onClick: (close, modal) => {
            const name = modal.querySelector('#setName').value.trim().slice(0, 20) || 'Commander';
            state.profile.name = name;
            state.profile.owner = name === 'CoMeBacK_49';
            state.settings.wsUrl = modal.querySelector('#setWs').value.trim();
            save(); close(); refreshAll(); renderAdmin();
            toast('Settings saved.', 'success');
          } },
        { label: 'RESET ALL PROGRESS', kind: 'btn-danger', onClick: (close) => {
            close();
            openModal({
              title: 'Reset everything?', sub: 'This wipes saved progress, cosmetics and the active campaign on this device.',
              html: '<p class="hint">The owner access key is kept. This cannot be undone.</p>',
              actions: [
                { label: 'YES, WIPE SAVE', kind: 'btn-danger', onClick: (c) => { c(); resetProgress(); } },
                { label: 'KEEP MY PROGRESS', kind: 'btn-ghost', onClick: (c) => c() }
              ]
            });
          } },
        { label: 'CLOSE', kind: 'btn-ghost', onClick: (close) => close() }
      ]
    });
    const modal = $('modalRoot').querySelector('.modal');
    $$('[data-set]', modal).forEach((b) => b.addEventListener('click', () => {
      const key = b.dataset.set;
      if (key === 'motion') { state.settings.reduceMotion = !state.settings.reduceMotion; }
      if (key === 'autosave') { state.settings.autoSave = !state.settings.autoSave; }
      if (key === 'help') { openHelpModal(); return; }
      if (key === 'owner') { $('modalRoot').innerHTML = ''; showScreen('admin'); return; }
      b.querySelector('.price').textContent = (key === 'motion' ? state.settings.reduceMotion : state.settings.autoSave) ? 'ON' : 'OFF';
      save(); refreshAll(); toast('Preference updated.', 'success');
    }));
  }

  function openGameMenuModal() {
    openModal({
      title: 'Command Menu',
      sub: `${state.match ? `Turn ${state.match.turn} · ${state.match.mode === 'online' ? 'Online lobby match' : 'Offline campaign'}` : 'No active campaign'}`,
      html: `<div class="modal-actions">
        <button class="modal-action" data-menu="save"><i>▣</i><span class="grow"><strong>Save now</strong><small>Write progress to localStorage</small></span></button>
        <button class="modal-action" data-menu="fit"><i>⊙</i><span class="grow"><strong>Fit whole world</strong><small>Reset the camera</small></span></button>
        <button class="modal-action" data-menu="help"><i>▤</i><span class="grow"><strong>Field manual</strong><small>How to play</small></span></button>
        <button class="modal-action" data-menu="owner"><i>⌘</i><span class="grow"><strong>Owner console</strong><small>${admin && admin.isUnlocked() ? 'Unlocked' : 'Restricted'}</small></span></button>
        <button class="modal-action" data-menu="home"><i>⌂</i><span class="grow"><strong>Command center</strong><small>Campaign stays saved</small></span></button>
        <button class="modal-action" data-menu="abandon"><i>✕</i><span class="grow"><strong>Abandon campaign</strong><small>End this match and return home</small></span></button>
      </div>`,
      actions: [{ label: 'BACK TO MAP', kind: 'btn-primary', onClick: (close) => close() }]
    });
    const modal = $('modalRoot').querySelector('.modal');
    $$('[data-menu]', modal).forEach((b) => b.addEventListener('click', () => {
      const key = b.dataset.menu;
      if (key === 'save') { save(); toast('Progress saved.', 'success'); }
      if (key === 'fit') { fitMap(false); draw(); }
      if (key === 'help') { openHelpModal(); return; }
      if (key === 'owner') { $('modalRoot').innerHTML = ''; showScreen('admin'); return; }
      if (key === 'home') { $('modalRoot').innerHTML = ''; showScreen('home'); return; }
      if (key === 'abandon') {
        if (state.match) { state.match.over = true; state.match.winner = 'abandoned'; }
        clearAiTimers(); save(); showScreen('home'); toast('Campaign abandoned.');
      }
      $('modalRoot').innerHTML = '';
    }));
  }

  /* ───────────────────── 10. ONLINE LOBBY ───────────────────────── */
  function defaultWsUrl() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}/ws`;
  }

  /* ================================================================
     LIVE MULTIPLAYER
     ----------------------------------------------------------------
     Two free transports are used at once and de-duplicated by message
     id: (1) the bundled same-origin /ws relay, and (2) an anonymous
     MQTT-over-WSS public bus, which works from purely static hosting
     (Vercel, Netlify, GitHub Pages) with no server and no account.

     The room creator is the authority: it assigns seats, sequences
     every command and owns the authoritative match state. Every device
     replays the same ordered commands against the same seeded RNG, so
     PvP + co-op with bots stays in lockstep. If a host drops out, the
     lowest-id client takes over automatically. No relay at all → the
     offline lobby simulation keeps the game fully playable.
     ================================================================ */
  const HOST_TIMEOUT_MS = 9000;

  class LobbyClient {
    constructor(onChange) {
      this.onChange = onChange;
      this.selfId = uid('p');
      this.state = {
        mode: 'connecting', url: '', connected: false, room: null,
        players: [], messages: [], ready: false, host: false, error: '',
        selfId: this.selfId
      };
      this.wsMesh = null;
      this.relay = null;
      this.wsReady = false;
      this.mqttReady = false;
      this.stopped = false;
      this.retry = 0;
      this.retryTimer = null;
      this.pingTimer = null;
      this.hbTimer = null;
      this.fallbackTimer = null;
      this.topicCode = null;
      this.hostRoom = null;
      this.hostSeq = 0;
      this.appliedIntents = new Set();
      this.seen = new Set();
      this.mid = 0;
      this.lastHostBeat = Date.now();
      this.lockUntil = 0;
      this.matchRoomCode = null;
      // Wired by setupLobby() to the engine's determinism layer.
      this.onGameAction = null;
      this.getSnapshot = null;
      this.applySnapshot = null;
      this.getSeq = () => -1;
      this.getPhase = () => null;
      this.onStartMatch = null;
    }

    selfPlayer() {
      const th = theme();
      return {
        id: this.selfId, name: state.profile.name || 'Commander',
        color: th.primary, light: th.light || th.primary, ready: false
      };
    }
    meshReady() { return this.wsReady || this.mqttReady; }
    isHost() { return !!(this.state.room && this.state.room.host === this.selfId); }
    cloneRoom() { return JSON.parse(JSON.stringify(this.hostRoom || this.state.room || {})); }

    connect(url) {
      this.stopped = false;
      [this.retryTimer, this.pingTimer, this.hbTimer, this.joinTimer, this.fallbackTimer]
        .forEach((t) => { clearTimeout(t); clearInterval(t); });
      if (this.wsMesh) { try { this.wsMesh.close(); } catch (_) {} this.wsMesh = null; }
      if (this.relay) { try { this.relay.close(); } catch (_) {} this.relay = null; }
      this.wsReady = false; this.mqttReady = false; this.retry = 0;

      const target = (url || state.settings.wsUrl || '').trim() || defaultWsUrl();
      this.state.url = target;
      this.state.mode = 'connecting';
      this.state.connected = false;
      this.pushSystem('Opening live relay…');
      this.onChange();

      if (typeof WebSocket === 'undefined') {
        this.useSim('WebSocket API unavailable — offline lobby simulation.');
        return;
      }
      this.startNative(target);
      this.startFreeRelay();
      this.hbTimer = setInterval(() => this.tick(), 1500);
      this.fallbackTimer = setTimeout(() => {
        if (!this.meshReady() && this.state.mode === 'connecting') {
          this.useSim('No live relay reachable — local lobby simulation (offline safe).');
        }
      }, 2800);
    }

    startNative(target) {
      let ws;
      try { ws = new WebSocket(target); } catch (_) { return; }
      this.wsMesh = ws;
      // addEventListener works in browsers AND Node's global WebSocket
      // (some runtimes do not invoke onmessage/onopen IDL assignments).
      ws.addEventListener('open', () => {
        this.wsReady = true;
        this.retry = 0;
        this.sendRaw({ type: 'hello', name: state.profile.name, id: this.selfId });
        if (this.topicCode) this.sendRaw({ type: 'subscribe', code: this.topicCode });
        this.pushSystem('Bundled relay connected.');
        this.publishStatus();
      });
      ws.addEventListener('message', (event) => {
        let msg; try { msg = JSON.parse(event.data); } catch (_) { return; }
        if (msg.type === 'relay' && msg.data) this.onMesh(msg.data);
        else this.reduce(msg);
      });
      ws.addEventListener('error', () => { /* close handler drives retry */ });
      ws.addEventListener('close', () => {
        this.wsReady = false;
        if (this.wsMesh === ws) this.wsMesh = null;
        clearInterval(this.pingTimer); this.pingTimer = null;
        this.publishStatus();
        if (!this.stopped) {
          this.retry = Math.min(this.retry + 1, 5);
          clearTimeout(this.retryTimer);
          this.retryTimer = setTimeout(() => this.startNative(target), 3000 * this.retry);
        }
      });
      this.pingTimer = setInterval(() => {
        if (ws.readyState === 1) this.sendRaw({ type: 'ping' });
      }, 15000);
    }

    startFreeRelay() {
      const Ctor = typeof window !== 'undefined' ? window.RoFrontierFreeRelay : null;
      if (!Ctor) return;
      const relay = new Ctor({
        onMessage: (msg) => this.onMesh(msg),
        onStatus: (status, detail) => {
          if (status === 'open') {
            this.mqttReady = true;
            this.pushSystem('Free public relay connected — cross-device rooms live.');
          } else if (status === 'closed') this.mqttReady = false;
          else if (status === 'failed') this.mqttReady = false;
          this.publishStatus();
        }
      });
      this.relay = relay;
      relay.connect();
    }

    publishStatus() {
      if (this.meshReady()) {
        this.state.mode = this.wsReady ? 'ws' : 'mesh';
        this.state.connected = true;
        if (this.topicCode) this.subscribe(this.topicCode);
      } else {
        this.state.mode = 'sim';
        this.state.connected = false;
      }
      this.onChange();
      renderHeader();
    }

    useSim(reason) {
      this.state.mode = 'sim';
      this.state.connected = false;
      this.pushSystem(reason);
      this.onChange();
      renderHeader();
    }
    disconnect(stopped = true) {
      this.stopped = stopped;
      [this.retryTimer, this.pingTimer, this.hbTimer, this.fallbackTimer]
        .forEach((t) => { clearTimeout(t); clearInterval(t); });
      if (this.wsMesh) { try { this.wsMesh.close(); } catch (_) {} this.wsMesh = null; }
      if (this.relay) { try { this.relay.close(); } catch (_) {} this.relay = null; }
      this.wsReady = false; this.mqttReady = false;
      if (stopped) { this.state.mode = 'offline'; this.onChange(); }
    }

    pushSystem(text) {
      this.state.messages.push({ text, system: true, ts: Date.now() });
      if (this.state.messages.length > 60) this.state.messages.shift();
    }
    pushChat(msg) {
      this.state.messages.push({
        name: msg.name || 'Commander', text: msg.text || '',
        system: !!msg.system, ts: msg.ts || Date.now()
      });
      if (this.state.messages.length > 60) this.state.messages.splice(0, this.state.messages.length - 60);
      this.onChange();
    }

    sendRaw(msg) {
      if (this.wsMesh && this.wsMesh.readyState === 1) {
        this.wsMesh.send(JSON.stringify({ ...msg, from: this.selfId, name: state.profile.name }));
        return true;
      }
      return false;
    }
    subscribe(code) {
      this.topicCode = String(code).toUpperCase();
      if (this.wsReady) this.sendRaw({ type: 'subscribe', code: this.topicCode });
      if (this.relay) this.relay.subscribe(this.topicCode);
    }
    broadcastMesh(msg) {
      if (!this.topicCode) return false;
      const data = {
        ...msg, code: this.topicCode, from: this.selfId,
        mid: `${this.selfId}-${++this.mid}-${Date.now()}`, ts: Date.now()
      };
      let sent = false;
      if (this.wsReady) sent = this.sendRaw({ type: 'relay', code: this.topicCode, data }) || sent;
      if (this.mqttReady && this.relay) sent = this.relay.publish(data) || sent;
      return sent;
    }

    /* ── Outbound lobby commands ───────────────────────────────── */
    send(type, payload = {}) {
      if (!this.meshReady()) { this.localHandle(type, payload); return; }
      if (type === 'create_room' || type === 'quick_match') {
        let code = '';
        const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
        const room = {
          code, host: this.selfId, max: Math.max(2, Math.min(8, Number(payload.max) || 4)),
          difficulty: payload.difficulty || 'normal', speed: payload.speed || 'off',
          players: [this.selfPlayer()], rev: 1, started: false, seats: null, bots: null
        };
        this.hostRoom = JSON.parse(JSON.stringify(room));
        this.matchRoomCode = null;
        this.subscribe(code);
        this.pushSystem(`Room ${code} created. Share the code — free public relay is live.`);
        this.publishRoom();
        return;
      }
      if (type === 'join_room') {
        const code = String(payload.code || '').toUpperCase().trim();
        if (!/^[A-Z0-9]{4,6}$/.test(code)) {
          this.reduce({ type: 'error', message: 'Enter a 4–6 character room code.' }); return;
        }
        this.subscribe(code);
        const room = {
          code, host: 'pending', max: 4, difficulty: payload.difficulty || 'normal',
          speed: payload.speed || 'off', players: [this.selfPlayer()], rev: 0, started: false
        };
        this.applyRoomState(room);
        this.pushSystem(`Joining ${code}… waiting for the host.`);
        this.broadcastMesh({ kind: 'cmd', type: 'join_request', player: this.selfPlayer() });
        return;
      }
      if (type === 'ready') {
        const p = (this.state.room?.players || []).find((x) => x.id === this.selfId);
        if (p) { p.ready = !p.ready; this.state.ready = p.ready; }
        // The host is authoritative and ignores its own broadcasts, so it
        // must commit its own command to hostRoom locally as well.
        if (this.isHost() && this.hostRoom) {
          const hp = this.hostRoom.players.find((x) => x.id === this.selfId);
          if (hp) hp.ready = !!(p && p.ready);
          this.publishRoom();
        } else this.broadcastMesh({ kind: 'cmd', type: 'ready' });
        this.onChange();
        return;
      }
      if (type === 'chat') {
        const m = { name: state.profile.name, text: String(payload.text || '').slice(0, 140) };
        this.pushChat(m);
        this.broadcastMesh({ kind: 'chat', ...m });
        return;
      }
      if (type === 'start') {
        if (this.isHost() && this.hostRoom) this.startRoom(this.hostRoom);
        else this.broadcastMesh({ kind: 'cmd', type: 'start' });
        return;
      }
      if (type === 'leave') {
        if (this.isHost() && this.hostRoom) {
          const others = this.hostRoom.players.filter((x) => x.id !== this.selfId);
          if (others.length) {
            this.hostRoom.players = others;
            this.hostRoom.host = others[0].id;
            this.publishRoom();
          }
        } else this.broadcastMesh({ kind: 'cmd', type: 'leave' });
        this.clearRoom();
        return;
      }
      if (type === 'ping') return;
    }

    /* ── Host authority ─────────────────────────────────────────── */
    publishRoom() {
      if (!this.hostRoom) return;
      this.hostRoom.rev = (this.hostRoom.rev || 0) + 1;
      const room = this.cloneRoom();
      this.applyRoomState(room);
      this.broadcastMesh({ kind: 'room_state', room });
    }
    applyRoomState(room) {
      if (!room) { this.clearRoom(); return; }
      const old = this.state.room;
      if (old && room.rev !== undefined && old.rev !== undefined && room.rev < old.rev) return;
      this.state.room = room;
      this.state.players = room.players || [];
      this.state.host = room.host === this.selfId;
      const selfPlayer = (room.players || []).find((p) => p.id === this.selfId);
      this.state.ready = !!(selfPlayer && selfPlayer.ready);
      if (this.topicCode !== room.code) this.subscribe(room.code);
      if (this.state.host && !this.hostRoom) this.hostRoom = JSON.parse(JSON.stringify(room));
      this.onChange();
    }
    clearRoom() {
      this.state.room = null;
      this.state.players = [];
      this.state.host = false;
      this.state.ready = false;
      this.hostRoom = null;
      this.topicCode = null;
      this.pushSystem('You left the room.');
      this.onChange();
    }
    handleCommand(msg) {
      if (!this.isHost() || !this.hostRoom) return;
      const room = this.hostRoom;
      if (msg.type === 'join_request') {
        if (room.started) {
          this.broadcastMesh({ kind: 'match_start', room: this.cloneRoom() });
          return;
        }
        const player = msg.player;
        if (!player) return;
        if (!(room.players || []).some((p) => p.id === player.id)) {
          if (room.players.length >= room.max) {
            this.broadcastMesh({ kind: 'chat', name: 'RoFrontier', text: 'Room is full.', system: true });
            return;
          }
          room.players.push({ ...player, ready: false });
          this.pushSystem(`${player.name} joined the room.`);
        }
        this.publishRoom();
      } else if (msg.type === 'ready') {
        const p = room.players.find((x) => x.id === msg.from);
        if (p) { p.ready = !p.ready; this.publishRoom(); }
      } else if (msg.type === 'leave') {
        room.players = room.players.filter((x) => x.id !== msg.from);
        if (room.host === msg.from && room.players.length) room.host = room.players[0].id;
        this.publishRoom();
      } else if (msg.type === 'start') {
        if (msg.from !== room.host) return;
        this.startRoom(room);
      }
    }
    startRoom(room) {
      const humans = room.players.filter((p) => !p.bot);
      const seats = humans.slice()
        .sort((a, b) => String(a.id).localeCompare(String(b.id)))
        .map((p) => ({ id: p.id, name: p.name, color: p.color || '#56dce2', light: p.light || p.color || '#56dce2' }));
      room.seats = seats;
      room.bots = Math.max(0, Math.min(12, (room.max || 4) - seats.length));
      room.started = true;
      const snap = this.cloneRoom();
      this.applyRoomState(snap);
      this.broadcastMesh({ kind: 'match_start', room: snap });
      this.startFromRoom(snap);
    }
    startFromRoom(room) {
      if (!room || !room.code) return;
      if (this.matchRoomCode === room.code && this.getSeq() >= 0) return;
      this.matchRoomCode = room.code;
      const seats = room.seats || (room.players || []).filter((p) => !p.bot)
        .map((p) => ({ id: p.id, name: p.name, color: p.color, light: p.light || p.color }));
      const idx = seats.findIndex((s) => s.id === this.selfId);
      const localSeat = idx >= 0 ? idx : 0;
      const bots = room.bots ?? Math.max(0, Math.min(12, (room.max || 8) - seats.length));
      this.hostSeq = 0;
      this.lockUntil = 0;
      this.appliedIntents.clear();
      if (this.onStartMatch) this.onStartMatch({
        mode: room.localSimulation ? 'offline' : 'online', seed: `ROOM-${room.code}`, difficulty: room.difficulty || 'normal',
        realtime: room.speed || 'off', seats, localSeat, bots, room
      });
    }

    /* ── Lockstep command bus ───────────────────────────────────── */
    sendGameIntent(action) {
      if (!this.meshReady() || !this.topicCode || !this.state.room || !this.state.room.started) return false;
      if (this.isHost()) { this.hostGameIntent(action); return true; }
      this.broadcastMesh({ kind: 'game_intent', action });
      const before = this.getSeq();
      setTimeout(() => {
        if (!this.stopped && this.state.room && this.getSeq() === before && action.intentId) {
          this.broadcastMesh({ kind: 'game_intent', action });
        }
      }, 2200);
      return true;
    }
    hostGameIntent(action) {
      if (!this.state.room || !this.state.room.started) return;
      if (action.intentId && this.appliedIntents.has(action.intentId)) return;
      if (action.intentId && this.appliedIntents.size > 300) this.appliedIntents.clear();
      if (action.type === 'end_turn' && (this.getPhase() !== 'player' || Date.now() < this.lockUntil)) {
        this.pushSystem('Turn resolving — wait a moment before ending again.');
        this.onChange();
        return;
      }
      const seats = this.state.room.seats || [];
      const idx = seats.findIndex((s) => s.id === action.by);
      if (idx >= 0) action.faction = `F${idx}`; // server-side seat authority
      const seq = Math.max(this.getSeq(), this.hostSeq || 0) + 1;
      this.hostSeq = seq;
      if (action.intentId) this.appliedIntents.add(action.intentId);
      this.broadcastMesh({ kind: 'game_action', seq, action });
      if (this.onGameAction) this.onGameAction(action, seq);
      if (action.type === 'end_turn') this.lockUntil = Date.now() + 3400;
    }
    requestGameState() {
      if (!this.meshReady() || !this.topicCode) return;
      this.broadcastMesh({ kind: 'state_request' });
    }
    sendGameState(to) {
      const snap = this.getSnapshot ? this.getSnapshot() : null;
      if (!snap) return;
      this.broadcastMesh({ kind: 'game_state', to, snap });
    }

    /* ── Inbound mesh packets ───────────────────────────────────── */
    onMesh(msg) {
      if (!msg || typeof msg !== 'object' || this.stopped) return;
      if (msg.from === this.selfId) return; // echoes are handled locally
      if (msg.mid) {
        if (this.seen.has(msg.mid)) return;
        this.seen.add(msg.mid);
        if (this.seen.size > 500) this.seen.clear();
      }
      if (msg.code && (!this.topicCode || msg.code !== this.topicCode)) return;
      switch (msg.kind) {
        case 'room_state': this.applyRoomState(msg.room); break;
        case 'chat': this.pushChat(msg); break;
        case 'cmd': this.handleCommand(msg); break;
        case 'match_start':
          this.applyRoomState(msg.room);
          this.startFromRoom(msg.room);
          break;
        case 'game_intent': if (this.isHost()) this.hostGameIntent(msg.action || {}); break;
        case 'game_action':
          if (this.onGameAction) this.onGameAction(msg.action, msg.seq);
          break;
        case 'host_state':
          this.lastHostBeat = Date.now();
          if (msg.room) this.applyRoomState(msg.room);
          if (msg.room && msg.room.started && (this.getSeq() < 0 || msg.seq > this.getSeq() + 1)) {
            this.requestGameState();
          }
          break;
        case 'state_request': if (this.isHost()) this.sendGameState(msg.from); break;
        case 'game_state':
          if ((!msg.to || msg.to === this.selfId) && msg.snap && this.applySnapshot) {
            this.applySnapshot(msg.snap);
          }
          break;
        default: break;
      }
    }

    tick() {
      if (this.stopped) return;
      const room = this.state.room;
      if (!room || !this.meshReady()) return;
      if (this.state.host) {
        if (!this.hostRoom) this.hostRoom = JSON.parse(JSON.stringify(room));
        this.lastHostBeat = Date.now();
        this.broadcastMesh({
          kind: 'host_state', seq: Math.max(this.getSeq(), this.hostSeq || 0),
          room: this.cloneRoom()
        });
      } else {
        if (!room.started && !(room.players || []).some((p) => p.id === this.selfId)) {
          this.broadcastMesh({ kind: 'cmd', type: 'join_request', player: this.selfPlayer() });
        }
        if (Date.now() - this.lastHostBeat > HOST_TIMEOUT_MS) {
          const ids = (room.players || []).filter((p) => !p.bot).map((p) => String(p.id)).sort();
          if (ids[0] === String(this.selfId)) {
            this.hostRoom = JSON.parse(JSON.stringify(room));
            this.hostRoom.host = this.selfId;
            this.lastHostBeat = Date.now();
            this.hostSeq = Math.max(0, this.getSeq());
            this.pushSystem('Host disconnected — relay authority migrated to you.');
            this.publishRoom();
          }
        }
      }
    }

    /* Legacy reducer (custom /ws relays using the original protocol). */
    reduce(msg) {
      switch (msg.type) {
        case 'hello_ack':
          this.selfId = msg.id || this.selfId;
          this.state.selfId = this.selfId;
          break;
        case 'room_state': {
          const room = msg.room;
          if (!room) { this.clearRoom(); break; }
          this.applyRoomState(room);
          break;
        }
        case 'chat': this.pushChat(msg); break;
        case 'match_start':
          this.pushSystem('Match starting — deploying world…');
          this.onChange();
          this.startFromRoom(msg.room);
          break;
        case 'error':
          this.state.error = msg.message || 'Unknown lobby error';
          this.pushSystem(`⚠ ${this.state.error}`);
          toast(this.state.error, 'error');
          break;
        case 'pong': break;
        default: break;
      }
      this.onChange();
      renderHeader();
    }

    /* Local mini-server: keeps the whole lobby UI usable with zero network. */
    localHandle(type, payload) {
      const s = this.state;
      const sys = (text) => { this.pushSystem(text); this.onChange(); };
      if (type === 'create_room' || type === 'quick_match') {
        let code = '';
        const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
        const selfPlayer = this.selfPlayer();
        s.room = {
          code, localSimulation: true, host: this.selfId, max: Number(payload.max) || 4,
          difficulty: payload.difficulty || 'normal', speed: payload.speed || state.settings.realtime || 'off',
          players: [selfPlayer], rev: 1, started: false,
          seats: [{ id: selfPlayer.id, name: selfPlayer.name, color: selfPlayer.color, light: selfPlayer.light }],
          bots: null
        };
        s.players = s.room.players; s.host = true;
        sys(`Room ${code} created (local simulation only — other devices cannot join).`);
        this.matchRoomCode = null;
        const botCount = type === 'quick_match' ? Math.min(3, s.room.max - 1) : 1;
        for (let i = 1; i <= botCount; i++) {
          setTimeout(() => {
            if (!s.room || s.room.code !== code) return;
            s.room.players.push({ id: `bot-${i}`, name: pick(AI_FACTIONS).name, ready: true, bot: true, color: AI_FACTIONS[i - 1].color });
            sys('A commander joined the room.');
            this.reduce({ type: 'room_state', room: s.room });
          }, 500 * i);
        }
        return;
      }
      if (type === 'join_room') {
        const code = String(payload.code || '').toUpperCase().trim();
        if (!/^[A-Z0-9]{4,6}$/.test(code)) { this.reduce({ type: 'error', message: 'Enter a 4–6 character room code.' }); return; }
        const selfPlayer = this.selfPlayer();
        const host = { id: 'local-host', name: 'Room Host', ready: true, bot: true, color: '#e2505e' };
        s.room = {
          code, localSimulation: true, host: this.selfId, max: 4, difficulty: payload.difficulty || 'normal',
          speed: payload.speed || state.settings.realtime || 'off', players: [selfPlayer, host], rev: 1, started: false,
          seats: [
            { id: selfPlayer.id, name: selfPlayer.name, color: selfPlayer.color, light: selfPlayer.light },
            { id: host.id, name: host.name, color: host.color, light: host.color }
          ], bots: null
        };
        s.players = s.room.players; s.host = true;
        this.matchRoomCode = null;
        sys(`Joined ${code} (local simulation).`);
        this.reduce({ type: 'room_state', room: s.room });
        return;
      }
      if (type === 'ready') {
        const selfPlayer = s.room?.players.find((p) => p.id === this.selfId);
        if (selfPlayer) { selfPlayer.ready = !selfPlayer.ready; this.reduce({ type: 'room_state', room: s.room }); }
        return;
      }
      if (type === 'chat') {
        this.pushChat({ name: state.profile.name, text: payload.text });
        if (Math.random() < 0.65) {
          setTimeout(() => this.pushChat({ name: 'Vesper Pact', text: pick(['Ready when you are.', 'Good luck, Commander!', 'Watch the sea lanes.', 'gg']) }), 900);
        }
        return;
      }
      if (type === 'start') {
        if (!s.room) { this.reduce({ type: 'error', message: 'Join a room first.' }); return; }
        const humans = s.room.players.filter((p) => !p.bot);
        s.room.seats = humans.map((p) => ({ id: p.id, name: p.name, color: p.color, light: p.light || p.color }));
        s.room.bots = Math.max(0, Math.min(12, s.room.max - humans.length));
        s.room.started = true;
        sys('All commanders deployed. Launching local match…');
        setTimeout(() => this.reduce({ type: 'match_start', room: s.room }), 500);
        return;
      }
      if (type === 'leave') { this.clearRoom(); return; }
      if (type === 'ping') this.reduce({ type: 'pong' });
    }
  }

  function setupLobby() {
    lobby = new LobbyClient(() => { if (ui.screen === 'lobby') renderLobby(); });
    lobby.onGameAction = (action, seq) => applyGameAction(action, seq);
    lobby.getSnapshot = () => state.match ? serializeMatch(state.match) : null;
    lobby.applySnapshot = (snap) => applyRemoteSnapshot(snap);
    lobby.getSeq = () => (state.match ? (state.match.seq || 0) : -1);
    lobby.getPhase = () => (state.match ? state.match.phase : null);
    lobby.onStartMatch = (opts) => {
      state.settings.bots = opts.bots;
      state.settings.difficulty = opts.difficulty || 'normal';
      startMatch(opts);
      toast(`${opts.room && opts.room.localSimulation ? 'Offline simulation' : 'Online match'} · ${opts.seats.length} commanders · ${opts.bots} AI rivals`, 'success');
    };
    // Probes the same-origin /ws relay AND the free public bus. If both are
    // unreachable the game silently switches to its offline lobby simulation.
    lobby.connect('');
  }

  /* ──────────────── 11. OWNER API + CONSOLE ─────────────────────── */
  function applySpawnTroops(rawId, amount) {
    const t = resolveTerritory(rawId);
    if (!t) return { ok: false, message: `Territory "${rawId}" not found. Use /reveal for IDs.` };
    t.troops = Math.min(1000000, t.troops + amount);
    addLog(`[OWNER] Spawned ${amount} troops in ${t.name} (${t.id}).`);
    floatText(t, `+${amount}`, '#f5be4a');
    return { ok: true, target: `${t.name} (${t.id})`, troops: fmt(t.troops) };
  }

  // Owner QA commands also run through the lockstep layer in shared matches,
  // so a victory test never desynchronises the room.
  function queueOwner(action) {
    if (!isShared() || !lobby || !lobby.state.room) return false;
    const r = performAction(action);
    return !!r.queued;
  }

  const ownerAPI = {
    onOwnerVerified() {
      state.profile.name = window.AdminSystem.OWNER_ID;
      state.profile.owner = true;
      save();
    },
    giveCurrency(amount, kind) {
      if (kind === 'gems' || kind === 'both') state.wallet.gems += amount;
      if (kind === 'coins' || kind === 'both') state.wallet.coins += amount;
      return `Granted ◆ ${kind === 'coins' ? 0 : fmt(amount)} Gems and ◉ ${kind === 'gems' ? 0 : fmt(amount)} Battle Coins.`;
    },
    nuke(rawId, opts) {
      if (opts.admin && queueOwner({ type: 'admin_nuke', id: String(rawId) })) {
        return { ok: true, target: String(rawId), detail: 'Strike broadcast to all commanders.' };
      }
      const r = launchNuke(String(rawId), opts);
      return r.ok ? { ok: true, target: r.target, detail: r.detail } : { ok: false, message: r.message };
    },
    conquerAll() {
      if (queueOwner({ type: 'admin_conquer' })) {
        return { ok: true, count: ownedCount(me()), percent: 80, message: 'Victory test broadcast to all commanders.' };
      }
      return conquerAll();
    },
    setGodMode(value) {
      if (!state.match) return false;
      const next = value === undefined ? !state.match.godMode : !!value;
      if (queueOwner({ type: 'admin_god', value: next })) return next;
      state.match.godMode = next;
      state.match.godFaction = next ? acting() : null;
      if (next) state.match.territories.filter((t) => t.owner === state.match.godFaction).forEach((t) => { t.troops = Math.max(t.troops, 9999); });
      addLog(`[OWNER] God mode ${next ? 'enabled' : 'disabled'}.`);
      return next;
    },
    isGodMode() { return !!(state.match && state.match.godMode); },
    spawnTroops(rawId, amount) {
      if (queueOwner({ type: 'admin_spawn', id: String(rawId), amount })) {
        return { ok: true, target: String(rawId), troops: 'queued' };
      }
      return applySpawnTroops(rawId, amount);
    },
    setTurn(n) {
      if (!state.match) return 'No active campaign.';
      if (queueOwner({ type: 'admin_turn', n })) return `Turn change broadcast (${n}).`;
      state.match.turn = n;
      if (n >= 12) state.match.nukeUnlocked = true;
      addLog(`[OWNER] Turn set to ${n}.`);
      return `Turn set to ${n}${n >= 12 ? ' · nuclear programme online' : ''}.`;
    },
    setWarheads(n) {
      if (!state.match) return 'No active campaign.';
      if (queueOwner({ type: 'admin_warheads', n })) return `Warhead update broadcast (${n}).`;
      state.match.warheads = n;
      state.match.nukeUnlocked = true;
      return `Warhead stockpile set to ${n}.`;
    },
    unlockAll() {
      Object.entries(COSMETICS).forEach(([type, list]) => list.forEach((item) => {
        const key = `${type}:${item.id}`;
        if (item.unlock?.type !== 'owner' && !state.cosmetics.owned.includes(key)) state.cosmetics.owned.push(key);
      }));
      PLAYTIME_TIERS.forEach((t) => { if (!state.playtime.claimed.includes(t.id)) state.playtime.claimed.push(t.id); });
      ACHIEVEMENTS.forEach((a) => { if (!state.achievements.includes(a.id)) state.achievements.push(a.id); });
      if (isOwnerProfile()) {
        Object.entries(COSMETICS).forEach(([type, list]) => list.forEach((item) => {
          const key = `${type}:${item.id}`;
          if (!state.cosmetics.owned.includes(key)) state.cosmetics.owned.push(key);
        }));
      }
      return `All cosmetics, traits and achievements unlocked (${ownedKeys().size} items).`;
    },
    reveal() {
      if (!state.match) return ['No active campaign. Start a match with /help or the Conquest tab.'];
      const counts = state.match.factions.map((f) => `${f.name}: ${ownedCount(f.id)}`).concat(`Neutral: ${ownedCount(NEUTRAL)}`);
      const top = state.match.territories.slice().sort((a, b) => b.troops - a.troops).slice(0, 5)
        .map((t) => `  ${t.id.padEnd(4)} ${t.name.padEnd(18)} ${String(t.troops).padStart(6)}  ${factionName(t.owner)}`);
      return [
        `WORLD ${state.match.seed} · turn ${state.match.turn} · ${state.match.phase} · ${totalTerritories()} regions`,
        ...counts,
        'Strongest garrisons:', ...top,
        `Warheads ${state.match.warheads} · god_mode ${state.match.godMode ? 'ON' : 'OFF'} · wallet ◆${state.wallet.gems} ◉${state.wallet.coins}`
      ];
    },
    endMatch(outcome) {
      if (!state.match || state.match.over) return 'No active campaign.';
      if (queueOwner({ type: 'admin_end', outcome })) return `${outcome.toUpperCase()} screen broadcast to all commanders.`;
      showVictory(outcome);
      return `${outcome.toUpperCase()} screen triggered (owner test).`;
    },
    resetProgress() { return resetProgress(); },
    afterCommand() { save(); refreshAll(); renderAdmin(); }
  };

  function resetProgress() {
    localStorage.removeItem(SAVE_KEY);
    state = defaultState();
    ensureDaily(); save();
    if (map) map = generateMap('49');
    clearAiTimers();
    ui.selected = ui.target = ui.inspect = null;
    showScreen('title');
    toast('All local progress reset.');
    return 'Local save wiped. Owner key preserved; console locked until profile is CoMeBacK_49 again.';
  }

  function setupAdmin() {
    admin = new window.AdminSystem({
      getContext: () => ({ state, match: state.match, profileName: state.profile.name, api: ownerAPI }),
      onLog: (entry) => {
        if (ui.screen !== 'admin' || $('adminConsole').hidden) return;
        const log = $('adminLog');
        const div = document.createElement('div');
        div.className = `t-${entry.type}`;
        div.textContent = entry.text;
        log.appendChild(div);
        log.scrollTop = log.scrollHeight;
      },
      onChange: () => { renderAdmin(); if (ui.screen === 'game') renderGame(); }
    });
  }

  async function runCommand(raw, inputEl) {
    if (!admin) return;
    const result = await admin.execute(raw);
    if (inputEl) inputEl.value = '';
    if (result && result.message && result.message !== 'Console cleared.') {
      toast(String(result.message).slice(0, 150), result.ok ? 'success' : 'error');
    }
    if (ui.screen === 'admin') renderAdmin();
    refreshAll();
  }

  /* ─────────────────── VICTORY ANIMATIONS ───────────────────────── */
  function startVictoryAnimation(kind) {
    victoryKind = kind;
    victoryParticles = [];
    if (!victoryCanvas || !vg) return;
    const rect = victoryCanvas.getBoundingClientRect();
    victoryCanvas.width = Math.round(rect.width * Math.min(2, window.devicePixelRatio || 1));
    victoryCanvas.height = Math.round(rect.height * Math.min(2, window.devicePixelRatio || 1));
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    vg.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function drawVictoryFrame(now) {
    if (!vg || !victoryCanvas || ui.screen !== 'victory') return;
    const w = victoryCanvas.clientWidth, h = victoryCanvas.clientHeight;
    vg.clearRect(0, 0, w, h);
    if (state.settings.reduceMotion) return;
    if (!victoryParticles.length || now - (victoryParticles[0].born || 0) > 2600) {
      victoryParticles = [];
      const count = victoryKind === 'defeat' ? 14 : 60;
      for (let i = 0; i < count; i++) {
        victoryParticles.push({
          x: Math.random() * w, y: Math.random() * h * 0.7,
          vx: (Math.random() - 0.5) * 2, vy: Math.random() * 2 + 0.6,
          size: 3 + Math.random() * 6, rot: Math.random() * 6, spin: (Math.random() - 0.5) * 0.2,
          color: victoryKind === 'defeat' ? '#8b3946'
            : ['#f5be4a', '#56dce2', '#63e6a4', '#ffffff', '#b28bff'][i % 5],
          born: now
        });
      }
      if (victoryKind === 'fireworks' || victoryKind === 'owner') {
        for (let i = 0; i < 3; i++) victoryParticles.push({ burst: true, x: w * (0.2 + 0.3 * i), y: h * (0.2 + Math.random() * 0.3), born: now, color: i % 2 ? '#f5be4a' : '#56dce2' });
      }
    }
    const age = now - (victoryParticles[0]?.born || now);
    if (victoryKind === 'rays' || victoryKind === 'owner') {
      vg.save(); vg.translate(w / 2, h / 2); vg.rotate(now / 2600);
      for (let i = 0; i < 12; i++) {
        vg.rotate(Math.PI / 6);
        const grad = vg.createLinearGradient(0, 0, 0, -h);
        grad.addColorStop(0, 'rgba(245,190,74,.18)'); grad.addColorStop(1, 'rgba(245,190,74,0)');
        vg.fillStyle = grad;
        vg.beginPath(); vg.moveTo(-14, 0); vg.lineTo(14, 0); vg.lineTo(60, -h); vg.lineTo(-60, -h); vg.fill();
      }
      vg.restore();
    }
    if (victoryKind === 'pulse' || victoryKind === 'owner') {
      for (let i = 0; i < 3; i++) {
        const k = ((now / 1400) + i / 3) % 1;
        vg.beginPath(); vg.arc(w / 2, h / 2, k * Math.max(w, h) * 0.7, 0, Math.PI * 2);
        vg.lineWidth = 3 * (1 - k); vg.strokeStyle = `rgba(86,220,226,${0.35 * (1 - k)})`; vg.stroke();
      }
    }
    victoryParticles.forEach((p) => {
      if (p.burst) {
        const k = clamp((now - p.born) / 900, 0, 1);
        for (let i = 0; i < 18; i++) {
          const a = (Math.PI * 2 * i) / 18;
          const r = k * 80;
          vg.globalAlpha = 1 - k;
          vg.beginPath(); vg.arc(p.x + Math.cos(a) * r, p.y + Math.sin(a) * r, 3, 0, Math.PI * 2);
          vg.fillStyle = p.color; vg.fill();
        }
        vg.globalAlpha = 1;
        return;
      }
      p.x += p.vx; p.y += p.vy; p.rot += p.spin;
      if (p.y > h + 20) { p.y = -20; p.x = Math.random() * w; }
      vg.save(); vg.translate(p.x, p.y); vg.rotate(p.rot);
      vg.globalAlpha = clamp(1 - age / 3200, 0.2, 1);
      vg.fillStyle = p.color;
      vg.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
      vg.restore();
    });
    vg.globalAlpha = 1;
  }

  /* ───────────────────── 12. BOOT & EVENTS ──────────────────────── */
  let lastDraw = 0;
  function frame(now) {
    lastFrame = now;
    // ~33fps cap keeps the map smooth without draining mobile batteries.
    if (ui.screen === 'game' && now - lastDraw > 30) { draw(); lastDraw = now; }
    if (ui.screen === 'victory') drawVictoryFrame(now);
    requestAnimationFrame(frame);
  }

  function setupEvents() {
    // global navigation
    document.addEventListener('click', (e) => {
      const nav = e.target.closest('[data-nav]');
      if (nav) { showScreen(nav.dataset.nav); return; }
    });
    $$('.bottom-nav button').forEach((b) => b.addEventListener('click', () => showScreen(b.dataset.nav)));

    // title
    $('btnPlay').addEventListener('click', () => showScreen(state.match && !state.match.over ? 'game' : 'setup'));
    $('btnNewCampaign').addEventListener('click', () => showScreen('setup'));
    $('btnOnline').addEventListener('click', () => showScreen('lobby'));
    $('btnSettings').addEventListener('click', openSettingsModal);
    let footerTaps = 0, footerFirst = 0;
    $('brandFooter').addEventListener('click', () => {
      const now = Date.now();
      if (now - footerFirst > 3000) { footerTaps = 0; footerFirst = now; }
      footerTaps++;
      if (footerTaps >= 5) {
        footerTaps = 0;
        showScreen('admin');
        toast('⌘ Owner console revealed', 'success');
      } else if (footerTaps >= 3) toast(`…${5 - footerTaps} more taps`);
    });

    // home
    $('btnContinue').addEventListener('click', () => showScreen(state.match && !state.match.over ? 'game' : 'setup'));
    $('dailyList').addEventListener('click', (e) => {
      const b = e.target.closest('[data-claim-daily]');
      if (b) claimDaily(b.dataset.claimDaily);
    });
    $('playtimePreview').addEventListener('click', () => showScreen('vault'));

    // setup
    $('profileName').addEventListener('change', (e) => {
      const name = e.target.value.trim().slice(0, 20) || 'Commander';
      state.profile.name = name;
      state.profile.owner = name === 'CoMeBacK_49';
      save(); renderHome(); renderAdmin();
    });
    $$('#difficultyGroup button').forEach((b) => b.addEventListener('click', () => {
      state.settings.difficulty = b.dataset.difficulty; save(); renderSetup();
    }));
    $$('#speedGroup button').forEach((b) => b.addEventListener('click', () => {
      state.settings.realtime = b.dataset.speed; save(); renderSetup();
    }));
    $('botRange').addEventListener('input', (e) => {
      state.settings.bots = Number(e.target.value);
      $('botCount').textContent = state.settings.bots;
      save(); renderSetup();
    });
    $('setupColor').addEventListener('change', (e) => { equip('colors', e.target.value); renderSetup(); });
    $('setupSkin').addEventListener('change', (e) => { equip('skins', e.target.value); renderSetup(); });
    $('btnRandomSeed').addEventListener('click', () => { $('matchSeed').value = String(rand(1000, 99999)); });
    $('btnStartMatch').addEventListener('click', () => startMatch());

    // game HUD
    $('btnZoomIn').addEventListener('click', () => { zoomAt(1.25, view.w / 2, view.h / 2); draw(); });
    $('btnZoomOut').addEventListener('click', () => { zoomAt(0.8, view.w / 2, view.h / 2); draw(); });
    $('btnFit').addEventListener('click', () => { fitMap(false); draw(); });
    $('btnGameMenu').addEventListener('click', openGameMenuModal);
    $('btnIntel').addEventListener('click', openWarRoom);
    $('btnEndTurn').addEventListener('click', () => performAction({ type: state.match && state.match.tickMs > 0 ? 'tick' : 'end_turn' }));
    $('btnDeployDown').addEventListener('click', () => stepDeployRatio(-0.1));
    $('btnDeployUp').addEventListener('click', () => stepDeployRatio(0.1));
    $('btnClearSelection').addEventListener('click', () => { ui.selected = ui.target = ui.inspect = null; renderGame(); });
    $$('#actionRow .action').forEach((b) => b.addEventListener('click', () => {
      const a = b.dataset.action;
      if (a === 'attack') openAttackModal();
      if (a === 'transfer') openTransferModal();
      if (a === 'build') openBuildModal();
      if (a === 'nuke') openNukeModal();
      if (a === 'info') openInfoModal(ui.target || ui.selected || ui.inspect);
      if (a === 'defend') { const r = performAction({ type: 'fortify', id: ui.selected }); toast(r.message, r.ok ? 'success' : 'error'); }
      if (a === 'diplomacy') openDiplomacyModal();
    }));
    $('btnCommand').addEventListener('click', () => {
      ui.commandOpen = !ui.commandOpen;
      $('commandBar').hidden = !ui.commandOpen;
      if (ui.commandOpen) $('commandInput').focus();
    });
    $('btnCommandClose').addEventListener('click', () => { ui.commandOpen = false; $('commandBar').hidden = true; });
    $('btnCommandSend').addEventListener('click', () => runCommand($('commandInput').value, $('commandInput')));
    $('commandInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') runCommand($('commandInput').value, $('commandInput'));
    });
    $('commandQuick').addEventListener('click', (e) => {
      const b = e.target.closest('[data-cmd]');
      if (b) { $('commandInput').value = b.dataset.cmd; $('commandInput').focus(); }
    });

    // store
    $('screen-store').addEventListener('click', (e) => {
      const b = e.target.closest('[data-buy]');
      if (!b) return;
      const [kind, id] = b.dataset.buy.split(':');
      const item = (SHOP[{ iap: 'iap', coins: 'coins', supply: 'supplies', bundle: 'bundles' }[kind]] || []).find((x) => x.id === id);
      if (!item) return;
      if (kind === 'iap') return confirmIAP(item);
      if (kind === 'coins') {
        if (state.wallet.gems < item.gems) return toast('Not enough Gems.', 'error');
        state.wallet.gems -= item.gems; state.wallet.coins += item.coins;
        toast(`+${fmt(item.coins)} Battle Coins`, 'success');
      }
      if (kind === 'supply') return buySupply(item);
      if (kind === 'bundle') {
        if (state.wallet.gems < item.gems) return toast('Not enough Gems.', 'error');
        state.wallet.gems -= item.gems;
        item.items.forEach((key) => {
          const [type, cid] = key.split(':');
          if (!state.cosmetics.owned.includes(`${type}:${cid}`)) state.cosmetics.owned.push(`${type}:${cid}`);
        });
        toast(`${item.name} unlocked!`, 'success');
      }
      checkAchievements(); save(); refreshAll();
    });
    $('btnFreeGems').addEventListener('click', () => {
      ensureDaily();
      if (state.daily.freeGemsClaimed) return;
      state.daily.freeGemsClaimed = true;
      state.wallet.gems += 15;
      save(); refreshAll();
      toast('◆ +15 Gems — daily supply drop claimed', 'success');
    });

    // vault
    $('vaultTabs').addEventListener('click', (e) => {
      const b = e.target.closest('[data-tab]');
      if (b) { ui.vaultTab = b.dataset.tab; renderVault(); }
    });
    $('vaultGrid').addEventListener('click', (e) => {
      const eq = e.target.closest('[data-equip]');
      const un = e.target.closest('[data-unlock]');
      if (eq) { const [t, id] = eq.dataset.equip.split(':'); const r = equip(t, id); toast(r.message, r.ok ? 'success' : 'error'); }
      if (un) { const [t, id] = un.dataset.unlock.split(':'); const r = unlock(t, id); toast(r.message, r.ok ? 'success' : 'error'); }
    });
    $('playtimeList').addEventListener('click', (e) => {
      const b = e.target.closest('[data-claim-playtime]');
      if (b) claimPlaytime(b.dataset.claimPlaytime);
    });

    // lobby
    $('btnWsConnect').addEventListener('click', () => {
      state.settings.wsUrl = $('wsUrl').value.trim();
      save(); lobby.stopped = false; lobby.connect(state.settings.wsUrl);
    });
    $('btnCreateRoom').addEventListener('click', () => lobby.send('create_room', {
      max: Number($('roomMax').value), difficulty: $('roomDifficulty').value, speed: $('roomSpeed').value
    }));
    $('btnJoinRoom').addEventListener('click', () => lobby.send('join_room', {
      code: $('roomCodeInput').value, difficulty: $('roomDifficulty').value, speed: $('roomSpeed').value
    }));
    $('btnQuickMatch').addEventListener('click', () => lobby.send('quick_match', { max: 4, difficulty: $('roomDifficulty').value, speed: $('roomSpeed').value }));
    $('btnReady').addEventListener('click', () => lobby.send('ready'));
    $('btnStartRoom').addEventListener('click', () => lobby.send('start'));
    $('btnLeaveRoom').addEventListener('click', () => lobby.send('leave'));
    $('btnCopyCode').addEventListener('click', async () => {
      const code = lobby.state.room?.code || '';
      try { await navigator.clipboard.writeText(code); toast(`Code ${code} copied`, 'success'); }
      catch (_) { toast(`Room code: ${code}`); }
    });
    $('btnChatSend').addEventListener('click', sendChat);
    $('chatInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });

    // admin
    $('btnOwnerVerify').addEventListener('click', async () => {
      const r = await admin.verify($('ownerIdInput').value, $('ownerKeyInput').value);
      $('adminLockMsg').textContent = r.message;
      $('ownerKeyInput').value = '';
      toast(r.message, r.ok ? 'success' : 'error');
      renderAdmin(); renderHeader(); if (ui.screen === 'game') renderGame();
    });
    $('ownerKeyInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btnOwnerVerify').click(); });
    $('btnOwnerHelp').addEventListener('click', () => openModal({
      title: 'Why is this restricted?',
      sub: 'Exclusive administrative powers belong to the registered owner.',
      html: `<ul class="help-list">
        <li>The console only unlocks for the ID <b>CoMeBacK_49</b>, with an access key verified against a salted hash stored on this device.</li>
        <li>The unlock token is bound to the active profile name. Renaming the profile revokes owner powers immediately.</li>
        <li>Local installs ship with a bootstrap key in <code>README.md</code>. Change it once with <code>/owner_key [new_key]</code> or the CHANGE KEY button.</li>
        <li><b>Security note:</b> this is a client-side game. Browser storage and JavaScript can be edited by the device owner, so this gate protects the UI and save flow — it is not a server-grade security boundary.</li>
        <li>Commands: <code>/give_currency 500</code>, <code>/nuke T01</code>, <code>/conquer_all</code>, <code>/god_mode</code>, <code>/spawn_troops T01 100</code>, <code>/help</code>.</li>
      </ul>`,
      actions: [
        { label: 'FILL LOCAL BOOTSTRAP KEY', kind: 'btn-ghost', onClick: (close) => {
            $('ownerIdInput').value = window.AdminSystem.OWNER_ID;
            $('ownerKeyInput').value = window.AdminSystem.BOOTSTRAP_KEY;
            close();
            toast('Local bootstrap key filled — press UNLOCK CONSOLE.');
          } },
        { label: 'CLOSE', kind: 'btn-primary', onClick: (close) => close() }
      ]
    }));
    $('btnAdminRun').addEventListener('click', () => runCommand($('adminInput').value, $('adminInput')));
    $('adminInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') runCommand($('adminInput').value, $('adminInput'));
      if (e.key === 'ArrowUp' && admin.history.length) $('adminInput').value = admin.history[admin.history.length - 1];
    });
    $('adminQuick').addEventListener('click', (e) => {
      const b = e.target.closest('[data-cmd]');
      if (b) { $('adminInput').value = b.dataset.cmd; $('adminInput').focus(); }
    });
    $('btnAdminClear').addEventListener('click', () => { admin.clearLog(); renderAdmin(); });
    $('btnAdminLock').addEventListener('click', () => { admin.lock(); renderAdmin(); toast('Owner console locked.'); });
    $('btnChangeKey').addEventListener('click', () => openModal({
      title: 'Replace owner key',
      sub: 'The new key is salted and hashed locally. It never leaves this device.',
      html: '<label class="field-label" for="newOwnerKey">NEW ACCESS KEY (MIN 6 CHARS)</label><input class="input" id="newOwnerKey" type="password" autocomplete="off">',
      actions: [
        { label: 'SAVE NEW KEY', kind: 'btn-primary', onClick: async (close, modal) => {
            const key = modal.querySelector('#newOwnerKey').value.trim();
            if (key.length < 6) return toast('Key too short.', 'error');
            await admin.changeKey(key);
            close(); toast('Owner access key replaced.', 'success');
          } },
        { label: 'CANCEL', kind: 'btn-ghost', onClick: (close) => close() }
      ]
    }));

    // victory
    $('btnVictoryAgain').addEventListener('click', () => showScreen('setup'));
    $('btnVictoryHome').addEventListener('click', () => showScreen('home'));
    $('btnVictoryShare').addEventListener('click', async () => {
      const text = `I ${state.match && state.match.winner === me() ? 'conquered' : 'fought for'} the world in RoFrontier by CoMeBacK_49! ${state.stats.wins} wins, ${state.stats.conquests} regions taken.`;
      try {
        if (navigator.share) await navigator.share({ title: 'RoFrontier', text });
        else { await navigator.clipboard.writeText(text); toast('Result copied to clipboard', 'success'); }
      } catch (_) { toast(text); }
    });

    // keyboard convenience on desktop (Space / Q / E / D handled above so
    // every order still goes through the sequenced command layer)
    document.addEventListener('keydown', (e) => {
      if (e.target && e.target.matches && e.target.matches('input, select, textarea')) return;
      if (ui.screen === 'game' && e.key === 'Escape') { ui.selected = ui.target = ui.inspect = null; renderGame(); }
    });

    window.addEventListener('resize', () => {
      if (ui.screen === 'game') resizeCanvas();
      if (ui.screen === 'victory') startVictoryAnimation(victoryKind);
    });
    document.addEventListener('visibilitychange', () => {
      state.stats.lastActive = Date.now();
      save();
    });
    window.addEventListener('pagehide', save);
    document.addEventListener('keydown', (e) => {
      if (ui.screen !== 'game' || ui.commandOpen) return;
      const tag = (e.target && e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
      const k = e.key.toLowerCase();
      if (k === 'q') { e.preventDefault(); stepDeployRatio(-0.1); }
      else if (k === 'e') { e.preventDefault(); stepDeployRatio(0.1); }
      else if (k === 'd') { e.preventDefault(); openDiplomacyModal(); }
      else if (k === 'i') { e.preventDefault(); openWarRoom(); }
      else if (k === ' ' && state.match) { e.preventDefault(); performAction({ type: state.match.tickMs > 0 ? 'tick' : 'end_turn' }); }
    });
    // Host-sequenced real-time ticks. Offline campaigns tick locally; online
    // matches only the host emits packets so all clients stay in lockstep.
    setInterval(() => {
      const m = state.match;
      if (!m || m.over || !m.tickMs) return;
      const now = Date.now();
      if (now - (m.lastTickAt || 0) < m.tickMs) return;
      m.lastTickAt = now;
      if (isShared()) {
        if (lobby && lobby.state.room && lobby.meshReady() && lobby.isHost()) lobby.hostGameIntent({ type: 'tick', intentId: uid('a'), by: lobby.selfId });
      } else {
        performAction({ type: 'tick' });
      }
    }, 200);
    window.addEventListener('online', () => { renderHeader(); toast('Back online — relay available.', 'success'); });
    window.addEventListener('offline', () => { renderHeader(); toast('Offline mode — campaign still playable.'); });
  }

  function sendChat() {
    const input = $('chatInput');
    const text = input.value.trim().slice(0, 140);
    if (!text) return;
    lobby.send('chat', { text });
    input.value = '';
  }

  function confirmIAP(item) {
    openModal({
      title: 'Simulated purchase',
      sub: 'NO REAL PAYMENT IS PROCESSED — this is an offline demo storefront.',
      html: `<div class="odds-box"><span>${esc(item.name)}</span><b>◆ +${item.gems} Gems</b></div>
        <div class="odds-box" style="margin-top:8px"><span>Display price</span><b>${esc(item.price)}</b></div>
        <p class="hint">Pressing confirm grants the Gems locally and records a simulated receipt in localStorage. No billing API, network request or charge is involved.</p>`,
      actions: [
        { label: 'COMPLETE SIMULATED PURCHASE', kind: 'btn-primary', onClick: (close) => {
            state.wallet.gems += item.gems;
            state.receipts.push({ id: uid('receipt'), item: item.id, gems: item.gems, price: item.price, simulated: true, ts: Date.now() });
            close(); save(); refreshAll();
            toast(`◆ +${item.gems} Gems (simulated)`, 'success');
          } },
        { label: 'CANCEL', kind: 'btn-ghost', onClick: (close) => close() }
      ]
    });
  }

  function buySupply(item) {
    if (state.wallet.coins < item.coins) return toast('Not enough Battle Coins.', 'error');
    if (item.id === 'reinforce' && (!state.match || state.match.over)) return toast('Start a campaign first.', 'error');
    if (item.id === 'shield' && (!state.match || state.match.over)) return toast('Start a campaign first.', 'error');
    state.wallet.coins -= item.coins;
    if (item.id === 'warhead') {
      if (state.match && !state.match.over) { state.match.warheads++; state.match.nukeUnlocked = true; }
      else { state.warheadsBank = (state.warheadsBank || 0) + 1; toast('Warhead banked — it joins your next campaign.'); }
    }
    if (item.id === 'reinforce') {
      const cap = state.match.territories.find((t) => t.capital === me()) || state.match.territories.find((t) => t.owner === me());
      if (cap) { cap.troops += 40; floatText(cap, '+40', '#f5be4a'); }
    }
    if (item.id === 'shield') {
      const cap = state.match.territories.find((t) => t.capital === me()) || state.match.territories.find((t) => t.owner === me());
      if (cap) cap.defended = Math.max(cap.defended, 3);
    }
    if (item.id === 'xp') state.stats.xp += 120;
    checkAchievements(); save(); refreshAll();
    toast(`${item.name} acquired`, 'success');
  }

  function setupPWA() {
    let deferred = null;
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault(); deferred = e;
      $('btnInstall').hidden = false;
    });
    $('btnInstall').addEventListener('click', async () => {
      if (!deferred) return;
      deferred.prompt();
      const choice = await deferred.userChoice;
      if (choice.outcome === 'accepted') toast('RoFrontier installed — see you on the home screen!', 'success');
      deferred = null;
      $('btnInstall').hidden = true;
    });
    window.addEventListener('appinstalled', () => { $('btnInstall').hidden = true; toast('Installed as a PWA.', 'success'); });

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').then((reg) => {
        reg.addEventListener('updatefound', () => {
          const worker = reg.installing;
          if (!worker) return;
          worker.addEventListener('statechange', () => {
            if (worker.state === 'installed' && navigator.serviceWorker.controller) {
              toast('Update ready — reload to apply the new build.');
            }
          });
        });
      }).catch((err) => console.warn('[RoFrontier] SW registration failed', err));
    }
    // Handle PWA shortcuts (?screen=setup / ?screen=lobby).
    const params = new URLSearchParams(location.search);
    const target = params.get('screen');
    if (target && ['home', 'setup', 'game', 'store', 'vault', 'lobby', 'admin'].includes(target)) {
      if (target === 'game' && (!state.match || state.match.over)) showScreen('setup');
      else showScreen(target);
    }
  }

  function init() {
    canvas = $('mapCanvas');
    g = canvas.getContext('2d');
    victoryCanvas = $('victoryCanvas');
    vg = victoryCanvas.getContext('2d');
    // Hydrate the saved world now that all map constants are initialised.
    if (state.match) state.match = hydrateMatch(state.match);
    else map = generateMap('49');
    // Never leave an unowned cosmetic equipped (e.g. after a profile rename).
    Object.entries(state.cosmetics.equipped).forEach(([type, id]) => {
      if (!isOwned(type, id)) {
        const fallback = COSMETICS[type]?.find((x) => x.unlock?.type === 'free');
        if (fallback) state.cosmetics.equipped[type] = fallback.id;
      }
    });
    setupAdmin();
    ensureDaily();
    setupLobby();
    setupEvents();
    setupCanvasInput();
    showScreen('title');
    setupPWA(); // may override the screen via PWA shortcut query parameters
    $('appVersion').textContent = `v${VERSION} · PWA`;
    $('commandQuick').innerHTML = (window.RF_ADMIN_META
      ? ['/help', '/god_mode', '/spawn_troops T01 100', '/conquer_all', '/whoami']
        .map((c) => `<button class="quick-cmd" data-cmd="${c}" type="button">${c}</button>`).join('') : '');
    setInterval(tickPlaytime, 5000);
    setInterval(() => { if (state.settings.autoSave) save(); }, 20000);
    requestAnimationFrame(frame);
    save();

    // Opt-in instrumentation for tools/smoke-test.js (?rf_test=1). It exposes
    // read access to the same state that is already in localStorage.
    if (new URLSearchParams(location.search).get('rf_test') === '1') {
      window.__RF_TEST__ = {
        get state() { return state; }, get map() { return map; },
        get ui() { return ui; }, get view() { return view; },
        get admin() { return admin; }, get lobby() { return lobby; },
        T, resolveAttack, transferTroops, buildStructure, launchNuke,
        conquerAll, endTurn, startMatch, fortify, showScreen, save,
        performAction, applyGameAction, applyRemoteSnapshot,
        nukeUnlocked, areAllied, setAlliance, realtimeTick,
        deployRatio, setDeployRatio, openDiplomacyModal, openWarRoom, battleCoins,
        TERRAINS, BUILDINGS, AI_FACTIONS, REALTIME
      };
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
