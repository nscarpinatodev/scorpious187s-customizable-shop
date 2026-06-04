import { MODULE_ID, SETTINGS } from '../constants.js';
import { THEME_VARS, THEME_CATEGORIES, getTheme } from '../data/theme-presets.js';
import { ThemeManager } from '../theme-manager.js';

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/** Full color editor for the "custom" theme (presets + per-variable overrides). */
export class ThemeEditorApp extends HandlebarsApplicationMixin(ApplicationV2) {

  static DEFAULT_OPTIONS = {
    id: 'scs-theme-editor',
    classes: ['scs-window', 'scs-theme-editor'],
    tag: 'form',
    window: { frame: true, positioned: true, title: 'SCS.Theme.Title', icon: 'fas fa-palette', resizable: true },
    position: { width: 560, height: 680 },
    form: { handler: ThemeEditorApp._onSubmit, submitOnChange: false, closeOnSubmit: false },
    actions: {
      seedFromPreset(event, target) { this._seedFromPreset(target.value ?? target.dataset.preset); },
      resetVars() { this._reset(); },
    },
  };

  static PARTS = {
    editor: { template: `modules/${MODULE_ID}/templates/theme-editor.hbs`, scrollable: ['.scs-theme-vars'] },
  };

  /** Working copy of the var overrides being edited. */
  _working = null;

  async _prepareContext(options) {
    const ctx = await super._prepareContext(options);
    if (!this._working) {
      this._working = { ...(game.settings.get(MODULE_ID, SETTINGS.CUSTOM_THEME) ?? {}) };
    }
    // Seed any unset vars from the parchment baseline so swatches show something.
    const base = getTheme('fantasy-parchment').vars;
    const vars = THEME_VARS.map(v => ({
      key: v.key,
      label: v.label,
      value: this._working[v.key] ?? base[v.key] ?? '#000000',
    }));

    const presetOptions = THEME_CATEGORIES
      .filter(c => c.id !== 'custom')
      .flatMap(c => c.themes.map(t => ({ id: t.id, label: `${c.label}: ${t.label}` })));

    return { ...ctx, vars, presetOptions };
  }

  _onRender(context, options) {
    super._onRender(context, options);
    ThemeManager.applyToElement(this.element, 'custom');
    this._preview();

    // Live preview as colors change.
    this.element.querySelectorAll('input[data-var]').forEach(input => {
      input.addEventListener('input', (e) => {
        this._working[e.currentTarget.dataset.var] = e.currentTarget.value;
        this._syncPair(e.currentTarget);
        this._preview();
      });
    });
  }

  /** Keep the color picker and its hex text field in sync. */
  _syncPair(changed) {
    const key = changed.dataset.var;
    this.element.querySelectorAll(`input[data-var="${key}"]`).forEach(el => {
      if (el !== changed) el.value = changed.value;
    });
  }

  _preview() {
    const base = getTheme('fantasy-parchment').vars;
    ThemeManager.previewVars({ ...base, ...this._working });
  }

  _seedFromPreset(presetId) {
    if (!presetId) return;
    this._working = { ...getTheme(presetId).vars };
    this.render();
  }

  _reset() {
    this._working = {};
    this.render();
  }

  static async _onSubmit(event, form, formData) {
    const data = foundry.utils.expandObject(formData.object);
    const vars = {};
    for (const v of THEME_VARS) {
      const val = data.vars?.[v.key] ?? this._working[v.key];
      if (val) vars[v.key] = val;
    }
    await game.settings.set(MODULE_ID, SETTINGS.CUSTOM_THEME, vars);
    await game.settings.set(MODULE_ID, SETTINGS.THEME, 'custom');
    ThemeManager.apply('custom');
    ui.notifications.info(game.i18n.localize('SCS.Theme.Saved'));
  }
}
