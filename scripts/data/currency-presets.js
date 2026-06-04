/**
 * System-specific currency configuration for the shop.
 *
 * Prices flow through a single "base unit" (the denomination with value 1 —
 * gp for D&D/PF, caps for Fallout, etc.). The shared engine reads a buyer's
 * total wealth in the smallest coin, adds/subtracts the transaction, and
 * redistributes greedily so change is made correctly across denominations.
 *
 * A preset may override `getWealth` / `adjustWealth` for systems that don't
 * store coins as plain numbers (e.g. PF2e keeps coins as inventory items).
 */

// ── Shared numeric-denomination engine ──────────────────────────────────────

/** Smallest coin value (in base units) for a denomination list. */
function smallestUnit(denoms) {
  return Math.min(...denoms.map(d => d.value));
}

/** Read an actor's total wealth, expressed in integer "smallest-coin" units. */
function readWealthSmall(actor, preset) {
  const unit = smallestUnit(preset.denominations);
  let total = 0;
  for (const d of preset.denominations) {
    const count = Number(foundry.utils.getProperty(actor, preset.path(d.key))) || 0;
    total += Math.round(count * (d.value / unit));
  }
  return total;
}

/** Denominations usable when making change (excludes e.g. electrum). */
function changeDenoms(preset) {
  const usable = preset.denominations.filter(d => d.change !== false);
  return (usable.length ? usable : preset.denominations).sort((a, b) => b.value - a.value);
}

/**
 * Split a base-unit amount into the fewest coins, largest denominations first
 * (skips non-change denominations like electrum). Returns { denomKey: count }.
 */
function splitToCoins(preset, amountBase) {
  const unit = smallestUnit(preset.denominations);
  let remaining = Math.max(0, Math.round(amountBase / unit));
  const out = {};
  for (const d of changeDenoms(preset)) {
    const unitsPer = Math.round(d.value / unit);
    const count = Math.floor(remaining / unitsPer);
    remaining -= count * unitsPer;
    out[d.key] = count;
  }
  return out;
}

/**
 * Write a wealth total (in smallest-coin units) back, simplified into the
 * largest denominations (so 1.5 gp becomes 1 gp + 5 sp, not 150 cp).
 */
async function writeWealthSmall(actor, preset, totalSmall) {
  const coins = splitToCoins(preset, Math.max(0, Math.round(totalSmall)) * smallestUnit(preset.denominations));
  const update = {};
  // Zero out every denomination first, then set the simplified counts, so
  // leftover coins in skipped denominations (e.g. electrum) don't linger.
  for (const d of preset.denominations) update[preset.path(d.key)] = 0;
  for (const [key, count] of Object.entries(coins)) update[preset.path(key)] = count;
  await actor.update(update);
}

/** Default wealth getter — base units (may be fractional). */
function defaultGetWealth(actor, preset) {
  return readWealthSmall(actor, preset) * smallestUnit(preset.denominations);
}

/**
 * Default wealth adjuster. `deltaBase` may be negative (a purchase).
 * Returns false (without writing) if the buyer can't cover the cost.
 */
async function defaultAdjustWealth(actor, preset, deltaBase) {
  const unit = smallestUnit(preset.denominations);
  const deltaSmall = Math.round(deltaBase / unit);
  const current = readWealthSmall(actor, preset);
  const next = current + deltaSmall;
  if (next < 0) return false;
  await writeWealthSmall(actor, preset, next);
  return true;
}

/** Generic item base-price reader for numeric `price.value` systems. */
function genericItemValue(item) {
  const sys = item.system ?? {};
  const candidates = [sys.price?.value, sys.price, sys.cost?.value, sys.cost];
  for (const c of candidates) {
    const n = Number(c);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

// ── Presets ─────────────────────────────────────────────────────────────────

export const CURRENCY_PRESETS = {
  custom: {
    id: 'custom',
    label: 'Custom / System Agnostic',
    denominations: [{ key: 'gp', label: 'Coins', value: 1 }],
    path: (key) => `system.currency.${key}`,
    getItemValue: genericItemValue,
  },

  dnd5e: {
    id: 'dnd5e',
    label: 'D&D 5th Edition',
    denominations: [
      { key: 'pp', label: 'Platinum', value: 10 },
      { key: 'gp', label: 'Gold',     value: 1 },
      // Electrum is counted if the player has it, but never used to make change.
      { key: 'ep', label: 'Electrum', value: 0.5, change: false },
      { key: 'sp', label: 'Silver',   value: 0.1 },
      { key: 'cp', label: 'Copper',   value: 0.01 },
    ],
    path: (key) => `system.currency.${key}`,
    getItemValue(item) {
      const price = item.system?.price;
      if (price && typeof price === 'object') {
        const denomValue = { pp: 10, gp: 1, ep: 0.5, sp: 0.1, cp: 0.01 }[price.denomination] ?? 1;
        return (Number(price.value) || 0) * denomValue;
      }
      return genericItemValue(item);
    },
  },

  pf2e: {
    id: 'pf2e',
    label: 'Pathfinder 2e',
    denominations: [
      { key: 'pp', label: 'Platinum', value: 10 },
      { key: 'gp', label: 'Gold',     value: 1 },
      { key: 'sp', label: 'Silver',   value: 0.1 },
      { key: 'cp', label: 'Copper',   value: 0.01 },
    ],
    path: (key) => `system.currency.${key}.value`,
    getItemValue(item) {
      const coins = item.system?.price?.value;
      if (coins && typeof coins === 'object') {
        const v = { pp: 10, gp: 1, sp: 0.1, cp: 0.01 };
        return Object.entries(coins).reduce((sum, [k, n]) => sum + (Number(n) || 0) * (v[k] ?? 0), 0);
      }
      return genericItemValue(item);
    },
    // PF2e stores coins as inventory items; use the actor coin helpers when present.
    getWealth(actor, preset) {
      const coins = actor.inventory?.coins;
      if (coins) return (coins.copperValue ?? 0) / 100; // copperValue → gp
      return defaultGetWealth(actor, preset);
    },
    async adjustWealth(actor, preset, deltaBase) {
      const inv = actor.inventory;
      if (inv?.coins && typeof inv.addCoins === 'function' && typeof inv.removeCoins === 'function') {
        // Split into pp/gp/sp/cp instead of dumping the whole value into copper.
        const coinObj = splitToCoins(preset, Math.abs(deltaBase));
        if (deltaBase < 0) {
          const have = (inv.coins.copperValue ?? 0);
          if (have < Math.round(Math.abs(deltaBase) * 100)) return false;
          await inv.removeCoins(coinObj); // removes by value, making change
        } else {
          await inv.addCoins(coinObj);
        }
        return true;
      }
      return defaultAdjustWealth(actor, preset, deltaBase);
    },
  },

  sw5e: {
    id: 'sw5e',
    label: 'SW5e (Star Wars 5e)',
    denominations: [{ key: 'gc', label: 'Galactic Credits', value: 1 }],
    path: (key) => `system.currency.${key}`,
    getItemValue: genericItemValue,
  },

  sf2e: {
    id: 'sf2e',
    label: 'Starfinder 2e (Credits)',
    // PF2e-based: currency is physical coin items managed via inventory.addCoins
    // with the keys { credits, upb }. 1 UPB ≈ 1 credit in value. No conversions.
    denominations: [
      { key: 'credits', label: 'Credits', value: 1 },
      { key: 'upb',     label: 'UPB',     value: 1, change: false },
    ],
    path: (key) => `system.currency.${key}`, // fallback only
    getItemValue(item) {
      const price = item.system?.price?.value;
      if (price && typeof price === 'object') {
        const credits = Number(price.credits) || 0;
        const upb = Number(price.upb) || 0;
        if (credits || upb) return credits + upb;
        // Some SF2e content reuses PF2e coin keys (1 credit ≈ 1 gp).
        const v = { pp: 10, gp: 1, sp: 0.1, cp: 0.01 };
        const sum = Object.entries(price).reduce((s, [k, n]) => s + (Number(n) || 0) * (v[k] ?? 0), 0);
        if (sum) return sum;
      }
      return genericItemValue(item);
    },
    getWealth(actor) {
      const c = actor.inventory?.coins;
      if (c) return (Number(c.credits) || 0) + (Number(c.upb) || 0);
      const cr  = Number(foundry.utils.getProperty(actor, 'system.currency.credits')) || 0;
      const upb = Number(foundry.utils.getProperty(actor, 'system.currency.upb')) || 0;
      return cr + upb;
    },
    async adjustWealth(actor, preset, deltaBase) {
      const inv = actor.inventory;
      if (inv && typeof inv.addCoins === 'function') {
        if (deltaBase >= 0) {
          await inv.addCoins({ credits: Math.round(deltaBase) }); // pay players in credits
          return true;
        }
        // Spending: draw from credits first, then UPB.
        const credits = Number(inv.coins?.credits) || 0;
        const upb = Number(inv.coins?.upb) || 0;
        const cost = Math.round(-deltaBase);
        if (credits + upb < cost) return false;
        if (typeof inv.removeCoins === 'function') {
          const fromCredits = Math.min(cost, credits);
          const fromUpb = cost - fromCredits;
          await inv.removeCoins({ credits: fromCredits, upb: fromUpb });
          return true;
        }
      }
      return defaultAdjustWealth(actor, preset, deltaBase);
    },
  },

  pf1: {
    id: 'pf1',
    label: 'Pathfinder 1e',
    denominations: [
      { key: 'pp', label: 'Platinum', value: 10 },
      { key: 'gp', label: 'Gold',     value: 1 },
      { key: 'sp', label: 'Silver',   value: 0.1 },
      { key: 'cp', label: 'Copper',   value: 0.01 },
    ],
    path: (key) => `system.currency.${key}`,
    getItemValue: genericItemValue,
  },

  wfrp4e: {
    id: 'wfrp4e',
    label: 'Warhammer Fantasy RPG 4e',
    denominations: [
      { key: 'gc', label: 'Gold Crowns',      value: 240 },
      { key: 'ss', label: 'Silver Shillings', value: 12 },
      { key: 'bp', label: 'Brass Pennies',    value: 1 },
    ],
    path: (key) => `system.currency.${key}`,
    getItemValue: genericItemValue,
  },

  fallout: {
    id: 'fallout',
    label: 'Fallout: The Roleplaying Game (2d20)',
    denominations: [{ key: 'caps', label: 'Caps', value: 1 }],
    path: (key) => `system.currency.${key}`,
    getItemValue: genericItemValue,
  },

  shadowrun5e: {
    id: 'shadowrun5e',
    label: 'Shadowrun 5e',
    denominations: [{ key: 'nuyen', label: 'Nuyen', value: 1 }],
    path: () => 'system.nuyen',
    getItemValue: genericItemValue,
  },
};

export function getCurrencyPreset(id) {
  return CURRENCY_PRESETS[id] ?? CURRENCY_PRESETS.custom;
}

export function getCurrencyPresetList() {
  return Object.values(CURRENCY_PRESETS).map(p => ({ id: p.id, label: p.label }));
}

/** Auto-detect the active game system; falls back to the agnostic preset. */
/** Starfinder 2e ships under several id slugs; SF1e ('sfrpg') is excluded. */
const SF2E_IDS = new Set(['sf2e', 'starfinder2e', 'starfinder-2e', 'starfinder2', 'starfinderv2']);

/** True when the active world runs a Starfinder 2e system (not SF1e). */
export function isStarfinder2e() {
  const id = game.system?.id ?? '';
  if (id === 'sfrpg') return false;
  if (SF2E_IDS.has(id)) return true;
  const title = game.system?.title ?? '';
  return /starfinder/i.test(title) && /(2e|second|v2|two)/i.test(title);
}

export function detectCurrencyPreset() {
  const id = game.system?.id ?? '';
  if (CURRENCY_PRESETS[id]) return id;
  if (id === 'sfrpg') return 'custom'; // Starfinder 1e — different model
  if (SF2E_IDS.has(id)) return 'sf2e';
  const title = game.system?.title ?? '';
  if (/starfinder/i.test(title) && /(2e|second|v2|two)/i.test(title)) return 'sf2e';
  return 'custom';
}

/** Label of the base denomination (value === 1), e.g. "Gold". */
export function baseLabel(preset) {
  return (preset.denominations.find(d => d.value === 1) ?? preset.denominations[0]).label;
}

// ── Public currency operations (preset-aware) ────────────────────────────────

export function getItemBaseValue(preset, item) {
  return preset.getItemValue ? preset.getItemValue(item) : genericItemValue(item);
}

export function getWealth(preset, actor) {
  return preset.getWealth ? preset.getWealth(actor, preset) : defaultGetWealth(actor, preset);
}

/** Adjust wealth by `deltaBase` base units (negative = spend). Returns success. */
export function adjustWealth(preset, actor, deltaBase) {
  return preset.adjustWealth
    ? preset.adjustWealth(actor, preset, deltaBase)
    : defaultAdjustWealth(actor, preset, deltaBase);
}
