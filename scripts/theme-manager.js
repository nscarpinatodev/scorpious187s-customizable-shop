import { MODULE_ID, SETTINGS, FLAGS } from './constants.js';
import { getTheme } from './data/theme-presets.js';

// Sibling theme hierarchy: Quest Tracker, when active, is the theme authority for
// all Scorpious187 modules. The Shop then mirrors QT's chosen theme (and its
// custom vars) onto its own --scs-* scheme.
const QT_ID = 'scorpious187s-quest-tracker';
function isQtActive() { return !!game.modules.get(QT_ID)?.active; }

/** Re-key a var map from one prefix to another (e.g. --sqt-bg → --scs-bg). */
function translatePrefix(vars, from, to) {
  const out = {};
  for (const [k, v] of Object.entries(vars ?? {})) {
    out[k.startsWith(from) ? to + k.slice(from.length) : k] = v;
  }
  return out;
}

const SCS_VARS = [
  '--scs-bg-primary', '--scs-bg-secondary', '--scs-bg-header',
  '--scs-bg-item', '--scs-bg-item-hover',
  '--scs-text-primary', '--scs-text-secondary', '--scs-text-header',
  '--scs-accent', '--scs-accent-hover',
  '--scs-border', '--scs-border-light', '--scs-shadow',
  '--scs-badge-bg', '--scs-badge-text',
  '--scs-btn-bg', '--scs-btn-text', '--scs-btn-hover',
  '--scs-buy', '--scs-sell', '--scs-infinite',
  '--scs-bg-right', '--scs-text-right', '--scs-border-right',
  '--scs-font-heading', '--scs-font-body', '--scs-radius',
];

// Foundry's stylesheet overrides chrome with high-specificity rules; we punch
// through with inline !important using var() refs so values track :root changes.
const INLINE_BG_TARGETS = [
  ['.scs-window',     'var(--scs-bg-secondary)', 'var(--scs-text-primary)'],
  ['.scs-titlebar',   'var(--scs-bg-header)',    'var(--scs-text-header)'],
  ['.scs-panel',      'var(--scs-bg-primary)',   null],
  ['.scs-panel-body', 'var(--scs-bg-primary)',   null],
];

const INLINE_INPUT_TARGETS = 'input[type="text"], input[type="number"], input[type="search"], textarea, select';

export class ThemeManager {

  /** True when Quest Tracker is active and therefore controls the theme. */
  static isControlledByQt() { return isQtActive(); }

  /**
   * Resolve the theme id to apply. Quest Tracker (when active) wins over the
   * per-actor override and the Shop's own setting; otherwise honor a per-actor
   * override, then the Shop's world theme setting.
   */
  static resolveThemeId(actor = null) {
    if (isQtActive()) return game.settings.get(QT_ID, SETTINGS.THEME);
    const actorTheme = actor?.getFlag?.(MODULE_ID, FLAGS.THEME);
    if (actorTheme) return actorTheme;
    return game.settings.get(MODULE_ID, SETTINGS.THEME);
  }

  /** Compose the final variable map for a theme id (preset + custom overrides). */
  static composeVars(themeId) {
    const theme = getTheme(themeId);
    let custom = {};
    if (themeId === 'custom') {
      // When QT drives a custom theme, mirror its --sqt-* custom vars into --scs-*.
      custom = isQtActive()
        ? translatePrefix(game.settings.get(QT_ID, SETTINGS.CUSTOM_THEME) ?? {}, '--sqt-', '--scs-')
        : (game.settings.get(MODULE_ID, SETTINGS.CUSTOM_THEME) ?? {});
    }
    return { ...theme.vars, ...custom };
  }

  /** Apply a theme globally to :root (affects all open shop windows). */
  static apply(themeId) {
    // QT, when active, overrides any explicitly-passed id to keep modules in sync.
    const resolved = isQtActive()
      ? game.settings.get(QT_ID, SETTINGS.THEME)
      : (themeId ?? game.settings.get(MODULE_ID, SETTINGS.THEME));
    ThemeManager._setRootVars(ThemeManager.composeVars(resolved));
    document.querySelectorAll('.application.scs-window').forEach(app => {
      ThemeManager._styleWindowChrome(app);
      ThemeManager._applyInlineBackgrounds(app);
    });
    return getTheme(resolved);
  }

  /** Apply a theme scoped to a single application element. */
  static applyToElement(el, themeId) {
    if (!el) return;
    const resolved = themeId ?? game.settings.get(MODULE_ID, SETTINGS.THEME);
    ThemeManager._setRootVars(ThemeManager.composeVars(resolved));
    el.dataset.scsTheme = resolved;
    ThemeManager._styleWindowChrome(el);
    ThemeManager._applyInlineBackgrounds(el);
    if (el.classList.contains('scs-window')) {
      el.style.setProperty('background', 'var(--scs-bg-secondary)', 'important');
      el.style.setProperty('color', 'var(--scs-text-primary)', 'important');
    }
  }

  /** Live-preview an arbitrary var map on :root (used by the theme editor). */
  static previewVars(vars) {
    ThemeManager._setRootVars(vars);
    document.querySelectorAll('.application.scs-window').forEach(app => {
      ThemeManager._styleWindowChrome(app);
      ThemeManager._applyInlineBackgrounds(app);
    });
  }

  static _setRootVars(vars) {
    const root = document.documentElement;
    for (const k of SCS_VARS) {
      if (vars[k] !== undefined) root.style.setProperty(k, vars[k]);
      else root.style.removeProperty(k);
    }
  }

  static _applyInlineBackgrounds(appEl) {
    for (const [selector, bg, color] of INLINE_BG_TARGETS) {
      appEl.querySelectorAll(selector).forEach(el => {
        el.style.setProperty('background', bg, 'important');
        if (color) el.style.setProperty('color', color, 'important');
      });
    }
    appEl.querySelectorAll(INLINE_INPUT_TARGETS).forEach(el => {
      el.style.setProperty('background', 'var(--scs-bg-item)', 'important');
      el.style.setProperty('color', 'var(--scs-text-primary)', 'important');
      el.style.setProperty('border-color', 'var(--scs-border)', 'important');
    });
  }

  static _styleWindowChrome(appEl) {
    const header = appEl.querySelector(':scope > .window-header');
    if (header) {
      header.style.setProperty('background', 'var(--scs-bg-header)', 'important');
      header.style.setProperty('border-bottom', '2px solid var(--scs-accent)', 'important');
    }
    const title = appEl.querySelector(':scope > .window-header .window-title');
    if (title) title.style.setProperty('color', 'var(--scs-text-header)', 'important');
  }
}
