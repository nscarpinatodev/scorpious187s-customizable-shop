import {
  MODULE_ID, SETTINGS, FLAGS, DEFAULT_MARKUP, DEFAULT_SELL_RATE, DEFAULT_ITEM_IMG,
} from '../constants.js';
import { ThemeManager } from '../theme-manager.js';
import { getThemeChoices } from '../data/theme-presets.js';
import { getCurrencyPreset, getItemBaseValue, baseLabel } from '../data/currency-presets.js';
import { ensurePlayersCanObserve } from '../helpers.js';
import { ShopApp } from './shop-app.js';

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/** Per-actor shop configuration: pricing + per-item infinite/price overrides. */
export class ShopConfigApp extends HandlebarsApplicationMixin(ApplicationV2) {

  static DEFAULT_OPTIONS = {
    id: 'scs-shop-config',
    classes: ['scs-window', 'scs-config'],
    tag: 'form',
    window: { frame: true, positioned: true, title: 'SCS.Config.Title', icon: 'fas fa-sliders-h', resizable: true },
    position: { width: 620, height: 780 },
    form: {
      handler: ShopConfigApp._onSubmit,
      submitOnChange: false,
      closeOnSubmit: true,
    },
    actions: {
      openThemeEditor() { this._openThemeEditor(); },
    },
  };

  static PARTS = {
    config: { template: `modules/${MODULE_ID}/templates/shop-config.hbs`, scrollable: ['.scs-config-items'] },
  };

  constructor(actor, options = {}) {
    super({ id: `scs-shop-config-${actor.id}`, ...options });
    this.actor = actor;
  }

  get title() { return game.i18n.format('SCS.Config.TitleFor', { name: this.actor.name }); }

  async _prepareContext(options) {
    const ctx = await super._prepareContext(options);
    const cfg = game.settings.get(MODULE_ID, SETTINGS.SYSTEM_CONFIG);
    const preset = getCurrencyPreset(cfg?.currencyPreset);
    const defaults = game.settings.get(MODULE_ID, SETTINGS.DEFAULTS);

    const get = (k, d) => {
      const v = this.actor.getFlag(MODULE_ID, k);
      return v === undefined ? d : v;
    };

    const items = this.actor.items
      .filter(i => ShopApp._isMerchandise(i))
      .map(i => ({
        id: i.id,
        name: i.name,
        img: i.img || DEFAULT_ITEM_IMG,
        baseValue: Math.round(getItemBaseValue(preset, i) * 100) / 100,
        infinite: !!i.getFlag(MODULE_ID, FLAGS.INFINITE),
        noSell: !!i.getFlag(MODULE_ID, FLAGS.NO_SELL),
        fixed: i.getFlag(MODULE_ID, FLAGS.PRICE_MODE) === 'fixed',
        fixedPrice: i.getFlag(MODULE_ID, FLAGS.FIXED_PRICE) ?? '',
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const themeChoices = { '': game.i18n.localize('SCS.Config.UseWorldTheme'), ...getThemeChoices() };

    return {
      ...ctx,
      actorName: this.actor.name,
      currencyLabel: baseLabel(preset),
      isShop: get(FLAGS.IS_SHOP, false),
      grantAccess: (this.actor.ownership?.default ?? 0) >= CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER,
      shopName: get(FLAGS.SHOP_NAME, ''),
      markupPct: Math.round(get(FLAGS.MARKUP, defaults?.markup ?? DEFAULT_MARKUP) * 100),
      sellRatePct: Math.round(get(FLAGS.SELL_RATE, defaults?.sellRate ?? DEFAULT_SELL_RATE) * 100),
      themeOverride: get(FLAGS.THEME, ''),
      themeChoices,
      items,
    };
  }

  _onRender(context, options) {
    super._onRender(context, options);
    ThemeManager.applyToElement(this.element, ThemeManager.resolveThemeId(this.actor));
  }

  async _openThemeEditor() {
    const { ThemeEditorApp } = await import('./theme-editor.js');
    new ThemeEditorApp().render(true);
  }

  static async _onSubmit(event, form, formData) {
    const data = foundry.utils.expandObject(formData.object);
    const isShop = !!data.isShop;

    // Actor-level flags
    const update = {
      [`flags.${MODULE_ID}.${FLAGS.IS_SHOP}`]: isShop,
      [`flags.${MODULE_ID}.${FLAGS.SHOP_NAME}`]: data.shopName?.trim() || '',
      // UI works in percent; flags store the multiplier (100% → 1.0).
      [`flags.${MODULE_ID}.${FLAGS.MARKUP}`]: (Number(data.markup) / 100) || DEFAULT_MARKUP,
      [`flags.${MODULE_ID}.${FLAGS.SELL_RATE}`]: (Number(data.sellRate) / 100) || DEFAULT_SELL_RATE,
      [`flags.${MODULE_ID}.${FLAGS.THEME}`]: data.themeOverride || '',
    };
    await this.actor.update(update);

    // Marking an actor as a shop grants players read access (Observer) so they
    // can open it and see its inventory themselves, unless told not to.
    if (isShop && data.grantAccess !== false) {
      await ensurePlayersCanObserve(this.actor);
    }

    // Per-item flags
    const itemUpdates = [];
    for (const [id, cfg] of Object.entries(data.items ?? {})) {
      const item = this.actor.items.get(id);
      if (!item) continue;
      const fixedOn = !!cfg.fixed;
      itemUpdates.push({
        _id: id,
        [`flags.${MODULE_ID}.${FLAGS.INFINITE}`]: !!cfg.infinite,
        [`flags.${MODULE_ID}.${FLAGS.NO_SELL}`]: !!cfg.noSell,
        [`flags.${MODULE_ID}.${FLAGS.PRICE_MODE}`]: fixedOn ? 'fixed' : 'auto',
        [`flags.${MODULE_ID}.${FLAGS.FIXED_PRICE}`]: fixedOn ? (Number(cfg.fixedPrice) || 0) : null,
      });
    }
    if (itemUpdates.length) await this.actor.updateEmbeddedDocuments('Item', itemUpdates);

    ui.notifications.info(game.i18n.localize('SCS.Config.Saved'));
    Hooks.callAll('scs.shopConfigSaved', this.actor);
  }
}
