# Soltopia

A multiplayer sandbox game in the style of Growtopia, where you sign in with a Solana wallet. The currency is the **Solana Lock (SLOCK)**: you buy them with gems (2,000 gems each) and spend them in the store.

## Run

```
npm install
npm start            # http://localhost:5173
```

| Env var | Default | Meaning |
|---|---|---|
| `DEV` | on | `DEV=0` removes the free "+5 SLOCK" test button |
| `PORT` | 5173 | |

Saves go to `data/` (accounts, worlds, sign-in tokens).

## Sign-in
- **Connect a wallet:** Phantom, Solflare, Backpack, OKX, Coinbase, Trust, Magic Eden and any other Wallet Standard wallet are found automatically. Older wallets are found through their browser objects.
- **Create me a wallet:** makes a real Solana keypair in the browser (tweetnacl). Export it anytime from **🔑 Wallet**: reveal or copy the base58 private key, or download a Solana CLI `.json` keypair. Import it into Phantom, Solflare or Backpack with "Import private key".
- **Sign:** the player signs a free one-time message. The server checks the signature, so no transaction is sent. A new wallet then picks a permanent username, and a known wallet goes straight in. A 7-day token means refreshing doesn't need another signature.

## Controls
A/D move · W/Space/↑ jump (twice with Angel Wings) · S drop through platforms · click to punch (Fist only) or place the selected item · 1–9 / wheel select · B open backpack · Enter chat · R respawn

## Gameplay
- **Worlds:** type any name to create or join one. A placed Solana Lock makes it yours, so only you can build there.
- **Breaking:** blocks drop gems, seeds or the block itself. Walk over drops to collect them.
- **Farming:** plant seeds on blocks, and punch ripe trees for blocks, seeds and gems. Plant a seed on an unripe tree to splice; recipes are in `public/items.js`.
- **Backpack:** 32 slots to start, up to 200 of each item per slot. Buy +10 slots in the store; each upgrade costs 1 more SLOCK than the last. Double-click clothing to wear it. Drop or Trash from the item bar.
- **Wrench:** click a player to see their profile, or a lock to see the owner.
- **Death:** lava hurts (3 hits kill) and Death Spikes kill instantly. Falling out of the world also kills. You respawn at the Main Door. `/respawn` or R does it on purpose.
- **Levels:** XP for breaking, planting, harvesting and splicing.
- **Trading:** both players add items and press Accept. Any change resets both accepts. The trade only goes through if both backpacks have room.
- **Chat:** `[W]` world chat with speech bubbles, plus `/msg`, `/r`, `/me`, `/who`, `/wave /dance /cheer /cry /laugh`, `/respawn`, `/clear` and `/help`. The server limits each player to 5 messages per 5 seconds.

## Before a real launch
- Move saves from JSON files to a database.
- The server trusts player positions, so add speed and position checks against teleport cheats.
- Built-in wallets live in browser storage, so players must back up their key. Losing it loses the account.
