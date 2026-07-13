/**
 * Theme catalog — re-exported from the shared library (scorpious187s-lib).
 *
 * The catalog this module used to ship now lives in the library on the
 * canonical --s187-* namespace; theme.vars keys are therefore --s187-*, not
 * --scs-*. The library mirrors values onto --scs-* at :root, so stylesheets
 * are unaffected.
 */
export {
  THEME_CATEGORIES,
  THEME_VARS,
  getAllThemes,
  getTheme,
  getThemeChoices,
} from '/modules/scorpious187s-lib/scripts/theming/theme-presets.js';
