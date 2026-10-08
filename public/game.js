// Soltopia client: rendering, animation, physics, UI. The server owns worlds, inventories and trades.
const { ITEMS, SLOCK, DSLOCK, W, H, TS, WRENCH } = SG;
const EPS = 0.001;
const $ = (s) => document.querySelector(s);
const RANGE = 5;

// ======================= STATE =======================
let ws, config = {}, myName = null;
let inv = {}, gems = 0, worn = {}, linkedWallet = null, level = 1, xp = 0, xpNeed = 40, slots = 32, upCost = 100;
let world = null;                 // {name, fg, bg, trees, drops, owner, door}
let others = {};                  // name -> remote player
let tOff = 0;                     // server clock offset
let selected = 0;
const me = { x: 0, y: 0, w: 20, h: 30, vx: 0, vy: 0, g: false, f: 1, walk: 0, punchT: 0, punchA: 0, hurtT: 0, jumps: 0, seed: 0,
  hp: 100, dead: 0, deadAt: null, lastGround: 0, jumpBuf: 0 };
const dmg = {}, particles = [], floaters = [];
const sNow = () => Date.now() + tOff;

// ======================= NETWORK =======================
let wsReady = null;
function ensureWS() {
  if (ws && ws.readyState === 1) return Promise.resolve();
  if (wsReady) return wsReady;
  // Never leave callers waiting forever: an attempt either opens or fails within 8s, then we retry.
  return (wsReady = new Promise((resolve, reject) => {
    const sock = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host);
    ws = sock;
    const giveUp = setTimeout(() => sock.close(), 8000);
    sock.onopen = () => { clearTimeout(giveUp); wsReady = null; resolve(); };
    sock.onmessage = (e) => { const m = JSON.parse(e.data); (NET[m.t] || (() => {}))(m); };
    sock.onclose = () => {
      clearTimeout(giveUp); wsReady = null; reject(new Error('offline'));
      if (ws !== sock) return;
      const wasIn = !!myName; myName = null; showScreen('login'); walletBusy(false);
      $('#lerr').textContent = "Can't reach the game server — reconnecting…";
      setTimeout(() => boot(wasIn), 2500);
    };
  }));
}
const send = (o) => ws && ws.readyState === 1 && ws.send(JSON.stringify(o));

const NET = {
  auth_nonce(m) { signAuth(m.message); },
  auth_fail(m) { $('#lerr').textContent = m.text; walletBusy(false); },
  need_name(m) { $('#nameWallet').textContent = short(m.wallet); $('#nerr').textContent = ''; showScreen('name'); $('#nname').focus(); },
  name_fail(m) { $('#nerr').textContent = m.text; $('#nbtn').disabled = false; },
  resume_fail() { store('sg_token', null); showScreen('login'); $('#lerr').textContent = ''; },
  logged_out() { store('sg_token', null); wallet?.disconnect(); wallet = null; walletAddr = null; showScreen('login'); },
  hello(m) {
    myName = m.name; config = m.config; me.seed = Math.random() * 5000; linkedWallet = m.wallet;
    store('sg_token', m.token); clearTimeout(signInTimer); walletBusy(false); $('#lerr').textContent = '';
    $('#menuWho').textContent = `${myName} · ${short(m.wallet)}`;
    renderWorldList(m.worlds); showScreen('menu');
  },
  worlds(m) { renderWorldList(m.worlds); showScreen('menu'); },
  inv(m) { inv = m.inv; gems = m.gems; worn = m.worn; linkedWallet = m.wallet; level = m.level; xp = m.xp; xpNeed = m.need; slots = m.slots; upCost = m.upCost; layout = m.layout || []; refreshHUD(); if (tradeSt) renderTrade(); },
  msg(m) { toast(m.text); },
  world(m) {
    world = m; tOff = m.now - Date.now(); others = {};
    for (const p of m.players) addOther(p);
    for (const k in dmg) delete dmg[k];
    particles.length = floaters.length = 0;
    me.x = m.door.x * TS + 6; me.y = m.door.y * TS + 2; me.vx = me.vy = 0; me.hp = 100; me.dead = 0;
    cam.x = me.x - innerWidth / 2; cam.y = me.y - innerHeight / 2;
    $('#chatlog').innerHTML = '';
    updateWorldPill(); showScreen('game');
    sysChat(`World ${m.name} entered. There ${m.players.length === 1 ? 'is 1 other person' : `are ${m.players.length} other people`} here.` + (m.owner ? ` This world is locked by ${m.owner}.` : '') + ' Type /help for commands.');
  },
  owner(m) { if (world) { world.owner = m.owner; updateWorldPill(); } },
  tile(m) {
    if (!world) return;
    world.fg[m.i] = m.fg; world.bg[m.i] = m.bg;
    if (m.tree) world.trees[m.i] = m.tree; else delete world.trees[m.i];
  },
  hit(m) {
    const tx = m.i % W, ty = Math.floor(m.i / W), cx = tx * TS + 16, cy = ty * TS + 16;
    if (m.strong) return floatText(cx, cy - 10, "It's too strong!", '#fff');
    if (m.broke) { delete dmg[m.i]; burst(cx, cy, m.col, 14); puff(cx, cy); }
    else { dmg[m.i] = { h: m.h, hp: m.hp, t: performance.now() }; burst(cx, cy, m.col, 4); }
  },
  punch(m) {
    const p = others[m.name]; if (!p) return;
    aimPunch(p, m.x, m.y);
  },
  drop_add(m) { if (world) world.drops[m.d.id] = m.d; },
  drop_del(m) {
    if (!world) return;
    const d = world.drops[m.id]; delete world.drops[m.id];
    if (d) sparkle(d.x, d.y);
    if (m.by === myName) floatText(me.x + 10, me.y - 8, m.item === 'gem' ? `+${m.n} 💎` : `+${m.n} ${ITEMS[m.item].name}`, m.item === 'gem' ? '#ffd1dc' : '#fff');
  },
  drop_upd(m) {
    const d = world?.drops[m.id]; if (!d) return;
    d.n = m.n; sparkle(d.x, d.y);
    if (m.by === myName) floatText(me.x + 10, me.y - 8, `+${m.taken} ${ITEMS[m.item].name}`, '#fff');
  },
  pdie(m) {
    const p = others[m.name]; if (!p) return;
    p.ghost = performance.now(); p.gx = p.x; p.gy = p.y;
    burst(p.x + 10, p.y + 15, '#ffffff', 14);
  },
  pjoin(m) { addOther(m.p); },
  pleave(m) { delete others[m.name]; },
  ppos(m) { const p = others[m.name]; if (!p) return; Object.assign(p, { tx: m.x, ty: m.y, vx: m.vx, f: m.f, g: m.g }); },
  pwear(m) { if (m.name === myName) worn = m.worn; else if (others[m.name]) others[m.name].worn = m.worn; },
  chat(m) {
    const who = (n) => `<b style="color:${nameColor(n)}">${esc(n)}</b>`;
    if (m.kind === 'pm_in') { addChat(`<span class="pm">[PM from ${who(m.from)}]</span> ${esc(m.text)}`); return toast(`💌 Message from ${m.from}`); }
    if (m.kind === 'pm_out') return addChat(`<span class="pm">[PM to ${who(m.to)}]</span> ${esc(m.text)}`);
    if (m.kind === 'enter') return addChat(esc(m.text), 'enter');
    const p = m.from === myName ? me : others[m.from];
    if (m.kind === 'me') { addChat(`* ${esc(m.from)} ${esc(m.text)} *`, 'me'); if (p) p.bubble = { text: `*${m.text}*`, t: performance.now() }; return; }
    if (!m.from) return sysChat(m.text);
    addChat(`<span class="cw">[W]</span> ${who(m.from)}: ${esc(m.text)}`);
    if (p) p.bubble = { text: m.text, t: performance.now() };
  },
  emote(m) {
    const p = m.name === myName ? me : others[m.name]; if (!p) return;
    p.emote = { e: m.e, t: performance.now() };
    floatText(p.x + 10, p.y - 24, { wave: '👋', dance: '💃', cheer: '🎉', cry: '😢', laugh: '😂' }[m.e] || '', '#fff');
  },
  trade_invite(m) { $('#invFrom').textContent = m.from; $('#invite').classList.remove('hidden'); $('#invite').dataset.from = m.from; },
  trade(m) { tradeSt = m; $('#trade').classList.remove('hidden'); renderTrade(); },
  trade_end(m) { tradeSt = null; $('#trade').classList.add('hidden'); toast(m.reason === 'done' ? '✨ Trade complete!' : m.reason); },
  levelup(m) {
    const p = m.name === myName ? me : others[m.name]; if (!p) return;
    if (p !== me) p.level = m.level;
    for (let i = 0; i < 3; i++) setTimeout(() => sparkle(p.x + 10 + (Math.random() - .5) * 30, p.y - 10), i * 120);
    burst(p.x + 10, p.y, '#ffd23f', 18);
    floatText(p.x + 10, p.y - 30, `LEVEL UP! ${m.level}`, '#ffe14d');
  },
  info(m) { renderInfo(m); },
};
function addOther(p) { others[p.name] = { ...p, tx: p.x, ty: p.y, w: 20, h: 30, walk: 0, punchT: 0, punchA: 0, seed: Math.random() * 5000 }; }

// ======================= DRAW HELPERS =======================
const cv = $('#c'), ctx = cv.getContext('2d');
let DPR = 1, VW = 0, VH = 0;
function resize() { DPR = Math.min(2, devicePixelRatio || 1); VW = innerWidth; VH = innerHeight; cv.width = VW * DPR; cv.height = VH * DPR; cv.style.width = VW + 'px'; cv.style.height = VH + 'px'; }
addEventListener('resize', resize); resize();

function rr(c, x, y, w, h, r) { c.beginPath(); c.roundRect(x, y, w, h, r); }
function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16), f = (v) => Math.max(0, Math.min(255, Math.round(amt < 0 ? v * (1 + amt) : v + (255 - v) * amt)));
  return `rgb(${f(n >> 16)},${f((n >> 8) & 255)},${f(n & 255)})`;
}
const OL = 'rgba(25,18,35,.9)';
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---- block art ----
// World blocks are drawn "connected" like Growtopia: textures flow from block to block, and outlines,
// bevels and rounded corners only appear on edges that touch something different.
function outline(c, r = 5) { c.lineWidth = 2; c.strokeStyle = OL; rr(c, 1, 1, 30, 30, r); c.stroke(); }
function dots(c, col, pts) { c.fillStyle = col; for (const [x, y, r] of pts) { c.beginPath(); c.arc(x, y, r, 0, 7); c.fill(); } }
function rng(seed) { let s = (seed >>> 0) || 1; return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296; }; }
const hash01 = (x, y, k = 0) => rng((x * 73856093) ^ (y * 19349663) ^ (k * 83492791))();
function paint(c, col) { c.fillStyle = col; c.fillRect(0, 0, 32, 32); }
function blobs(c, r, col, n, min, max, squash = .75) {   // wraps around the tile so neighbours line up
  c.fillStyle = col;
  for (let i = 0; i < n; i++) {
    const x = r() * 32, y = r() * 32, rx = min + r() * (max - min), a = r() * 3;
    for (const ox of [-32, 0, 32]) for (const oy of [-32, 0, 32]) { c.beginPath(); c.ellipse(x + ox, y + oy, rx, rx * squash, a, 0, 7); c.fill(); }
  }
}
function stones(c, r, n, fill, edge) {
  for (let i = 0; i < n; i++) {
    const w = 6 + r() * 7, h = 4 + r() * 5, x = r() * 32, y = r() * 32;
    for (const ox of [-32, 0, 32]) for (const oy of [-32, 0, 32]) { rr(c, x + ox, y + oy, w, h, 2.5); c.fillStyle = fill; c.fill(); c.strokeStyle = edge; c.lineWidth = 1.2; c.stroke(); }
  }
}
function bricks(c, r, base, mortar, hi) {
  paint(c, base);
  for (let row = 0; row < 4; row++) {
    const y = row * 8, off = row % 2 ? 8 : 0;
    c.fillStyle = hi; for (let k = -1; k < 3; k++) c.fillRect(off + k * 16 + 1, y + 1, 14, 1.5);
    c.fillStyle = mortar; c.fillRect(0, y + 6.5, 32, 1.5);
    for (let k = 0; k < 3; k++) c.fillRect(off + k * 16 - 1, y, 1.5, 7);
  }
  blobs(c, r, 'rgba(0,0,0,.12)', 5, 1, 2.5);
}
function planks(c, r, base, line, grain, vertical) {
  paint(c, base);
  c.save(); if (vertical) { c.translate(32, 0); c.rotate(Math.PI / 2); }
  c.fillStyle = grain; for (let i = 0; i < 7; i++) { c.fillRect(r() * 28, r() * 32, 4 + r() * 8, .9); }
  c.fillStyle = line;
  for (let y = 0; y < 32; y += 8) { c.fillRect(0, y + 6.5, 32, 1.5); c.fillRect(Math.floor(r() * 26) + 3, y, 1.5, 7); }
  c.restore();
}
const TEXDEF = {
  1(c, r) { paint(c, '#8d582b'); blobs(c, r, '#7a4a22', 6, 3, 6); blobs(c, r, '#a3703c', 5, 1.2, 2.4); blobs(c, r, '#5c3415', 7, .7, 1.3, 1); },
  5(c, r) { TEXDEF[1](c, r); },
  2(c, r) { paint(c, '#7f838c'); blobs(c, r, '#737780', 5, 3, 6); stones(c, r, 4, '#9ca0a9', '#5b5f67'); blobs(c, r, '#5b5f67', 6, .6, 1.1, 1); },
  4(c, r) {
    paint(c, '#2e2840'); c.strokeStyle = '#3e3656'; c.lineWidth = 3;
    for (let k = -32; k < 64; k += 10) { c.beginPath(); c.moveTo(k, 32); c.lineTo(k + 32, 0); c.stroke(); }
    blobs(c, r, '#1f1a2e', 5, 1, 2);
  },
  6(c, r) { planks(c, r, '#b47638', '#7f4c20', '#c88c4c'); },
  7(c, r) {
    c.fillStyle = 'rgba(175,228,255,.5)'; c.fillRect(0, 0, 32, 32);
    c.strokeStyle = 'rgba(255,255,255,.85)'; c.lineWidth = 2.2; c.lineCap = 'round';
    const k = r() * 8; c.beginPath(); c.moveTo(6 + k, 16); c.lineTo(16 + k, 6); c.moveTo(9 + k, 22); c.lineTo(22 + k, 9); c.stroke(); c.lineCap = 'butt';
  },
  9(c, r) { bricks(c, r, '#b0462f', '#d6c1ab', '#c75c42'); },
  10(c, r) { paint(c, '#e9c878'); blobs(c, r, '#d8b25c', 5, 2, 4); blobs(c, r, '#f8e2a8', 8, .6, 1, 1); blobs(c, r, '#c49848', 6, .5, .9, 1); },
  12(c, r) {
    paint(c, '#23505d'); blobs(c, r, '#2d6170', 4, 3, 5);
    for (let i = 0; i < 3; i++) {
      const x = 2 + r() * 22, h = 10 + r() * 12, w = 5 + r() * 3, b = 30 - r() * 6;
      c.fillStyle = '#4fe3f2'; c.beginPath(); c.moveTo(x, b); c.lineTo(x, b - h + 4); c.lineTo(x + w / 2, b - h); c.lineTo(x + w, b - h + 4); c.lineTo(x + w, b); c.closePath(); c.fill();
      c.strokeStyle = '#0c3c47'; c.lineWidth = 1.2; c.stroke(); c.fillStyle = '#dcfcff'; c.fillRect(x + 1.2, b - h + 5, 1.3, h - 8);
    }
  },
  13(c, r) { paint(c, '#e0a81e'); blobs(c, r, '#ffcf3a', 6, 2, 5); blobs(c, r, '#fff3a8', 4, .8, 1.6); blobs(c, r, '#b98208', 6, .5, 1, 1); },
  20(c, r) { paint(c, '#2b2019'); blobs(c, r, '#35281f', 7, 3, 7); stones(c, r, 3, '#3a2c23', '#1c1410'); blobs(c, r, '#1c1410', 6, .6, 1.2, 1); },
  21(c, r) { planks(c, r, '#5e3c21', '#3f2713', '#6c482a', true); },
  22(c, r) { bricks(c, r, '#5a2a1f', '#7b5d4c', '#683427'); },
};
const CONNECT = new Set([1, 2, 3, 4, 5, 6, 7, 9, 10, 12, 13, 20, 21, 22]);
const TEX = {};
function texImg(id, v) {
  const k = id * 4 + v;
  if (TEX[k]) return TEX[k];
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const x = c.getContext('2d'); x.scale(2, 2); TEXDEF[id](x, rng(id * 7919 + v * 104729 + 17));
  return (TEX[k] = c);
}
function lavaBody(c, x, y, s, t, tx, ty) {
  const g = c.createLinearGradient(x, y, x, y + s); g.addColorStop(0, '#ff9a1f'); g.addColorStop(1, '#d9301a');
  c.fillStyle = g; c.fillRect(x, y, s, s);
  const u = s / 32;
  for (let i = 0; i < 4; i++) {
    const ph = hash01(tx, ty, i), r = (1.5 + 1.6 * Math.abs(Math.sin(t / 500 + ph * 6))) * u;
    c.fillStyle = i % 2 ? '#fff38a' : '#ffd23f';
    c.beginPath(); c.arc(x + (4 + ph * 24) * u, y + (6 + ((i * 9 + ph * 20) % 20)) * u + Math.sin(t / 700 + i) * 2 * u, r, 0, 7); c.fill();
  }
}
function grassTop(c, x, y, s, tx) {
  const u = s / 32;
  c.fillStyle = '#4fbf3f'; c.beginPath(); c.moveTo(x, y); c.lineTo(x + s, y); c.lineTo(x + s, y + 8 * u);
  for (let k = 0; k < 4; k++) { const bx = x + s - k * 8 * u; c.quadraticCurveTo(bx - 4 * u, y + (13 + ((tx + k) % 2) * 2) * u, bx - 8 * u, y + 8 * u); }
  c.closePath(); c.fill();
  c.fillStyle = '#78dd5c'; c.fillRect(x, y + 1.5 * u, s, 3 * u);
  c.strokeStyle = '#2f8a2a'; c.lineWidth = 1.4 * u; c.beginPath(); c.moveTo(x + s, y + 8 * u);
  for (let k = 0; k < 4; k++) { const bx = x + s - k * 8 * u; c.quadraticCurveTo(bx - 4 * u, y + (13 + ((tx + k) % 2) * 2) * u, bx - 8 * u, y + 8 * u); }
  c.stroke();
}
const famOf = (id) => (id === 5 ? 1 : id);
function nbr(layer, tx, ty) { if (tx < 0 || tx >= W || ty >= H) return -1; if (ty < 0) return 0; return world[layer][ty * W + tx]; }
function drawConnected(c, layer, id, tx, ty, now) {
  const x = tx * TS, y = ty * TS, f = famOf(id), isBg = layer === 'bg';
  const same = (n) => n === -1 || famOf(n) === f;
  const T = !same(nbr(layer, tx, ty - 1)), B = !same(nbr(layer, tx, ty + 1)), L = !same(nbr(layer, tx - 1, ty)), R = !same(nbr(layer, tx + 1, ty));
  const v = ((tx * 73856093) ^ (ty * 19349663)) >>> 0 & 3;
  if (!T && !B && !L && !R && id !== 3) { c.drawImage(texImg(id, v), x, y, TS, TS); return; }
  const k = 7, rad = [T && L ? k : 0, T && R ? k : 0, B && R ? k : 0, B && L ? k : 0];
  c.save(); c.beginPath(); c.roundRect(x, y, TS, TS, rad); c.clip();
  if (id === 3) lavaBody(c, x, y, TS, now, tx, ty); else c.drawImage(texImg(id, v), x, y, TS, TS);
  if (!isBg) {
    if (T) { c.fillStyle = 'rgba(255,255,255,.22)'; c.fillRect(x, y, TS, 4); }
    if (L) { c.fillStyle = 'rgba(255,255,255,.1)'; c.fillRect(x, y, 3, TS); }
    if (B) { c.fillStyle = 'rgba(0,0,0,.28)'; c.fillRect(x, y + TS - 5, TS, 5); }
    if (R) { c.fillStyle = 'rgba(0,0,0,.16)'; c.fillRect(x + TS - 4, y, 4, TS); }
    if (id === 5 && T) grassTop(c, x, y, TS, tx);
  }
  // outline only the exposed sides: hidden sides are pushed outside the clip
  const h = 1.2, o = 4;
  const px = x + (L ? h : -o), py = y + (T ? h : -o), px2 = x + TS - (R ? h : -o), py2 = y + TS - (B ? h : -o);
  c.beginPath(); c.roundRect(px, py, px2 - px, py2 - py, rad.map((r) => Math.max(0, r - h)));
  c.strokeStyle = isBg ? 'rgba(0,0,0,.6)' : OL; c.lineWidth = 2.4; c.stroke();
  c.restore();
}

// Standalone art: inventory icons, drops, and blocks that don't connect (door, platform, cloud, spikes, locks)
function texIcon(id) {
  return (c, t = 0) => {
    c.save(); rr(c, 1, 1, 30, 30, 6); c.clip();
    if (id === 3) lavaBody(c, 0, 0, 32, t, 0, 0); else c.drawImage(texImg(id, 0), 0, 0, 32, 32);
    if (id === 5) grassTop(c, 0, 0, 32, 0);
    c.fillStyle = 'rgba(255,255,255,.22)'; c.fillRect(0, 0, 32, 5); c.fillStyle = 'rgba(0,0,0,.25)'; c.fillRect(0, 26, 32, 6);
    c.restore(); outline(c, 6);
  };
}
const ART = {
  8(c) {
    c.fillStyle = '#f4ead2'; rr(c, 3, 0, 26, 32, [8, 8, 0, 0]); c.fill(); c.lineWidth = 2; c.strokeStyle = OL; c.stroke();
    const g = c.createLinearGradient(6, 0, 26, 0); g.addColorStop(0, '#a86b35'); g.addColorStop(1, '#7a4a20');
    c.fillStyle = g; rr(c, 6, 3, 20, 29, [6, 6, 0, 0]); c.fill(); c.stroke();
    c.fillStyle = '#ffd23f'; c.beginPath(); c.arc(21, 18, 2, 0, 7); c.fill(); c.stroke();
    c.fillStyle = '#5ccc4c'; rr(c, 9, 7, 14, 6, 2); c.fill(); c.stroke();
  },
  11(c) {
    c.fillStyle = '#fff'; c.strokeStyle = '#9cc7e8'; c.lineWidth = 2;
    const puffs = [[8, 16, 7], [16, 11, 9], [24, 16, 7], [16, 19, 8]];
    for (const [x, y, r] of puffs) { c.beginPath(); c.arc(x, y, r, 0, 7); c.stroke(); }
    for (const [x, y, r] of puffs) { c.beginPath(); c.arc(x, y, r, 0, 7); c.fill(); }
    c.fillStyle = '#e6f2ff'; c.beginPath(); c.ellipse(16, 22, 11, 3, 0, 0, 7); c.fill();
  },
  14(c) {
    c.fillStyle = ITEMS[14].col; rr(c, 0, 1, 32, 9, 3); c.fill(); c.lineWidth = 2; c.strokeStyle = OL; c.stroke();
    c.fillStyle = shade(ITEMS[14].col, .25); c.fillRect(3, 3, 26, 2);
    c.fillStyle = shade(ITEMS[14].col, -.2); c.fillRect(5, 10, 3, 6); c.fillRect(24, 10, 3, 6);
  },
  15(c) {
    c.fillStyle = '#3a3448'; rr(c, 1, 24, 30, 8, 2); c.fill(); c.lineWidth = 2; c.strokeStyle = OL; c.stroke();
    for (const x of [2, 12, 22]) {
      const g = c.createLinearGradient(x, 0, x + 8, 0); g.addColorStop(0, '#e8ecf2'); g.addColorStop(1, '#8a92a0');
      c.fillStyle = g; c.beginPath(); c.moveTo(x, 25); c.lineTo(x + 4, 4); c.lineTo(x + 8, 25); c.closePath(); c.fill(); c.lineWidth = 1.6; c.stroke();
      c.fillStyle = '#d42a2a'; c.beginPath(); c.moveTo(x + 2.6, 11); c.lineTo(x + 4, 4); c.lineTo(x + 5.4, 11); c.closePath(); c.fill();
    }
  },
  [SLOCK](c) { lockArt(c, ['#b678ff', '#9945ff', '#14f195']); },
  [DSLOCK](c) { lockArt(c, ['#eafffa', '#5ff0d0', '#14b8f1'], true); },
};
for (const id of CONNECT) ART[id] = texIcon(id);
function lockArt(c, cols, diamond) {
  c.lineWidth = 4; c.strokeStyle = '#3a3550'; c.beginPath(); c.arc(16, 13, 7, Math.PI, 0); c.lineTo(23, 16); c.moveTo(9, 13); c.lineTo(9, 16); c.stroke();
  c.lineWidth = 2; c.strokeStyle = '#c9c4dd'; c.beginPath(); c.arc(16, 13, 7, Math.PI, 0); c.stroke();
  const g = c.createLinearGradient(5, 14, 27, 30); g.addColorStop(0, cols[0]); g.addColorStop(.5, cols[1]); g.addColorStop(1, cols[2]);
  c.fillStyle = g; rr(c, 5, 14, 22, 16, 4); c.fill(); c.lineWidth = 2; c.strokeStyle = OL; c.stroke();
  c.fillStyle = 'rgba(255,255,255,.5)'; rr(c, 7, 16, 18, 3, 1.5); c.fill();
  if (diamond) { c.fillStyle = '#fff'; c.beginPath(); c.moveTo(16, 18); c.lineTo(20, 22); c.lineTo(16, 27); c.lineTo(12, 22); c.closePath(); c.fill(); c.strokeStyle = '#0a7d73'; c.lineWidth = 1.2; c.stroke(); }
  else { c.fillStyle = '#1b1530'; c.beginPath(); c.arc(16, 21, 2.3, 0, 7); c.fill(); c.fillRect(15, 21, 2, 5); }
}

const tileCache = {};
function tileImg(id) {
  if (tileCache[id]) return tileCache[id];
  const c = document.createElement('canvas'); c.width = c.height = TS * 2;
  const x = c.getContext('2d'); x.scale(2 * TS / 32, 2 * TS / 32); ART[id](x);
  return (tileCache[id] = c);
}
function drawTile(c, id, x, y, s, t) {
  if (id === 3) { c.save(); c.translate(x, y); c.scale(s / 32, s / 32); ART[3](c, t); c.restore(); }
  else c.drawImage(tileImg(id), x, y, s, s);
}

// ---- seeds, gems, wearables ----
function drawSeed(c, col, x, y, s) {
  c.save(); c.translate(x + s / 2, y + s / 2); c.scale(s / 32, s / 32);
  c.fillStyle = col; c.beginPath(); c.ellipse(0, 1, 9, 11, .5, 0, 7); c.fill();
  c.lineWidth = 2.5; c.strokeStyle = OL; c.stroke();
  c.fillStyle = 'rgba(255,255,255,.55)'; c.beginPath(); c.ellipse(-3, -3, 3, 4.5, .5, 0, 7); c.fill();
  c.strokeStyle = shade(col.length === 7 ? col : '#888888', -.4); c.lineWidth = 1.5; c.beginPath(); c.moveTo(2, -6); c.quadraticCurveTo(5, 1, 1, 8); c.stroke();
  c.restore();
}
const GEMCOL = { 1: '#ff4d6d', 5: '#3fb6ff', 10: '#c86bff' };
function drawGem(c, x, y, s, v, spin) {
  c.save(); c.translate(x, y); c.scale(Math.max(.15, Math.abs(spin)) * s / 16, s / 16);
  const col = GEMCOL[v] || GEMCOL[1];
  c.fillStyle = col; c.beginPath(); c.moveTo(0, -7); c.lineTo(6, -2); c.lineTo(0, 8); c.lineTo(-6, -2); c.closePath(); c.fill();
  c.lineWidth = 1.5; c.strokeStyle = OL; c.stroke();
  c.fillStyle = 'rgba(255,255,255,.7)'; c.beginPath(); c.moveTo(0, -7); c.lineTo(-6, -2); c.lineTo(0, -1); c.closePath(); c.fill();
  c.restore();
}
function drawFist(c, x, y, s) {
  c.save(); c.translate(x + s / 2, y + s / 2); c.scale(s / 32, s / 32);
  c.fillStyle = SKIN; rr(c, -9, -8, 18, 16, 6); c.fill(); c.lineWidth = 2.5; c.strokeStyle = OL; c.stroke();
  c.lineWidth = 1.5; for (const k of [-4, 1, 6]) { c.beginPath(); c.moveTo(k - 1, -8); c.lineTo(k - 1, -2); c.stroke(); }
  c.fillStyle = SKIN; rr(c, -12, -3, 7, 9, 3); c.fill(); c.lineWidth = 2.5; c.stroke();
  c.restore();
}

const SKIN = '#f7c79a';
const HATS = {
  200(c) { c.fillStyle = '#23202e'; rr(c, -8, -53, 16, 14, 2); c.fill(); c.stroke(); c.fillStyle = '#e0484f'; c.fillRect(-8, -44, 16, 3); c.fillStyle = '#23202e'; rr(c, -13, -41, 26, 4, 2); c.fill(); c.stroke(); },
  201(c) {
    c.fillStyle = '#ff6fb5'; c.beginPath(); c.moveTo(-8, -38); c.lineTo(8, -38); c.lineTo(1, -58); c.closePath(); c.fill(); c.stroke();
    c.save(); c.clip(); c.strokeStyle = '#ffe14d'; c.lineWidth = 3; for (const y of [-42, -48, -54]) { c.beginPath(); c.moveTo(-10, y + 3); c.lineTo(10, y - 2); c.stroke(); } c.restore();
    c.fillStyle = '#ffe14d'; c.beginPath(); c.arc(1, -58, 3.2, 0, 7); c.fill(); c.lineWidth = 2; c.strokeStyle = OL; c.stroke();
  },
  202(c) {
    const g = c.createLinearGradient(0, -52, 0, -38); g.addColorStop(0, '#fff09a'); g.addColorStop(1, '#e0a000');
    c.fillStyle = g; c.beginPath(); c.moveTo(-10, -37); c.lineTo(-10, -50); c.lineTo(-5, -44); c.lineTo(0, -53); c.lineTo(5, -44); c.lineTo(10, -50); c.lineTo(10, -37); c.closePath(); c.fill(); c.stroke();
    dots(c, '#e0484f', [[0, -42, 2]]); dots(c, '#3fb6ff', [[-6, -41, 1.5], [6, -41, 1.5]]);
  },
  203(c) {
    c.fillStyle = '#9945ff'; c.beginPath(); c.moveTo(-10, -35); c.quadraticCurveTo(-10, -49, 0, -49); c.quadraticCurveTo(10, -49, 10, -35); c.closePath(); c.fill(); c.stroke();
    c.fillStyle = '#14f195'; rr(c, 4, -38, 13, 4, 2); c.fill(); c.stroke();
    c.fillStyle = '#fff'; c.beginPath(); c.arc(0, -49, 2, 0, 7); c.fill();
  },
};
function drawShades(c) {
  c.fillStyle = '#15121f'; rr(c, -1, -34, 5.5, 5, 2); c.fill(); rr(c, 5.5, -34, 5.5, 5, 2); c.fill();
  c.fillRect(-1, -33.5, 12, 1.5); c.lineWidth = 1.5; c.beginPath(); c.moveTo(-1, -33); c.lineTo(-10, -32); c.stroke();
  c.fillStyle = '#7fd3ff'; c.fillRect(0.5, -33, 1.5, 1.5); c.fillRect(7, -33, 1.5, 1.5);
}
function drawHandItem(c, id) {
  if (id === 250) {
    c.fillStyle = '#8b5a2b'; rr(c, -1.4, -18, 2.8, 22, 1.4); c.fill(); c.stroke();
    c.fillStyle = '#b8bfcc'; c.beginPath(); c.moveTo(-11, -12); c.quadraticCurveTo(0, -24, 11, -12); c.quadraticCurveTo(0, -19, -11, -12); c.fill(); c.stroke();
  } else if (id === 251) {
    const g = c.createLinearGradient(0, -28, 0, -4); g.addColorStop(0, '#14f195'); g.addColorStop(1, '#9945ff');
    c.fillStyle = g; c.beginPath(); c.moveTo(-2.5, -5); c.lineTo(-2.5, -24); c.lineTo(0, -29); c.lineTo(2.5, -24); c.lineTo(2.5, -5); c.closePath(); c.fill(); c.stroke();
    c.fillStyle = '#ffd23f'; rr(c, -6, -6, 12, 3, 1.5); c.fill(); c.stroke();
    c.fillStyle = '#6b4423'; rr(c, -1.5, -3, 3, 7, 1.5); c.fill(); c.stroke();
  }
}
function drawWings(c, flap) {
  for (const [rot, col, sc] of [[-.15, '#dfe9f7', .85], [0, '#ffffff', 1]]) {
    c.save(); c.translate(-3, -17); c.rotate(-.35 - flap + rot); c.scale(sc, sc);
    c.fillStyle = col; c.beginPath(); c.moveTo(0, 0);
    c.quadraticCurveTo(-16, -18, -24, -6); c.quadraticCurveTo(-18, -4, -21, 2); c.quadraticCurveTo(-14, 1, -15, 7); c.quadraticCurveTo(-8, 5, 0, 5); c.closePath();
    c.fill(); c.stroke();
    c.strokeStyle = '#b9c9e0'; c.lineWidth = 1.2; c.beginPath(); c.moveTo(-4, 1); c.lineTo(-17, -4); c.moveTo(-4, 3); c.lineTo(-14, 4); c.stroke();
    c.restore(); c.strokeStyle = OL; c.lineWidth = 2;
  }
}
function drawCape(c, sway) {
  c.fillStyle = '#d33a3a'; c.beginPath(); c.moveTo(-6, -20); c.lineTo(4, -20);
  c.quadraticCurveTo(0, -8, -2 - sway * .5, -2); c.lineTo(-15 - sway, -3); c.quadraticCurveTo(-10, -10, -6, -20); c.closePath(); c.fill(); c.stroke();
}
function drawWearIcon(c, id, x, y, s) {
  const it = ITEMS[id];
  c.save(); c.translate(x + s / 2, y + s / 2); c.scale(s / 32, s / 32); c.lineWidth = 2; c.strokeStyle = OL; c.lineJoin = 'round';
  if (it.slot === 'hat') { c.translate(0, id === 201 ? 46 : 44); HATS[id](c); }
  else if (it.slot === 'face') { c.scale(1.8, 1.8); c.translate(-5, 31.5); drawShades(c); }
  else if (it.slot === 'shirt') { shirtShape(c, it.col, id); }
  else if (it.slot === 'pants') { c.fillStyle = it.col; rr(c, -8, -10, 16, 7, 2); c.fill(); c.stroke(); rr(c, -8, -5, 7, 15, 2); c.fill(); c.stroke(); rr(c, 1, -5, 7, 15, 2); c.fill(); c.stroke(); }
  else if (it.slot === 'back') { if (id === 240) { c.translate(12, 12); drawWings(c, 0); } else { c.translate(5, 12); drawCape(c, 0); } }
  else if (it.slot === 'hand') { c.translate(0, 12); c.rotate(.6); drawHandItem(c, id); }
  c.restore();
}
function shirtShape(c, col, id) {
  c.fillStyle = col; rr(c, -13, -9, 7, 11, 3); c.fill(); c.stroke(); rr(c, 6, -9, 7, 11, 3); c.fill(); c.stroke();
  rr(c, -8, -10, 16, 19, 4); c.fill(); c.stroke();
  if (id === 222) { c.fillStyle = '#14f195'; c.fillRect(-8, -1, 16, 3); c.fillStyle = '#fff'; c.fillRect(-1, -10, 2, 6); }
}

function drawWrench(c, x, y, s) {
  c.save(); c.translate(x + s / 2, y + s / 2); c.scale(s / 32, s / 32); c.rotate(-.75);
  // open-ended jaw: thick C-shape with an outline, then the handle with a grip
  c.lineCap = 'round';
  c.lineWidth = 8.5; c.strokeStyle = OL; c.beginPath(); c.arc(0, -8, 5.5, Math.PI * .72, Math.PI * 2.28); c.stroke();
  c.lineWidth = 5; c.strokeStyle = '#c9ced8'; c.beginPath(); c.arc(0, -8, 5.5, Math.PI * .72, Math.PI * 2.28); c.stroke();
  c.lineCap = 'butt'; c.lineWidth = 2.5; c.strokeStyle = OL; c.fillStyle = '#c9ced8';
  rr(c, -2.6, -3, 5.2, 18, 2.6); c.fill(); c.stroke();
  c.fillStyle = '#e0484f'; rr(c, -2.6, 6, 5.2, 9, 2.6); c.fill(); c.stroke();
  c.restore();
}
function drawIcon(c, id, x, y, s) {
  const it = ITEMS[id]; if (!it) return;
  if (id === 0) return drawFist(c, x, y, s);
  if (id === WRENCH) return drawWrench(c, x, y, s);
  if (it.type === 'seed') return drawSeed(c, it.col, x, y, s);
  if (it.type === 'wear') return drawWearIcon(c, id, x, y, s);
  drawTile(c, id, x, y, s, performance.now());
}

// ---- avatar ----
function drawAvatar(c, p, now, opts = {}) {
  const wr = p.worn || {}, moving = Math.abs(p.vx) > 10 && p.g, air = !p.g;
  const em = p.emote && now - p.emote.t < 2600 ? p.emote.e : null;
  let swing = moving ? Math.sin(p.walk) * .7 : air ? .45 : 0;
  let bob = moving ? -Math.abs(Math.sin(p.walk)) * 1.5 : Math.sin(now / 450 + p.seed) * .5;
  if (em === 'dance') { swing = Math.sin(now / 110) * .8; bob = -Math.abs(Math.sin(now / 110)) * 3; }
  if (em === 'laugh') bob = -Math.abs(Math.sin(now / 70)) * 1.5;
  if (em === 'cry') bob = 1.5;
  const shirt = ITEMS[wr.shirt]?.col, pants = ITEMS[wr.pants]?.col || '#4a4a8a';
  c.save();
  if (opts.at) c.translate(opts.at[0], opts.at[1]); else c.translate(p.x + 10, p.y + 30);
  c.scale((p.f || 1) * (opts.scale || .82), opts.scale || .82);
  c.lineWidth = 2; c.strokeStyle = OL; c.lineJoin = 'round';
  if (!opts.at) { c.fillStyle = 'rgba(0,0,0,.18)'; c.beginPath(); c.ellipse(0, 1, 11, 3, 0, 0, 7); c.fill(); }

  if (wr.back === 240) drawWings(c, air ? Math.sin(now / 70) * .45 : Math.sin(now / 600) * .12);
  if (wr.back === 241) drawCape(c, Math.min(6, Math.abs(p.vx) / 40) + Math.sin(now / 300) * 1.5);

  // back arm
  limb(c, -3, -17 + bob, em === 'cheer' ? -Math.PI / 2 - .5 + Math.sin(now / 120) * .2 : Math.PI / 2 - swing * .8, 9, shirt || SKIN, null);
  // legs
  for (const [lx, a] of [[-4.5, swing], [1.5, -swing]]) {
    c.save(); c.translate(lx + 1.5, -8); c.rotate(a);
    c.fillStyle = pants; rr(c, -3, -1, 6, 8, 2); c.fill(); c.stroke();
    c.fillStyle = '#2b2233'; rr(c, -3, 5.5, 7.5, 3.5, 1.7); c.fill(); c.stroke();
    c.restore();
  }
  // body
  c.fillStyle = shirt || SKIN; rr(c, -7, -21 + bob, 14, 14, 4); c.fill(); c.stroke();
  if (wr.shirt === 222) { c.fillStyle = '#14f195'; c.fillRect(-6, -14 + bob, 12, 2.5); }
  if (!shirt) { c.fillStyle = pants; rr(c, -7, -11 + bob, 14, 4, 1.5); c.fill(); }
  // head
  const hy = bob;
  c.fillStyle = SKIN; rr(c, -10, -40 + hy, 21, 20, 8); c.fill(); c.stroke();
  c.fillStyle = 'rgba(255,140,140,.35)'; c.beginPath(); c.arc(8, -25 + hy, 2.5, 0, 7); c.fill();
  const blink = (now + p.seed) % 3600 < 130;
  if (blink) { c.lineWidth = 1.6; c.beginPath(); c.moveTo(0, -31 + hy); c.lineTo(4, -31 + hy); c.moveTo(6, -31 + hy); c.lineTo(10, -31 + hy); c.stroke(); c.lineWidth = 2; }
  else {
    for (const ex of [2, 8]) {
      c.fillStyle = '#fff'; c.beginPath(); c.ellipse(ex, -31 + hy, 2.6, 3.4, 0, 0, 7); c.fill(); c.lineWidth = 1.2; c.stroke();
      c.fillStyle = '#1b1530'; c.beginPath(); c.arc(ex + .9, -30.6 + hy, 1.5, 0, 7); c.fill();
    }
    c.lineWidth = 2;
  }
  c.lineWidth = 1.5; c.beginPath(); c.arc(5, -26 + hy, 2.4, .2, Math.PI - .2); c.stroke(); c.lineWidth = 2;
  if (em === 'cry') { c.fillStyle = '#6ec6ff'; for (const ex of [2, 8]) { c.beginPath(); c.ellipse(ex, -26 + hy + (now / 25 % 10), 1.3, 2, 0, 0, 7); c.fill(); } }
  if (wr.face === 210) { c.save(); c.translate(0, hy); drawShades(c); c.restore(); }
  if (wr.hat && HATS[wr.hat]) { c.save(); c.translate(0, hy); HATS[wr.hat](c); c.restore(); c.lineWidth = 2; c.strokeStyle = OL; }

  // front arm (punch)
  const pt = now - (p.punchT || 0);
  let ang = Math.PI / 2 + swing * .8, len = 9;
  if (em === 'wave') ang = -Math.PI / 2 + .3 + Math.sin(now / 90) * .5;
  if (em === 'cheer') ang = -Math.PI / 2 + .5 - Math.sin(now / 120) * .2;
  if (pt < 220) { const k = Math.sin(pt / 220 * Math.PI); ang += (p.punchA - ang) * k; len += 6 * k; }
  limb(c, 3, -17 + bob, ang, len, shirt || SKIN, wr.hand);
  c.restore();
}
function limb(c, x, y, ang, len, col, item) {
  c.save(); c.translate(x, y); c.rotate(ang - Math.PI / 2);
  c.fillStyle = col; rr(c, -2.6, -1, 5.2, len, 2.6); c.fill(); c.stroke();
  if (item) { c.save(); c.translate(0, len); c.rotate(Math.PI / 2 - .5); drawHandItem(c, item); c.restore(); c.lineWidth = 2; c.strokeStyle = OL; }
  c.fillStyle = SKIN; c.beginPath(); c.arc(0, len, 3.2, 0, 7); c.fill(); c.stroke();
  c.restore();
}

// ---- trees ----
function drawTree(c, t, x, y, now) {
  const it = ITEMS[t.s], prog = Math.min(1, (sNow() - t.t) / SG.growMs(t.s)), ripe = prog >= 1;
  c.save(); c.translate(x + 16, y + 32);
  c.rotate(Math.sin(now / 900 + x) * .03);
  const th = 6 + prog * 12;
  c.lineWidth = 2; c.strokeStyle = OL;
  c.fillStyle = '#7a4a22'; rr(c, -2.5, -th, 5, th, 2); c.fill(); c.stroke();
  const r = 4 + prog * 8;
  const leaf = it.type === 'bg' ? shade(it.col, .2) : it.col;
  for (const [dx, dy, k] of [[-r * .55, -th, .75], [r * .55, -th, .75], [0, -th - r * .45, .9]]) { c.fillStyle = shade(leaf, -.1); c.beginPath(); c.arc(dx, dy, r * k, 0, 7); c.fill(); c.stroke(); }
  for (const [dx, dy, k] of [[-r * .55, -th, .75], [r * .55, -th, .75], [0, -th - r * .45, .9]]) { c.fillStyle = leaf; c.beginPath(); c.arc(dx, dy, r * k - 1.2, 0, 7); c.fill(); }
  c.fillStyle = 'rgba(255,255,255,.35)'; c.beginPath(); c.arc(-r * .3, -th - r * .6, r * .3, 0, 7); c.fill();
  if (ripe) {
    const b = Math.sin(now / 260) * 1;
    for (const [fx, fy] of [[-7, -th - 4], [6, -th - 8], [1, -th + 3]]) drawIcon(c, t.s, fx - 4.5, fy - 4.5 + b, 9);
  }
  c.restore();
}

// ======================= PARTICLES =======================
function burst(x, y, col, n) {
  for (let i = 0; i < n; i++) particles.push({ x, y, vx: (Math.random() - .5) * 260, vy: -Math.random() * 260 - 40, life: 0, max: .5 + Math.random() * .4, col: col || '#999', s: 3 + Math.random() * 3, k: 'chunk' });
}
function puff(x, y) { for (let i = 0; i < 6; i++) particles.push({ x: x + (Math.random() - .5) * 20, y: y + (Math.random() - .5) * 20, vx: (Math.random() - .5) * 40, vy: -20, life: 0, max: .35, col: 'rgba(255,255,255,.7)', s: 3 + Math.random() * 3, k: 'puff' }); }
function sparkle(x, y) { for (let i = 0; i < 5; i++) particles.push({ x, y, vx: (Math.random() - .5) * 120, vy: (Math.random() - .5) * 120, life: 0, max: .35, col: '#fff7b0', s: 3, k: 'star' }); }
function floatText(x, y, text, col = '#fff') { floaters.push({ x, y, text, col, age: 0 }); }

// ======================= RENDER =======================
const cam = { x: 0, y: 0 };
let hover = null;

function drawSky(now) {
  const g = ctx.createLinearGradient(0, 0, 0, VH); g.addColorStop(0, '#3d8fff'); g.addColorStop(.7, '#9bd6ff'); g.addColorStop(1, '#d3f0ff');
  ctx.fillStyle = g; ctx.fillRect(0, 0, VW, VH);
  // sun
  const sx = VW * .82, sy = 90 - cam.y * .05;
  const sg = ctx.createRadialGradient(sx, sy, 10, sx, sy, 90); sg.addColorStop(0, 'rgba(255,250,200,.9)'); sg.addColorStop(1, 'rgba(255,250,200,0)');
  ctx.fillStyle = sg; ctx.fillRect(sx - 90, sy - 90, 180, 180);
  ctx.fillStyle = '#fff6b0'; ctx.beginPath(); ctx.arc(sx, sy, 32, 0, 7); ctx.fill();
  // clouds
  for (let i = 0; i < 7; i++) {
    const span = VW + 400, x = ((i * 337 + now * .008 * (1 + i % 3) - cam.x * .12) % span + span) % span - 200;
    const y = 50 + (i * 71) % 170 - cam.y * .08, s = .7 + (i % 3) * .3;
    ctx.fillStyle = 'rgba(255,255,255,.92)';
    for (const [dx, dy, r] of [[0, 0, 24], [26, -10, 30], [56, 0, 24], [28, 8, 24]]) { ctx.beginPath(); ctx.arc(x + dx * s, y + dy * s, r * s, 0, 7); ctx.fill(); }
  }
  // parallax hills
  for (const [par, col, amp, base, freq] of [[.2, '#8edc7a', 40, 21, 260], [.4, '#6cc95c', 28, 22.5, 170]]) {
    ctx.fillStyle = col; ctx.beginPath(); ctx.moveTo(0, VH);
    const by = (base * TS - cam.y) * (.5 + par) + VH * (.5 - par) * .5;
    for (let x = 0; x <= VW + 20; x += 20) { const wx = x + cam.x * par; ctx.lineTo(x, by - Math.sin(wx / freq) * amp - Math.sin(wx / (freq * .37)) * amp * .3); }
    ctx.lineTo(VW, VH); ctx.fill();
  }
}

function render(now) {
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  if (!world) { drawSky(now); return; }
  drawSky(now);
  ctx.save(); ctx.translate(-Math.round(cam.x), -Math.round(cam.y));
  const x0 = Math.max(0, Math.floor(cam.x / TS)), x1 = Math.min(W - 1, Math.floor((cam.x + VW) / TS));
  const y0 = Math.max(0, Math.floor(cam.y / TS)), y1 = Math.min(H - 1, Math.floor((cam.y + VH) / TS));
  // background layer
  for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) {
    const b = world.bg[ty * W + tx];
    if (b) { if (CONNECT.has(b)) drawConnected(ctx, 'bg', b, tx, ty, now); else drawTile(ctx, b, tx * TS, ty * TS, TS, now); }
  }
  // shadows cast by foreground blocks onto the background
  ctx.fillStyle = 'rgba(0,0,0,.35)';
  for (let ty = Math.max(0, y0 - 1); ty <= y1; ty++) for (let tx = Math.max(0, x0 - 1); tx <= x1; tx++) {
    if (!SG.isSolid(world.fg[ty * W + tx])) continue;
    const ri = ty * W + tx + 1, di = (ty + 1) * W + tx;
    if (tx + 1 < W && !SG.isSolid(world.fg[ri]) && world.bg[ri]) ctx.fillRect((tx + 1) * TS, ty * TS + 6, 6, TS - 6);
    if (ty + 1 < H && !SG.isSolid(world.fg[di]) && world.bg[di]) ctx.fillRect(tx * TS + 6, (ty + 1) * TS, TS - 6, 6);
  }
  // lava glow
  for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) if (world.fg[ty * W + tx] === 3) {
    const gx = tx * TS + 16, gy = ty * TS + 16, gg = ctx.createRadialGradient(gx, gy, 4, gx, gy, 44);
    gg.addColorStop(0, 'rgba(255,140,40,.35)'); gg.addColorStop(1, 'rgba(255,140,40,0)'); ctx.fillStyle = gg; ctx.fillRect(gx - 44, gy - 44, 88, 88);
  }
  // foreground + trees + damage
  for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) {
    const i = ty * W + tx, f = world.fg[i];
    if (f) { if (CONNECT.has(f)) drawConnected(ctx, 'fg', f, tx, ty, now); else drawTile(ctx, f, tx * TS, ty * TS, TS, now); }
    if (world.trees[i]) drawTree(ctx, world.trees[i], tx * TS, ty * TS, now);
    const d = dmg[i];
    if (d) { if (now - d.t > 5000) delete dmg[i]; else drawCracks(tx * TS, ty * TS, d.h / d.hp); }
  }
  // depth shading
  const dg = ctx.createLinearGradient(0, 30 * TS, 0, H * TS); dg.addColorStop(0, 'rgba(10,5,20,0)'); dg.addColorStop(1, 'rgba(10,5,20,.5)');
  ctx.fillStyle = dg; ctx.fillRect(x0 * TS, Math.max(30 * TS, y0 * TS), (x1 - x0 + 1) * TS, (y1 - y0 + 1) * TS);
  // drops
  for (const d of Object.values(world.drops)) {
    const b = Math.sin(now / 300 + d.id) * 2.5;
    ctx.fillStyle = 'rgba(0,0,0,.18)'; ctx.beginPath(); ctx.ellipse(d.x, d.y + 11, 7, 2, 0, 0, 7); ctx.fill();
    if (d.item === 'gem') drawGem(ctx, d.x, d.y + b, 15, d.n, Math.cos(now / 250 + d.id));
    else {
      ctx.save(); ctx.translate(d.x, d.y + b); ctx.rotate(Math.sin(now / 500 + d.id) * .12);
      ctx.fillStyle = 'rgba(255,255,255,.35)'; ctx.beginPath(); ctx.arc(0, 0, 12, 0, 7); ctx.fill();
      drawIcon(ctx, d.item, -9, -9, 18); ctx.restore();
      if (d.n > 1) outlinedText(String(d.n), d.x + 9, d.y + b + 10, 11, '#fff');
    }
  }
  // hover highlight
  if (hover) {
    const ok = inRange(hover.x, hover.y), pulse = 1 + Math.sin(now / 150) * .5;
    ctx.lineWidth = 2 + pulse; ctx.strokeStyle = ok ? 'rgba(255,255,255,.9)' : 'rgba(255,90,90,.6)';
    rr(ctx, hover.x * TS + 1, hover.y * TS + 1, TS - 2, TS - 2, 6); ctx.stroke();
  }
  // players
  for (const p of Object.values(others)) {
    if (p.ghost && now - p.ghost < 1200) drawGhost(p, p.gx, p.gy, now - p.ghost, now);
    else { drawAvatar(ctx, p, now); nameTag(p, false); }
  }
  if (me.dead) drawGhost({ ...me, worn }, me.deadAt.x, me.deadAt.y, now - me.dead, now);
  else {
    if (now - me.hurtT < 300 && Math.floor(now / 60) % 2) ctx.globalAlpha = .5;
    drawAvatar(ctx, { ...me, worn }, now); ctx.globalAlpha = 1;
    nameTag({ ...me, name: myName }, true);
    if (me.hp < 100) {
      const bx = me.x - 4, by = me.y - (worn.hat ? 40 : 28);
      ctx.fillStyle = OL; rr(ctx, bx, by, 28, 6, 3); ctx.fill();
      ctx.fillStyle = me.hp > 50 ? '#5ccc4c' : me.hp > 25 ? '#ffb02e' : '#ff4d4d'; rr(ctx, bx + 1, by + 1, 26 * me.hp / 100, 4, 2); ctx.fill();
    }
  }
  for (const p of [...Object.values(others), { ...me, name: myName }]) bubble(p, now);
  // particles
  for (const p of particles) {
    const a = 1 - p.life / p.max; ctx.globalAlpha = Math.max(0, a);
    if (p.k === 'chunk') { ctx.fillStyle = p.col; ctx.fillRect(p.x - p.s / 2, p.y - p.s / 2, p.s, p.s); ctx.strokeStyle = 'rgba(0,0,0,.4)'; ctx.lineWidth = 1; ctx.strokeRect(p.x - p.s / 2, p.y - p.s / 2, p.s, p.s); }
    else if (p.k === 'puff') { ctx.fillStyle = p.col; ctx.beginPath(); ctx.arc(p.x, p.y, p.s * (1 + p.life * 2), 0, 7); ctx.fill(); }
    else { ctx.fillStyle = p.col; star(p.x, p.y, p.s); }
  }
  ctx.globalAlpha = 1;
  for (const f of floaters) { ctx.globalAlpha = Math.max(0, 1 - f.age / 1.4); outlinedText(f.text, f.x, f.y - f.age * 32, 14, f.col); }
  ctx.globalAlpha = 1;
  ctx.restore();
}
function drawGhost(p, x, y, t, now) {
  const k = Math.min(1, t / 1100);
  ctx.save(); ctx.globalAlpha = Math.max(0, 1 - k); ctx.filter = 'grayscale(1) brightness(1.7)';
  drawAvatar(ctx, { ...p, x, y: y - k * 40, vx: 0, g: true, punchT: 0 }, now);
  ctx.filter = 'none'; ctx.restore();
  ctx.globalAlpha = Math.max(0, 1 - k); outlinedText('💀', x + 10, y - 20 - k * 50, 22, '#fff'); ctx.globalAlpha = 1;
}
function drawCracks(x, y, f) {
  ctx.save(); ctx.translate(x, y); ctx.strokeStyle = 'rgba(0,0,0,.65)'; ctx.lineWidth = 2; ctx.lineCap = 'round'; ctx.beginPath();
  const lines = [[16, 16, 5, 4], [16, 16, 27, 9], [16, 16, 9, 28], [16, 16, 26, 26], [5, 4, 3, 12], [27, 9, 30, 17]];
  const n = Math.ceil(f * lines.length);
  for (let k = 0; k < n; k++) { const [a, b, c2, d] = lines[k]; ctx.moveTo(a, b); ctx.lineTo(c2, d); }
  ctx.stroke(); ctx.restore();
}
function star(x, y, s) { ctx.beginPath(); for (let k = 0; k < 8; k++) { const r = k % 2 ? s * .4 : s * 1.4, a = k * Math.PI / 4; ctx.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r); } ctx.fill(); }
function outlinedText(t, x, y, size, col) {
  ctx.font = `700 ${size}px Fredoka, system-ui`; ctx.textAlign = 'center'; ctx.lineJoin = 'round';
  ctx.lineWidth = 3.5; ctx.strokeStyle = 'rgba(20,15,30,.9)'; ctx.strokeText(t, x, y); ctx.fillStyle = col; ctx.fillText(t, x, y);
}
function nameTag(p, mine) {
  const isOwner = world.owner === p.name;
  outlinedText((isOwner ? '👑 ' : '') + p.name + ` [${mine ? level : p.level || 1}]`, p.x + 10, p.y - (p.worn?.hat || (mine && worn.hat) ? 22 : 10), 13, mine ? '#fff58a' : '#ffffff');
}
function bubble(p, now) {
  if (!p.bubble || now - p.bubble.t > 5000) return;
  ctx.font = '600 13px Fredoka, system-ui';
  const t = p.bubble.text.length > 40 ? p.bubble.text.slice(0, 38) + '…' : p.bubble.text, w = ctx.measureText(t).width + 16;
  const x = p.x + 10 - w / 2, y = p.y - 58;
  ctx.fillStyle = '#fff'; ctx.strokeStyle = OL; ctx.lineWidth = 2; rr(ctx, x, y, w, 22, 9); ctx.fill(); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(p.x + 5, y + 22); ctx.lineTo(p.x + 10, y + 29); ctx.lineTo(p.x + 15, y + 22); ctx.fill();
  ctx.fillStyle = '#1b1f3b'; ctx.textAlign = 'center'; ctx.fillText(t, p.x + 10, y + 15);
}

// ======================= PHYSICS =======================
function tileAt(tx, ty) { return (tx < 0 || ty < 0 || tx >= W || ty >= H) ? 0 : world.fg[ty * W + tx]; }
function solidAt(tx, ty) { if (tx < 0 || tx >= W || ty >= H) return true; if (ty < 0) return false; return SG.isSolid(world.fg[ty * W + tx]); }
function rectHits(x, y, w, h) {
  for (let ty = Math.floor(y / TS); ty <= Math.floor((y + h - EPS) / TS); ty++)
    for (let tx = Math.floor(x / TS); tx <= Math.floor((x + w - EPS) / TS); tx++) if (solidAt(tx, ty)) return true;
  return false;
}
function inRange(tx, ty) { return Math.hypot((tx + .5) * TS - (me.x + 10), (ty + .5) * TS - (me.y + 15)) <= RANGE * TS; }
const keys = {};
function platformRow(ty) {
  for (let tx = Math.floor(me.x / TS); tx <= Math.floor((me.x + me.w - EPS) / TS); tx++) if (SG.isPlatform(tileAt(tx, ty))) return true;
  return false;
}
function die() {
  if (me.dead || !world) return;
  me.dead = performance.now(); me.deadAt = { x: me.x, y: me.y }; me.vx = me.vy = 0; mouse.down = false;
  burst(me.x + 10, me.y + 15, '#ffffff', 16); burst(me.x + 10, me.y + 15, '#ff4d4d', 8);
  send({ t: 'die' });
  setTimeout(respawn, 1200);
}
function respawn() {
  if (!world) return;
  me.x = world.door.x * TS + 6; me.y = world.door.y * TS + 2; me.vx = me.vy = 0; me.hp = 100; me.dead = 0; me.jumps = 0;
  puff(me.x + 10, me.y + 15); sparkle(me.x + 10, me.y + 5);
  send({ t: 'pos', x: me.x, y: me.y, vx: 0, f: me.f, g: true }); lastPos = performance.now();
}
let jumpHeld = false, lastPos = 0, lastSent = '';

function update(dt, now) {
  if (!world) return;
  const typing = document.activeElement === $('#chatin') || !!me.dead;
  const L = !typing && (keys.ArrowLeft || keys.KeyA || keys.left), R = !typing && (keys.ArrowRight || keys.KeyD || keys.right);
  const J = !typing && (keys.ArrowUp || keys.KeyW || keys.Space || keys.jump), D = !typing && (keys.ArrowDown || keys.KeyS);
  if (!me.dead) {
    const target = ((R ? 1 : 0) - (L ? 1 : 0)) * 230;
    me.vx += (target - me.vx) * Math.min(1, dt * (me.g ? 18 : 8));
    if (Math.abs(me.vx) < 3) me.vx = 0;
    if (target) me.f = Math.sign(target);

    // jumping: buffered presses + a little coyote time so jumps never get eaten
    const pressed = J && !jumpHeld; jumpHeld = J;
    if (pressed) me.jumpBuf = now;
    if (me.g) { me.lastGround = now; me.jumps = 0; }
    if (now - me.jumpBuf < 120) {
      if (me.jumps === 0 && now - me.lastGround < 100) { me.vy = -520; me.jumps = 1; me.jumpBuf = 0; me.lastGround = 0; }
      else if (pressed && worn.back === 240 && me.jumps < 2) { me.vy = -470; me.jumps = 2; me.jumpBuf = 0; puff(me.x + 10, me.y + 28); }
    }
    if (!J && me.vy < -200) me.vy += 1600 * dt;       // short hop when the key is released early
    me.vy = Math.min(820, me.vy + 1500 * dt);

    me.x += me.vx * dt;
    if (rectHits(me.x, me.y, me.w, me.h)) { me.x = me.vx > 0 ? Math.floor((me.x + me.w - EPS) / TS) * TS - me.w : (Math.floor(me.x / TS) + 1) * TS; me.vx = 0; }
    const prevBottom = me.y + me.h;
    me.y += me.vy * dt;
    if (rectHits(me.x, me.y, me.w, me.h)) {
      me.y = me.vy > 0 ? Math.floor((me.y + me.h - EPS) / TS) * TS - me.h : (Math.floor(me.y / TS) + 1) * TS;
      me.vy = 0;
    } else if (me.vy > 0 && !D) {                      // one-way platforms
      const ty = Math.floor((me.y + me.h - EPS) / TS);
      if (prevBottom <= ty * TS + .5 && platformRow(ty)) { me.y = ty * TS - me.h; me.vy = 0; }
    }
    me.g = me.vy >= 0 && (rectHits(me.x, me.y + 1, me.w, me.h) || (!D && Math.abs((me.y + me.h) / TS - Math.round((me.y + me.h) / TS)) < .02 && platformRow(Math.round((me.y + me.h) / TS))));

    // hazards: spikes kill, lava burns (3 touches and you're toast); health slowly regenerates
    let hz = null;
    for (let ty = Math.floor((me.y - 1) / TS); ty <= Math.floor((me.y + me.h) / TS); ty++)
      for (let tx = Math.floor((me.x - 1) / TS); tx <= Math.floor((me.x + me.w) / TS); tx++) {
        const it = ITEMS[tileAt(tx, ty)];
        if (it?.kill) { const sx = tx * TS, sy = ty * TS + 6; if (me.x < sx + TS && me.x + me.w > sx && me.y < sy + TS && me.y + me.h > sy) hz = 'kill'; }
        else if (it?.hurt && !hz) hz = 'lava';
      }
    if (hz === 'kill') die();
    else if (hz === 'lava' && now - me.hurtT > 500) {
      me.hp -= 34; me.vy = -480; me.hurtT = now; burst(me.x + 10, me.y + 28, '#ff8a2a', 8);
      floatText(me.x + 10, me.y - 10, 'Ouch!', '#ffb02e');
      if (me.hp <= 0) die();
    } else if (now - me.hurtT > 3000) me.hp = Math.min(100, me.hp + 25 * dt);
    if (me.y > H * TS) die();
  }
  me.walk += Math.abs(me.vx) * dt * .045;

  // remote players: smooth toward target
  for (const p of Object.values(others)) {
    const k = p.ghost && performance.now() - p.ghost < 1200 ? 1 : Math.min(1, dt * 14);
    p.x += (p.tx - p.x) * k; p.y += (p.ty - p.y) * k; p.walk += Math.abs(p.vx) * dt * .045;
  }
  for (const p of particles) { p.life += dt; p.x += p.vx * dt; p.y += p.vy * dt; if (p.k === 'chunk') p.vy += 900 * dt; }
  for (let i = particles.length - 1; i >= 0; i--) if (particles[i].life > particles[i].max) particles.splice(i, 1);
  for (const f of floaters) f.age += dt;
  while (floaters.length && floaters[0].age > 1.4) floaters.shift();

  // camera
  const cx = Math.max(0, Math.min(W * TS - VW, me.x + 10 - VW / 2)), cy = Math.max(-100, Math.min(H * TS - VH, me.y + 15 - VH / 2));
  cam.x += (cx - cam.x) * Math.min(1, dt * 8); cam.y += (cy - cam.y) * Math.min(1, dt * 8);
  if (W * TS < VW) cam.x = (W * TS - VW) / 2;

  // network position
  const s = `${Math.round(me.x)},${Math.round(me.y)},${me.f},${me.g},${Math.round(me.vx)}`;
  if (!me.dead && ((s !== lastSent && now - lastPos > 60) || now - lastPos > 1000)) { send({ t: 'pos', x: me.x, y: me.y, vx: me.vx, f: me.f, g: me.g }); lastSent = s; lastPos = now; }

  if (mouse.down && now - lastAct > 200) actAtMouse();
}

// ======================= ACTIONS / INPUT =======================
const mouse = { x: 0, y: 0, down: false };
let lastAct = 0;
function aimPunch(p, tx, ty) {
  const dx = (tx + .5) * TS - (p.x + 10), dy = (ty + .5) * TS - (p.y + 14);
  p.f = dx < 0 ? -1 : 1; p.punchT = performance.now(); p.punchA = Math.atan2(dy, Math.abs(dx));
}
function act(tx, ty) {
  if (!world || me.dead || tx < 0 || ty < 0 || tx >= W || ty >= H || !inRange(tx, ty)) return;
  const i = ty * W + tx, f = world.fg[i], b = world.bg[i], tree = world.trees[i], it = ITEMS[selected];
  if (selected === WRENCH) {
    if (ITEMS[f]?.type === 'lock') toast(`🔒 ${ITEMS[f].name} — this world belongs to ${world.owner}.`);
    else if (tree) toast(`🌳 ${ITEMS[tree.s].name} Tree — ${sNow() - tree.t >= SG.growMs(tree.s) ? 'ripe!' : fmtTime(SG.growMs(tree.s) - (sNow() - tree.t)) + ' left'}`);
    else if (f) toast(`${ITEMS[f].name}${ITEMS[f].hp === Infinity ? ' (unbreakable)' : ` — ${ITEMS[f].hp} hits to break`}`);
    return;
  }
  aimPunch(me, tx, ty);
  let place = false;
  if (selected && inv[selected] > 0) {
    if (it.type === 'seed') place = !f && (!tree || (SG.splice(tree.s, it.of) != null && sNow() - tree.t < SG.growMs(tree.s)));
    else if (it.type === 'bg') place = !b && !f && !tree;
    else if (['block', 'platform', 'lock', 'spikes'].includes(it.type)) place = !f && !tree;
  }
  if (place) { send({ t: 'place', x: tx, y: ty, id: selected }); burst(tx * TS + 16, ty * TS + 16, it.col || '#fff', 3); }
  else if (selected === 0 || it?.type === 'wear') { send({ t: 'punch', x: tx, y: ty, tool: selected }); particles.push({ x: tx * TS + 16, y: ty * TS + 16, vx: 0, vy: 0, life: 0, max: .15, col: '#fff', s: 7, k: 'star' }); }
}
function worldMouse() { return { x: mouse.x + cam.x, y: mouse.y + cam.y }; }
function actAtMouse() { lastAct = performance.now(); const w = worldMouse(); act(Math.floor(w.x / TS), Math.floor(w.y / TS)); }

cv.addEventListener('pointermove', (e) => {
  mouse.x = e.clientX; mouse.y = e.clientY;
  if (!world) return;
  const w = worldMouse(), tx = Math.floor(w.x / TS), ty = Math.floor(w.y / TS);
  hover = { x: tx, y: ty };
  const t = world.trees[ty * W + tx], tip = $('#tip');
  if (t) {
    const left = Math.max(0, SG.growMs(t.s) - (sNow() - t.t));
    showTip(e, `${ITEMS[t.s].name} Tree — ${left ? fmtTime(left) + ' left' : 'ripe! punch to harvest 🍎'}`);
  } else hideTip();
});
cv.addEventListener('pointerleave', () => { hover = null; mouse.down = false; hideTip(); });
cv.addEventListener('pointerdown', (e) => {
  mouse.x = e.clientX; mouse.y = e.clientY;
  if (!world) return;
  $('#chatin').blur();
  const w = worldMouse();
  for (const p of Object.values(others)) {
    if (w.x >= p.x - 4 && w.x <= p.x + 24 && w.y >= p.y - 12 && w.y <= p.y + 30 && (selected === 0 || selected === WRENCH || ITEMS[selected].type === 'wear')) return openPlayer(p);
  }
  if (w.x >= me.x && w.x <= me.x + 20 && w.y >= me.y - 12 && w.y <= me.y + 30 && (selected === WRENCH || (selected === 0 && w.y <= me.y + 12))) return openPlayer({ ...me, name: myName, worn });
  mouse.down = true; actAtMouse();
});
addEventListener('pointerup', () => (mouse.down = false));
cv.addEventListener('contextmenu', (e) => e.preventDefault());
cv.addEventListener('wheel', (e) => { const ids = invIds(); const k = ids.indexOf(selected) + Math.sign(e.deltaY); selectItem(ids[(k + ids.length) % ids.length]); }, { passive: true });

addEventListener('keydown', (e) => {
  const chatin = $('#chatin');
  if (document.activeElement === chatin) {
    if (e.key === 'Enter') { sendChat(); closeChat(); }
    if (e.key === 'Escape') closeChat();
    return;
  }
  if (e.target.tagName === 'INPUT') return;
  if (!world) return;
  keys[e.code] = true;
  if (e.key === 'Enter') { openChat(); e.preventDefault(); }
  if (e.code === 'KeyB' || e.code === 'KeyI') toggleInv();
  if (e.code === 'KeyR') die();
  if (e.code === 'Escape') document.querySelectorAll('.modal').forEach((m) => m.id !== 'trade' && m.classList.add('hidden'));
  if (/^Digit[1-9]$/.test(e.code)) { const id = invCells()[+e.code.slice(5) - 1]; if (id != null) selectItem(id); }
  if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
});
addEventListener('keyup', (e) => (keys[e.code] = false));
addEventListener('blur', () => { for (const k in keys) keys[k] = false; });
document.querySelectorAll('#touch [data-k]').forEach((b) => {
  b.addEventListener('pointerdown', (e) => { e.preventDefault(); keys[b.dataset.k] = true; });
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) b.addEventListener(ev, () => (keys[b.dataset.k] = false));
});
$('#chatTouch').onclick = openChat;

// ======================= UI =======================
function showScreen(which) {
  $('#loginScreen').classList.toggle('hidden', which !== 'login');
  $('#nameScreen').classList.toggle('hidden', which !== 'name');
  $('#menuScreen').classList.toggle('hidden', which !== 'menu');
  for (const id of ['#hud', '#inv', '#chat', '#touch']) $(id).classList.toggle('hidden', which !== 'game');
  if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
  if (which !== 'game') { world = null; document.querySelectorAll('.modal').forEach((m) => m.classList.add('hidden')); }
}
function toast(text) { const t = document.createElement('div'); t.className = 'toast'; t.textContent = text; $('#toasts').appendChild(t); setTimeout(() => t.remove(), 4000); }
function addChat(html, cls) {
  const log = $('#chatlog'), atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 30;
  const d = document.createElement('div'); d.innerHTML = html; if (cls) d.className = cls;
  log.appendChild(d); while (log.children.length > 100) log.firstChild.remove();
  if (atBottom) log.scrollTop = log.scrollHeight;
}
const NAME_COLS = ['#7fe3ff', '#9dff8a', '#ffd36b', '#ff9ec7', '#c3a6ff', '#ffb27a', '#7affd1'];
function nameColor(n) { if (n === myName) return '#fff58a'; let h = 0; for (const ch of n) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return NAME_COLS[h % NAME_COLS.length]; }
const HELP = ['/msg <name> <text> — private message', '/r <text> — reply to last message', '/me <action> — describe an action', '/who — players in this world',
  '/wave /dance /cheer /cry /laugh — emotes', '/respawn — go back to the door', '/clear — clear chat'];
function sendChat() {
  const i = $('#chatin'), t = i.value.trim(); i.value = '';
  if (!t) return;
  const cmd = t.split(' ')[0].toLowerCase();
  if (cmd === '/help' || cmd === '/?') return HELP.forEach((h) => sysChat(h));
  if (cmd === '/clear') { $('#chatlog').innerHTML = ''; return; }
  if (cmd === '/respawn') return die();
  send({ t: 'chat', text: t });
}
$('#chatSend').onclick = () => { sendChat(); closeChat(); };
$('#chatMin').onclick = () => { $('#chat').classList.toggle('min'); $('#chatMin').textContent = $('#chat').classList.contains('min') ? '+' : '–'; };
function sysChat(text) { addChat(esc(text), 'sys'); }
function openChat() { $('#chat').classList.remove('min'); $('#chatMin').textContent = '–'; $('#chatin').focus(); for (const k in keys) keys[k] = false; }
function closeChat() { $('#chatin').blur(); }
const tipEl = Object.assign(document.createElement('div'), { id: 'tip' });
tipEl.style.cssText = 'position:fixed;pointer-events:none;background:#fdf7e8;border:2px solid #3b2a14;border-radius:8px;padding:3px 8px;font-size:13px;font-weight:600;display:none;z-index:4';
document.body.appendChild(tipEl);
function showTip(e, text) { tipEl.textContent = text; tipEl.style.display = 'block'; tipEl.style.left = e.clientX + 14 + 'px'; tipEl.style.top = e.clientY + 14 + 'px'; }
function hideTip() { tipEl.style.display = 'none'; }
function fmtTime(ms) { const s = Math.ceil(ms / 1000); return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`; }
function updateWorldPill() { $('#worldName').innerHTML = `🌍 ${esc(world.name)}` + (world.owner ? ` <small>🔒 ${esc(world.owner)}</small>` : ''); }
function toggleModal(id, render) { const m = $('#' + id); if (m.classList.contains('hidden')) { render && render(); m.classList.remove('hidden'); } else m.classList.add('hidden'); }
document.querySelectorAll('[data-close]').forEach((b) => (b.onclick = () => b.closest('.modal').classList.add('hidden')));
document.querySelectorAll('.modal').forEach((m) => m.addEventListener('pointerdown', (e) => { if (e.target === m && m.id !== 'trade') m.classList.add('hidden'); }));

const ORDER = { fist: 0, wrench: 0, block: 1, platform: 1, spikes: 1, bg: 2, seed: 3, lock: 4, wear: 5 };
// Backpack layout: the player's saved slot order (with gaps); new items fill the first free slot.
function buildLayout() {
  const owned = Object.keys(inv).map(Number).filter((id) => inv[id] > 0 && ITEMS[id]);
  const lay = new Array(Math.max(slots, owned.length)).fill(null), placed = new Set();
  (layout || []).forEach((id, k) => { if (k < lay.length && id != null && inv[id] > 0 && !placed.has(id)) { lay[k] = id; placed.add(id); } });
  for (const id of owned.filter((id) => !placed.has(id)).sort((a, b) => ORDER[ITEMS[a].type] - ORDER[ITEMS[b].type] || a - b)) {
    const k = lay.indexOf(null); if (k < 0) lay.push(id); else lay[k] = id;
  }
  return lay;
}
function invCells() { return [0, WRENCH, ...buildLayout()]; }
function invIds() { return invCells().filter((id) => id != null); }
function moveSlot(from, to) {
  const lay = buildLayout();
  if (from === to || from < 0 || to < 0 || from >= lay.length || to >= lay.length) return;
  [lay[from], lay[to]] = [lay[to], lay[from]];
  layout = lay; send({ t: 'layout', layout: lay }); renderInv();
}
function selectItem(id) {
  selected = id;
  if (ITEMS[id]?.slot === 'hand' && worn.hand !== id) send({ t: 'wear', id });   // holding a tool equips it
  refreshHUD();
}
function slotEl(id, count, opts = {}) {
  const d = document.createElement('div'); d.className = 'slot' + (opts.sel ? ' sel' : '') + (opts.worn ? ' worn' : ''); d.title = ITEMS[id].name;
  const c = document.createElement('canvas'); c.width = c.height = 72; const x = c.getContext('2d'); x.scale(2, 2); drawIcon(x, id, 0, 0, 36);
  d.appendChild(c);
  if (count != null) { const b = document.createElement('b'); b.textContent = count; d.appendChild(b); }
  if (opts.key) { const i = document.createElement('i'); i.textContent = opts.key; d.appendChild(i); }
  return d;
}
function refreshHUD() {
  $('#gems').textContent = gems.toLocaleString();
  $('#lvlNum').textContent = level; $('#lvlBar').style.width = Math.min(100, xp / xpNeed * 100) + '%'; $('#lvl').title = `${xp} / ${xpNeed} XP`;
  $('#slock').textContent = ((inv[SLOCK] || 0) + (inv[DSLOCK] || 0) * 100).toLocaleString();
  if (!invIds().includes(selected)) selected = 0;
  renderInv();
}

// ---- Growtopia-style backpack: a quick bar that drops open into the full slot grid ----
let invOpen = false, layout = [], dragFrom = null;
function toggleInv() { invOpen = !invOpen; renderInv(); }
function itemDesc(it) {
  return it.desc || ({ seed: `Plant it on a block to grow ${ITEMS[it.of]?.name}. Plant on an unripe tree to splice.`, bg: 'Background block. Goes behind everything.',
    block: `Takes ${it.hp} hits to break.`, platform: 'Jump up through it. Hold S to drop down.', wear: `Clothing (${it.slot}). Double-click to wear.` }[it.type] || '');
}
function renderInv() {
  const g = $('#invGrid'); g.innerHTML = '';
  const all = invCells(), items = all.length - 2 - all.slice(2).filter((id) => id == null).length;
  const cells = invOpen ? all.length : 10;
  for (let k = 0; k < cells; k++) {
    const id = all[k], slotIdx = k - 2;
    let s;
    if (id == null) { s = document.createElement('div'); s.className = 'slot empty'; }
    else {
      s = slotEl(id, id && id !== WRENCH ? inv[id] : null, { sel: id === selected, worn: Object.values(worn).includes(id), key: k < 9 ? k + 1 : '' });
      s.onclick = () => selectItem(id);
      s.ondblclick = () => { if (ITEMS[id].type === 'wear') send({ t: 'wear', id }); };
    }
    if (slotIdx >= 0) {   // drag items between backpack slots
      if (id != null) {
        s.draggable = true;
        s.addEventListener('dragstart', (e) => { dragFrom = slotIdx; s.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(slotIdx)); });
        s.addEventListener('dragend', () => { dragFrom = null; s.classList.remove('dragging'); });
      }
      s.addEventListener('dragover', (e) => { if (dragFrom != null) { e.preventDefault(); s.classList.add('dropto'); } });
      s.addEventListener('dragleave', () => s.classList.remove('dropto'));
      s.addEventListener('drop', (e) => { e.preventDefault(); s.classList.remove('dropto'); if (dragFrom != null) moveSlot(dragFrom, slotIdx); dragFrom = null; });
    }
    g.appendChild(s);
  }
  $('#inv').classList.toggle('open', invOpen);
  $('#invToggle').textContent = invOpen ? '▼' : '▲';
  $('#invFoot').classList.toggle('hidden', !invOpen);
  $('#slotCount').textContent = `🎒 ${items} / ${slots} slots used`;
  $('#upgradeBtn').textContent = `+10 slots · ${upCost} 🔒`;
  const box = $('#invInfo'), id = selected;
  if (!invOpen || !id || id === WRENCH || !inv[id]) { box.classList.add('hidden'); return; }
  const it = ITEMS[id], isWorn = Object.values(worn).includes(id);
  box.classList.remove('hidden');
  box.innerHTML = `<canvas class="ic" width="72" height="72"></canvas><div class="grow"><b>${esc(it.name)}</b> ×${inv[id]}<small>${esc(itemDesc(it))}</small></div>
    ${it.type === 'wear' ? `<button class="btn sol" id="iWear">${isWorn ? 'Remove' : 'Wear'}</button>` : ''}
    <button class="btn" id="iDrop">Drop</button><button class="btn red" id="iTrash" title="Trash">🗑</button>`;
  const ic = box.querySelector('canvas').getContext('2d'); ic.scale(2, 2); drawIcon(ic, id, 0, 0, 36);
  if ($('#iWear')) $('#iWear').onclick = () => send({ t: 'wear', id });
  $('#iDrop').onclick = () => askCount(`Drop ${it.name}`, 'How many do you want to drop? Anyone can pick them up.', inv[id], (n) => send({ t: 'drop', id, n }));
  $('#iTrash').onclick = () => askCount(`Trash ${it.name}`, it.type === 'lock' ? '⚠️ These are worth real SOL and will be destroyed forever!' : 'Trashed items are destroyed forever.', inv[id], (n) => send({ t: 'trash', id, n }), true);
}
function askCount(title, text, max, cb, danger) {
  $('#cmTitle').textContent = title; $('#cmText').textContent = text;
  const n = $('#cmN'); n.max = max; n.value = danger ? 1 : max;
  $('#cmOk').className = 'btn ' + (danger ? 'red' : 'green');
  $('#cmOk').onclick = () => { const v = Math.max(1, Math.min(max, Math.floor(+n.value || 1))); $('#countModal').classList.add('hidden'); cb(v); };
  $('#countModal').classList.remove('hidden'); n.focus(); n.select();
}
$('#invToggle').onclick = toggleInv;
$('#bagBtn').onclick = toggleInv;
$('#upgradeBtn').onclick = () => send({ t: 'buy', key: 'bpupgrade' });
$('#lvl').onclick = () => openPlayer({ ...me, name: myName, worn });

// ---- store ----
function renderStore() {
  const box = $('#storeItems'); box.innerHTML = '';
  const up = document.createElement('div'); up.className = 'line';
  up.innerHTML = `<div style="font-size:30px;width:36px;text-align:center">🎒</div><div class="grow"><b>Backpack Upgrade</b><small>+10 inventory slots (you have ${slots}) · ${upCost} 🔒 SLOCK</small></div>`;
  const ub = document.createElement('button'); ub.className = 'btn green'; ub.textContent = 'Buy'; ub.onclick = () => { send({ t: 'buy', key: 'bpupgrade' }); setTimeout(renderStore, 300); };
  up.appendChild(ub); box.appendChild(up);
  const groups = [['Solana Locks (bought with gems)', (s) => s.price.gems], ['Packs', (s) => s.price.slock && !s.wear], ['Clothing & gear', (s) => s.wear]];
  for (const [title, fn] of groups) {
    const h = document.createElement('div'); h.className = 'sec'; h.textContent = title; box.appendChild(h);
    for (const s of SG.STORE.filter(fn)) {
      const line = document.createElement('div'); line.className = 'line';
      const iconId = s.wear || +Object.keys(s.give || {})[0] || null;
      const price = s.price.gems ? `${s.price.gems.toLocaleString()} 💎` : `${s.price.slock} 🔒 SLOCK`;
      const it = s.wear ? ITEMS[s.wear] : null;
      line.innerHTML = `<canvas class="ic" width="72" height="72"></canvas><div class="grow"><b>${esc(s.name)}</b><small>${price}${it?.desc ? ' · ' + esc(it.desc) : ''}</small></div>`;
      const ic = line.querySelector('canvas').getContext('2d'); ic.scale(2, 2);
      if (iconId != null) drawIcon(ic, iconId, 0, 0, 36); else drawGem(ic, 18, 18, 26, 1, 1);
      const b = document.createElement('button'); b.className = 'btn ' + (s.price.slock ? 'sol' : 'green'); b.textContent = 'Buy';
      if (s.price.gems && gems < s.price.gems) b.disabled = true;
      b.onclick = () => { send({ t: 'buy', key: s.key }); setTimeout(() => !$('#store').classList.contains('hidden') && renderStore(), 300); }; line.appendChild(b); box.appendChild(line);
    }
  }
  $('#storeGems').textContent = `You have ${gems.toLocaleString()} 💎 and ${((inv[SLOCK] || 0) + (inv[DSLOCK] || 0) * 100).toLocaleString()} 🔒`;
}
$('#storeBtn').onclick = () => toggleModal('store', renderStore);
document.querySelectorAll('[data-convert]').forEach((b) => (b.onclick = () => send({ t: 'convert', dir: b.dataset.convert })));

// ---- player popup ----
let popPlayer = null;
function openPlayer(p) {
  popPlayer = p.name; $('#ppName').textContent = p.name;
  $('#ppInfo').innerHTML = '<div class="muted">Loading…</div>'; send({ t: 'info', name: p.name });
  $('#ppTrade').classList.toggle('hidden', p.name === myName);
  const c = $('#ppAvatar').getContext('2d'); c.clearRect(0, 0, 160, 160);
  drawAvatar(c, { ...p, x: 0, y: 0, vx: 0, g: true, f: 1, punchT: 0 }, performance.now(), { at: [80, 140], scale: 2.6 });
  const names = Object.values(p.worn || {}).map((id) => ITEMS[id]?.name).filter(Boolean);
  $('#ppWorn').textContent = names.length ? 'Wearing: ' + names.join(', ') : 'Not wearing anything fancy.';
  $('#ppop').classList.remove('hidden');
}
function renderInfo(m) {
  if (m.name !== popPlayer) return;
  const st = m.stats, pct = Math.min(100, m.xp / m.need * 100);
  $('#ppInfo').innerHTML = `
    <div class="row" style="justify-content:space-between"><b style="font-size:18px">⭐ Level ${m.level}</b><span class="muted">${m.xp} / ${m.need} XP</span></div>
    <div class="xpbar"><div style="width:${pct}%"></div></div>
    <div class="stats">
      <div>🧱 <b>${st.broken.toLocaleString()}</b><small>blocks broken</small></div>
      <div>🌳 <b>${st.harvested.toLocaleString()}</b><small>trees harvested</small></div>
      <div>🌱 <b>${st.planted.toLocaleString()}</b><small>seeds planted</small></div>
      <div>🧬 <b>${st.spliced.toLocaleString()}</b><small>splices</small></div>
      <div>🤝 <b>${st.trades.toLocaleString()}</b><small>trades</small></div>
      <div>📅 <b>${new Date(m.created).toLocaleDateString()}</b><small>joined</small></div>
    </div>
    <div class="muted" style="margin-top:6px">${m.world ? '🟢 Online in ' + esc(m.world) : '⚪ Offline'}${m.owns.length ? ' · Owns: ' + m.owns.map(esc).join(', ') : ''}</div>`;
}
$('#ppTrade').onclick = () => { send({ t: 'trade_req', to: popPlayer }); $('#ppop').classList.add('hidden'); };
$('#invYes').onclick = () => { send({ t: 'trade_respond', from: $('#invite').dataset.from, ok: true }); $('#invite').classList.add('hidden'); };
$('#invNo').onclick = () => { send({ t: 'trade_respond', from: $('#invite').dataset.from, ok: false }); $('#invite').classList.add('hidden'); };

// ---- trade ----
let tradeSt = null, trPick = null;
function renderTrade() {
  const T = tradeSt; if (!T) return;
  $('#trTitle').textContent = `🤝 Trading with ${T.with}`;
  $('#trTheirsTitle').textContent = `${T.with}'s offer`;
  const fill = (el, items, onClick) => {
    el.innerHTML = '';
    for (const [id, n] of Object.entries(items)) { const s = slotEl(+id, n); if (onClick) s.onclick = () => onClick(+id); el.appendChild(s); }
    if (!Object.keys(items).length) el.innerHTML = '<div class="muted">Nothing yet</div>';
  };
  fill($('#trMine'), T.mine, (id) => { const o = { ...T.mine }; delete o[id]; send({ t: 'trade_offer', items: o }); });
  fill($('#trTheirs'), T.theirs);
  $('#trMineBox').classList.toggle('ok', T.myAcc); $('#trTheirsBox').classList.toggle('ok', T.theirAcc);
  const g = $('#trInv'); g.innerHTML = '';
  for (const id of invIds().slice(2)) { const s = slotEl(id, inv[id], { sel: id === trPick }); s.onclick = () => { trPick = id; renderTrade(); }; g.appendChild(s); }
  const row = $('#trAddRow');
  if (trPick && inv[trPick]) {
    row.innerHTML = `<b>${esc(ITEMS[trPick].name)}</b><input class="field" type="number" id="trN" min="1" max="${inv[trPick]}" value="${T.mine[trPick] || 1}" style="width:90px"><button class="btn" id="trAdd">Put in trade</button>`;
    $('#trAdd').onclick = () => { const n = Math.max(1, Math.min(inv[trPick], Math.floor(+$('#trN').value || 1))); send({ t: 'trade_offer', items: { ...T.mine, [trPick]: n } }); };
  } else row.innerHTML = '';
  $('#trStatus').textContent = T.myAcc && !T.theirAcc ? `Waiting for ${T.with}…` : T.theirAcc ? `${T.with} accepted ✔ — check their offer!` : 'Changing an offer resets both accepts.';
  $('#trAccept').disabled = T.myAcc;
  $('#trAccept').textContent = T.myAcc ? 'Accepted ✔' : 'Accept';
}
$('#trAccept').onclick = () => tradeSt && send({ t: 'trade_accept', v: tradeSt.v });
$('#trCancel').onclick = () => send({ t: 'trade_cancel' });

// ---- menu ----
$('#logoutBtn').onclick = () => send({ t: 'logout' });
function renderWorldList(list) {
  const el = $('#worldlist'); el.innerHTML = '';
  if (!list.length) el.innerHTML = '<div class="muted">No worlds yet. Make one!</div>';
  for (const w of list) {
    const d = document.createElement('div'); d.className = 'wchip';
    d.innerHTML = `${esc(w.name)}<small>${w.players ? `👥 ${w.players} online` : 'empty'}${w.owner ? ' · 🔒' : ''}</small>`;
    d.onclick = () => send({ t: 'join', world: w.name }); el.appendChild(d);
  }
}
$('#wjoin').onclick = () => send({ t: 'join', world: $('#wname').value });
$('#wname').addEventListener('keydown', (e) => e.key === 'Enter' && $('#wjoin').click());
$('#wrandom').onclick = () => { const a = ['SUNNY', 'GROW', 'PIXEL', 'MEGA', 'COZY', 'LAVA', 'CLOUD', 'MOON'], b = ['LAND', 'TOWN', 'FARM', 'CAVE', 'ISLE', 'BAY']; send({ t: 'join', world: a[Math.random() * a.length | 0] + b[Math.random() * b.length | 0] + (Math.random() * 99 | 0) }); };
$('#wrefresh').onclick = () => send({ t: 'worlds' });
$('#exitBtn').onclick = () => { if (tradeSt) send({ t: 'trade_cancel' }); send({ t: 'leave' }); };

// ======================= WALLETS =======================
// Every modern Solana wallet (Phantom, Solflare, Backpack, OKX, Coinbase, Trust, Magic Eden, Exodus…) announces itself
// through the Wallet Standard. Older injected providers are picked up as a fallback.
let wallet = null, walletAddr = null;
const wallets = new Map();
const short = (a) => (a ? a.slice(0, 4) + '…' + a.slice(-4) : '');
const store = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} };
const load = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58encode(bytes) {
  let n = 0n; for (const b of bytes) n = n * 256n + BigInt(b);
  let out = ''; while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b === 0) out = '1' + out; else break; }
  return out;
}
function b58decode(str) {
  let n = 0n;
  for (const ch of str) { const v = B58.indexOf(ch); if (v < 0) throw new Error('bad base58'); n = n * 58n + BigInt(v); }
  const out = [];
  while (n > 0n) { out.unshift(Number(n % 256n)); n /= 256n; }
  for (const ch of str) { if (ch === '1') out.unshift(0); else break; }
  return new Uint8Array(out);
}

// ---- built-in "Soltopia Wallet": a real Solana keypair generated and kept in this browser ----
// Its private key can be exported any time and imported into Phantom, Solflare, Backpack or the Solana CLI.
const LOCAL_KEY = 'sg_localkey';
function localAdapter() {
  const sk = load(LOCAL_KEY);
  if (!sk || typeof nacl === 'undefined') return null;
  let kp; try { kp = nacl.sign.keyPair.fromSecretKey(b58decode(sk)); } catch { return null; }
  return {
    name: 'Soltopia Wallet', icon: null, local: true, address: b58encode(kp.publicKey), secret: kp.secretKey,
    async connect() { return this.address; },
    async signMessage(bytes) { return nacl.sign.detached(bytes, kp.secretKey); },
    disconnect() {},
  };
}
function createLocalWallet() {
  if (typeof nacl === 'undefined') { $('#lerr').textContent = 'Could not load the wallet library. Check your connection and refresh.'; return null; }
  if (localAdapter()) return localAdapter();
  store(LOCAL_KEY, b58encode(nacl.sign.keyPair().secretKey));
  return localAdapter();
}

function stdAdapter(w) {
  return {
    name: w.name, icon: w.icon, account: null,
    async connect() {
      const { accounts } = await w.features['standard:connect'].connect();
      this.account = accounts.find((a) => a.chains?.some((c) => c.startsWith('solana:'))) || accounts[0];
      if (!this.account) throw new Error('No account');
      return this.account.address;
    },
    async signMessage(bytes) { const [r] = await w.features['solana:signMessage'].signMessage({ account: this.account, message: bytes }); return r.signature; },
    disconnect() { try { w.features['standard:disconnect']?.disconnect(); } catch {} },
  };
}
function legacyAdapter(name, prov) {
  return {
    name, icon: null,
    async connect() { const r = await prov.connect(); return (r?.publicKey || prov.publicKey).toString(); },
    async signMessage(bytes) { const r = await prov.signMessage(bytes, 'utf8'); return r.signature || r; },
    disconnect() { try { prov.disconnect?.(); } catch {} },
  };
}
const walletApi = {
  register(...list) {
    for (const w of list) {
      if (w.chains?.some((c) => c.startsWith('solana:')) && w.features?.['standard:connect'] && w.features?.['solana:signMessage']) wallets.set(w.name, stdAdapter(w));
    }
    renderWallets();
    return () => {};
  },
};
addEventListener('wallet-standard:register-wallet', (e) => { try { e.detail(walletApi); } catch {} });
try { dispatchEvent(new CustomEvent('wallet-standard:app-ready', { detail: walletApi })); } catch {}
function addLegacyWallets() {
  const found = [['Phantom', window.phantom?.solana], ['Solflare', window.solflare], ['Backpack', window.backpack], ['Glow', window.glowSolana],
    ['Coinbase Wallet', window.coinbaseSolana], ['Trust Wallet', window.trustwallet?.solana], ['Exodus', window.exodus?.solana], ['OKX Wallet', window.okxwallet?.solana]];
  for (const [n, p] of found) if (p?.connect && p?.signMessage && !wallets.has(n)) wallets.set(n, legacyAdapter(n, p));
  renderWallets();
}

const INSTALL = [['Phantom', 'https://phantom.com/download'], ['Solflare', 'https://solflare.com/download'], ['Backpack', 'https://backpack.app/download']];
function walletButtons(el, onPick) {
  el.innerHTML = '';
  const local = localAdapter();
  for (const a of local ? [local, ...wallets.values()] : wallets.values()) {
    const b = document.createElement('div'); b.className = 'wallet';
    b.innerHTML = (a.icon ? `<img src="${esc(a.icon)}" alt="">` : '<span style="font-size:26px">👛</span>') + `<span>${esc(a.name)}</span><small>${a.local ? 'on this device · ' + short(a.address) : load('sg_wallet') === a.name ? 'last used' : 'detected'}</small>`;
    b.onclick = () => onPick(a, b); el.appendChild(b);
  }
  $('#createWallet').classList.toggle('hidden', !!local);
  if (!wallets.size) {
    const here = encodeURIComponent(location.href), ref = encodeURIComponent(location.origin);
    el.insertAdjacentHTML('beforeend', `<div class="muted">No wallet extension found. Install one and refresh, or create a wallet below:</div>
      <div class="row" style="flex-wrap:wrap">${INSTALL.map(([n, u]) => `<a class="btn gray" href="${u}" target="_blank" rel="noopener">${n}</a>`).join('')}</div>
      <div class="muted">On a phone? Open Soltopia inside your wallet app:</div>
      <div class="row" style="flex-wrap:wrap">
        <a class="btn sol" href="https://phantom.app/ul/browse/${here}?ref=${ref}">Open in Phantom</a>
        <a class="btn sol" href="https://solflare.com/ul/v1/browse/${here}?ref=${ref}">Open in Solflare</a>
      </div>`);
  }
}
function renderWallets() {
  walletButtons($('#walletList'), signIn);
}
function walletBusy(on, el) {
  document.querySelectorAll('.wallet').forEach((w) => w.classList.toggle('busy', on));
  if (el?.querySelector && on) el.querySelector('small').textContent = 'check your wallet…';
  if (!on) renderWallets();
}

// ---- sign-in: connect → sign message → (new wallet) choose username ----
let signInTimer = null;
async function signIn(adapter, el) {
  $('#lerr').textContent = ''; walletBusy(true, el);
  clearTimeout(signInTimer);   // if the wallet never answers, unlock the buttons so the player can retry
  signInTimer = setTimeout(() => { if (!myName) { walletBusy(false); $('#lerr').textContent = 'No response from your wallet. Please try again.'; } }, 60000);
  try { walletAddr = await adapter.connect(); wallet = adapter; store('sg_wallet', adapter.name); }
  catch (e) { console.warn(e); clearTimeout(signInTimer); $('#lerr').textContent = 'Wallet connection was cancelled.'; return walletBusy(false); }
  try { await ensureWS(); }
  catch { clearTimeout(signInTimer); $('#lerr').textContent = "Can't reach the game server right now. Try again in a moment."; return walletBusy(false); }
  send({ t: 'auth_nonce', addr: walletAddr });
}
async function signAuth(message) {
  try { const sig = await wallet.signMessage(new TextEncoder().encode(message)); send({ t: 'auth', sig: Array.from(sig) }); }
  catch (e) { console.warn(e); $('#lerr').textContent = 'You need to sign the message to play.'; walletBusy(false); }
}
$('#nbtn').onclick = () => { $('#nerr').textContent = ''; $('#nbtn').disabled = true; send({ t: 'register', name: $('#nname').value.trim() }); setTimeout(() => ($('#nbtn').disabled = false), 1500); };
$('#nname').addEventListener('keydown', (e) => e.key === 'Enter' && $('#nbtn').click());
$('#nname').addEventListener('input', () => ($('#nname').value = $('#nname').value.replace(/[^A-Za-z0-9_]/g, '')));
$('#createWallet').onclick = () => {
  const a = createLocalWallet(); if (!a) return;
  toast('✨ Wallet created! Back it up anytime from the 🔑 Wallet button.');
  signIn(a, null);
};

// ---- wallet / export screen ----
function openWalletModal() {
  const local = localAdapter(), mine = local && local.address === linkedWallet;
  $('#wmAddr').textContent = linkedWallet || '';
  $('#wmLocal').classList.toggle('hidden', !mine);
  $('#wmExternal').classList.toggle('hidden', !!mine);
  $('#wmKey').textContent = '••••••••••••••••••••••••••••••••';
  $('#wmReveal').textContent = 'Reveal';
  $('#walletModal').classList.remove('hidden');
}
$('#wmReveal').onclick = () => {
  const a = localAdapter(); if (!a) return;
  const shown = $('#wmReveal').textContent === 'Hide';
  $('#wmKey').textContent = shown ? '••••••••••••••••••••••••••••••••' : b58encode(a.secret);
  $('#wmReveal').textContent = shown ? 'Reveal' : 'Hide';
};
$('#wmCopy').onclick = async () => { const a = localAdapter(); if (!a) return; try { await navigator.clipboard.writeText(b58encode(a.secret)); toast('Private key copied. Keep it secret!'); } catch { toast('Copy failed. Use Reveal and copy it by hand.'); } };
$('#wmCopyAddr').onclick = async () => { try { await navigator.clipboard.writeText(linkedWallet); toast('Address copied.'); } catch {} };
$('#wmDownload').onclick = () => {
  const a = localAdapter(); if (!a) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(Array.from(a.secret))], { type: 'application/json' }));
  const link = Object.assign(document.createElement('a'), { href: url, download: `soltopia-wallet-${a.address.slice(0, 6)}.json` });
  link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
};
$('#keyBtn').onclick = openWalletModal;
$('#menuWalletBtn').onclick = openWalletModal;
$('#nback').onclick = () => { wallet?.disconnect(); wallet = null; showScreen('login'); };

async function boot(resume = true) {
  try { await ensureWS(); } catch { return; }   // onclose already schedules the next attempt
  $('#lerr').textContent = '';
  const token = load('sg_token');
  if (resume && token) send({ t: 'resume', token }); else showScreen('login');
}

setTimeout(addLegacyWallets, 500);
renderWallets();
boot();

// ======================= LOOP =======================
let last = performance.now();
function frame(now) {
  const dt = Math.min(1 / 30, (now - last) / 1000); last = now;
  update(dt, now); render(now);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
