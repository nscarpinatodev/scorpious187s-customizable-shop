/**
 * Scorpious187's Customizable Shop — main entry point
 * Foundry VTT v13/v14
 */

import { MODULE_ID, SOCKET_NAME, SOCKET_TYPES, FLAGS } from './constants.js';
import { registerSettings, setShopSettingsApp } from './settings.js';
import { registerHandlebarsHelpers, preloadTemplates } from './helpers.js';
import { ThemeManager } from './theme-manager.js';
import { ShopApp } from './apps/shop-app.js';
import { ShopConfigApp } from './apps/shop-config.js';
import { ShopSettingsApp } from './apps/shop-settings.js';
import { ThemeEditorApp } from './apps/theme-editor.js';

// ── Init ────────────────────────────────────────────────────────────────────

Hooks.once('init', () => {
  setShopSettingsApp(ShopSettingsApp);
  registerSettings();
  registerHandlebarsHelpers();
  console.log(`${MODULE_ID} | Initialized`);
});

// ── Ready ───────────────────────────────────────────────────────────────────

Hooks.once('ready', async () => {
  await preloadTemplates();
  ThemeManager.apply();
  Hooks.on('scs.themeChanged', (id) => ThemeManager.apply(id));

  // ── Socket relay: open-for-players + player→GM transaction execution ──
  game.socket.on(SOCKET_NAME, async (data) => {
    switch (data?.type) {
      case SOCKET_TYPES.OPEN_SHOP: {
        if (game.user.isGM) break; // GM already has it open
        // The ownership grant that lets this client read the shop may still be
        // propagating; wait briefly for the actor (and its items) to sync.
        let actor = game.actors.get(data.actorId);
        let tries = 0;
        while ((!actor || !actor.testUserPermission(game.user, 'OBSERVER')) && tries++ < 20) {
          await new Promise(r => setTimeout(r, 150));
          actor = game.actors.get(data.actorId);
        }
        if (actor) ShopApp.open(actor);
        break;
      }
      case SOCKET_TYPES.TXN_REQUEST: {
        // Only the single primary active GM executes, to avoid double-runs.
        const primaryGM = game.users.find(u => u.isGM && u.active);
        if (!game.user.isGM || game.user.id !== primaryGM?.id) break;

        const requester = game.users.get(data.userId);
        // Resolve by UUID (handles unlinked-token actors) with an id fallback.
        const buyer = ShopApp._resolveActor(data.payload?.buyerUuid, data.payload?.buyerId);
        // Security: the requesting user must own the buyer actor.
        const allowed = requester && buyer && buyer.testUserPermission(requester, 'OWNER');
        const result = allowed
          ? await ShopApp.executeTransaction(data.payload)
          : { ok: false, message: game.i18n.localize('SCS.Warn.TxnFailed') };

        game.socket.emit(SOCKET_NAME, {
          type: SOCKET_TYPES.TXN_RESULT, requestId: data.requestId, userId: data.userId, result,
        });
        // Refresh the GM's own view if this shop is open.
        ShopApp.instances.get(data.payload?.merchantId)?.render();
        break;
      }
      case SOCKET_TYPES.TXN_RESULT: {
        if (data.userId !== game.user.id) break;
        ShopApp.resolvePending(data.requestId, data.result);
        break;
      }
      case SOCKET_TYPES.SHOP_UPDATED: {
        const app = ShopApp.instances.get(data.merchantId);
        if (!app?.rendered) break;
        // Render now, then again shortly after to catch the item-change
        // broadcast that may arrive just after this signal.
        app.render();
        setTimeout(() => { if (app.rendered) app.render(); }, 300);
        break;
      }
    }
  });

  game.modules.get(MODULE_ID).api = {
    ShopApp, ShopConfigApp, ShopSettingsApp, ThemeEditorApp, ThemeManager,
    openShop: (actorOrId) => {
      const actor = actorOrId?.documentName === 'Actor' ? actorOrId : game.actors.get(actorOrId);
      if (actor) ShopApp.open(actor);
    },
    configureShop: (actorOrId) => {
      const actor = actorOrId?.documentName === 'Actor' ? actorOrId : game.actors.get(actorOrId);
      if (actor) new ShopConfigApp(actor).render(true);
    },
  };

  console.log(`${MODULE_ID} | Ready`);
});

// ── Entry points ────────────────────────────────────────────────────────────

/** Header button on actor sheets (classic Application sheets). */
Hooks.on('getActorSheetHeaderButtons', (sheet, buttons) => {
  const actor = sheet.actor ?? sheet.document;
  if (!actor || actor.type === 'character') return;
  buttons.unshift({
    label: game.i18n.localize('SCS.Open'),
    class: 'scs-open-shop',
    icon: 'fas fa-store',
    onclick: () => ShopApp.open(actor),
  });
});

/** Header control on ApplicationV2 actor sheets (v13+). */
Hooks.on('getHeaderControlsApplicationV2', (app, controls) => {
  const actor = app?.document;
  if (!actor || actor.documentName !== 'Actor' || actor.type === 'character') return;
  controls.push({
    icon: 'fas fa-store',
    label: 'SCS.Open',
    action: 'scsOpenShop',
    onClick: () => ShopApp.open(actor),
  });
});

/** Resolve the actor for a directory entry, across jQuery (v12) / element (v13). */
function _entryActor(li) {
  const el = li?.dataset ? li : (li?.[0] ?? li?.currentTarget ?? null);
  const id = el?.dataset?.documentId ?? el?.dataset?.entryId ?? el?.dataset?.actorId
    ?? el?.closest?.('[data-entry-id],[data-document-id]')?.dataset?.entryId;
  return id ? game.actors.get(id) : null;
}

/** Right-click context menu in the Actors directory (v12 + v13 hook names). */
function _addActorContext(options) {
  options.push(
    {
      name: game.i18n.localize('SCS.Open'),
      icon: '<i class="fas fa-store"></i>',
      condition: (li) => { const a = _entryActor(li); return !!a && a.type !== 'character'; },
      callback: (li) => { const a = _entryActor(li); if (a) ShopApp.open(a); },
    },
    {
      name: game.i18n.localize('SCS.ConfigureShop'),
      icon: '<i class="fas fa-sliders-h"></i>',
      condition: () => game.user.isGM,
      callback: (li) => { const a = _entryActor(li); if (a) new ShopConfigApp(a).render(true); },
    },
  );
}
Hooks.on('getActorDirectoryEntryContext', (html, options) => _addActorContext(options));
// v13 renamed the directory context hook on some builds.
Hooks.on('getActorContextOptions', (directory, options) => _addActorContext(options));

/**
 * Players open a shop themselves by double-clicking the merchant's token.
 *
 * Two layers, because the canvas click-handler internals shift between Foundry
 * versions and game-system Token subclasses:
 *   1) Patch the active Token class's double-click to open the shop directly.
 *   2) Version-agnostic safety net: if a player's client ever renders a shop
 *      NPC's sheet (e.g. the patch was shadowed), close it and open the shop.
 * GMs keep normal behavior so they can still edit the NPC.
 */
Hooks.once('ready', () => {
  const TokenCls = CONFIG.Token?.objectClass
    ?? foundry.canvas?.placeables?.Token
    ?? globalThis.Token;
  const proto = TokenCls?.prototype;
  if (proto && typeof proto._onClickLeft2 === 'function') {
    const original = proto._onClickLeft2;
    proto._onClickLeft2 = function (event) {
      const actor = this.actor;
      if (actor?.getFlag(MODULE_ID, FLAGS.IS_SHOP) && !game.user.isGM) {
        ShopApp.open(actor);
        return;
      }
      return original.call(this, event);
    };
    console.log(`${MODULE_ID} | Token double-click patched on ${TokenCls.name}`);
  } else {
    console.warn(`${MODULE_ID} | Token double-click not patched; relying on sheet-redirect`);
  }
});

/** Redirect a player away from a shop NPC's sheet straight into the shop. */
function _redirectShopSheet(actor, app) {
  if (!actor || actor.documentName !== 'Actor' || !app) return;
  if (game.user.isGM || !actor.getFlag(MODULE_ID, FLAGS.IS_SHOP)) return;
  // Transient guard: multiple render hooks fire for one render; only act once
  // per render, but clear it so future renders (re-opens) redirect again.
  if (app._scsRedirecting) return;
  app._scsRedirecting = true;
  // Defer so we don't close mid-render, then swap the sheet for the shop.
  Promise.resolve().then(() => {
    delete app._scsRedirecting;
    app.close({ force: true });
    ShopApp.open(actor);
  });
}
// Cover v1 ActorSheet, the v2 ActorSheetV2 base, and the generic v2 hook —
// whichever the active system fires. The WeakSet guards against double-firing.
Hooks.on('renderActorSheet',   (app) => _redirectShopSheet(app.actor ?? app.document, app));
Hooks.on('renderActorSheetV2', (app) => _redirectShopSheet(app.actor ?? app.document, app));
Hooks.on('renderApplicationV2', (app) => {
  if (app?.document?.documentName === 'Actor') _redirectShopSheet(app.document, app);
});

/** Token HUD button for actors marked as shops. */
Hooks.on('renderTokenHUD', (hud, html, data) => {
  const actor = hud?.object?.actor;
  if (!actor || !actor.getFlag(MODULE_ID, FLAGS.IS_SHOP)) return;
  const root = html instanceof HTMLElement ? html : html?.[0];
  if (!root) return;
  const col = root.querySelector('.col.left') ?? root.querySelector('.left');
  if (!col) return;
  const btn = document.createElement('div');
  btn.className = 'control-icon scs-hud-shop';
  btn.title = game.i18n.localize('SCS.Open');
  btn.innerHTML = '<i class="fas fa-store"></i>';
  btn.addEventListener('click', () => ShopApp.open(actor));
  col.appendChild(btn);
});
