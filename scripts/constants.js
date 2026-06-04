export const MODULE_ID = 'scorpious187s-customizable-shop';
export const MODULE_TITLE = "Scorpious187's Customizable Shop";
export const SOCKET_NAME = `module.${MODULE_ID}`;

/** Shop interaction modes. */
export const SHOP_MODE = Object.freeze({
  BUY:  'buy',   // player buys FROM the merchant
  SELL: 'sell',  // player sells TO the merchant
});

/** Socket message types (module.<id> channel). */
export const SOCKET_TYPES = Object.freeze({
  OPEN_SHOP:   'openShop',    // GM → players: open this shop window
  TXN_REQUEST: 'txnRequest',  // player → GM: please execute this transaction
  TXN_RESULT:  'txnResult',   // GM → player: transaction outcome
});

/** World/client settings keys. */
export const SETTINGS = Object.freeze({
  SYSTEM_CONFIG: 'systemConfig',   // currency preset + currency path overrides (world)
  THEME:         'theme',          // active theme id (world)
  CUSTOM_THEME:  'customTheme',    // custom theme var overrides (client)
  DEFAULTS:      'defaults',       // default markup / sellRate for new shops (world)
});

/**
 * Flag keys (all under the module namespace).
 *   Actor flags  → shop-wide config.
 *   Item flags   → per-item overrides.
 */
export const FLAGS = Object.freeze({
  // Actor-level
  IS_SHOP:     'isShop',      // boolean — marks an NPC as a shop
  SHOP_NAME:   'shopName',    // string  — display name override (defaults to actor.name)
  MARKUP:      'markup',      // number  — buy price multiplier (e.g. 1.2 = 120%)
  SELL_RATE:   'sellRate',    // number  — sell payout multiplier (e.g. 0.5 = 50%)
  THEME:       'theme',       // string  — per-actor theme override (optional)
  // Item-level
  INFINITE:    'infinite',    // boolean — item never depletes
  PRICE_MODE:  'priceMode',   // 'auto' | 'fixed' — how base price is determined
  FIXED_PRICE: 'fixedPrice',  // number  — base price in base units when priceMode === 'fixed'
  NO_SELL:     'noSell',      // boolean — exclude this item from the shop entirely
});

export const DEFAULT_MARKUP    = 1.2;
export const DEFAULT_SELL_RATE = 0.5;
export const DEFAULT_ACTOR_IMG = 'icons/svg/mystery-man.svg';
export const DEFAULT_ITEM_IMG  = 'icons/svg/item-bag.svg';
