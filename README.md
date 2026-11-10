# RoFrontier — Global Conquest

A complete, mobile-first **Progressive Web App** real-time grand-strategy game inspired by *RoWorld*. Built with plain HTML5 Canvas, CSS and vanilla JavaScript — no frameworks, no build step, no CDN, no paid services. Playable **offline after install** against smart AI bots, and **online with real people** through a free public relay (plus the bundled zero-dependency WebSocket server). Includes a simulated storefront, cosmetics, playtime rewards, and an exclusive owner/developer console.

> **Developed by CoMeBacK_49** — registered Owner / Developer with exclusive admin powers.

---

## Quick start

```bash
# 1. Static hosting (any web server works; the PWA needs http/https, not file://)
python3 -m http.server 3000 --bind 0.0.0.0
# open http://localhost:3000

# OR use the included zero-dependency static server + WebSocket lobby relay
node server.js 3000
```

`server.js` also runs in the Arena live preview (`node server.js`, port 3000, bound to `0.0.0.0`). It serves the app and hosts `/ws` so **online lobbies are genuinely real-time** between two browser windows. No npm install is required: the WebSocket protocol is implemented natively with Node's `http`/`crypto` modules.

**Deploying to free static hosting (Vercel / Netlify / GitHub Pages):** no server process is needed. `free-relay.js` speaks MQTT 3.1.1 over secure WebSockets to free anonymous public brokers (`broker.emqx.io`, `broker.hivemq.com`, `test.mosquitto.org`). There is no account, no API key, no billing and nothing to configure — upload the repository as a static site and room codes work across devices and networks. The client tries the same-origin `/ws` relay and the public bus at the same time, de-duplicates packets by message id, and uses whichever is reachable. Set `state.settings.wsUrl` (Settings → WebSocket relay URL) to point at your own relay if you host one later.

> Public test brokers are shared, unauthenticated and best-effort: they are perfect for a free game, but they offer no privacy or uptime guarantee and are rate-limited. Room codes are unguessable-ish 6-character strings, not secrets. For a private deployment, run `server.js` or set your own relay URL.

> The service worker only activates over `http(s)` (or localhost). Once installed, the entire shell — `index.html`, `style.css`, `game.js`, `admin.js`, `free-relay.js`, `manifest.json`, icons — is pre-cached. Offline campaigns, the store, cosmetics, achievements and the local lobby simulation all keep working with the network disconnected.

### Install on Android

Chrome → ⋮ → **Add to Home screen / Install app**. `manifest.json` ships 192px, 512px and 512px maskable PNG icons, standalone display, theme colours, shortcuts (`?screen=setup`, `?screen=lobby`) and `display_override`. The in-app **INSTALL APP** button appears when the browser fires `beforeinstallprompt`.

---

## Files

| File | Purpose |
| --- | --- |
| `index.html` | All screens: title, command center, campaign setup, canvas game, store, vault, lobby, owner console, victory. |
| `style.css` | Mobile-first UI: safe-area insets, 44px+ touch targets, bottom nav, bottom-sheet modals, dark command-table theme. |
| `game.js` | World generator, canvas renderer, pinch/pan/touch engine, combat, economy, buildings, nukes, AI, turn cycle, progression, store, cosmetics, daily challenges, playtime track, WebSocket lobby client, owner API, PWA bootstrap. |
| `admin.js` | Owner identity verification (salted SHA-256), session binding, command parser/registry and console log. |
| `free-relay.js` | Dependency-free MQTT 3.1.1 over WSS client (CONNECT/SUBSCRIBE/PUBLISH/PING) for the free public cross-device relay. |
| `manifest.json` | Installable PWA metadata and icons. |
| `sw.js` | Offline-first app-shell cache: network-first navigation, stale-while-revalidate assets, versioned cache cleanup, WebSocket bypass. |
| `vercel.json` | Static-hosting headers (no-cache service worker, correct SW scope, security headers) for one-click free Vercel deploys. |
| `server.js` | Optional static server + native WebSocket room relay (`/ws`) + channel broadcast bus. |
| `icons/*` | Generated PNG/SVG app icons (regenerate with `python3 tools/make_icons.py`). |
| `tools/make_icons.py` | Pure-stdlib icon rasteriser (no Pillow needed). |
| `tools/smoke-test.js` | Optional headless DOM test (map, UI, combat, economy, lobby, store, owner commands, victory, reset). Run `npm install --no-save jsdom && node tools/smoke-test.js`. |
| `tools/multiplayer-test.js` | Two independent jsdom clients join one room over the real `/ws` relay and assert byte-identical lockstep state after a dice attack and a full AI turn. Run `node server.js 3100 &` then `node tools/multiplayer-test.js 3100`. |
| `tools/free-relay-test.js` | In-process mock MQTT broker verifies `free-relay.js` packet encoding, subscriptions and room isolation without any network. |
| `tools/roworld-test.js` | Offline regression test for terrain, 12 tribes, Q/E deployment, alliances, SAM/silo and deterministic real-time ticks. |

Everything persists in `localStorage` under `rofrontier.save.v2` (profile, wallet, cosmetics, unlocks, achievements, daily challenges, playtime, receipts and the full active campaign). The world geometry is regenerated deterministically from the match seed, so saves stay small.

---

## How to play

1. **New Conquest** → set commander name, AI difficulty (Recruit / Commander / Warlord / Legend), 1–12 rival tribes, battle speed (turn-based / real-time 2s / blitz 1s), nation theme, map skin and world seed → **Deploy Troops**. Online lobbies support up to 8 real commanders plus AI tribes filling the rest.
2. **Map controls (touch-first):** drag to pan, pinch or `＋ / −` to zoom, `⊙` to fit the whole world. Tap one of your regions, then tap a neighbour. A second tap on the target opens the attack/transfer dialog immediately. Long-press one of your regions to fortify it. **Q / E** change the global deployment ratio (10–90%); **D** opens Diplomacy; **Space** forces a real-time tick.
3. **Orders:** `⚔ Attack` (dice-based Risk-style combat with a live odds estimate and deployment presets), `⇄ Transfer`, `⬟ Defend` (+35% defence for 2 turns), `⚙ Build`, `☢ Nuke`, `◎ Info`, `⚑ Allies`, `END TURN` (or `FORCE TICK` in real-time mode).
4. **Terrain & economy:** every region is **Plains** (+10% attack, +1 recruit), **Highlands** (+12% defence) or **Mountains** (+32% defence, −10% attack); coasts are biased toward Plains for fast early expansion. Each tick grants income + recruits. **City** = +6 coins & +1 recruit, **Port** = naval transport (coastal only), **Factory** = +2 recruits. Continent control adds a bonus. Fallout blocks recruitment.
   - **Defense Post** = +25% permanent defence, **SAM Site** = intercepts a nuclear strike on itself or a neighbour, **Missile Silo** = instant nuke unlock + 2 warheads.
5. **Late game:** nuclear weapons unlock at commander level 5, turn 12 or with a Missile Silo. A strike neutralises the target (4 turns of fallout), destroys its buildings and removes 55% of neighbouring garrisons unless a SAM intercepts it. Hard/insane AI can strike back after turn 14.
6. **Diplomacy:** sign pacts with human commanders or AI tribes. Allies cannot attack each other, earn shared trade income and can win together at 80% combined control — real co-op with bots and people.
7. **Victory:** hold **80%** of all 75 regions alone or with allies, or eliminate every non-allied rival. Losing all your regions ends the campaign. The victory screen shows stats, rewards, an equipped celebration animation and *Developed by CoMeBacK_49*.

The world is a 17×11 hex globe with 7 continents, 75 territories (`T01` … `T75`), seeded terrain, explicit land adjacency and BFS-derived naval sea lanes. Borders, army counters, faction colours, structure glyphs, selection/target highlights, fallout and particles are all drawn on `<canvas>` with device-pixel-ratio scaling; labels are drawn in screen space so they stay readable at any zoom.

### Progression

- **Gems** (premium) and **Battle Coins** (soft) from conquests, turns, wins, daily challenges, playtime rewards and the store.
- **Simulated IAP** gem packs with display prices: a confirmation sheet explicitly states *no real payment is processed*, then grants gems and records a simulated local receipt.
- **Cosmetic Vault:** nation colour themes, map skins, army icons, victory animations, unit badges. Unlock with coins/gems, achievements, playtime tiers — or automatically for the owner.
- **Playtime reward track:** 5 min → Midnight map, 15 min → Rapid Mobilisation trait, 30 min → Blitz icon, 60 min → Satellite map, 2 h → Fortified Doctrine, 5 h → Neon map + Veteran badge, 10 h → Blitzkrieg trait. Traits are passive (+1 factory recruit, +10% defence, +8% attack).
- **Daily challenges:** 3 seeded challenges per calendar day (conquer, build, turns, nuke, win, naval…), progress bars and claimable rewards.
- **Achievements:** 9 milestones that also unlock cosmetics (e.g. World Conqueror → Solar Empire colour + Victory Rays).

---

## Owner / Developer console — CoMeBacK_49

**Access is exclusive.** Three gates:

1. The Owner ID must be exactly `CoMeBacK_49`.
2. The access key is verified against a **salted SHA-256 digest** in `localStorage`.
3. The unlock token is bound to the active profile name — renaming the profile away from `CoMeBacK_49` immediately revokes admin powers, and every command re-checks the unlock state.

**Bootstrap key for local installs:**

```
COMEBACK-49-OWNER-2049
```

Open **Owner** in the bottom nav (or tap *Developed by CoMeBacK_49* on the title screen **5 times**, or press `>_` inside a match), enter the ID and key, then **UNLOCK CONSOLE**. The *WHY IS THIS RESTRICTED?* dialog can fill the bootstrap key for you on a local install. Replace it with your own private key via **CHANGE KEY** or `/owner_key [new_key]`.

### Commands

| Command | Effect |
| --- | --- |
| `/give_currency [amount] [gems\|coins\|both]` | Instantly grants Gems and/or Battle Coins (default: both). |
| `/nuke [territory_id]` | Free instant strike on a region (IDs like `T12`; names also work). |
| `/conquer_all` | Claims **80%** of the map instantly and triggers the victory test screen. |
| `/god_mode [on\|off]` | Prevents territory loss + infinite manpower (toggle). |
| `/spawn_troops [territory_id] [amount]` | Adds troops directly to a region. |
| `/help [command]` | Lists commands / shows detail. |
| `/whoami` | Owner session, flags and match info. |
| `/set_turn [n]`, `/warheads [n]` | Jump to late-game state / set stockpile. |
| `/unlock_all` | Unlock all cosmetics, traits and achievements for QA. |
| `/reveal` | Compact world report (owner counts, strongest garrisons, IDs). |
| `/end_match [victory\|defeat]` | Force the result screen. |
| `/reset_progress --confirm` | Wipe the local save. |
| `/owner_key [new_key]`, `/clear` | Replace the access key / clear the log. |

Command history (↑ in the console input), quick-command chips and an in-match command bar are included. Output is colour-coded and mirrored to toasts.

> **Security note:** this is an offline, client-side game. A determined user can edit JavaScript or `localStorage`; the owner gate protects the UI and save flow, not a server. Real authoritative admin powers would require server-side verification — the included relay is intentionally limited to lobby state.

---

## Online mode — real cross-device play

The lobby is a **lockstep mesh**, not a fake "online" label. The room creator is the authority: it assigns seats, sequences every command and owns the authoritative match state. Every device replays the same ordered command stream against the same seeded RNG, so PvP **and** co-op with AI bots stay in sync.

- **No paid infrastructure.** Two free transports are attempted in parallel and de-duplicated by message id:
  1. the bundled same-origin `/ws` relay (`server.js`, native RFC 6455, zero npm dependencies);
  2. a free anonymous public MQTT-over-WSS bus (`free-relay.js`) which works from purely static hosting with no server, account or API key.
- **Rooms:** create a room → share the 6-character code → the other player joins from any device/network → ready up → host presses **START MATCH**. Each human gets a real faction; empty seats are filled by AI bots.
- **Lockstep commands:** `attack`, `transfer`, `build`, `fortify`, `nuke`, `end_turn` and all owner QA commands are packed as small action objects. The host stamps a monotonically increasing `seq`; each client applies it via `applyGameAction()` and rejects duplicates/out-of-order packets, requesting a full state snapshot when it detects a gap.
- **Determinism:** combat dice, AI scoring/builds/strikes, terrain and world generation use a shared seeded PRNG (`grng()` / `mulberry32`), never `Math.random()`. Local-only data (wallet, XP, cosmetics, achievements, saved campaigns) is kept out of the replicated state, so different devices never diverge because of different unlocks.
- **Delta-only sync + client-side prediction:** a tap paints an instant pulsing order marker while the host validates and broadcasts a tiny JSON command (an attack is ~80 bytes) rather than a full world snapshot. The marker clears as soon as the sequenced delta is applied. Real-time ticks are the same: one small packet per tick for up to 20 nations.
- **Resilience:** heartbeat every 1.5 s; if the host drops out the lowest-id client automatically takes over authority. Late joiners and lagged clients receive a `game_state` snapshot and resume mid-match. Disconnected clients can keep playing their saved campaign offline and re-sync later.
- **Offline fallback:** if neither relay is reachable (or the device is offline), the lobby switches to its **local simulation** — create/join/ready/chat/start and AI lobby bots still work, and a full bots-only campaign launches. Installed PWA play never depends on a network.

Legacy `/ws` room messages (`hello`, `create_room`, `join_room`, `ready`, `chat`, `start`, `leave`, `ping`) remain supported for custom relays. The mesh adds `subscribe` + `relay` channel broadcasts:

```json
{ "type": "subscribe", "code": "A1B2C3" }
{ "type": "relay", "code": "A1B2C3", "data": { "kind": "game_action", "seq": 7,
    "action": { "type": "attack", "from": "T01", "to": "T07", "troops": 9 } } }
```

Other mesh kinds: `room_state`, `cmd` (`join_request` / `ready` / `leave` / `start`), `chat`, `match_start`, `game_intent`, `host_state`, `state_request`, `game_state`. Rooms are ephemeral, capped at 6 human players, with automatic host migration.

---

## PWA / offline details

- `sw.js` pre-caches the complete shell on install, uses `skipWaiting` + `clients.claim()`, deletes old versioned caches on activate, serves navigations network-first with a cached `index.html` fallback, and static assets stale-while-revalidate.
- WebSocket upgrades, non-GET requests and cross-origin URLs are never intercepted.
- `GET_VERSION`, `SKIP_WAITING`, `CACHE_URLS` messages, plus a push/notificationclick handler, are included for future use.
- `navigator.onLine` / `online` / `offline` events drive the header connection badge and toasts.
- All assets are local and relative — no external fonts, images or scripts. The only outbound connection is the optional multiplayer relay; it is never needed for offline play.

## Notes

- `level()` is linear (150 XP/level): level 2 → Ports, level 3 → Factories, level 5 → nuclear programme.
- The AI evaluates every frontier by strength ratio, capital/city value and difficulty aggression, builds ports/factories over time, honours alliances and uses late-game tactical strikes on Warlord/Legend.
- **Real-time mode** runs a deterministic world tick every 1–2 s. In online matches only the host emits ticks as sequenced commands, so 20 nations stay in lockstep without streaming full maps — smaller than the per-cell deltas a typical MMO sends.
- All gameplay randomness (dice, AI scoring, terrain generation) uses a seeded PRNG; only cosmetic particles use `Math.random()`.
- Reduce motion, auto-save, profile name and relay URL are configurable in Settings.
- Verify locally:
  ```bash
  node --check game.js admin.js sw.js server.js free-relay.js tools/*.js
  node tools/smoke-test.js
  node tools/free-relay-test.js
  node tools/roworld-test.js
  node server.js 3100 & node tools/multiplayer-test.js 3100
  ```
  `jsdom` is the only optional dev dependency (`npm install --no-save jsdom`); the game itself has no dependencies.
- Regenerate icons: `python3 tools/make_icons.py` (pure stdlib).
