import { MODULE_ID, LIB_ID, SETTINGS, FLAGS } from './constants.js';

/**
 * Thin delegate to the shared library's ThemeManager (scorpious187s-lib).
 *
 * The theming engine — canonical --s187-* variables mirrored onto this
 * module's --scs-* prefix, window-chrome styling, inline punch-through —
 * lives in the library, which is also the family-wide theme authority.
 * The old "Quest Tracker wins" sibling hierarchy and prefix translation are
 * gone: every Scorpious187 module now follows the library's theme setting.
 *
 * What stays here is the one Shop-specific rule: a per-actor theme override
 * flag on the merchant beats the family theme for that shop's window.
 */

function libTheming() {
  return game.modules.get(LIB_ID)?.api?.theming ?? null;
}

export class ThemeManager {

  /** Kept for template/back-compat; the lib is the single authority now. */
  static isControlledByQt() { return false; }

  /** The family-wide active theme id (lib is the authority). */
  static activeThemeId() {
    try {
      return game.settings.get(LIB_ID, 'theme') || 'fantasy-parchment';
    } catch {
      return 'fantasy-parchment';
    }
  }

  /**
   * Resolve the theme id to apply for a shop window: a per-actor override
   * flag wins, then the family theme.
   */
  static resolveThemeId(actor = null) {
    const actorTheme = actor?.getFlag?.(MODULE_ID, FLAGS.THEME);
    if (actorTheme) return actorTheme;
    return ThemeManager.activeThemeId();
  }

  /** Apply the family theme (or an explicit id) globally. */
  static apply(themeId) {
    return libTheming()?.ThemeManager.apply(themeId);
  }

  /** Apply the theme to a single application element. */
  static applyToElement(el, themeId) {
    libTheming()?.ThemeManager.applyToElement(el, MODULE_ID, themeId);
  }

  /** Live-preview an arbitrary canonical var map (theme editor). */
  static previewVars(vars) {
    libTheming()?.ThemeManager.previewVars(vars);
  }
}
