import { MODULE_ID, SETTINGS, DEFAULT_MARKUP, DEFAULT_SELL_RATE } from './constants.js';
import { detectCurrencyPreset } from './data/currency-presets.js';

export function registerSettings() {

  // ── System / currency configuration (world) ─────────────────────────────
  game.settings.register(MODULE_ID, SETTINGS.SYSTEM_CONFIG, {
    name: 'System Configuration',
    scope: 'world',
    config: false,
    type: Object,
    default: {
      currencyPreset: detectCurrencyPreset(),
      adjustMerchantCurrency: false, // also credit/debit the merchant NPC's coins
      layoutSide: 'left',            // which side the avatar + Buy/Sell column sits on
    },
    onChange: () => Hooks.callAll('scs.systemConfigChanged'),
  });

  // ── Active theme (world) — GM-controlled, propagates to all clients ──────
  game.settings.register(MODULE_ID, SETTINGS.THEME, {
    name: game.i18n.localize('SCS.Settings.Theme'),
    hint: game.i18n.localize('SCS.Settings.ThemeHint'),
    scope: 'world',
    config: false,
    type: String,
    default: 'fantasy-parchment',
    onChange: (value) => Hooks.callAll('scs.themeChanged', value),
  });

  // ── Custom theme variables (client) ─────────────────────────────────────
  game.settings.register(MODULE_ID, SETTINGS.CUSTOM_THEME, {
    name: 'Custom Theme Variables',
    scope: 'client',
    config: false,
    type: Object,
    default: {},
  });

  // ── Default pricing for new shops (world) ───────────────────────────────
  game.settings.register(MODULE_ID, SETTINGS.DEFAULTS, {
    name: 'Shop Defaults',
    scope: 'world',
    config: false,
    type: Object,
    default: { markup: DEFAULT_MARKUP, sellRate: DEFAULT_SELL_RATE },
  });

  // ── Settings menu button ────────────────────────────────────────────────
  game.settings.registerMenu(MODULE_ID, 'shopSettings', {
    name: game.i18n.localize('SCS.Settings.Title'),
    label: game.i18n.localize('SCS.Settings.Title'),
    hint: game.i18n.localize('SCS.Settings.MenuHint'),
    icon: 'fas fa-store',
    type: ShopSettingsApp,
    restricted: true,
  });
}

// Avoid circular import — the settings menu app is wired after its file loads.
let ShopSettingsApp;
export function setShopSettingsApp(cls) {
  ShopSettingsApp = cls;
}
