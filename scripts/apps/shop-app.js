import {
  MODULE_ID, SOCKET_NAME, SETTINGS, FLAGS, SHOP_MODE, SOCKET_TYPES,
  DEFAULT_MARKUP, DEFAULT_SELL_RATE, DEFAULT_ACTOR_IMG, DEFAULT_ITEM_IMG,
} from '../constants.js';
import { ThemeManager } from '../theme-manager.js';
import {
  getCurrencyPreset, getItemBaseValue, getWealth, adjustWealth, baseLabel, isStarfinder2e,
} from '../data/currency-presets.js';
import {
  getActiveBuyerActor, formatPrice, roundCoin, ensurePlayersCanObserve, canReadInventory,
} from '../helpers.js';

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/** Item types that are never merchandise (character-build / world types). */
const NON_PHYSICAL = new Set([
  // dnd5e / pf2e / sf2e
  'spell', 'feat', 'feature', 'class', 'subclass', 'background', 'race',
  'ancestry', 'heritage', 'deity', 'lore', 'action', 'effect', 'condition',
  'status', 'classfeature', 'heritagefeature', 'spellcastingEntry', 'formula',
  'campaignFeature', 'proficiency', 'specialability', 'buff', 'attack', 'aura',
  'trait', 'talent', 'spell-effect', 'kit', 'script',
  // fallout 2d20
  'skill', 'perk', 'addiction', 'disease', 'special_ability', 'origin',
  'object_or_structure', 'leveling',
]);

export class ShopApp extends HandlebarsApplicationMixin(ApplicationV2) {

  /** Open shop windows keyed by actor id (one per merchant). */
  static instances = new Map();

  /** Pending player-initiated transactions awaiting a GM result, by requestId. */
  static _pending = new Map();

  /** True while executeTransaction is mutating inventories; pauses re-renders. */
  static _transacting = false;

  static DEFAULT_OPTIONS = {
    id: 'scs-shop',
    classes: ['scs-window', 'scs-shop'],
    tag: 'div',
    window: {
      frame: true,
      positioned: true,
      title: 'SCS.Shop.Title',
      icon: 'fas fa-store',
      resizable: true,
    },
    position: { width: 980, height: 640 },
    actions: {
      setMode(event, target)     { this._setMode(target.dataset.mode); },
      addItem(event, target)     { this._onAddItem(target); },
      showDetail(event, target)  { this._showDetail(target); },
      closeDetail()              { this._closeDetail(); },
      incLine(event, target)     { this._stepLine(target.dataset.key, +1); },
      decLine(event, target)     { this._stepLine(target.dataset.key, -1); },
      removeLine(event, target)  { this._removeLine(target.dataset.key); },
      clearCart()                { this._clearCart(); },
      checkout()                 { this._checkout(); },
      openConfig()               { this._openConfig(); },
      showToPlayers()            { this._showToPlayers(); },
      viewLog()                  { this._viewLog(); },
    },
  };

  static PARTS = {
    shop: {
      template: `modules/${MODULE_ID}/templates/shop.hbs`,
      scrollable: ['.scs-inventory-body', '.scs-cart-rows'],
    },
  };

  /**
   * @param {Actor} actor  The merchant NPC.
   */
  constructor(actor, options = {}) {
    // Unique id per merchant so multiple shops can be open at once. Set via
    // options so ApplicationV2 uses it for the element id (a get id() override
    // would not change the internally-stored id).
    super({ id: `scs-shop-${actor.id}`, ...options });
    this.actor = actor;
    this._mode = SHOP_MODE.BUY;
    /** @type {Map<string, object>} key `${side}::${itemId}` → cart line */
    this._cart = new Map();
    /** @type {{side: string, itemId: string}|null} currently inspected item */
    this._detail = null;
  }

  get title() {
    const name = this.actor.getFlag(MODULE_ID, FLAGS.SHOP_NAME) || this.actor.name;
    return name;
  }

  /** Open (or focus) the shop window for an actor. */
  static open(actor) {
    const existing = ShopApp.instances.get(actor.id);
    if (existing?.rendered) {
      existing.bringToFront();
      return existing;
    }
    const app = new ShopApp(actor);
    ShopApp.instances.set(actor.id, app);
    app.render(true);
    return app;
  }

  /**
   * Resolve an actor by UUID (preferred — works for world actors and synthetic
   * unlinked-token actors), falling back to a bare world-actor id.
   */
  static _resolveActor(uuid, id) {
    if (uuid) {
      const doc = fromUuidSync(uuid);
      if (doc?.documentName === 'Actor') return doc;
    }
    return id ? game.actors.get(id) : null;
  }

  // ── Config accessors ───────────────────────────────────────────────────

  get _preset() { return ShopApp.presetNow(); }
  get _markup() { return ShopApp.markupOf(this.actor); }
  get _sellRate() { return ShopApp.sellRateOf(this.actor); }

  // ── Pricing (static so the GM can recompute authoritatively) ────────────

  static presetNow() {
    const cfg = game.settings.get(MODULE_ID, SETTINGS.SYSTEM_CONFIG);
    return getCurrencyPreset(cfg?.currencyPreset);
  }

  static markupOf(actor) {
    const flag = actor.getFlag(MODULE_ID, FLAGS.MARKUP);
    if (Number.isFinite(flag)) return flag;
    return game.settings.get(MODULE_ID, SETTINGS.DEFAULTS)?.markup ?? DEFAULT_MARKUP;
  }

  static sellRateOf(actor) {
    const flag = actor.getFlag(MODULE_ID, FLAGS.SELL_RATE);
    if (Number.isFinite(flag)) return flag;
    return game.settings.get(MODULE_ID, SETTINGS.DEFAULTS)?.sellRate ?? DEFAULT_SELL_RATE;
  }

  /** Base value of an item (fixed-price override or system price). */
  static baseValueOf(preset, item) {
    if (item.getFlag(MODULE_ID, FLAGS.PRICE_MODE) === 'fixed') {
      const fixed = item.getFlag(MODULE_ID, FLAGS.FIXED_PRICE);
      if (Number.isFinite(fixed)) return fixed;
    }
    return getItemBaseValue(preset, item);
  }

  static buyUnitOf(merchant, preset, item)  { return roundCoin(ShopApp.baseValueOf(preset, item) * ShopApp.markupOf(merchant)); }
  static sellUnitOf(merchant, preset, item) { return roundCoin(ShopApp.baseValueOf(preset, item) * ShopApp.sellRateOf(merchant)); }

  _baseValue(item) { return ShopApp.baseValueOf(this._preset, item); }
  _buyUnit(item)   { return ShopApp.buyUnitOf(this.actor, this._preset, item); }
  _sellUnit(item)  { return ShopApp.sellUnitOf(this.actor, this._preset, item); }

  // ── Item collection ────────────────────────────────────────────────────

  static _quantity(item) {
    const q = foundry.utils.getProperty(item, 'system.quantity');
    if (typeof q === 'object' && q !== null) return Number(q.value) || 0;
    return Number.isFinite(Number(q)) ? Number(q) : 1;
  }

  static _isMerchandise(item) {
    if (NON_PHYSICAL.has(item.type)) return false;
    // PF2e / SF2e store coins (gp, credits, UPB…) as inventory items — never sell those.
    if (foundry.utils.getProperty(item, 'system.stackGroup') === 'coins') return false;
    return true;
  }

  /**
   * Whether the owner currently has this item equipped/worn/held. Used to keep a
   * merchant from accidentally selling gear off its own body. Equip state is
   * stored differently per system, so we check the common shapes:
   *   • pf2e / sf2e  — `item.isEquipped` getter (carryType held/worn)
   *   • dnd5e / fallout / sfrpg — boolean `system.equipped`
   *   • nested boolean `system.equipped.value`
   */
  static _isEquipped(item) {
    if (typeof item.isEquipped === 'boolean') return item.isEquipped;
    const eq = foundry.utils.getProperty(item, 'system.equipped');
    if (eq === true) return true;
    if (eq && typeof eq === 'object') {
      if (eq.value === true) return true;
      if (typeof eq.carryType === 'string') return ['held', 'worn'].includes(eq.carryType);
    }
    return false;
  }

  /** Items the merchant offers for sale (buy mode source). */
  _merchantStock() {
    return this.actor.items
      // Never offer gear the merchant has equipped/worn/held on its own body.
      .filter(i => ShopApp._isMerchandise(i) && !ShopApp._isEquipped(i) && !i.getFlag(MODULE_ID, FLAGS.NO_SELL))
      .map(i => ({
        id: i.id,
        name: i.name,
        img: i.img || DEFAULT_ITEM_IMG,
        infinite: !!i.getFlag(MODULE_ID, FLAGS.INFINITE),
        qty: ShopApp._quantity(i),
        unit: this._buyUnit(i),
      }))
      .filter(row => row.infinite || row.qty > 0);
  }

  /** Items the active buyer can sell (sell mode source). */
  _buyerStock(buyer) {
    if (!buyer) return [];
    return buyer.items
      .filter(i => ShopApp._isMerchandise(i))
      .map(i => ({
        id: i.id,
        name: i.name,
        img: i.img || DEFAULT_ITEM_IMG,
        infinite: false,
        qty: ShopApp._quantity(i),
        unit: this._sellUnit(i),
      }))
      .filter(row => row.qty > 0);
  }

  // ── Context ────────────────────────────────────────────────────────────

  async _prepareContext(options) {
    const ctx = await super._prepareContext(options);
    const isGM = game.user.isGM;
    const buyer = getActiveBuyerActor();
    const preset = this._preset;
    const themeId = ThemeManager.resolveThemeId(this.actor);
    const layoutSide = game.settings.get(MODULE_ID, SETTINGS.SYSTEM_CONFIG)?.layoutSide === 'right'
      ? 'right' : 'left';

    const inventory = this._mode === SHOP_MODE.BUY
      ? this._merchantStock()
      : this._buyerStock(buyer);

    // Build cart sections from the unified cart.
    const buying = [];
    const selling = [];
    let buyTotal = 0;
    let sellTotal = 0;
    for (const line of this._cart.values()) {
      const lineTotal = roundCoin(line.unit * line.qty);
      const row = { ...line, lineTotal, lineTotalLabel: formatPrice(lineTotal) };
      if (line.side === SHOP_MODE.BUY) { buying.push(row); buyTotal += lineTotal; }
      else { selling.push(row); sellTotal += lineTotal; }
    }
    buying.sort((a, b) => a.name.localeCompare(b.name));
    selling.sort((a, b) => a.name.localeCompare(b.name));

    const net = roundCoin(buyTotal - sellTotal);

    const detail = await this._buildDetail(buyer);

    return {
      ...ctx,
      isGM,
      themeId,
      layoutSide,
      canRead: canReadInventory(this.actor),
      detail,
      mode: this._mode,
      isBuy: this._mode === SHOP_MODE.BUY,
      merchant: {
        name: this.title,
        img: this.actor.img || DEFAULT_ACTOR_IMG,
        subtitle: this.actor.getFlag(MODULE_ID, FLAGS.SHOP_NAME) ? this.actor.name : '',
      },
      buyer: buyer ? { name: buyer.name, id: buyer.id } : null,
      hasBuyer: !!buyer,
      currencyLabel: baseLabel(preset),
      markupPct: Math.round(this._markup * 100),
      sellPct: Math.round(this._sellRate * 100),
      inventory,
      inventoryTitle: this._mode === SHOP_MODE.BUY
        ? game.i18n.localize('SCS.Shop.ForSale')
        : game.i18n.format('SCS.Shop.SellingFrom', { name: buyer?.name ?? '—' }),
      buying,
      selling,
      buyTotal, sellTotal, net,
      buyTotalLabel: formatPrice(buyTotal),
      sellTotalLabel: formatPrice(sellTotal),
      netLabel: formatPrice(Math.abs(net)),
      netDirection: net > 0 ? 'pay' : (net < 0 ? 'receive' : 'even'),
      cartEmpty: this._cart.size === 0,
    };
  }

  _onRender(context, options) {
    super._onRender(context, options);
    ThemeManager.applyToElement(this.element, context.themeId);
    if (!this._hooked) {
      const reapplyTheme = () =>
        ThemeManager.applyToElement(this.element, ThemeManager.resolveThemeId(this.actor));
      this._hookTheme = Hooks.on('scs.themeChanged', reapplyTheme);
      // Follow Quest Tracker too — when QT is active it controls the theme.
      this._hookThemeQt = Hooks.on('sqt.themeChanged', reapplyTheme);
      this._hookActor = Hooks.on('updateActor', (doc) => {
        if (ShopApp._transacting) return;
        if (doc.id === this.actor.id || doc.id === getActiveBuyerActor()?.id) this.render();
      });
      this._hookItem = Hooks.on('updateItem', (item) => this._maybeRefresh(item));
      this._hookItemC = Hooks.on('createItem', (item) => this._maybeRefresh(item));
      this._hookItemD = Hooks.on('deleteItem', (item) => this._maybeRefresh(item));
      this._hookCfg = Hooks.on('scs.systemConfigChanged', () => this.render());
      this._hooked = true;
    }
  }

  _maybeRefresh(item) {
    // Hold off while a transaction is mutating inventories — executeTransaction
    // issues a single refresh (and a SHOP_UPDATED broadcast) when it finishes.
    if (ShopApp._transacting) return;
    const parentId = item.parent?.id;
    if (parentId === this.actor.id || parentId === getActiveBuyerActor()?.id) this.render();
  }

  _onClose(options) {
    super._onClose(options);
    Hooks.off('scs.themeChanged', this._hookTheme);
    Hooks.off('sqt.themeChanged', this._hookThemeQt);
    Hooks.off('updateActor', this._hookActor);
    Hooks.off('updateItem', this._hookItem);
    Hooks.off('createItem', this._hookItemC);
    Hooks.off('deleteItem', this._hookItemD);
    Hooks.off('scs.systemConfigChanged', this._hookCfg);
    this._hooked = false;
    ShopApp.instances.delete(this.actor.id);
  }

  // ── Cart operations ────────────────────────────────────────────────────

  _setMode(mode) {
    if (mode !== SHOP_MODE.BUY && mode !== SHOP_MODE.SELL) return;
    this._mode = mode;
    this._detail = null; // a detail may not exist on the other side
    this.render();
  }

  _onAddItem(target) {
    const itemId = target.dataset.itemId ?? target.closest('[data-item-id]')?.dataset.itemId;
    if (!itemId) return;
    const side = target.dataset.side ?? this._mode; // buy from merchant, sell from buyer
    const sourceActor = side === SHOP_MODE.BUY ? this.actor : getActiveBuyerActor();
    const item = sourceActor?.items.get(itemId);
    if (!item) return;

    const infinite = side === SHOP_MODE.BUY && !!item.getFlag(MODULE_ID, FLAGS.INFINITE);
    const maxQty = infinite ? Infinity : ShopApp._quantity(item);
    const unit = side === SHOP_MODE.BUY ? this._buyUnit(item) : this._sellUnit(item);
    const key = `${side}::${itemId}`;

    const existing = this._cart.get(key);
    const nextQty = (existing?.qty ?? 0) + 1;
    if (nextQty > maxQty) {
      ui.notifications.warn(game.i18n.format('SCS.Warn.StockLimit', { name: item.name, max: maxQty }));
      return;
    }
    this._cart.set(key, {
      key, side, itemId,
      sourceActorId: sourceActor.id,
      name: item.name,
      img: item.img || DEFAULT_ITEM_IMG,
      unit,
      unitLabel: formatPrice(unit),
      qty: nextQty,
      infinite,
      maxQty: infinite ? null : maxQty,
    });
    this.render();
  }

  _stepLine(key, delta) {
    const line = this._cart.get(key);
    if (!line) return;
    const next = line.qty + delta;
    if (next <= 0) { this._cart.delete(key); this.render(); return; }
    if (!line.infinite && line.maxQty != null && next > line.maxQty) {
      ui.notifications.warn(game.i18n.format('SCS.Warn.StockLimit', { name: line.name, max: line.maxQty }));
      return;
    }
    line.qty = next;
    this.render();
  }

  _removeLine(key) {
    this._cart.delete(key);
    this.render();
  }

  _clearCart() {
    this._cart.clear();
    this.render();
  }

  // ── Item detail (inline) ───────────────────────────────────────────────

  _showDetail(target) {
    const itemId = target.dataset.itemId ?? target.closest('[data-item-id]')?.dataset.itemId;
    if (!itemId) return;
    const side = target.dataset.side ?? this._mode;
    this._detail = { side, itemId };
    this.render();
  }

  _closeDetail() {
    this._detail = null;
    this.render();
  }

  /** Resolve the inspected item and build its display context. */
  async _buildDetail(buyer) {
    if (!this._detail) return null;
    const { side, itemId } = this._detail;
    const sourceActor = side === SHOP_MODE.BUY ? this.actor : buyer;
    const item = sourceActor?.items.get(itemId);
    if (!item) { this._detail = null; return null; }

    const infinite = side === SHOP_MODE.BUY && !!item.getFlag(MODULE_ID, FLAGS.INFINITE);
    const unit = side === SHOP_MODE.BUY ? this._buyUnit(item) : this._sellUnit(item);

    return {
      side,
      itemId,
      isBuy: side === SHOP_MODE.BUY,
      name: item.name,
      img: item.img || DEFAULT_ITEM_IMG,
      typeLabel: ShopApp._typeLabel(item),
      priceLabel: side === SHOP_MODE.BUY
        ? game.i18n.localize('SCS.Item.BuyPrice')
        : game.i18n.localize('SCS.Item.SellPrice'),
      price: formatPrice(unit),
      infinite,
      stock: infinite ? game.i18n.localize('SCS.Item.Unlimited') : ShopApp._quantity(item),
      stats: ShopApp._extractStats(item),
      descriptionHTML: await ShopApp._enrich(ShopApp._rawDescription(item), item),
    };
  }

  static async _enrich(html, item) {
    if (!html) return '';
    const TE = foundry.applications?.ux?.TextEditor?.implementation ?? globalThis.TextEditor;
    try {
      return await TE.enrichHTML(html, { secrets: false, relativeTo: item });
    } catch {
      return html;
    }
  }

  static _rawDescription(item) {
    const d = item.system?.description;
    if (typeof d === 'string') return d;
    return d?.value ?? d?.full ?? d?.gm ?? '';
  }

  static _typeLabel(item) {
    const key = `TYPES.Item.${item.type}`;
    const loc = game.i18n.localize(key);
    return loc === key ? (item.type ?? '').replace(/^\w/, c => c.toUpperCase()) : loc;
  }

  /**
   * System-aware stat extraction (weapon damage, armor, etc.). Dispatches to a
   * per-system extractor; unknown systems fall back to a generic reader.
   * Returns [{ label, value }]; missing fields are skipped.
   */
  static _extractStats(item) {
    const id = game.system?.id ?? '';
    let stats;
    if (id === 'dnd5e') stats = ShopApp._stats5e(item);
    else if (id === 'pf2e' || isStarfinder2e()) stats = ShopApp._statsPf2e(item);
    else if (id === 'fallout') stats = ShopApp._statsFallout(item);
    else stats = ShopApp._statsGeneric(item);
    return stats.filter(s => s.value !== undefined && s.value !== null && s.value !== '');
  }

  /** Title-case a key: "smallGuns" / "speed_penalty" → "Small Guns" / "Speed Penalty". */
  static _titleCase(s) {
    if (s === undefined || s === null || s === '') return undefined;
    return String(s)
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/[_-]+/g, ' ')
      .replace(/\b\w/g, c => c.toUpperCase())
      .trim();
  }

  // ── D&D 5e ──────────────────────────────────────────────────────────────
  static _stats5e(item) {
    const get = (p) => foundry.utils.getProperty(item, `system.${p}`);
    const out = [];
    const push = (label, value) => { if (value !== undefined && value !== null && value !== '') out.push({ label, value: String(value) }); };

    // Damage — v3+ `damage.base` ({number, denomination, types}) or v2 `damage.parts`.
    const base = get('damage.base');
    if (base && (base.number != null || base.denomination != null)) {
      const die = base.denomination ? `d${base.denomination}` : '';
      const bonus = base.bonus ? ` + ${base.bonus}` : '';
      const types = base.types instanceof Set ? [...base.types]
        : Array.isArray(base.types) ? base.types : (base.type ? [base.type] : []);
      const typeStr = types.length ? ' ' + types.map(t => ShopApp._titleCase(t)).join('/') : '';
      push('Damage', `${base.number ?? 1}${die}${bonus}${typeStr}`.trim());
    } else {
      const parts = get('damage.parts');
      if (Array.isArray(parts) && parts.length) {
        push('Damage', parts.map(p => Array.isArray(p) ? `${p[0]}${p[1] ? ' ' + ShopApp._titleCase(p[1]) : ''}` : p).join(', '));
      }
    }

    const range = get('range.value');
    if (range) push('Range', `${range}${get('range.long') ? '/' + get('range.long') : ''} ${get('range.units') || 'ft'}`.trim());

    if (get('armor.value') != null) push('Armor Class', get('armor.value'));
    if (get('armor.dex') != null) push('Max Dex', `+${get('armor.dex')}`);

    push('Properties', ShopApp._dnd5eProperties(item));
    const weight = typeof get('weight') === 'object' ? get('weight.value') : get('weight');
    if (weight) push('Weight', `${weight} lb`);
    push('Rarity', ShopApp._titleCase(get('rarity')));
    if (get('attunement')) push('Attunement', 'Required');
    return out;
  }

  static _dnd5eProperties(item) {
    const p = foundry.utils.getProperty(item, 'system.properties');
    let keys = [];
    if (p instanceof Set) keys = [...p];
    else if (Array.isArray(p)) keys = p;
    else if (p && typeof p === 'object') keys = Object.entries(p).filter(([, v]) => v === true).map(([k]) => k);
    if (!keys.length) return undefined;
    const labels = CONFIG?.DND5E?.itemProperties ?? {};
    return keys.map(k => labels[k]?.label ?? ShopApp._titleCase(k)).join(', ');
  }

  // ── Pathfinder 2e / Starfinder 2e ───────────────────────────────────────
  static _statsPf2e(item) {
    const get = (p) => foundry.utils.getProperty(item, `system.${p}`);
    const out = [];
    const push = (label, value) => { if (value !== undefined && value !== null && value !== '') out.push({ label, value: String(value) }); };

    // Weapon damage: { dice, die: "d6", damageType }
    const die = get('damage.die');
    if (die) {
      const dtype = get('damage.damageType');
      push('Damage', `${get('damage.dice') ?? 1}${die}${dtype ? ' ' + ShopApp._titleCase(dtype) : ''}`);
    }
    if (get('range')) push('Range', `${get('range')} ft`);
    if (get('reload.value') !== undefined && get('reload.value') !== null && get('reload.value') !== '') push('Reload', get('reload.value'));

    // Armor / shield
    if (get('acBonus') != null) push('AC Bonus', get('acBonus') >= 0 ? `+${get('acBonus')}` : get('acBonus'));
    if (get('dexCap') != null) push('Dex Cap', `+${get('dexCap')}`);
    if (get('checkPenalty')) push('Check Penalty', get('checkPenalty'));
    if (get('speedPenalty')) push('Speed Penalty', get('speedPenalty'));
    if (get('hardness')) push('Hardness', get('hardness'));
    if (get('hp.max')) push('HP', get('hp.max'));

    push('Category', ShopApp._titleCase(get('category')));
    push('Group', ShopApp._titleCase(get('group')?.value ?? get('group')));

    const bulk = get('bulk.value');
    if (bulk != null) push('Bulk', bulk === 0 ? '—' : (bulk === 0.1 ? 'L' : bulk));
    if (get('level.value')) push('Level', get('level.value'));
    push('Rarity', ShopApp._titleCase(get('traits.rarity')));
    const traits = get('traits.value');
    if (Array.isArray(traits) && traits.length) push('Traits', traits.map(t => ShopApp._titleCase(t)).join(', '));
    return out;
  }

  // ── Fallout 2d20 ────────────────────────────────────────────────────────
  static _statsFallout(item) {
    const get = (p) => foundry.utils.getProperty(item, `system.${p}`);
    const out = [];
    const push = (label, value) => { if (value !== undefined && value !== null && value !== '') out.push({ label, value: String(value) }); };

    // Weapon — damage and its nested ranked sub-objects live under `damage`.
    if (get('damage.rating') != null) push('Damage', `${get('damage.rating')} CD`);
    push('Damage Type', ShopApp._falloutFlags(get('damage.damageType')));
    push('Effects', ShopApp._falloutRanked(get('damage.damageEffect')));
    push('Qualities', ShopApp._falloutRanked(get('damage.weaponQuality')));
    push('Weapon Type', ShopApp._titleCase(get('weaponType')));
    if (get('fireRate')) push('Fire Rate', get('fireRate'));
    if (get('range')) push('Range', ShopApp._titleCase(typeof get('range') === 'object' ? get('range.value') : get('range')));
    if (get('ammo')) push('Ammo', typeof get('ammo') === 'object' ? get('ammo.value') : get('ammo'));
    if (get('ammoPerShot') && !get('melee')) push('Ammo / Shot', get('ammoPerShot'));

    // Armor / apparel — resistances and coverage (field shapes vary by version).
    const res = (...paths) => {
      for (const p of paths) { const v = get(p); if (v != null) return (typeof v === 'object' ? v.value : v); }
      return undefined;
    };
    const phys = res('resistance.physical', 'physicalRes.value', 'physical.value');
    const enrg = res('resistance.energy', 'energyRes.value', 'energy.value');
    const rad = res('resistance.radiation', 'radiationRes.value', 'radiation.value');
    if (phys != null) push('Physical DR', phys);
    if (enrg != null) push('Energy DR', enrg);
    if (rad != null) push('Radiation DR', rad);
    push('Covers', ShopApp._falloutFlags(get('location')));

    const weight = typeof get('weight') === 'object' ? get('weight.value') : get('weight');
    if (weight) push('Weight', `${weight} lbs`);
    push('Rarity', ShopApp._falloutRarity(get('rarity')));
    return out;
  }

  /** Boolean map → active keys: { physical:true, energy:false } → "Physical". */
  static _falloutFlags(obj) {
    if (!obj || typeof obj !== 'object') return obj ? ShopApp._titleCase(obj) : undefined;
    const on = Object.entries(obj).filter(([, v]) => v === true).map(([k]) => ShopApp._titleCase(k));
    return on.length ? on.join(', ') : undefined;
  }

  /** Ranked map → active entries: { piercing_x:{value:1}, inaccurate:{value:-2} } → "Piercing, Inaccurate -2". */
  static _falloutRanked(obj) {
    if (!obj || typeof obj !== 'object') return undefined;
    const out = [];
    for (const [key, v] of Object.entries(obj)) {
      const val = (v && typeof v === 'object') ? v.value : v;
      if (!val) continue; // 0 / null → quality not present
      const name = ShopApp._titleCase(key.replace(/_x$/, ''));
      out.push(val === 1 ? name : `${name} ${val}`);
    }
    return out.length ? out.join(', ') : undefined;
  }

  static _falloutRarity(r) {
    if (r == null || r === '') return undefined;
    const labels = ['Common', 'Uncommon', 'Rare', 'Epic', 'Legendary'];
    return typeof r === 'number' ? (labels[r] ?? `Rarity ${r}`) : ShopApp._titleCase(r);
  }

  // ── Generic fallback ────────────────────────────────────────────────────
  static _statsGeneric(item) {
    const get = (p) => foundry.utils.getProperty(item, `system.${p}`);
    const out = [];
    const push = (label, value) => { if (value !== undefined && value !== null && value !== '') out.push({ label, value: String(value) }); };
    const parts = get('damage.parts');
    if (Array.isArray(parts) && parts.length) push('Damage', parts.map(p => Array.isArray(p) ? p.filter(Boolean).join(' ') : p).join(', '));
    else if (get('damage.value')) push('Damage', `${get('damage.value')}${get('damage.type') ? ' ' + get('damage.type') : ''}`);
    else if (typeof get('damage') === 'string') push('Damage', get('damage'));
    push('Range', get('range.value') ?? (typeof get('range') === 'object' ? undefined : get('range')));
    push('Armor', get('armor.value') ?? get('ac.value') ?? get('acBonus'));
    const weight = typeof get('weight') === 'object' ? get('weight.value') : get('weight');
    if (weight) push('Weight', weight);
    push('Rarity', ShopApp._titleCase(get('rarity')));
    return out;
  }

  // ── Checkout ───────────────────────────────────────────────────────────

  async _checkout() {
    if (this._cart.size === 0) return;
    const buyer = getActiveBuyerActor();
    if (!buyer) {
      ui.notifications.warn(game.i18n.localize('SCS.Warn.NoBuyer'));
      return;
    }
    // Only side/itemId/qty are sent; the GM recomputes prices authoritatively.
    const lines = [...this._cart.values()].map(l => ({ side: l.side, itemId: l.itemId, qty: l.qty }));
    // UUIDs (not bare ids) so the executor resolves the *same* actor instance we
    // see — critical for unlinked tokens, whose item ids differ from the world actor.
    const payload = {
      merchantId: this.actor.id, merchantUuid: this.actor.uuid,
      buyerId: buyer.id, buyerUuid: buyer.uuid,
      lines,
    };

    // GMs execute directly; players relay the request to an active GM.
    const result = game.user.isGM
      ? await ShopApp.executeTransaction(payload)
      : await this._requestTransaction(payload);

    if (!result?.ok) {
      ui.notifications.error(result?.message ?? game.i18n.localize('SCS.Warn.TxnFailed'));
      return;
    }
    ui.notifications.info(`${game.i18n.localize('SCS.Notify.Done')} — ${ShopApp._summaryText(result)}`);
    this._cart.clear();
    this.render();
  }

  /** Player path: ask an active GM to run the transaction; await the result. */
  _requestTransaction(payload) {
    if (!game.users.some(u => u.isGM && u.active)) {
      return Promise.resolve({ ok: false, message: game.i18n.localize('SCS.Warn.NoGM') });
    }
    const requestId = foundry.utils.randomID();
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        ShopApp._pending.delete(requestId);
        resolve({ ok: false, message: game.i18n.localize('SCS.Warn.TxnTimeout') });
      }, 15000);
      ShopApp._pending.set(requestId, { resolve, timeout });
      game.socket.emit(SOCKET_NAME, {
        type: SOCKET_TYPES.TXN_REQUEST, requestId, userId: game.user.id, payload,
      });
    });
  }

  /** Resolve a pending player transaction (called from the socket handler). */
  static resolvePending(requestId, result) {
    const entry = ShopApp._pending.get(requestId);
    if (!entry) return;
    clearTimeout(entry.timeout);
    ShopApp._pending.delete(requestId);
    entry.resolve(result);
  }

  static _summaryText(result) {
    const net = result.net ?? 0;
    if (net > 0) return game.i18n.format('SCS.Notify.Paid', { amount: formatPrice(net), cur: result.currency });
    if (net < 0) return game.i18n.format('SCS.Notify.Received', { amount: formatPrice(-net), cur: result.currency });
    return game.i18n.localize('SCS.Notify.EvenTrade');
  }

  /**
   * Authoritative transaction executor — runs on a client with permission to
   * modify both actors (the GM). Recomputes all prices from live documents;
   * never trusts client-supplied prices. Returns { ok, message?, net?, currency? }.
   */
  static async executeTransaction({ merchantId, merchantUuid, buyerId, buyerUuid, lines }) {
    const merchant = ShopApp._resolveActor(merchantUuid, merchantId);
    const buyer = ShopApp._resolveActor(buyerUuid, buyerId);
    if (!merchant || !buyer) return { ok: false, message: game.i18n.localize('SCS.Warn.TxnFailed') };

    const preset = ShopApp.presetNow();
    const cfg = game.settings.get(MODULE_ID, SETTINGS.SYSTEM_CONFIG);
    const buys = lines.filter(l => l.side === SHOP_MODE.BUY);
    const sells = lines.filter(l => l.side === SHOP_MODE.SELL);

    let buyTotal = 0;
    let sellTotal = 0;
    const logLines = [];

    // Validate + price the buy side against the merchant's live stock.
    for (const l of buys) {
      const item = merchant.items.get(l.itemId);
      if (!item) return { ok: false, message: game.i18n.format('SCS.Warn.GoneStock', { name: l.itemId }) };
      // Guard: the merchant may have equipped this item after it entered the cart.
      if (ShopApp._isEquipped(item)) return { ok: false, message: game.i18n.format('SCS.Warn.Equipped', { name: item.name }) };
      const infinite = !!item.getFlag(MODULE_ID, FLAGS.INFINITE);
      if (!infinite && ShopApp._quantity(item) < l.qty)
        return { ok: false, message: game.i18n.format('SCS.Warn.StockLimit', { name: item.name, max: ShopApp._quantity(item) }) };
      const amount = roundCoin(ShopApp.buyUnitOf(merchant, preset, item) * l.qty);
      buyTotal += amount;
      logLines.push({ name: item.name, qty: l.qty, side: SHOP_MODE.BUY, amount });
    }
    // Validate + price the sell side against the buyer's live inventory.
    for (const l of sells) {
      const item = buyer.items.get(l.itemId);
      if (!item || ShopApp._quantity(item) < l.qty)
        return { ok: false, message: game.i18n.format('SCS.Warn.SellGone', { name: item?.name ?? l.itemId }) };
      const amount = roundCoin(ShopApp.sellUnitOf(merchant, preset, item) * l.qty);
      sellTotal += amount;
      logLines.push({ name: item.name, qty: l.qty, side: SHOP_MODE.SELL, amount });
    }

    const net = roundCoin(buyTotal - sellTotal); // >0 buyer pays, <0 buyer receives
    if (net !== 0) {
      const ok = await adjustWealth(preset, buyer, -net);
      if (!ok) return { ok: false, message: game.i18n.localize('SCS.Warn.CantAfford') };
      if (cfg?.adjustMerchantCurrency) await adjustWealth(preset, merchant, net).catch(() => {});
    }

    // Suppress the document-change re-renders that every open shop window would
    // otherwise fire on each create/delete during this loop. Those re-renders,
    // multiplied across viewers, run mid-`await` and were preventing the
    // merchant-side removals from completing. We refresh once at the end.
    ShopApp._transacting = true;
    try {
      // Resolve every item document up front, before any create/delete mutates
      // the collections we're iterating, so no reference goes stale mid-loop.
      const buyOps = buys
        .map(l => ({ item: merchant.items.get(l.itemId), qty: l.qty }))
        .filter(o => o.item);
      const sellOps = sells
        .map(l => ({ item: buyer.items.get(l.itemId), qty: l.qty }))
        .filter(o => o.item);

      for (const { item, qty } of buyOps) {
        const infinite = !!item.getFlag(MODULE_ID, FLAGS.INFINITE);
        try {
          await ShopApp._giveItem(buyer, item, qty);
          if (!infinite) await ShopApp._takeItem(merchant, item, qty);
        } catch (err) {
          console.error(`${MODULE_ID} | buy op failed for "${item?.name}"`, err);
        }
      }
      for (const { item, qty } of sellOps) {
        try {
          await ShopApp._giveItem(merchant, item, qty);
          await ShopApp._takeItem(buyer, item, qty);
        } catch (err) {
          console.error(`${MODULE_ID} | sell op failed for "${item?.name}"`, err);
        }
      }
    } finally {
      ShopApp._transacting = false;
    }

    // Record the transaction on the merchant and feed the GM's chat log.
    await ShopApp._recordTransaction(merchant, buyer, logLines, net, baseLabel(preset))
      .catch(err => console.error(`${MODULE_ID} | failed to record transaction`, err));

    // Refresh the executor's own open window now that the guard is lifted, and
    // tell every other client viewing this shop to refresh its stock display.
    ShopApp.instances.get(merchantId)?.render();
    game.socket.emit(SOCKET_NAME, { type: SOCKET_TYPES.SHOP_UPDATED, merchantId });
    return { ok: true, net, currency: baseLabel(preset) };
  }

  // ── Transaction log ─────────────────────────────────────────────────────

  /**
   * Append a completed transaction to the merchant's log flag (newest first,
   * capped) and whisper a summary card to the GMs so purchases can be followed
   * live from the chat log.
   */
  static async _recordTransaction(merchant, buyer, lines, net, cur) {
    if (!lines.length) return;
    const entry = { t: Date.now(), buyer: buyer.name, lines, net, cur };

    const log = foundry.utils.deepClone(merchant.getFlag(MODULE_ID, FLAGS.TXN_LOG) ?? []);
    log.unshift(entry);
    if (log.length > 200) log.length = 200; // cap so the flag can't grow unbounded
    await merchant.setFlag(MODULE_ID, FLAGS.TXN_LOG, log);

    const esc      = Handlebars.escapeExpression;
    const shopName = merchant.getFlag(MODULE_ID, FLAGS.SHOP_NAME) || merchant.name;
    const rows = lines.map(l => {
      const verb = l.side === SHOP_MODE.BUY
        ? game.i18n.localize('SCS.Log.Bought')
        : game.i18n.localize('SCS.Log.Sold');
      const qty = l.qty > 1 ? `${l.qty}× ` : '';
      return `<li class="scs-txn-line ${l.side}">${verb} ${qty}${esc(l.name)} — ${formatPrice(l.amount)} ${esc(cur)}</li>`;
    }).join('');
    const netLine = net > 0
      ? game.i18n.format('SCS.Log.NetPaid',     { amount: formatPrice(net),  cur })
      : net < 0
        ? game.i18n.format('SCS.Log.NetReceived', { amount: formatPrice(-net), cur })
        : game.i18n.localize('SCS.Log.NetEven');

    const gmIds = game.users.filter(u => u.isGM).map(u => u.id);
    await ChatMessage.create({
      content: `<div class="scs-txn-card">
        <header class="scs-txn-header"><i class="fas fa-receipt"></i> ${esc(shopName)} — ${esc(buyer.name)}</header>
        <ul class="scs-txn-lines">${rows}</ul>
        <footer class="scs-txn-net">${netLine}</footer>
      </div>`,
      whisper: gmIds,
      speaker: { alias: shopName },
    });
  }

  /** GM: show this shop's transaction history in a dialog. */
  _viewLog() {
    const esc = Handlebars.escapeExpression;
    const log = this.actor.getFlag(MODULE_ID, FLAGS.TXN_LOG) ?? [];

    const body = log.length ? log.map(e => {
      const when  = new Date(e.t).toLocaleString();
      const rows  = (e.lines ?? []).map(l => {
        const verb = l.side === SHOP_MODE.BUY
          ? game.i18n.localize('SCS.Log.Bought')
          : game.i18n.localize('SCS.Log.Sold');
        const qty = l.qty > 1 ? `${l.qty}× ` : '';
        return `<li class="scs-txn-line ${l.side}">${verb} ${qty}${esc(l.name)} — ${formatPrice(l.amount)} ${esc(e.cur)}</li>`;
      }).join('');
      return `<div class="scs-txn-entry">
        <div class="scs-txn-entry-head"><strong>${esc(e.buyer)}</strong><span class="scs-txn-when">${esc(when)}</span></div>
        <ul class="scs-txn-lines">${rows}</ul>
      </div>`;
    }).join('') : `<p class="scs-txn-empty">${game.i18n.localize('SCS.Log.Empty')}</p>`;

    new Dialog({
      title: game.i18n.format('SCS.Log.Title', { name: this.title }),
      content: `<div class="scs-txn-log">${body}</div>`,
      buttons: {
        clear: {
          icon: '<i class="fas fa-trash"></i>',
          label: game.i18n.localize('SCS.Log.Clear'),
          callback: () => this.actor.unsetFlag(MODULE_ID, FLAGS.TXN_LOG),
        },
        close: {
          icon: '<i class="fas fa-times"></i>',
          label: game.i18n.localize('SCS.Log.Close'),
        },
      },
      default: 'close',
    }, { width: 460, classes: ['dialog', 'scs-txn-dialog'] }).render(true);
  }

  // ── Share with players ─────────────────────────────────────────────────

  /** GM action: grant read access + broadcast the shop to all player clients. */
  async _showToPlayers() {
    await ensurePlayersCanObserve(this.actor);
    // Give the ownership change a moment to propagate so players' clients have
    // the actor + its items before they open the window.
    await new Promise(r => setTimeout(r, 300));
    game.socket.emit(SOCKET_NAME, { type: SOCKET_TYPES.OPEN_SHOP, actorId: this.actor.id });
    ui.notifications.info(game.i18n.localize('SCS.Notify.Shared'));
  }

  /** Clone `qty` of `item` onto `actor` (merges quantity into an existing copy). */
  static async _giveItem(actor, item, qty) {
    const data = item.toObject();
    delete data._id;
    if (data.flags) delete data.flags[MODULE_ID]; // strip shop flags
    const hasQty = foundry.utils.getProperty(item, 'system.quantity') !== undefined;

    // Merge into an identically-named item the actor already owns, if any.
    const existing = actor.items.find(i => i.name === item.name && i.type === item.type);
    if (existing && hasQty) {
      await ShopApp._setQuantity(existing, ShopApp._quantity(existing) + qty);
      return;
    }
    if (hasQty) {
      ShopApp._setQuantityData(data, qty);
      await actor.createEmbeddedDocuments('Item', [data]);
    } else {
      // No quantity concept — create N copies.
      await actor.createEmbeddedDocuments('Item', Array.from({ length: qty }, () => foundry.utils.deepClone(data)));
    }
  }

  /** Remove `qty` of `item` from its actor (delete when depleted). */
  static async _takeItem(actor, item, qty) {
    const hasQty = foundry.utils.getProperty(item, 'system.quantity') !== undefined;
    if (!hasQty) { await item.delete(); return; }
    const remaining = ShopApp._quantity(item) - qty;
    if (remaining > 0) await ShopApp._setQuantity(item, remaining);
    else await item.delete();
  }

  static _quantityPath(item) {
    const q = foundry.utils.getProperty(item, 'system.quantity');
    return (typeof q === 'object' && q !== null) ? 'system.quantity.value' : 'system.quantity';
  }

  static async _setQuantity(item, q) {
    await item.update({ [ShopApp._quantityPath(item)]: q });
  }

  static _setQuantityData(data, q) {
    const existing = foundry.utils.getProperty(data, 'system.quantity');
    if (typeof existing === 'object' && existing !== null) {
      foundry.utils.setProperty(data, 'system.quantity.value', q);
    } else {
      foundry.utils.setProperty(data, 'system.quantity', q);
    }
  }

  // ── Config window ──────────────────────────────────────────────────────

  async _openConfig() {
    const { ShopConfigApp } = await import('./shop-config.js');
    new ShopConfigApp(this.actor).render(true);
  }
}
