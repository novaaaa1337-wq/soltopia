// Soltopia game server: static files + WebSocket game state (wallet sign-in, worlds, inventories, trades, chat).
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const SG = require('./public/items.js');
const { ITEMS, SLOCK, DSLOCK, SEED, W, H, TS, MAX_STACK, BASE_SLOTS } = SG;
const MAX_SLOTS = 400;

const PORT = +process.env.PORT || 5173;
const CONFIG = {};

// ---------------- persistence ----------------
const DATA = path.join(__dirname, 'data');
fs.mkdirSync(path.join(DATA, 'worlds'), { recursive: true });
const readJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJSON = (f, v) => { fs.writeFileSync(f + '.tmp', JSON.stringify(v)); fs.renameSync(f + '.tmp', f); };
const accounts = readJSON(path.join(DATA, 'accounts.json'), {});
const worlds = new Map();          // name -> loaded world
const sessions = new Set();
let accountsDirty = false;

function saveAll() {
  writeJSON(path.join(DATA, 'accounts.json'), accounts);
  for (const w of worlds.values()) saveWorld(w);
  accountsDirty = false;
}
function saveWorld(w) {
  const { players, dmg, ...rest } = w;
  writeJSON(path.join(DATA, 'worlds', w.name + '.json'), rest);
}
setInterval(() => { if (accountsDirty) saveAll(); else for (const w of worlds.values()) if (w.dirty) { saveWorld(w); w.dirty = false; } }, 10000);
process.on('SIGINT', () => { saveAll(); process.exit(0); });

// ---------------- world gen ----------------
const rand = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
function genWorld(name) {
  const fg = new Array(W * H).fill(0), bg = new Array(W * H).fill(0), surf = [];
  let h = 24;
  for (let x = 0; x < W; x++) { if (Math.random() < .3) h += rand(-1, 1); h = Math.max(20, Math.min(28, h)); surf[x] = h; }
  for (let x = 0; x < W; x++) for (let y = surf[x]; y < H; y++) {
    const i = y * W + x, d = y - surf[x], r = Math.random();
    if (d > 0) bg[i] = 20;
    let v;
    if (y >= H - 2) v = 4;
    else if (d === 0) v = 5;
    else if (d < 4) v = r < .12 ? 10 : 1;
    else if (y > 42 && r < .06) v = 3;
    else if (y > 34 && r < .08) v = 12;
    else if (y > 48 && r < .095) v = 13;
    else v = r < .3 + d / 70 ? 2 : 1;
    fg[i] = v;
  }
  // a few caves
  for (let c = 0; c < 6; c++) {
    let cx = rand(5, W - 6), cy = rand(34, H - 8);
    for (let s = 0; s < 40; s++) {
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const x = cx + dx, y = cy + dy; if (x > 0 && x < W - 1 && y > 30 && y < H - 2) fg[y * W + x] = 0;
      }
      cx += rand(-1, 1); cy += rand(-1, 1);
    }
  }
  const dx = 50, dy = surf[dx] - 1;
  fg[dy * W + dx] = 8;
  return { name, fg, bg, trees: {}, drops: {}, owner: null, door: { x: dx, y: dy }, nextDrop: 1 };
}
function getWorld(name) {
  let w = worlds.get(name);
  if (w) return w;
  w = readJSON(path.join(DATA, 'worlds', name + '.json'), null) || genWorld(name);
  w.players = new Set(); w.dmg = {};
  worlds.set(name, w);
  return w;
}

// ---------------- helpers ----------------
const send = (s, o) => { if (s.ws.readyState === 1) s.ws.send(JSON.stringify(o)); };
const bcast = (w, o, except) => { const m = JSON.stringify(o); for (const s of w.players) if (s !== except && s.ws.readyState === 1) s.ws.send(m); };
const msg = (s, text) => send(s, { t: 'msg', text });
const pub = (s) => ({ name: s.name, x: s.x, y: s.y, vx: 0, f: s.f, g: true, worn: s.acc.worn, level: s.acc.level });
function sendInv(s) {
  const a = s.acc;
  send(s, { t: 'inv', inv: a.inv, gems: a.gems, worn: a.worn, wallet: a.wallet || null, level: a.level, xp: a.xp, need: xpNeed(a.level), slots: a.slots, upCost: upgradeCost(a) });
}

// ---------------- levels ----------------
const xpNeed = (lvl) => Math.floor(40 * Math.pow(lvl, 1.6));
function migrate(acc) {
  acc.level ??= 1; acc.xp ??= 0; acc.created ??= Date.now(); acc.slots ??= BASE_SLOTS;
  acc.stats = { broken: 0, harvested: 0, planted: 0, spliced: 0, trades: 0, ...(acc.stats || {}) };
}
function stat(s, key, n = 1) { s.acc.stats[key] += n; accountsDirty = true; }
function addXp(s, n) {
  const a = s.acc;
  if (a.level >= 125) return;
  a.xp += n;
  let up = false;
  while (a.xp >= xpNeed(a.level) && a.level < 125) { a.xp -= xpNeed(a.level); a.level++; up = true; }
  accountsDirty = true;
  if (up && s.world) {
    bcast(s.world, { t: 'levelup', name: s.name, level: a.level });
    bcast(s.world, { t: 'chat', from: '', text: `⭐ ${s.name} reached level ${a.level}!` });
  }
  sendInv(s);
}
function addItem(acc, id, n) { acc.inv[id] = (acc.inv[id] || 0) + n; if (acc.inv[id] <= 0) delete acc.inv[id]; accountsDirty = true; }
function fixWorn(s) {  // unequip anything no longer owned
  let changed = false;
  for (const [slot, id] of Object.entries(s.acc.worn)) if (!s.acc.inv[id]) { delete s.acc.worn[slot]; changed = true; }
  if (changed && s.world) bcast(s.world, { t: 'pwear', name: s.name, worn: s.acc.worn });
}
const isLockId = (id) => id === SLOCK || id === DSLOCK;
const usedSlots = (inv) => Object.keys(inv).filter((k) => inv[k] > 0).length;
// Would the backpack still be valid after taking `remove` out and putting `add` in?
function fits(acc, add, remove = {}) {
  const inv = { ...acc.inv };
  for (const [id, n] of Object.entries(remove)) { inv[id] = (inv[id] || 0) - n; if (inv[id] <= 0) delete inv[id]; }
  for (const [id, n] of Object.entries(add)) { inv[id] = (inv[id] || 0) + n; if (!isLockId(+id) && inv[id] > MAX_STACK) return false; }
  return usedSlots(inv) <= acc.slots;
}
function room(acc, id) {
  if (acc.inv[id]) return isLockId(id) ? Infinity : Math.max(0, MAX_STACK - acc.inv[id]);
  return usedSlots(acc.inv) < acc.slots ? (isLockId(id) ? Infinity : MAX_STACK) : 0;
}
const upgradeCost = (acc) => (acc.slots - BASE_SLOTS) / 10 + 1;   // in Solana Locks
const slockTotal = (acc) => (acc.inv[SLOCK] || 0) + (acc.inv[DSLOCK] || 0) * 100;
function spendSlock(acc, n) {
  if (slockTotal(acc) < n) return false;
  while ((acc.inv[SLOCK] || 0) < n) { addItem(acc, DSLOCK, -1); addItem(acc, SLOCK, 100); }
  addItem(acc, SLOCK, -n); return true;
}
function tileUpdate(w, i) { w.dirty = true; bcast(w, { t: 'tile', i, fg: w.fg[i], bg: w.bg[i], tree: w.trees[i] || null }); }
function inRange(s, tx, ty) { return Math.hypot((tx + .5) * TS - (s.x + 10), (ty + .5) * TS - (s.y + 15)) <= 6 * TS; }
function canEdit(s, w) { return !w.owner || w.owner === s.name; }
function overlapsPlayer(w, tx, ty) {
  for (const p of w.players) if (p.x < tx * TS + TS && p.x + 20 > tx * TS && p.y < ty * TS + TS && p.y + 30 > ty * TS) return true;
  return false;
}

function spawnDrop(w, x, y, item, n, owner) {
  const id = w.nextDrop++;
  const d = { id, x: x + rand(-6, 6), y: y + rand(-4, 4), item, n };
  if (owner) d.noPick = { name: owner, until: Date.now() + 1500 };
  w.drops[id] = d; w.dirty = true;
  bcast(w, { t: 'drop_add', d });
}
function spawnGems(w, x, y, total) {
  while (total > 0) { const v = total >= 10 ? 10 : total >= 5 ? 5 : 1; spawnDrop(w, x, y, 'gem', v); total -= v; }
}
function tryPickups(s) {
  const w = s.world, cx = s.x + 10, cy = s.y + 15, now = Date.now();
  for (const d of Object.values(w.drops)) {
    if (Math.abs(d.x - cx) > 22 || Math.abs(d.y - cy) > 26) continue;
    if (d.noPick && d.noPick.name === s.name && d.noPick.until > now) continue;
    let take = d.n;
    if (d.item === 'gem') s.acc.gems += d.n;
    else {
      take = Math.min(d.n, room(s.acc, d.item));
      if (!take) {
        if (now - (s.fullMsg || 0) > 4000) { s.fullMsg = now; msg(s, '🎒 Your backpack is full! Buy more slots in the Store.'); }
        continue;
      }
      addItem(s.acc, d.item, take);
    }
    accountsDirty = true; w.dirty = true;
    if (take < d.n) { d.n -= take; bcast(w, { t: 'drop_upd', id: d.id, n: d.n, by: s.name, item: d.item, taken: take }); }
    else { delete w.drops[d.id]; bcast(w, { t: 'drop_del', id: d.id, by: s.name, item: d.item, n: d.n }); }
    sendInv(s);
  }
}

// ---------------- world actions ----------------
function punch(s, tx, ty) {
  const w = s.world, now = Date.now();
  if (!w || tx < 0 || ty < 0 || tx >= W || ty >= H || !inRange(s, tx, ty)) return;
  if (now - s.lastHit < 150) return;
  s.lastHit = now;
  bcast(w, { t: 'punch', name: s.name, x: tx, y: ty });
  const i = ty * W + tx, tree = w.trees[i], f = w.fg[i], b = w.bg[i];
  if (!tree && !f && !b) return;
  if (!canEdit(s, w)) return msg(s, `🔒 This world is locked by ${w.owner}.`);

  const power = ITEMS[s.acc.worn.hand]?.power || 1;
  const d = w.dmg[i] && now - w.dmg[i].t < 5000 ? w.dmg[i] : (w.dmg[i] = { h: 0 });
  d.t = now;
  const cx = tx * TS + 16, cy = ty * TS + 16;

  if (tree) {
    if (now - tree.t >= SG.growMs(tree.s)) {
      spawnDrop(w, cx, cy, tree.s, rand(1, 4));
      if (Math.random() < .3) spawnDrop(w, cx, cy, SEED + tree.s, 1);
      spawnGems(w, cx, cy, rand(1, (ITEMS[tree.s].gems || 1) * 2));
      delete w.trees[i]; delete w.dmg[i];
      stat(s, 'harvested'); addXp(s, ITEMS[tree.s].rarity * 2 + 1);
      bcast(w, { t: 'hit', i, h: 0, hp: 1, broke: true, col: ITEMS[tree.s].col });
      return tileUpdate(w, i);
    }
    d.h += power;
    const broke = d.h >= 3;
    bcast(w, { t: 'hit', i, h: d.h, hp: 3, broke, col: '#6b4423' });
    if (broke) { delete w.trees[i]; delete w.dmg[i]; tileUpdate(w, i); }
    return;
  }

  const layer = f ? 'fg' : 'bg', id = f || b, it = ITEMS[id];
  if (it.hp === Infinity) return bcast(w, { t: 'hit', i, h: 0, hp: 1, strong: true });
  d.h += power;
  const broke = d.h >= it.hp;
  bcast(w, { t: 'hit', i, h: d.h, hp: it.hp, broke, col: it.col });
  if (!broke) return;
  w[layer][i] = 0; delete w.dmg[i];
  if (it.type === 'lock') {
    w.owner = null; addItem(s.acc, id, 1); sendInv(s);
    bcast(w, { t: 'owner', owner: null });
    bcast(w, { t: 'chat', from: '', text: `${s.name} removed the ${it.name}. The world is now unlocked.` });
  } else {
    const r = Math.random();
    if (it.rarity && r < .25) spawnDrop(w, cx, cy, SEED + id, 1);
    else if (r < .45) spawnDrop(w, cx, cy, id, 1);
    if (it.gems && Math.random() < .75) spawnGems(w, cx, cy, rand(1, it.gems));
    stat(s, 'broken'); addXp(s, it.rarity || 1);
  }
  tileUpdate(w, i);
}

function place(s, tx, ty, id) {
  const w = s.world;
  if (!w || tx < 0 || ty < 0 || tx >= W || ty >= H || !inRange(s, tx, ty)) return;
  if (!(s.acc.inv[id] > 0)) return;
  if (!canEdit(s, w)) return msg(s, `🔒 This world is locked by ${w.owner}.`);
  const it = ITEMS[id], i = ty * W + tx;
  if (!it) return;

  if (it.type === 'seed') {
    const tree = w.trees[i];
    if (tree) {
      const res = SG.splice(tree.s, it.of);
      if (!res || Date.now() - tree.t >= SG.growMs(tree.s)) return msg(s, 'Those seeds can\'t be spliced.');
      w.trees[i] = { s: res, t: Date.now() };
      stat(s, 'spliced'); addXp(s, ITEMS[res].rarity * 3);
      bcast(w, { t: 'chat', from: '', text: `${s.name} spliced a ${ITEMS[res].name} tree! 🌱` });
    } else {
      if (w.fg[i]) return;
      const below = w.fg[i + W];
      if (ty + 1 >= H || !(SG.isSolid(below) || SG.isPlatform(below))) return msg(s, 'Seeds need a block underneath.');
      w.trees[i] = { s: it.of, t: Date.now() };
      stat(s, 'planted'); addXp(s, 1);
    }
  } else if (it.type === 'bg') {
    if (w.bg[i]) return;
    w.bg[i] = id;
  } else if (it.type === 'block' || it.type === 'platform' || it.type === 'lock' || it.type === 'spikes') {
    if (w.fg[i] || w.trees[i]) return;
    if (it.type !== 'platform' && overlapsPlayer(w, tx, ty)) return;
    if (it.type === 'lock') {
      if (w.owner) return msg(s, 'This world already has a lock.');
      w.owner = s.name;
      bcast(w, { t: 'owner', owner: s.name });
      bcast(w, { t: 'chat', from: '', text: `🔒 ${s.name} locked this world with a ${it.name}!` });
    }
    w.fg[i] = id;
  } else return;

  addItem(s.acc, id, -1); fixWorn(s); sendInv(s);
  tileUpdate(w, i);
}

// ---------------- worlds ----------------
function joinWorld(s, rawName) {
  const name = String(rawName || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 16);
  if (!name) return msg(s, 'World names use letters and numbers only.');
  leaveWorld(s);
  const w = getWorld(name);
  s.world = w;
  s.x = w.door.x * TS + 6; s.y = w.door.y * TS + 2; s.f = 1;
  w.players.add(s);
  send(s, {
    t: 'world', name: w.name, fg: w.fg, bg: w.bg, trees: w.trees, drops: w.drops, owner: w.owner,
    door: w.door, now: Date.now(), players: [...w.players].filter(p => p !== s).map(pub),
  });
  bcast(w, { t: 'pjoin', p: pub(s) }, s);
  bcast(w, { t: 'chat', kind: 'enter', text: `<${s.name} entered, ${w.players.size - 1} others here>` });
}
function leaveWorld(s) {
  const w = s.world;
  if (!w) return;
  endTrade(s, `${s.name} left the world.`);
  w.players.delete(s); s.world = null;
  bcast(w, { t: 'pleave', name: s.name });
  bcast(w, { t: 'chat', kind: 'enter', text: `<${s.name} left, ${w.players.size} others here>` });
  if (!w.players.size) { saveWorld(w); worlds.delete(w.name); }
}
function worldList() {
  const list = [...worlds.values()].map(w => ({ name: w.name, players: w.players.size, owner: w.owner }));
  for (const f of fs.readdirSync(path.join(DATA, 'worlds'))) {
    const n = f.replace(/\.json$/, '');
    if (f.endsWith('.json') && !worlds.has(n)) list.push({ name: n, players: 0 });
  }
  return list.sort((a, b) => b.players - a.players).slice(0, 30);
}

// ---------------- trading ----------------
function tradeState(T) {
  for (const [k, s] of [[0, T.a], [1, T.b]]) {
    const o = 1 - k;
    send(s, { t: 'trade', with: (k ? T.a : T.b).name, mine: T.offer[k], theirs: T.offer[o], myAcc: T.acc[k], theirAcc: T.acc[o], v: T.v });
  }
}
function endTrade(s, reason) {
  const T = s.trade; if (!T) return;
  T.a.trade = T.b.trade = null;
  for (const p of [T.a, T.b]) send(p, { t: 'trade_end', reason });
}
function sanitizeOffer(acc, items) {
  const out = {}; let kinds = 0;
  for (const [k, v] of Object.entries(items || {})) {
    const id = +k, n = Math.floor(+v);
    if (!ITEMS[id] || id === 0 || !(n > 0) || n > (acc.inv[id] || 0)) continue;
    out[id] = n; if (++kinds >= 12) break;
  }
  return out;
}
function execTrade(T) {
  const accs = [T.a.acc, T.b.acc];
  for (let k = 0; k < 2; k++) for (const [id, n] of Object.entries(T.offer[k])) if ((accs[k].inv[id] || 0) < n) return false;
  if (!fits(accs[0], T.offer[1], T.offer[0]) || !fits(accs[1], T.offer[0], T.offer[1])) return false;
  for (let k = 0; k < 2; k++) for (const [id, n] of Object.entries(T.offer[k])) { addItem(accs[k], +id, -n); addItem(accs[1 - k], +id, n); }
  return true;
}

// ---------------- solana ----------------
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58decode(str) {
  let n = 0n;
  for (const c of str) { const v = B58.indexOf(c); if (v < 0) throw new Error('bad base58'); n = n * 58n + BigInt(v); }
  const bytes = [];
  while (n > 0n) { bytes.unshift(Number(n % 256n)); n /= 256n; }
  for (const c of str) { if (c === '1') bytes.unshift(0); else break; }
  return Buffer.from(bytes);
}
function verifyWalletSig(addr, message, sigBytes) {
  const pub = b58decode(addr);
  if (pub.length !== 32) return false;
  const key = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: pub.toString('base64url') }, format: 'jwk' });
  return crypto.verify(null, Buffer.from(message), key, Buffer.from(sigBytes));
}
// ---------------- chat ----------------
function privateMsg(s, to, text) {
  const sys = (t) => send(s, { t: 'chat', kind: 'sys', text: t });
  if (!to || !text) return sys('Usage: /msg <name> <message>');
  const o = [...sessions].find((x) => x.acc && x.name.toLowerCase() === String(to).toLowerCase());
  if (!o) return sys(`${to} is not online.`);
  send(o, { t: 'chat', kind: 'pm_in', from: s.name, text }); o.lastPm = s.name;
  send(s, { t: 'chat', kind: 'pm_out', to: o.name, text });
}

// ---------------- messages ----------------
const sessionTokens = readJSON(path.join(DATA, 'tokens.json'), {});   // token -> { wallet, exp }
const TOKEN_TTL = 7 * 24 * 3600 * 1000;
const NAME_RE = /^[A-Za-z0-9_]{3,16}$/;
const accountByWallet = (addr) => Object.values(accounts).find((a) => a.wallet === addr);
function saveTokens() {
  const now = Date.now();
  for (const [k, v] of Object.entries(sessionTokens)) if (v.exp < now) delete sessionTokens[k];
  writeJSON(path.join(DATA, 'tokens.json'), sessionTokens);
}
function startSession(s, acc, token) {
  migrate(acc);
  for (const o of sessions) if (o !== s && o.acc === acc) { msg(o, 'Signed in from another place.'); o.ws.close(); }
  if (!token) { token = crypto.randomBytes(32).toString('hex'); sessionTokens[token] = { wallet: acc.wallet, exp: Date.now() + TOKEN_TTL }; saveTokens(); }
  s.name = acc.name; s.acc = acc; s.token = token; s.pendingWallet = null;
  send(s, { t: 'hello', name: acc.name, wallet: acc.wallet, token, config: CONFIG, worlds: worldList() });
  sendInv(s);
}

const handlers = {
  // 1) client asks for a message to sign with its wallet
  auth_nonce(s, m) {
    const addr = String(m.addr || '');
    try { if (b58decode(addr).length !== 32) throw 0; } catch { return send(s, { t: 'auth_fail', text: 'That is not a valid Solana address.' }); }
    s.authAddr = addr; s.authAt = Date.now();
    s.authMsg = `Sign in to Soltopia\n\nThis only proves you own this wallet. It costs nothing and sends no transaction.\n\nWallet: ${addr}\nNonce: ${crypto.randomBytes(12).toString('hex')}\nIssued: ${new Date().toISOString()}`;
    send(s, { t: 'auth_nonce', message: s.authMsg });
  },
  // 2) client returns the signature; existing wallets log straight in, new ones pick a name
  auth(s, m) {
    if (!s.authMsg || Date.now() - s.authAt > 5 * 60 * 1000) return send(s, { t: 'auth_fail', text: 'Sign-in expired, try again.' });
    let ok = false;
    try { ok = verifyWalletSig(s.authAddr, s.authMsg, m.sig); } catch {}
    s.authMsg = null;
    if (!ok) return send(s, { t: 'auth_fail', text: 'Signature check failed.' });
    const acc = accountByWallet(s.authAddr);
    if (acc) return startSession(s, acc);
    s.pendingWallet = s.authAddr;
    send(s, { t: 'need_name', wallet: s.authAddr });
  },
  // 3) first-time players choose a username
  register(s, m) {
    if (!s.pendingWallet) return send(s, { t: 'auth_fail', text: 'Connect your wallet first.' });
    const name = String(m.name || '').trim();
    if (!NAME_RE.test(name)) return send(s, { t: 'name_fail', text: 'Use 3–16 letters, numbers or _.' });
    if (accounts[name.toLowerCase()]) return send(s, { t: 'name_fail', text: 'That name is taken.' });
    if (accountByWallet(s.pendingWallet)) return startSession(s, accountByWallet(s.pendingWallet));
    const acc = accounts[name.toLowerCase()] = { name, wallet: s.pendingWallet, inv: { 1: 20, 1001: 3, 1005: 2, 20: 10 }, gems: 0, worn: {}, created: Date.now() };
    accountsDirty = true; saveAll();
    startSession(s, acc);
  },
  resume(s, m) {
    const t = sessionTokens[String(m.token || '')];
    const acc = t && t.exp > Date.now() && accountByWallet(t.wallet);
    if (!acc) return send(s, { t: 'resume_fail' });
    startSession(s, acc, m.token);
  },
  logout(s) {
    if (s.token) { delete sessionTokens[s.token]; saveTokens(); }
    leaveWorld(s); s.acc = null; s.name = null; s.token = null;
    send(s, { t: 'logged_out' });
  },
  worlds(s) { send(s, { t: 'worlds', worlds: worldList() }); },
  info(s, m) {
    const a = accounts[String(m.name || '').toLowerCase()]; if (!a) return;
    migrate(a);
    const online = [...sessions].find(o => o.acc === a);
    send(s, { t: 'info', name: a.name, level: a.level, xp: a.xp, need: xpNeed(a.level), stats: a.stats, created: a.created,
      worn: a.worn, world: online?.world?.name || null, owns: [...worlds.values()].filter(w => w.owner === a.name).map(w => w.name) });
  },
  join(s, m) { joinWorld(s, m.world); },
  leave(s) { leaveWorld(s); send(s, { t: 'worlds', worlds: worldList() }); },
  pos(s, m) {
    const w = s.world; if (!w) return;
    s.x = Math.max(0, Math.min(W * TS - 20, +m.x || 0)); s.y = Math.max(-200, Math.min(H * TS, +m.y || 0));
    s.f = m.f < 0 ? -1 : 1;
    bcast(w, { t: 'ppos', name: s.name, x: s.x, y: s.y, vx: +m.vx || 0, f: s.f, g: !!m.g }, s);
    tryPickups(s);
  },
  punch(s, m) { punch(s, m.x | 0, m.y | 0); },
  place(s, m) { place(s, m.x | 0, m.y | 0, m.id | 0); },
  wear(s, m) {
    const id = m.id | 0, it = ITEMS[id];
    if (!it || it.type !== 'wear' || !s.acc.inv[id]) return;
    if (s.acc.worn[it.slot] === id) delete s.acc.worn[it.slot]; else s.acc.worn[it.slot] = id;
    accountsDirty = true; sendInv(s);
    if (s.world) bcast(s.world, { t: 'pwear', name: s.name, worn: s.acc.worn });
  },
  drop(s, m) {
    const w = s.world, id = m.id | 0, n = Math.floor(+m.n);
    if (!w || !ITEMS[id] || !(n > 0) || (s.acc.inv[id] || 0) < n) return;
    if (s.trade) return msg(s, 'Finish your trade first.');
    addItem(s.acc, id, -n); fixWorn(s); sendInv(s);
    spawnDrop(w, s.x + 10 + s.f * 36, s.y + 12, id, n, s.name);
  },
  chat(s, m) {
    const text = String(m.text || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    if (!text) return;
    const now = Date.now();
    s.chatTimes = (s.chatTimes || []).filter((t) => now - t < 5000);
    if (s.chatTimes.length >= 5) return send(s, { t: 'chat', kind: 'sys', text: 'Slow down! You are chatting too fast.' });
    s.chatTimes.push(now);
    if (!text.startsWith('/')) { if (s.world) bcast(s.world, { t: 'chat', from: s.name, text }); return; }
    const [cmd, ...rest] = text.slice(1).split(' '), arg = rest.join(' ');
    const sys = (t) => send(s, { t: 'chat', kind: 'sys', text: t });
    switch (cmd.toLowerCase()) {
      case 'msg': return privateMsg(s, rest[0], rest.slice(1).join(' '));
      case 'r': return s.lastPm ? privateMsg(s, s.lastPm, arg) : sys('Nobody has messaged you yet.');
      case 'me': if (s.world && arg) bcast(s.world, { t: 'chat', kind: 'me', from: s.name, text: arg }); return;
      case 'who': return sys(s.world ? `Players in ${s.world.name}: ${[...s.world.players].map((p) => p.name).join(', ')}` : 'You are not in a world.');
      case 'wave': case 'dance': case 'cheer': case 'cry': case 'laugh':
        if (s.world) bcast(s.world, { t: 'emote', name: s.name, e: cmd.toLowerCase() }); return;
      default: return sys(`Unknown command /${cmd}. Type /help for a list.`);
    }
  },
  buy(s, m) {
    if (m.key === 'bpupgrade') {
      const cost = upgradeCost(s.acc);
      if (s.acc.slots >= MAX_SLOTS) return msg(s, 'Your backpack is already maxed out.');
      if (!spendSlock(s.acc, cost)) return msg(s, `You need ${cost} Solana Lock${cost > 1 ? 's' : ''}.`);
      s.acc.slots += 10; accountsDirty = true; sendInv(s);
      return msg(s, `🎒 Backpack upgraded to ${s.acc.slots} slots!`);
    }
    const item = SG.STORE.find(x => x.key === m.key); if (!item) return;
    if (item.give && !fits(s.acc, item.give)) return msg(s, '🎒 Not enough backpack space!');
    if (item.price.gems) { if (s.acc.gems < item.price.gems) return msg(s, 'Not enough gems.'); s.acc.gems -= item.price.gems; }
    else if (!spendSlock(s.acc, item.price.slock)) return msg(s, 'Not enough SLOCK.');
    for (const [id, n] of Object.entries(item.give || {})) addItem(s.acc, +id, n);
    if (item.gems) s.acc.gems += item.gems;
    accountsDirty = true; sendInv(s); msg(s, `Purchased ${item.name}!`);
  },
  convert(s, m) {
    if (m.dir === 'up') { if ((s.acc.inv[SLOCK] || 0) < 100) return msg(s, 'Need 100 Solana Locks.'); if (!fits(s.acc, { [DSLOCK]: 1 }, { [SLOCK]: 100 })) return msg(s, '🎒 Not enough backpack space!'); addItem(s.acc, SLOCK, -100); addItem(s.acc, DSLOCK, 1); }
    else { if (!s.acc.inv[DSLOCK]) return msg(s, 'No Diamond Solana Locks.'); if (!fits(s.acc, { [SLOCK]: 100 }, { [DSLOCK]: 1 })) return msg(s, '🎒 Not enough backpack space!'); addItem(s.acc, DSLOCK, -1); addItem(s.acc, SLOCK, 100); }
    sendInv(s);
  },
  trash(s, m) {
    const id = m.id | 0, n = Math.floor(+m.n);
    if (!ITEMS[id] || !(n > 0) || (s.acc.inv[id] || 0) < n) return;
    if (s.trade) return msg(s, 'Finish your trade first.');
    addItem(s.acc, id, -n); fixWorn(s); sendInv(s);
  },
  die(s) {
    const now = Date.now();
    if (!s.world || now - (s.lastDie || 0) < 800) return;
    s.lastDie = now;
    bcast(s.world, { t: 'pdie', name: s.name }, s);
  },


  trade_req(s, m) {
    const w = s.world; if (!w || s.trade) return;
    const o = [...w.players].find(p => p.name === m.to);
    if (!o || o === s) return;
    if (o.trade) return msg(s, `${o.name} is busy trading.`);
    o.invites = o.invites || new Set(); o.invites.add(s.name);
    send(o, { t: 'trade_invite', from: s.name });
    msg(s, `Trade request sent to ${o.name}.`);
  },
  trade_respond(s, m) {
    const o = s.world && [...s.world.players].find(p => p.name === m.from);
    if (!o || !s.invites?.has(m.from)) return;
    s.invites.delete(m.from);
    if (!m.ok) return msg(o, `${s.name} declined your trade.`);
    if (o.trade || s.trade) return msg(s, 'One of you is already trading.');
    const T = { a: o, b: s, offer: [{}, {}], acc: [false, false], v: 0 };
    o.trade = s.trade = T; tradeState(T);
  },
  trade_offer(s, m) {
    const T = s.trade; if (!T) return;
    const k = T.a === s ? 0 : 1;
    T.offer[k] = sanitizeOffer(s.acc, m.items); T.acc = [false, false]; T.v++;
    tradeState(T);
  },
  trade_accept(s, m) {
    const T = s.trade; if (!T || m.v !== T.v) return;
    const k = T.a === s ? 0 : 1;
    T.acc[k] = true;
    if (!(T.acc[0] && T.acc[1])) return tradeState(T);
    if (!execTrade(T)) { T.acc = [false, false]; T.v++; tradeState(T); return msg(s, 'Trade failed: items changed or a backpack is full.'); }
    for (const p of [T.a, T.b]) { fixWorn(p); stat(p, 'trades'); sendInv(p); }
    accountsDirty = true; saveAll();
    const w = T.a.world;
    endTrade(T.a, 'done');
    if (w) bcast(w, { t: 'chat', from: '', text: `✨ ${T.a.name} traded with ${T.b.name}.` });
  },
  trade_cancel(s) { endTrade(s, `${s.name} cancelled the trade.`); },
};

// ---------------- http + ws ----------------
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  const file = path.join(__dirname, 'public', url === '/' ? 'index.html' : url);
  if (!file.startsWith(path.join(__dirname, 'public'))) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(data);
  });
});
const PUBLIC = new Set(['auth_nonce', 'auth', 'register', 'resume']);
const wss = new WebSocketServer({ server });
wss.on('connection', (ws) => {
  const s = { ws, name: null, acc: null, world: null, x: 0, y: 0, f: 1, lastHit: 0, trade: null };
  sessions.add(s);
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    const h = handlers[m.t];
    if (!h || (!PUBLIC.has(m.t) && !s.acc)) return;
    try { h(s, m); } catch (e) { console.error('handler', m.t, e); }
  });
  ws.on('close', () => { leaveWorld(s); sessions.delete(s); });
});
server.listen(PORT, () => console.log(`Soltopia running on http://localhost:${PORT}`));
