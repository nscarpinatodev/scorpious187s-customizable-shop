import { LIB_ID } from '../constants.js';

/**
 * Retired: the custom theme editor now lives in the shared library
 * (scorpious187s-lib) and edits the family-wide custom theme. This shim keeps
 * the old `new ThemeEditorApp().render(true)` call sites (and any macros
 * using the module api) working by forwarding to the library's editor.
 */
export class ThemeEditorApp {
  render(_force) {
    const theming = game.modules.get(LIB_ID)?.api?.theming;
    if (theming) theming.openEditor();
    else ui.notifications.error(`Theme editor requires the ${LIB_ID} module.`);
    return this;
  }
}
