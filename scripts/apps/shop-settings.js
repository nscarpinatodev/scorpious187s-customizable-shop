import { MODULE_ID, LIB_ID, SETTINGS, DEFAULT_MARKUP, DEFAULT_SELL_RATE } from '../constants.js';
import { getThemeChoices } from '../data/theme-presets.js';
import { getCurrencyPresetList } from '../data/currency-presets.js';
import { ThemeManager } from '../theme-manager.js';

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/** World-level shop settings (currency system, defaults, active theme). */
export class ShopSettingsApp extends HandlebarsApplicationMixin(ApplicationV2) {

  static DEFAULT_OPTIONS = {
    id: 'scs-shop-settings',
    classes: ['scs-window', 'scs-config'],
    tag: 'form',
    window: { frame: true, positioned: true, title: 'SCS.Settings.Title', icon: 'fas fa-store', resizable: true },
    position: { width: 540, height: 'auto' },
    form: { handler: ShopSettingsApp._onSubmit, submitOnChange: false, closeOnSubmit: true },
    actions: {
      openThemeEditor() { this._openThemeEditor(); },
    },
  };

  static PARTS = {
    settings: { template: `modules/${MODULE_ID}/templates/shop-settings.hbs` },
  };

  async _prepareContext(options) {
    const ctx = await super._prepareContext(options);
    const cfg = game.settings.get(MODULE_ID, SETTINGS.SYSTEM_CONFIG);
    const defaults = game.settings.get(MODULE_ID, SETTINGS.DEFAULTS);
    return {
      ...ctx,
      currencyPreset: cfg?.currencyPreset ?? 'custom',
      currencyPresets: getCurrencyPresetList(),
      adjustMerchantCurrency: !!cfg?.adjustMerchantCurrency,
      layoutSide: cfg?.layoutSide === 'right' ? 'right' : 'left',
      theme: ThemeManager.activeThemeId(),
      effectiveTheme: ThemeManager.resolveThemeId(),
      themeChoices: getThemeChoices(),
      themeLocked: ThemeManager.isControlledByQt(),
      markupPct: Math.round((defaults?.markup ?? DEFAULT_MARKUP) * 100),
      sellRatePct: Math.round((defaults?.sellRate ?? DEFAULT_SELL_RATE) * 100),
    };
  }

  _onRender(context, options) {
    super._onRender(context, options);
    // Render this window in the effective (possibly QT-controlled) theme.
    ThemeManager.applyToElement(this.element, context.effectiveTheme);
  }

  async _openThemeEditor() {
    const { ThemeEditorApp } = await import('./theme-editor.js');
    new ThemeEditorApp().render(true);
  }

  static async _onSubmit(event, form, formData) {
    const data = foundry.utils.expandObject(formData.object);
    await game.settings.set(MODULE_ID, SETTINGS.SYSTEM_CONFIG, {
      currencyPreset: data.currencyPreset,
      adjustMerchantCurrency: !!data.adjustMerchantCurrency,
      layoutSide: data.layoutSide === 'right' ? 'right' : 'left',
    });
    // UI works in percent; the setting stores the multiplier (100% → 1.0).
    await game.settings.set(MODULE_ID, SETTINGS.DEFAULTS, {
      markup: (Number(data.markup) / 100) || DEFAULT_MARKUP,
      sellRate: (Number(data.sellRate) / 100) || DEFAULT_SELL_RATE,
    });
    // The library's setting is the family-wide authority; this module's own
    // setting is kept as a mirror for older sibling releases that read it.
    await game.settings.set(LIB_ID, 'theme', data.theme);
    await game.settings.set(MODULE_ID, SETTINGS.THEME, data.theme);
    ThemeManager.apply(data.theme);
    ui.notifications.info(game.i18n.localize('SCS.Settings.Saved'));
  }
}
