// Shared item definitions — loaded by both the server (require) and the browser (window.SG).
(function (root) {
  const SLOCK = 50, DSLOCK = 51, SEED = 1000;

  // type: block (solid) | platform (one-way) | bg (background layer) | door | lock | seed | wear
  const ITEMS = {
    0:  { name: 'Fist', type: 'fist' },
    1:  { name: 'Dirt',          type: 'block',    col: '#9b6331', hp: 3, gems: 2,  rarity: 1 },
    2:  { name: 'Rock',          type: 'block',    col: '#8d929c', hp: 5, gems: 3,  rarity: 2 },
    3:  { name: 'Lava',          type: 'block',    col: '#ff5a1f', hp: 4, gems: 4,  rarity: 3, hurt: true },
    4:  { name: 'Bedrock',       type: 'block',    col: '#3b3450', hp: Infinity },
    5:  { name: 'Grass',         type: 'block',    col: '#5ccc4c', hp: 3, gems: 2,  rarity: 1 },
    6:  { name: 'Wood Block',    type: 'block',    col: '#c08443', hp: 4, gems: 3,  rarity: 4 },
    7:  { name: 'Glass Pane',    type: 'block',    col: '#a8e1ff', hp: 2, gems: 5,  rarity: 6 },
    8:  { name: 'Main Door',     type: 'door',     col: '#8b5a2b', hp: Infinity },
    9:  { name: 'Brick',         type: 'block',    col: '#c4533a', hp: 6, gems: 6,  rarity: 8 },
    10: { name: 'Sand',          type: 'block',    col: '#f1d184', hp: 2, gems: 2,  rarity: 2 },
    11: { name: 'Cloud',         type: 'platform', col: '#ffffff', hp: 2, gems: 5,  rarity: 7 },
    12: { name: 'Crystal Block', type: 'block',    col: '#3fd8e8', hp: 7, gems: 10, rarity: 12 },
    13: { name: 'Gold Block',    type: 'block',    col: '#ffc93a', hp: 8, gems: 15, rarity: 20 },
    14: { name: 'Platform',      type: 'platform', col: '#b9783a', hp: 2, gems: 3,  rarity: 5 },
    15: { name: 'Death Spikes',  type: 'spikes',   col: '#9aa0aa', hp: 3, gems: 4,  rarity: 10, kill: true, desc: 'Instantly kills anyone who touches it.' },
    32: { name: 'Wrench',        type: 'wrench',   desc: 'Use it on players to see their profile, or on locks to see the owner.' },
    20: { name: 'Cave Background',   type: 'bg', col: '#5a4030', hp: 2, gems: 1, rarity: 1 },
    21: { name: 'Wooden Background', type: 'bg', col: '#8c5c33', hp: 2, gems: 2, rarity: 3 },
    22: { name: 'Brick Background',  type: 'bg', col: '#8a3d2c', hp: 3, gems: 3, rarity: 5 },
    [SLOCK]:  { name: 'Solana Lock',         type: 'lock', col: '#9945ff', hp: 3, desc: 'The currency of Soltopia. Buy them with gems, spend them in the store, or place one to lock a world.' },
    [DSLOCK]: { name: 'Diamond Solana Lock', type: 'lock', col: '#14f195', hp: 3, desc: 'Worth 100 Solana Locks.' },

    200: { name: 'Top Hat',       type: 'wear', slot: 'hat',   price: { slock: 2 } },
    201: { name: 'Party Hat',     type: 'wear', slot: 'hat',   price: { slock: 1 } },
    202: { name: 'Golden Crown',  type: 'wear', slot: 'hat',   price: { slock: 10 } },
    203: { name: 'Solana Cap',    type: 'wear', slot: 'hat',   price: { slock: 1 } },
    210: { name: 'Cool Shades',   type: 'wear', slot: 'face',  price: { slock: 2 } },
    220: { name: 'Red Shirt',     type: 'wear', slot: 'shirt', price: { slock: 1 },  col: '#e0484f' },
    221: { name: 'Green Shirt',   type: 'wear', slot: 'shirt', price: { slock: 1 },  col: '#3fbf5a' },
    222: { name: 'Solana Hoodie', type: 'wear', slot: 'shirt', price: { slock: 2 },  col: '#9945ff' },
    230: { name: 'Blue Jeans',    type: 'wear', slot: 'pants', price: { slock: 1 },  col: '#3a5fbf' },
    231: { name: 'Black Pants',   type: 'wear', slot: 'pants', price: { slock: 1 },  col: '#2a2a35' },
    240: { name: 'Angel Wings',   type: 'wear', slot: 'back',  price: { slock: 20 }, desc: 'Double jump.' },
    241: { name: 'Red Cape',      type: 'wear', slot: 'back',  price: { slock: 4 } },
    250: { name: 'Pickaxe',       type: 'wear', slot: 'hand',  price: { slock: 8 },   power: 2, desc: 'Breaks blocks 2x faster.' },
    251: { name: 'Solana Sword',  type: 'wear', slot: 'hand',  price: { slock: 5 },   power: 2, desc: 'Breaks blocks 2x faster.' },
  };

  // Every growable block gets a seed (id + 1000).
  for (const [id, it] of Object.entries(ITEMS)) {
    if (it.rarity) ITEMS[SEED + +id] = { name: it.name + ' Seed', type: 'seed', of: +id, col: it.col };
  }

  // Seed splicing: plant seed B on an unripe tree of seed A.
  const RECIPES = [
    [1, 2, 10],   // Dirt + Rock = Sand
    [2, 10, 15],  // Rock + Sand = Death Spikes
    [2, 3, 9],    // Rock + Lava = Brick
    [5, 10, 6],   // Grass + Sand = Wood Block
    [6, 10, 7],   // Wood + Sand = Glass Pane
    [6, 1, 14],   // Wood + Dirt = Platform
    [7, 5, 11],   // Glass + Grass = Cloud
    [7, 2, 12],   // Glass + Rock = Crystal Block
    [12, 3, 13],  // Crystal + Lava = Gold Block
    [20, 6, 21],  // Cave BG + Wood = Wooden Background
    [20, 9, 22],  // Cave BG + Brick = Brick Background
  ];
  function splice(a, b) {
    for (const [x, y, r] of RECIPES) if ((x === a && y === b) || (x === b && y === a)) return r;
    return null;
  }

  const STORE = [
    { key: 'slock',    name: 'Solana Lock',                                      price: { gems: 2000 },  give: { [SLOCK]: 1 } },
    { key: 'slock10',  name: '10 Solana Locks',                                  price: { gems: 20000 }, give: { [SLOCK]: 10 } },
    { key: 'glass',    name: 'Glass Pane x50',                                   price: { slock: 1 }, give: { 7: 50 } },
    { key: 'plat',     name: 'Platform x50',                                     price: { slock: 1 }, give: { 14: 50 } },
    { key: 'woodbg',   name: 'Wooden Background x50',                            price: { slock: 1 }, give: { 21: 50 } },
    { key: 'woodseed', name: 'Wood Block Seed x10',                              price: { slock: 1 }, give: { 1006: 10 } },
    { key: 'builder',  name: 'Builder Pack (50 Brick, 50 Glass, 20 Platform)',   price: { slock: 2 }, give: { 9: 50, 7: 50, 14: 20 } },
    { key: 'rare',     name: 'Rare Seeds (3 Crystal, 1 Gold)',                   price: { slock: 3 }, give: { 1012: 3, 1013: 1 } },
    { key: 'spikes',   name: 'Death Spikes x10',                                 price: { slock: 2 }, give: { 15: 10 } },
  ];
  for (const [id, it] of Object.entries(ITEMS)) {
    if (it.type === 'wear') STORE.push({ key: 'w' + id, name: it.name, price: it.price, give: { [id]: 1 }, wear: +id });
  }

  const api = {
    ITEMS, STORE, RECIPES, SLOCK, DSLOCK, SEED, splice,
    growMs: (id) => ITEMS[id].rarity * 15000,
    isSolid: (id) => !!id && (ITEMS[id].type === 'block' || ITEMS[id].type === 'lock'),
    isPlatform: (id) => !!id && ITEMS[id].type === 'platform',
    WRENCH: 32, MAX_STACK: 200, BASE_SLOTS: 32,
    W: 100, H: 60, TS: 32,
  };
  if (typeof module !== 'undefined') module.exports = api; else root.SG = api;
})(this);
