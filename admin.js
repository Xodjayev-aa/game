/* ============================================================
   RoFrontier — Owner / Developer Console  (admin.js)
   ------------------------------------------------------------
   Exclusive administrative powers for the registered owner
   "CoMeBacK_49". Loaded before game.js; exposes window.AdminSystem.

   Access model (client-side demo):
     * Owner ID must be exactly CoMeBacK_49.
     * An access key is verified against a salted SHA-256 digest kept in
       localStorage. The bootstrap key ships with the project README so a
       local install can be claimed; the owner can replace it afterwards.
     * The unlock token is bound to the owner ID AND the active profile
       name. Renaming the profile away from CoMeBacK_49 locks the console.
     * Every command re-checks the unlock state. Nothing here is a security
       boundary against a determined client (see README "Security note").

   game.js supplies the command implementations through `getContext()`.
   ============================================================ */
(function (global) {
  'use strict';

  const OWNER_ID = 'CoMeBacK_49';
  const BOOTSTRAP_KEY = 'COMEBACK-49-OWNER-2049';
  const OWNER_STORE = 'rofrontier.owner.v1';
  const HISTORY_STORE = 'rofrontier.admin.history.v1';
  const BOOTSTRAP_SALT = 'rofrontier-bootstrap-salt-v1';

  /* ---------- small helpers ---------------------------------- */
  const safeStorage = {
    get(key) { try { return global.localStorage.getItem(key); } catch (_) { return null; } },
    set(key, value) { try { global.localStorage.setItem(key, value); } catch (_) { /* private mode */ } },
    remove(key) { try { global.localStorage.removeItem(key); } catch (_) { /* noop */ } }
  };

  function readJSON(key, fallback) {
    try { return JSON.parse(safeStorage.get(key)) ?? fallback; } catch (_) { return fallback; }
  }
  function writeJSON(key, value) { safeStorage.set(key, JSON.stringify(value)); }

  function randomHex(bytes) {
    const arr = new Uint8Array(bytes);
    if (global.crypto && global.crypto.getRandomValues) global.crypto.getRandomValues(arr);
    else for (let i = 0; i < bytes; i++) arr[i] = Math.floor(Math.random() * 256);
    return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  function fallbackHash(text) {
    // Deterministic non-cryptographic fallback for engines without SubtleCrypto.
    let h1 = 0x811c9dc5, h2 = 0x01000193;
    for (let i = 0; i < text.length; i++) {
      h1 = Math.imul(h1 ^ text.charCodeAt(i), 16777619) >>> 0;
      h2 = Math.imul(h2 + text.charCodeAt(i) + i, 2246822519) >>> 0;
    }
    return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
  }

  async function digest(salt, key) {
    const input = `rofrontier|${salt}|${key}`;
    try {
      if (global.crypto && global.crypto.subtle && global.TextEncoder) {
        const buf = await global.crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
        return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
      }
    } catch (_) { /* fall through */ }
    return fallbackHash(input);
  }

  function tokenize(text) {
    const out = [];
    const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
    let m;
    while ((m = re.exec(text)) !== null) out.push(m[1] ?? m[2] ?? m[3]);
    return out;
  }

  function levenshtein(a, b) {
    const row = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      let prev = row[0]; row[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const tmp = row[j];
        row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
        prev = tmp;
      }
    }
    return row[b.length];
  }

  function parseAmount(raw, max = 1e9) {
    const n = Number(String(raw).replace(/[,_\s]/g, ''));
    if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0 || n > max) return null;
    return n;
  }

  /* ---------- command registry ------------------------------- */
  const COMMANDS = {
    give_currency: {
      usage: '/give_currency [amount] [gems|coins|both]',
      desc: 'Instantly grant Gems and/or Battle Coins.',
      min: 1, max: 2, ownerOnly: true,
      run(ctx, args) {
        const amount = parseAmount(args[0]);
        if (amount === null) return { ok: false, message: 'Amount must be a whole number from 1 to 1,000,000,000.' };
        const kind = (args[1] || 'both').toLowerCase();
        if (!['gems', 'coins', 'both'].includes(kind)) return { ok: false, message: 'Currency must be gems, coins or both.' };
        const result = ctx.api.giveCurrency(amount, kind);
        return { ok: true, message: result || `Granted ${amount} ${kind === 'both' ? 'Gems and Battle Coins' : kind}.` };
      }
    },
    nuke: {
      usage: '/nuke [territory_id]',
      desc: 'Instantly strike a target region (free, bypasses warheads).',
      min: 1, max: 1, ownerOnly: true,
      run(ctx, args) {
        const result = ctx.api.nuke(args[0], { admin: true, free: true });
        return result.ok
          ? { ok: true, message: `☢ Strike confirmed on ${result.target}. ${result.detail}` }
          : { ok: false, message: result.message };
      }
    },
    conquer_all: {
      usage: '/conquer_all',
      desc: 'Claim 80% of the map instantly to trigger victory test screens.',
      min: 0, max: 0, ownerOnly: true,
      run(ctx) {
        const result = ctx.api.conquerAll();
        return result.ok
          ? { ok: true, message: `⚑ Owner decree: ${result.count} regions claimed (${result.percent}% of the world). Victory condition evaluated.` }
          : { ok: false, message: result.message };
      }
    },
    god_mode: {
      usage: '/god_mode [on|off]',
      desc: 'Toggle invulnerability: no territory loss + infinite manpower.',
      min: 0, max: 1, ownerOnly: true,
      run(ctx, args) {
        const explicit = args[0] ? String(args[0]).toLowerCase() : null;
        if (explicit && !['on', 'off', 'true', 'false', '1', '0'].includes(explicit)) {
          return { ok: false, message: 'Use /god_mode on or /god_mode off.' };
        }
        const state = ctx.api.setGodMode(explicit ? ['on', 'true', '1'].includes(explicit) : undefined);
        return { ok: true, message: `God mode ${state ? 'ENABLED' : 'DISABLED'}${state ? ' — territories cannot fall, manpower is unlimited.' : '.'}` };
      }
    },
    spawn_troops: {
      usage: '/spawn_troops [territory_id] [amount]',
      desc: 'Add troops directly to a selected region.',
      min: 2, max: 2, ownerOnly: true,
      run(ctx, args) {
        const amount = parseAmount(args[1]);
        if (amount === null) return { ok: false, message: 'Amount must be a whole number from 1 to 1,000,000,000.' };
        const result = ctx.api.spawnTroops(args[0], amount);
        return result.ok
          ? { ok: true, message: `Deployed ${amount} troops to ${result.target} (now ${result.troops}).` }
          : { ok: false, message: result.message };
      }
    },
    help: {
      usage: '/help [command]',
      desc: 'List all owner commands, or show detail for one.',
      min: 0, max: 1,
      run(_ctx, args) {
        if (args[0]) {
          const key = String(args[0]).replace(/^\//, '').toLowerCase();
          const cmd = COMMANDS[key];
          if (!cmd) return { ok: false, message: `Unknown command: ${key}` };
          return { ok: true, lines: [`${cmd.usage}`, `  ${cmd.desc}`] };
        }
        return {
          ok: true,
          lines: [
            'ROFRONTIER OWNER COMMANDS — CoMeBacK_49',
            ...Object.entries(COMMANDS).map(([name, cmd]) => `  ${cmd.usage.padEnd(42)} ${cmd.desc}`),
            'Territory IDs look like T01, T42. Names also work. Run /help [command] for detail.'
          ]
        };
      }
    },
    whoami: {
      usage: '/whoami',
      desc: 'Show the authenticated owner session and game flags.',
      min: 0, max: 0,
      run(ctx, _args, admin) {
        return {
          ok: true,
          lines: [
            `identity   : ${OWNER_ID} (OWNER / DEVELOPER)`,
            `profile    : ${ctx.profileName}`,
            `session    : ${admin.getSession().token.slice(0, 10)}… (bound to ${OWNER_ID})`,
            `god_mode   : ${ctx.api.isGodMode() ? 'ON' : 'OFF'}`,
            `match      : ${ctx.match ? `#${ctx.match.id} · turn ${ctx.match.turn} · ${ctx.match.mode}` : 'none'}`,
            `build      : RoFrontier v1.3.0 · Developed by CoMeBacK_49`
          ]
        };
      }
    },
    set_turn: {
      usage: '/set_turn [number]',
      desc: 'Jump to a turn (useful for late-game nuke testing).',
      min: 1, max: 1,
      run(ctx, args) {
        const n = parseAmount(args[0], 9999);
        if (n === null) return { ok: false, message: 'Turn must be a whole number from 1 to 9999.' };
        return { ok: true, message: ctx.api.setTurn(n) };
      }
    },
    warheads: {
      usage: '/warheads [amount]',
      desc: 'Set the nuclear warhead stockpile.',
      min: 1, max: 1,
      run(ctx, args) {
        const n = parseAmount(args[0], 999);
        if (n === null) return { ok: false, message: 'Amount must be a whole number from 1 to 999.' };
        return { ok: true, message: ctx.api.setWarheads(n) };
      }
    },
    unlock_all: {
      usage: '/unlock_all',
      desc: 'Unlock every cosmetic, trait and achievement (owner QA).',
      min: 0, max: 0,
      run(ctx) { return { ok: true, message: ctx.api.unlockAll() }; }
    },
    reveal: {
      usage: '/reveal',
      desc: 'Print a compact report of the current world state.',
      min: 0, max: 0,
      run(ctx) {
        const lines = ctx.api.reveal();
        return { ok: true, lines };
      }
    },
    end_match: {
      usage: '/end_match [victory|defeat]',
      desc: 'Force the result screen (victory test).',
      min: 0, max: 1,
      run(ctx, args) {
        const outcome = (args[0] || 'victory').toLowerCase();
        if (!['victory', 'defeat'].includes(outcome)) return { ok: false, message: 'Use victory or defeat.' };
        return { ok: true, message: ctx.api.endMatch(outcome) };
      }
    },
    reset_progress: {
      usage: '/reset_progress --confirm',
      desc: 'Wipe all local saves (requires --confirm).',
      min: 1, max: 1,
      run(ctx, args) {
        if (args[0] !== '--confirm') return { ok: false, message: 'Destructive. Run /reset_progress --confirm' };
        return { ok: true, message: ctx.api.resetProgress() };
      }
    },
    owner_key: {
      usage: '/owner_key [new_key]',
      desc: 'Replace the bootstrap key with a private owner key.',
      min: 1, max: 1,
      async run(_ctx, args, admin) {
        const key = String(args[0]);
        if (key.length < 6) return { ok: false, message: 'Key must be at least 6 characters.' };
        await admin.changeKey(key);
        return { ok: true, message: 'Owner access key replaced. Store it safely — it is only hashed on this device.' };
      }
    },
    clear: {
      usage: '/clear',
      desc: 'Clear the console output.',
      min: 0, max: 0,
      run(_ctx, _args, admin) { admin.clearLog(); return { ok: true, silent: true }; }
    }
  };

  /* ---------- AdminSystem ------------------------------------ */
  class AdminSystem {
    /**
     * @param {object} options
     * @param {Function} options.getContext  () => ({state, match, profileName, api})
     * @param {Function} [options.onLog]     ({text, type, ts}) => void
     * @param {Function} [options.onChange]  () => void
     */
    constructor(options = {}) {
      this.getContext = options.getContext || (() => ({}));
      this.onLog = options.onLog || (() => {});
      this.onChange = options.onChange || (() => {});
      this.logs = [];
      this.history = readJSON(HISTORY_STORE, []);
      this.emit('RoFrontier owner console · v1.3.0', 'info');
      this.emit(`Registered owner: ${OWNER_ID}. Type /help for commands.`, 'info');
      if (!this.isUnlocked()) this.emit('LOCKED — verify owner identity + access key to run privileged commands.', 'warn');
    }

    static get OWNER_ID() { return OWNER_ID; }
    static get BOOTSTRAP_KEY() { return BOOTSTRAP_KEY; }
    static get COMMANDS() { return COMMANDS; }

    getOwnerRecord() { return readJSON(OWNER_STORE, null); }
    getSession() {
      const rec = this.getOwnerRecord();
      return rec && rec.session ? rec.session : { name: '', token: '' };
    }

    /** True only for the owner identity, a valid session token and matching profile. */
    isUnlocked() {
      const rec = this.getOwnerRecord();
      if (!rec || !rec.session || !rec.session.token || rec.session.name !== OWNER_ID) return false;
      let ctx = {};
      try { ctx = this.getContext() || {}; } catch (_) { return false; }
      if (!ctx.state || !ctx.state.profile) return false;
      return String(ctx.state.profile.name).toLowerCase() === OWNER_ID.toLowerCase();
    }

    /** Does the supplied key match the stored hash (or the bootstrap key)? */
    async checkKey(key) {
      const rec = this.getOwnerRecord();
      const salt = rec ? rec.salt : BOOTSTRAP_SALT;
      const hash = await digest(salt, String(key));
      return rec ? hash === rec.hash : hash === await digest(BOOTSTRAP_SALT, BOOTSTRAP_KEY);
    }

    /**
     * Verify owner identity + key, then persist an owner-bound session.
     * `onVerified` (from the context) lets game.js bind the profile identity.
     */
    async verify(name, key) {
      const typed = String(name || '').trim();
      if (typed.toLowerCase() !== OWNER_ID.toLowerCase()) {
        return { ok: false, message: 'Access denied. The owner ID is CoMeBacK_49 — this console is exclusive.' };
      }
      if (!key) return { ok: false, message: 'Enter the owner access key.' };
      if (!(await this.checkKey(key))) return { ok: false, message: 'Invalid access key. Access logged.' };

      const rec = this.getOwnerRecord() || {};
      const salt = rec.salt || randomHex(16);
      const saltChanged = !rec.salt;
      const record = {
        salt,
        hash: await digest(salt, saltChanged ? BOOTSTRAP_KEY : String(key)),
        session: { name: OWNER_ID, token: randomHex(24), since: Date.now() },
        bootstrapReplaced: !!rec.bootstrapReplaced
      };
      writeJSON(OWNER_STORE, record);
      try {
        const ctx = this.getContext();
        ctx.api?.onOwnerVerified?.();
      } catch (_) { /* context may not exist yet */ }
      this.emit(`✓ Owner verified: ${OWNER_ID}. Administrative powers enabled.`, 'ok');
      this.onChange();
      return { ok: true, message: `Welcome back, ${OWNER_ID}.` };
    }

    async changeKey(newKey) {
      const salt = randomHex(16);
      const rec = this.getOwnerRecord() || {};
      writeJSON(OWNER_STORE, {
        salt,
        hash: await digest(salt, String(newKey)),
        session: rec.session || { name: OWNER_ID, token: randomHex(24), since: Date.now() },
        bootstrapReplaced: true
      });
      this.onChange();
    }

    lock() {
      const rec = this.getOwnerRecord();
      if (rec) { rec.session = null; writeJSON(OWNER_STORE, rec); }
      this.emit('Console locked.', 'warn');
      this.onChange();
    }

    emit(text, type = 'info') {
      const entry = { text: String(text), type, ts: Date.now() };
      this.logs.push(entry);
      if (this.logs.length > 250) this.logs.splice(0, this.logs.length - 250);
      this.onLog(entry);
    }

    clearLog() {
      this.logs = [];
      this.emit('Console cleared.', 'info');
    }

    getQuickCommands() {
      return ['/help', '/give_currency 500', '/spawn_troops T01 250', '/god_mode', '/nuke T01', '/conquer_all', '/unlock_all', '/whoami', '/reveal'];
    }

    /** Execute a raw command line. Returns {ok, message, lines}. */
    async execute(raw) {
      const line = String(raw || '').trim();
      if (!line) return { ok: false, message: 'Empty command.' };
      this.history.push(line);
      if (this.history.length > 40) this.history.shift();
      writeJSON(HISTORY_STORE, this.history);
      this.emit(`> ${line}`, 'in');

      if (!line.startsWith('/')) {
        const out = { ok: false, message: 'Commands begin with "/" — try /help.' };
        this.emit(out.message, 'err');
        return out;
      }
      const parts = tokenize(line);
      const name = parts[0].slice(1).toLowerCase();
      const args = parts.slice(1);
      const cmd = COMMANDS[name];

      if (!cmd) {
        const near = Object.keys(COMMANDS)
          .map((k) => ({ k, d: levenshtein(name, k) }))
          .sort((a, b) => a.d - b.d)[0];
        const msg = `Unknown command "/${name}".${near && near.d <= 4 ? ` Did you mean /${near.k}?` : ' Try /help.'}`;
        this.emit(msg, 'err');
        return { ok: false, message: msg };
      }
      if (!this.isUnlocked()) {
        const msg = 'ACCESS DENIED — owner verification required. Exclusive to CoMeBacK_49.';
        this.emit(msg, 'err');
        return { ok: false, message: msg };
      }
      if (args.length < cmd.min || args.length > cmd.max) {
        const msg = `Usage: ${cmd.usage}`;
        this.emit(msg, 'err');
        return { ok: false, message: msg };
      }

      let ctx = {};
      try { ctx = this.getContext() || {}; } catch (err) {
        this.emit(`Context error: ${err.message}`, 'err');
        return { ok: false, message: err.message };
      }
      try {
        const result = await cmd.run(ctx, args, this);
        if (result && result.ok) {
          if (!result.silent) {
            if (result.message) this.emit(result.message, 'ok');
            if (result.lines) result.lines.forEach((l) => this.emit(l, 'info'));
          }
        } else if (result) {
          this.emit(result.message || 'Command failed.', 'err');
        }
        try { ctx.api?.afterCommand?.(name, result); } catch (_) { /* noop */ }
        return result || { ok: false, message: 'Command failed.' };
      } catch (err) {
        const msg = `Command error: ${err && err.message ? err.message : err}`;
        this.emit(msg, 'err');
        return { ok: false, message: msg };
      }
    }
  }

  global.AdminSystem = AdminSystem;
  global.RF_ADMIN_META = { OWNER_ID, BOOTSTRAP_KEY, COMMANDS };
})(typeof window !== 'undefined' ? window : globalThis);
