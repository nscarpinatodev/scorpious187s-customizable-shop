import { MODULE_ID } from './constants.js';

/** Register Handlebars helpers used by SCS templates. */
export function registerHandlebarsHelpers() {
  Handlebars.registerHelper('scs-eq',  (a, b) => a === b);
  Handlebars.registerHelper('scs-ne',  (a, b) => a !== b);
  Handlebars.registerHelper('scs-or',  (a, b) => a || b);
  Handlebars.registerHelper('scs-and', (a, b) => a && b);
  Handlebars.registerHelper('scs-not', (a) => !a);
  Handlebars.registerHelper('scs-gt',  (a, b) => a > b);
  Handlebars.registerHelper('scs-abs', (a) => Math.abs(Number(a) || 0));

  if (!Handlebars.helpers['concat']) {
    Handlebars.registerHelper('concat', (...args) => {
      args.pop();
      return args.join('');
    });
  }
}

/** Pre-load all SCS Handlebars templates. */
export async function preloadTemplates() {
  const base = `modules/${MODULE_ID}/templates`;
  const paths = [
    `${base}/shop.hbs`,
    `${base}/shop-config.hbs`,
    `${base}/theme-editor.hbs`,
    `${base}/shop-settings.hbs`,
  ];
  // loadTemplates was namespaced under foundry.applications.handlebars in v13+.
  const loader = foundry.applications?.handlebars?.loadTemplates ?? loadTemplates;
  return loader(paths);
}

/**
 * Resolve the actor that should act as the "player" side of a transaction:
 * a controlled token's actor first, then the user's assigned character.
 */
export function getActiveBuyerActor() {
  const controlled = canvas?.tokens?.controlled ?? [];
  if (controlled.length === 1 && controlled[0]?.actor) return controlled[0].actor;
  if (game.user?.character) return game.user.character;
  // Last resort: a single owned character.
  const owned = game.actors?.filter(a => a.isOwner && a.type === 'character') ?? [];
  return owned.length === 1 ? owned[0] : null;
}

/**
 * Ensure every player can at least OBSERVE the actor, so they can read its
 * inventory (LIMITED permission hides embedded items). Raises the default and
 * any explicit below-observer player entries. Returns true if anything changed.
 */
export async function ensurePlayersCanObserve(actor) {
  const OBSERVER = CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER;
  const ownership = foundry.utils.deepClone(actor.ownership ?? {});
  let changed = false;
  if ((ownership.default ?? 0) < OBSERVER) { ownership.default = OBSERVER; changed = true; }
  for (const user of game.users) {
    if (user.isGM) continue;
    if (ownership[user.id] !== undefined && ownership[user.id] < OBSERVER) {
      ownership[user.id] = OBSERVER;
      changed = true;
    }
  }
  if (changed) await actor.update({ ownership });
  return changed;
}

/** Whether the current user can read the actor's inventory. */
export function canReadInventory(actor) {
  return game.user.isGM || actor.isOwner || actor.testUserPermission(game.user, 'OBSERVER');
}

/** Round currency to a sensible number of decimal places. */
export function roundCoin(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/** Format a price for display, trimming trailing zeros. */
export function formatPrice(n) {
  const r = roundCoin(n);
  return Number.isInteger(r) ? String(r) : r.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}
