// Interfaz de la app. Dibuja vistas con plantillas y reacciona con delegación de eventos.
import * as E from './engine.js';
import { load, save, defaultState, migrate, exportFile, isNative, postNative, loadSyncConfig, saveSyncConfig, PRICE_UNITS } from './store.js';
import * as Sync from './sync.js';

let state = load();
const ui = {
  view: state.onboarded ? 'inicio' : 'onb',
  month: E.monthKey(new Date()),
  onbStep: 0,
  onbSaldo: { emergencia: '', mac: '', iphone: '' },
  modal: null,
  draft: {},
};
const $app = document.getElementById('app');
const $modal = document.getElementById('modal-root');
const $toast = document.getElementById('toast');

// ---------- Utilidades ----------

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
const sumBy = (arr, f) => arr.reduce((s, x) => s + f(x), 0);
const pct = (v) => `${Math.round(v * 100)}%`;
const clamp01 = (v) => Math.max(0, Math.min(1, v || 0));
const envById = (id) => state.envelopes.find((e) => e.id === id);
// Mismo orden que la cascada; también es el orden validado de colores de las categorías.
const GROUP_ORDER = ['necesidad', 'ahorro', 'profesional', 'gusto', 'impuestos'];

if (isNative) document.documentElement.classList.add('native');

// SF Symbols: en la app de Mac llegan como imágenes desde el lado nativo; en el navegador se usa un texto de respaldo.
const SYMBOLS = (isNative && window.__NATIVE__?.symbols) || {};
const SYMBOL_FALLBACK = {
  plus: '+', minus: '−', 'arrow.left.arrow.right': '⇄', 'chevron.left': '‹', 'chevron.right': '›', 'chevron.forward': '›',
  trash: '🗑', xmark: '✕', 'square.and.arrow.up': '↑', 'square.and.arrow.down': '↓', lightbulb: '💡',
  'checkmark.circle.fill': '✓', 'exclamationmark.triangle.fill': '⚠', 'xmark.octagon.fill': '⛔', 'info.circle.fill': 'ℹ',
  'building.columns': '🏦', 'arrow.counterclockwise': '↺', house: '🏠', target: '🎯', 'chart.pie': '🧮',
  'fork.knife': '🥗', 'person.2': '🏡', shippingbox: '📦', cart: '🛒', 'clock.arrow.circlepath': '📜', gearshape: '⚙', book: '📘', 'ellipsis.circle': '☰',
};
function sym(name, cls = '') {
  const url = SYMBOLS[name];
  if (url) return `<span class="sym ${cls}" aria-hidden="true" style="--sym:url(${url})"></span>`;
  return `<span class="sym-fb ${cls}" aria-hidden="true">${SYMBOL_FALLBACK[name] || ''}</span>`;
}

// Dos monedas: ingresos (settings.currency) y gastos (settings.costCurrency). Si difieren, cada monto lleva su código.
const baseCode = () => state.settings.currency;
const costCode = () => state.settings.costCurrency || state.settings.currency;
const isDual = () => costCode() !== baseCode();

function currencySymbol(code = baseCode()) {
  try {
    return new Intl.NumberFormat('es-MX', { style: 'currency', currency: code, currencyDisplay: 'narrowSymbol' })
      .formatToParts(0).find((p) => p.type === 'currency').value;
  } catch { return '$'; }
}
function fmtIn(n, code) {
  const v = Number(n) || 0;
  const dec = Math.abs(v - Math.round(v)) < 0.005 ? 0 : 2;
  const body = new Intl.NumberFormat('es-MX', { minimumFractionDigits: dec, maximumFractionDigits: dec }).format(Math.abs(v));
  const sign = v < 0 ? '-' : '';
  if (!isDual()) return `${sign}${currencySymbol(code)}${body}`;
  return code === 'USD' ? `${sign}US$${body}` : `${sign}${currencySymbol(code)}${body} ${code}`;
}
// Moneda de ingresos (saldos, pagos, reparto) y moneda de gastos (costos de productos y servicios).
const fmt = (n) => fmtIn(n, baseCode());
const fmtCost = (n) => fmtIn(n, costCode());
// Monto en la moneda propia de un sobre (p. ej. un pedido que se paga en USD).
const fmtEnv = (env, n) => fmtIn(n, E.envCurrency(state, env));
const envIsBase = (env) => E.envCurrency(state, env) === baseCode();
// Equivalente en la moneda de ingresos de un costo, solo si hay dos monedas.
const inBase = (costAmount) => (isDual() ? `≈ ${fmt(E.costToBase(state, costAmount))}` : '');
function monthLabel(m) {
  const [y, mo] = m.split('-').map(Number);
  const label = new Date(y, mo - 1, 1).toLocaleDateString('es', { month: 'long', year: 'numeric' });
  return label.charAt(0).toUpperCase() + label.slice(1);
}
function dateLabel(d) {
  return new Date(d + 'T12:00:00').toLocaleDateString('es', { day: 'numeric', month: 'short' });
}

// Aviso breve; con `action` ({ label, run }) muestra un botón (p. ej. Deshacer) y dura más.
function toast(msg, action = null) {
  $toast.innerHTML = '';
  const text = document.createElement('span');
  text.textContent = msg;
  $toast.appendChild(text);
  if (action) {
    const btn = document.createElement('button');
    btn.className = 'toast-btn';
    btn.textContent = action.label;
    btn.addEventListener('click', () => { $toast.classList.remove('show'); action.run(); });
    $toast.appendChild(btn);
  }
  $toast.classList.toggle('actionable', Boolean(action));
  $toast.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => $toast.classList.remove('show'), action ? 7000 : 2600);
}

// ---------- Papelera ----------
// Lo borrado se guarda 30 días en `state.trash` para deshacer o restaurar.
const TRASH_KINDS = { pago: 'Pago', gasto: 'Gasto', sobre: 'Sobre', alimento: 'Alimento', producto: 'Producto de una lista', productos: 'Productos de una lista' };
function toTrash(kind, label, item, extra = {}) {
  const entry = { id: E.uid(), kind, label, at: Date.now(), item: structuredClone(item), extra };
  (state.trash ||= []).unshift(entry);
  return entry;
}
function restoreTrash(entryId) {
  const entry = (state.trash || []).find((t) => t.id === entryId);
  if (!entry) return;
  const now = Date.now();
  const revive = (...ids) => { state.restored ||= {}; for (const id of ids) state.restored[id] = now; };
  const insertAt = (list, item, index) => list.splice(Math.min(Number(index) || 0, list.length), 0, item);
  const { item, extra } = entry;
  if (entry.kind === 'pago') {
    state.payments.push(item);
    for (const x of extra.expenses || []) state.expenses.push(x);
    revive(item.id, ...(extra.expenses || []).map((x) => x.id));
  } else if (entry.kind === 'gasto') {
    state.expenses.push(item);
    revive(item.id);
  } else if (entry.kind === 'sobre') {
    insertAt(state.envelopes, { ...item, updatedAt: now }, extra.index);
    revive(item.id);
  } else if (entry.kind === 'alimento') {
    insertAt(state.food.items, item, extra.index);
    touch('food');
  } else if (entry.kind === 'producto') {
    const env = envById(extra.envId) || currentOrder();
    if (!env) return toast('Esa lista ya no existe; restaura primero su sobre.');
    insertAt(env.order.items, item, extra.index);
    env.updatedAt = now;
  } else if (entry.kind === 'productos') {
    const env = envById(extra.envId);
    if (!env) return toast('Esa lista ya no existe; restaura primero su sobre.');
    for (const { index, item: it } of [...item].sort((a, b) => a.index - b.index)) insertAt(env.order.items, it, index);
    env.updatedAt = now;
  }
  state.trash = state.trash.filter((t) => t.id !== entryId);
  commit(`${TRASH_KINDS[entry.kind]} restaurado ✓`);
}
const undoable = (entry, message) => commit() || toast(message, { label: 'Deshacer', run: () => restoreTrash(entry.id) });

function persist() {
  state.updatedAt = Date.now();
  if (!save(state)) toast('No se pudo guardar en este dispositivo. Exporta un respaldo.');
  scheduleSync();
}

// Marcas para la fusión entre dispositivos: qué sección cambió y qué registros se borraron.
function touch(section) { (state.meta ||= {})[section] = Date.now(); }
function markDeleted(...ids) { state.deleted ||= {}; for (const id of ids) state.deleted[id] = Date.now(); }

// Vuelve a dibujar después de que el navegador mueva el foco (p. ej. con Tab) y lo conserva.
let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  setTimeout(() => { renderQueued = false; render(); }, 0);
}

function commit(msg) {
  persist();
  render();
  if (msg) toast(msg);
}

// ---------- Sincronización entre dispositivos ----------

const DEVICE = isNative ? 'Mac' : /iPhone|iPad/.test(navigator.userAgent) ? 'iPhone' : 'navegador';
const syncState = { config: loadSyncConfig(), busy: false, again: false, last: null, error: '' };
let syncTimer = null;

// Copia de seguridad local antes de cualquier reemplazo de datos (Mac: carpeta de copias; navegador: últimas 5).
const LOCAL_BACKUPS_KEY = 'economia:copias';
function backupLocal(label, data = state) {
  const text = JSON.stringify(data, null, 2);
  if (isNative) { postNative({ type: 'backup', label, data: text }); return; }
  try {
    const list = JSON.parse(localStorage.getItem(LOCAL_BACKUPS_KEY) || '[]');
    list.unshift({ label, at: Date.now(), data: text });
    localStorage.setItem(LOCAL_BACKUPS_KEY, JSON.stringify(list.slice(0, 5)));
  } catch { /* sin almacenamiento: la copia no se guarda */ }
}

// Lista de copias disponibles: en la Mac, la carpeta de copias; en el navegador, las guardadas localmente.
async function loadBackupList() {
  let list = [];
  try {
    if (isNative) list = await window.webkit.messageHandlers.storeReply.postMessage({ type: 'list-backups' });
    else list = JSON.parse(localStorage.getItem(LOCAL_BACKUPS_KEY) || '[]').map((c, i) => ({ label: c.label, at: c.at, local: i }));
  } catch { list = []; }
  if (ui.modal === 'copias') { ui.draft.list = list || []; renderModal(); }
}
async function readBackup(entry) {
  if (isNative) return window.webkit.messageHandlers.storeReply.postMessage({ type: 'read-backup', name: entry.name });
  return JSON.parse(localStorage.getItem(LOCAL_BACKUPS_KEY) || '[]')[entry.local]?.data;
}

// Restaura una copia como versión definitiva: lo que no está en la copia se marca borrado y lo que está,
// restaurado; las secciones toman la fecha actual. Así la sincronización deja todos los dispositivos igual.
function applyRestore(snapshot, message = 'Copia restaurada ✓') {
  backupLocal('antes-de-restaurar');
  const now = Date.now();
  const snap = migrate(snapshot);
  const kept = [...snap.payments, ...snap.expenses, ...snap.envelopes];
  const keepIds = new Set(kept.map((x) => x.id));
  const deleted = { ...(state.deleted || {}), ...(snap.deleted || {}) };
  const restored = { ...(state.restored || {}), ...(snap.restored || {}) };
  for (const x of [...state.payments, ...state.expenses, ...state.envelopes]) if (!keepIds.has(x.id)) deleted[x.id] = now;
  for (const id of keepIds) restored[id] = now;
  for (const env of snap.envelopes) env.updatedAt = now;
  state = { ...snap, deleted, restored, trash: state.trash || [], meta: { settings: now, partner: now, food: now, onboarded: now } };
  closeModal();
  commit(message);
}

// Conecta la sincronización con la preferencia elegida (combinar, usar los locales o los sincronizados).
async function connectSync(config, prefer) {
  backupLocal('antes-de-sincronizar');
  const result = await Sync.synchronize(state, config, { device: DEVICE, prefer });
  state = migrate(result.state);
  save(state);
  saveSyncConfig(config);
  Object.assign(syncState, { config, last: result.waiting ? null : result.at, error: '', waiting: Boolean(result.waiting) });
  closeModal();
  render();
  toast(result.waiting ? 'Conectado. Se sincronizará cuando haya datos en algún dispositivo.' : 'Sincronización activada ✓');
}

function scheduleSync(delay = 2000) {
  if (!syncState.config) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(runSync, delay);
}

async function runSync() {
  if (!syncState.config) return;
  if (syncState.busy) { syncState.again = true; return; }
  syncState.busy = true;
  refreshSyncStatus();
  const startedAt = state.updatedAt;
  try {
    const before = state;
    const result = await Sync.synchronize(state, syncState.config, { device: DEVICE });
    if (result.adopted) backupLocal('antes-de-adoptar', before);
    if (state.updatedAt !== startedAt) {
      // Hubo cambios mientras se sincronizaba: se fusionan y se vuelve a subir.
      state = migrate(Sync.mergeStates(state, result.state));
      syncState.again = true;
    } else if (result.changed) {
      state = migrate(result.state);
    }
    if (result.changed || syncState.again) {
      save(state);
      if (!ui.modal) render();
    }
    syncState.waiting = Boolean(result.waiting);
    if (!result.waiting) syncState.last = result.at;
    syncState.error = '';
  } catch (err) {
    const message = err?.message || String(err);
    if (message !== syncState.error) toast(`Sincronización: ${message}`);
    syncState.error = message;
  } finally {
    syncState.busy = false;
    refreshSyncStatus();
    if (syncState.again) { syncState.again = false; scheduleSync(500); }
  }
}

function syncStatusText() {
  if (!syncState.config) return 'Desactivada';
  if (syncState.busy) return 'Sincronizando…';
  if (syncState.error) return `Error: ${syncState.error}`;
  if (syncState.waiting) return 'Conectado; esperando datos de algún dispositivo';
  if (syncState.last) return `Sincronizado a las ${new Date(syncState.last).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })}`;
  return 'Pendiente';
}
function refreshSyncStatus() {
  const el = document.getElementById('sync-status');
  if (el) {
    el.textContent = syncStatusText();
    el.className = `small ${syncState.error ? 'warn-ink' : 'ink-2'}`;
  }
}

// ---------- Piezas reutilizables ----------

// `kind`: 'base' (ingresos, USD) o 'cost' (gastos, p. ej. MXN). Con dos monedas el campo muestra su código.
const money = (attrs, value, cls = '', kind = 'base') => {
  const code = kind === 'cost' ? costCode() : kind === 'base' ? baseCode() : kind; // o un código explícito (moneda del sobre)
  return `<div class="money ${cls}" data-sym="${esc(currencySymbol(code))}"${isDual() ? ` data-code="${code}"` : ''}><input class="input ${cls.includes('amount') ? 'amount' : ''}" type="number" inputmode="decimal" min="0" step="0.01" placeholder="0" value="${value === '' || value == null ? '' : esc(value)}" ${attrs}></div>`;
};
const percent = (attrs, value) =>
  `<div class="money pct"><input class="input" type="number" inputmode="decimal" min="0" max="100" step="1" value="${esc(value)}" ${attrs}></div>`;

const bind = (path, type = 'number') => `data-bind="${path}" data-type="${type}" data-k="b:${path}"`;
const envBind = (id, field, type = 'number') => `data-env="${id}" data-field="${field}" data-type="${type}" data-k="e:${id}:${field}"`;

function meter(value, opts = {}) {
  const w = clamp01(value) * 100;
  const color = opts.color ? `background:${opts.color}` : '';
  return `<div class="meter ${opts.thin ? 'thin' : ''}" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(w)}"><span style="width:${w}%;${color}"></span></div>`;
}

// Barra apilada por grupo: cada segmento tiene tooltip nativo (title) y la leyenda nombra cada color.
function stackBar(byGroup, total, extra = null) {
  const segs = GROUP_ORDER.filter((g) => (byGroup[g] || 0) > 0).map((g) => ({ g, v: byGroup[g], label: E.GROUPS[g].label, color: `var(--g-${g})` }));
  if (extra && extra.v > 0) segs.push(extra);
  const t = total || sumBy(segs, (s) => s.v) || 1;
  if (!segs.length) return '<div class="stackbar" aria-hidden="true"></div>';
  return `
    <div class="stackbar" role="img" aria-label="${esc(segs.map((s) => `${s.label} ${fmt(s.v)}`).join(', '))}">
      ${segs.map((s) => `<span style="flex:${s.v / t};background:${s.color}" title="${esc(`${s.label}: ${fmt(s.v)} (${pct(s.v / t)})`)}"></span>`).join('')}
    </div>
    <div class="legend">${segs.map((s) => `<span><i class="dot" style="background:${s.color}"></i>${esc(s.label)} · ${fmt(s.v)}</span>`).join('')}</div>`;
}

const LEVEL_ICON = { critical: 'xmark.octagon.fill', warning: 'exclamationmark.triangle.fill', good: 'checkmark.circle.fill', info: 'info.circle.fill' };
const LEVEL_RANK = { critical: 0, warning: 1, info: 2, good: 3 };
function tipCards(recs) {
  return recs.map((r) => `
    <div class="tipcard ${r.level}">
      <span class="ic">${sym(LEVEL_ICON[r.level])}</span>
      <div><strong><span class="sr-only">${{ critical: 'Urgente', warning: 'Atención', good: 'Bien', info: 'Dato' }[r.level]}: </span>${esc(r.title)}</strong><p>${esc(r.text)}</p>
        ${r.level !== 'good' && r.id && (E.FIXES[r.id] || NAV_FIXES[r.id]) ? `<div class="fix"><button class="btn sm" data-action="resolve" data-rec="${r.id}" data-title="${esc(r.title)}" data-env="${esc(r.data?.envId || '')}" data-missing="${esc(r.data?.missing || '')}" title="${E.FIXES[r.id] ? 'Corrige el plan según esta recomendación (te muestra los cambios antes de aplicarlos)' : 'Te lleva a donde puedes corregirlo'}">Resolver</button></div>` : ''}
      </div>
    </div>`).join('');
}

// Recomendaciones que dependen de una decisión tuya: Resolver te lleva al lugar exacto para corregirlas.
function goAndFocus(view, selector, message) {
  ui.modal = null;
  renderModal();
  ui.view = view;
  render();
  const el = selector && $app.querySelector(selector);
  if (el) { el.scrollIntoView({ block: 'center' }); el.focus({ preventScroll: true }); } else window.scrollTo(0, 0);
  if (message) toast(message);
}
const NAV_FIXES = {
  necesidades: () => goAndFocus('plan', '.group-title', 'Revisa los montos de tus necesidades: renta y transporte suelen ser los más grandes.'),
  renta: (d) => goAndFocus('plan', `[data-k="e:${d.env}:monthly"]`, 'Para bajar este porcentaje hay que bajar la renta o subir tus ingresos.'),
  'internet-caro': (d) => goAndFocus('plan', `[data-k="e:${d.env}:monthly"]`, 'Con Wi-Fi en casa puedes bajar el plan del móvil.'),
  vence: (d) => {
    // Mover dinero al sobre que vence, desde el sobre con más disponible que no sea una necesidad ni el fondo.
    const sources = state.envelopes
      .filter((e) => e.id !== d.env && e.group !== 'necesidad' && e.role !== 'emergencia' && e.role !== 'impuestos')
      .map((e) => ({ e, bal: E.envelopeBalance(state, e.id) }))
      .sort((a, b) => b.bal - a.bal);
    const from = sources[0]?.bal > 0 ? sources[0].e.id : 'libre';
    openModal('mover', { from, to: d.env, amount: Math.ceil(num(d.missing) * 100) / 100 });
    if (!(sources[0]?.bal > 0)) toast('Ningún sobre de gustos o ahorro tiene dinero: el siguiente pago completará este sobre primero.');
  },
};
// Si una corrección automática ya no tiene nada que cambiar, se lleva al ajuste correspondiente.
const FIX_FALLBACK = {
  ingreso: () => goAndFocus('ajustes', '#inc', 'Escribe cuánto recibes al mes en promedio.'),
  fondo: () => goAndFocus('ajustes', '#pf', 'Págate primero ya está al máximo recomendado; el excedente de pagos grandes también va al fondo.'),
  ahorro: () => goAndFocus('ajustes', '#pf'),
  internet: (d) => goAndFocus('plan', `[data-k="e:${d.env}:monthly"]`, 'Revisa internet y plan móvil: juntos no deberían pasar del 3% de tu ingreso.'),
  'plan-excede': () => goAndFocus('plan', '.group-title'),
  cliente: () => goAndFocus('ajustes', '#efm', 'Tu fondo de emergencia ya apunta a 8 meses o más.'),
  impuestos: () => goAndFocus('ajustes', '#tax'),
  'hogar-desigual': () => goAndFocus('hogar'),
};
function sortedRecs() {
  return E.recommendations(state, ui.month, fmt).sort((a, b) => LEVEL_RANK[a.level] - LEVEL_RANK[b.level]);
}

function monthNav() {
  return `<div class="month-nav">
    <button data-action="month" data-d="-1" aria-label="Mes anterior" title="Mes anterior">${sym('chevron.left')}</button>
    <span>${monthLabel(ui.month)}</span>
    <button data-action="month" data-d="1" aria-label="Mes siguiente" title="Mes siguiente">${sym('chevron.right')}</button>
  </div>`;
}

// ---------- Vistas ----------

function viewInicio() {
  const m = ui.month;
  const received = E.incomeInMonth(state, m);
  const plan = E.monthPlan(state, m);
  const covered = sumBy(plan.lines, (l) => Math.min(E.fundedInMonth(state, l.env.id, m), l.target));
  const coverage = plan.total > 0 ? covered / plan.total : 0;
  const missing = Math.max(0, plan.total - covered);
  const recs = sortedRecs().filter((r) => r.level !== 'good').slice(0, 3);

  const groups = GROUP_ORDER.map((g) => {
    const envs = state.envelopes.filter((e) => e.group === g).sort((a, b) => (a.priority ?? 50) - (b.priority ?? 50));
    if (!envs.length) return '';
    return `<div class="group-title"><i class="dot" style="background:var(--g-${g})"></i>${E.GROUPS[g].label}</div>
      <div class="env-list">${envs.map((e) => envRow(e, m)).join('')}</div>`;
  }).join('');

  return `
    <div class="page-head">
      <div><h1>Inicio</h1><p>Hola${state.settings.name ? `, ${esc(state.settings.name)}` : ''}. Así va tu dinero este mes.</p></div>
      ${monthNav()}
    </div>

    <section class="card hero">
      <div class="label">Recibido de clientes en ${monthLabel(m).toLowerCase()}</div>
      <div class="big">${fmt(received)}</div>
      ${meter(coverage)}
      <div class="foot">
        <span>Plan del mes cubierto: <strong>${pct(coverage)}</strong> de ${fmt(plan.total)}</span>
        <span>${missing > 0 ? `Faltan ${fmt(missing)}` : '¡Mes cubierto! 🎉'}</span>
      </div>
    </section>

    <div class="actions quick-actions">
      <button class="btn primary big" data-action="open" data-modal="pago">${sym('plus')} Recibí un pago…</button>
      <button class="btn big" data-action="open" data-modal="gasto">${sym('minus')} Registrar gasto…</button>
    </div>

    ${weeklyCards()}
    ${recs.length ? `<section class="card stack"><div class="row between"><h2>Recomendaciones</h2><button class="btn link sm" data-action="go" data-view="consejos">Ver todas</button></div>${tipCards(recs)}</section>` : ''}

    <section class="stack">
      <div class="row between"><h2>Tus sobres</h2><button class="btn sm" data-action="open" data-modal="mover">${sym('arrow.left.arrow.right')} Mover dinero…</button></div>
      <p class="small ink-2">A la derecha, lo disponible en cada sobre. La barra muestra cuánto le ha llegado este mes de lo que necesita.</p>
      ${groups}
    </section>`;
}

// Los sobres de gastos en otra moneda (p. ej. MXN) se muestran en su moneda, con el equivalente en USD.
const localCur = (e) => isDual() && !envIsBase(e) && E.isManualEnvelope(e);
const inEnv = (e, usd) => (localCur(e) ? E.baseToCost(state, usd) : usd);
const fmtLocal = (e, usd) => (localCur(e) ? fmtEnv(e, E.baseToCost(state, usd)) : fmt(usd));

function envRow(e, m) {
  const bal = E.envelopeBalance(state, e.id);
  const target = E.monthlyTarget(state, e, m);
  const funded = E.fundedInMonth(state, e.id, m);
  let detail;
  if (e.goal && num(e.goal.target) > 0) {
    const goal = E.goalTarget(state, e);
    detail = `${meter(bal / goal, { thin: true, color: `var(--g-${e.group})` })}<span class="tiny"><span>Meta ${fmtCost(e.goal.target)}${isDual() ? ` (${fmt(goal)})` : ''}</span><span>${pct(bal / goal)}</span></span>`;
  } else if (e.role === 'impuestos') {
    detail = `<span class="tiny"><span>${state.settings.taxPct}% de cada pago</span><span>Este mes ${fmt(funded)}</span></span>`;
  } else if (target > 0) {
    detail = `${meter(funded / target, { thin: true, color: `var(--g-${e.group})` })}<span class="tiny"><span>Este mes ${fmtLocal(e, funded)} de ${fmtLocal(e, target)}</span><span>${funded >= target - 0.005 ? '✓ cubierto' : `faltan ${fmtLocal(e, target - funded)}`}</span></span>`;
  } else {
    detail = `<span class="tiny"><span>${e.role === 'libre' ? 'Recibe parte del excedente' : e.role === 'inversion' ? 'Recibe el excedente cuando el fondo está completo' : 'Sin monto mensual'}</span><span></span></span>`;
  }
  const badges = `${e.pending ? '<span class="badge">pendiente</span>' : ''}${e.shared && state.partner.mode !== 'yo100' ? '<span class="badge accent">compartido</span>' : ''}`;
  return `<button class="env" data-action="open" data-modal="sobre" data-id="${e.id}">
    <span class="emoji" aria-hidden="true">${esc(e.icon)}</span>
    <span class="name">${esc(e.name)}${badges}</span>
    <span class="bal num ${bal < 0 ? 'neg' : ''}">${fmtLocal(e, bal)}${localCur(e) ? `<span class="tiny muted" style="display:block;font-weight:400">${fmt(bal)}</span>` : ''}</span>
    <span class="detail">${detail}</span>
  </button>`;
}

function viewConsejos() {
  return `<div class="page-head"><div><h1>Recomendaciones</h1><p>Calculadas con tu plan y tus pagos de ${monthLabel(ui.month)}.</p></div>${monthNav()}</div>
    <section class="card stack">${tipCards(sortedRecs())}</section>
    <div><button class="btn" data-action="go" data-view="guia">¿En qué se basan estas reglas?</button></div>`;
}

function viewMetas() {
  const m = ui.month;
  const ef = state.envelopes.find((e) => e.role === 'emergencia');
  const needs = E.needsMonthly(state, m);
  const efTarget = E.emergencyTarget(state, m);
  const efBal = ef ? E.envelopeBalance(state, ef.id) : 0;
  const efMonthly = ef ? E.monthlyTarget(state, ef, m) : 0;
  const goals = state.envelopes.filter((e) => e.goal);
  const inv = state.envelopes.find((e) => e.role === 'inversion');

  const goalCard = (e) => {
    const bal = E.envelopeBalance(state, e.id);
    const target = E.goalTarget(state, e);
    const monthly = E.monthlyTarget(state, e, m);
    const left = E.monthsBetween(m, e.goal.date || m);
    return `<section class="card stack">
      <div class="row between"><h2>${esc(e.icon)} ${esc(e.name)}</h2><button class="icon-btn" data-action="del-env" data-id="${e.id}" aria-label="Eliminar meta" title="Eliminar meta">${sym('trash')}</button></div>
      <div class="row between"><span class="num" style="font-size:1.5rem;font-weight:700">${fmt(bal)}</span><span class="muted">de ${fmt(target)}${isDual() && target ? ` (${fmtCost(e.goal.target)})` : ''}</span></div>
      ${meter(target ? bal / target : 0, { color: `var(--g-${e.group})` })}
      <div class="form-grid">
        <div class="field"><label for="gt-${e.id}">Precio / meta</label>${money(`id="gt-${e.id}" ${envBind(e.id, 'goal.target')}`, e.goal.target || '', '', 'cost')}${isDual() && target ? `<span class="help">${inBase(e.goal.target)}</span>` : ''}</div>
        <div class="field"><label for="gd-${e.id}">Lo quiero para</label><input class="input" type="month" id="gd-${e.id}" value="${esc(e.goal.date)}" ${envBind(e.id, 'goal.date', 'text')}></div>
      </div>
      <p class="small ink-2">${target <= 0 ? 'Escribe el precio para calcular cuánto apartar.' : bal >= target ? '¡Meta lograda! Ya puedes comprarlo sin deudas. 🎉' : `Aparta <strong>${fmt(monthly)}</strong> al mes durante ${left} ${left === 1 ? 'mes' : 'meses'}. El excedente de pagos grandes la adelanta.`}</p>
    </section>`;
  };

  return `<div class="page-head"><div><h1>Metas</h1><p>Ahorra antes de comprar: sin deudas ni intereses.</p></div></div>
    ${ef && !E.emergencyEnabled(state) ? `<section class="card stack">
      <div class="row between"><h2>Fondo de emergencia</h2><span class="badge">En pausa</span></div>
      <p class="sub">No recibe dinero por ahora. Conserva su saldo de ${fmt(efBal)}. Actívalo cuando tus ingresos lo permitan, aunque sea con una meta más pequeña.</p>
      <div><button class="btn primary" data-action="ef-toggle" data-v="1">Activar fondo de emergencia</button></div>
    </section>` : ''}
    ${ef && E.emergencyEnabled(state) ? `<section class="card stack">
      <div class="row between"><h2>Fondo de emergencia</h2><button class="btn sm" data-action="ef-toggle" data-v="0">Pausar…</button></div>
      <p class="sub">Tu seguro contra meses flojos de clientes, enfermedades o imprevistos. Meta: ${state.settings.emergencyMonths} meses de necesidades (${fmt(needs)}/mes).</p>
      <div class="row between"><span class="num" style="font-size:1.5rem;font-weight:700">${fmt(efBal)}</span><span class="muted">de ${fmt(efTarget)}</span></div>
      ${meter(efTarget ? efBal / efTarget : 0, { color: 'var(--g-ahorro)' })}
      <div class="stats">
        <div class="stat"><div class="k">Meses cubiertos</div><div class="v">${needs ? (efBal / needs).toFixed(1) : '0'}</div></div>
        <div class="stat"><div class="k">Aporte del mes</div><div class="v">${fmt(efMonthly)}</div></div>
      </div>
    </section>` : ''}
    ${goals.map(goalCard).join('')}
    <div class="actions">
      <button class="btn" data-action="add-goal">${sym('plus')} Nueva meta</button>
      <button class="btn" data-action="open" data-modal="saldo">${sym('building.columns')} Registrar ahorro existente…</button>
    </div>
    ${inv ? `<section class="card stack"><h2>Inversión a largo plazo</h2><p class="sub">Cuando el fondo de emergencia esté completo, el ahorro extra llega aquí. Consulta opciones de bajo costo (fondos indexados o un plan de retiro) con un asesor de tu país.</p><div class="num" style="font-size:1.5rem;font-weight:700">${fmt(E.envelopeBalance(state, inv.id))}</div></section>` : ''}`;
}

function viewPlan() {
  const m = ui.month;
  const income = E.referenceIncome(state, m);
  const plan = E.monthPlan(state, m);
  const afterTax = income * (1 - num(state.settings.taxPct) / 100);
  const payFirst = income * num(state.settings.payFirstPct) / 100;
  const byG = plan.byGroup;
  const free = afterTax - (plan.total + payFirst);
  const rule = [
    { k: 'Necesidades', v: byG.necesidad || 0, goal: 0.5, max: true, color: 'var(--g-necesidad)' },
    { k: 'Gustos e imagen', v: (byG.gusto || 0) + (byG.profesional || 0), goal: 0.3, max: true, color: 'var(--g-profesional)' },
    { k: 'Ahorro', v: (byG.ahorro || 0) + payFirst, goal: 0.2, max: false, color: 'var(--g-ahorro)' },
  ];

  const editor = GROUP_ORDER.filter((g) => g !== 'impuestos').map((g) => {
    const envs = state.envelopes.filter((e) => e.group === g).sort((a, b) => (a.priority ?? 50) - (b.priority ?? 50));
    return `<div class="group-title"><i class="dot" style="background:var(--g-${g})"></i>${E.GROUPS[g].label}<span class="muted" style="text-transform:none;font-weight:400;letter-spacing:0">— ${E.GROUPS[g].hint}</span></div>
      <div class="env-list">${envs.map((e) => envEditor(e, m)).join('')}</div>`;
  }).join('');

  return `<div class="page-head"><div><h1>Plan mensual</h1><p>Cuánto necesita cada sobre al mes. Cada pago completa primero lo que vence pronto y luego avanza todas las necesidades a la par.</p></div>${monthNav()}</div>
    <section class="card stack">
      <div class="stats">
        <div class="stat"><div class="k">Ingreso de referencia</div><div class="v">${fmt(income)}</div></div>
        <div class="stat"><div class="k">Plan del mes</div><div class="v">${fmt(plan.total + payFirst)}</div></div>
        <div class="stat"><div class="k">${free >= 0 ? 'Margen libre' : 'Te faltan'}</div><div class="v ${free < 0 ? 'warn-ink' : ''}">${fmt(Math.abs(free))}</div></div>
      </div>
      <p class="tiny muted">Ingreso de referencia = promedio de los últimos 3 meses con pagos registrados (o tu estimación en Ajustes si aún no hay historial).</p>
      ${stackBar({ ...byG, ahorro: (byG.ahorro || 0) + payFirst, impuestos: income - afterTax }, Math.max(income, plan.total + payFirst + income - afterTax), free > 0 ? { v: free, label: 'Margen libre', color: 'var(--line)' } : null)}
    </section>

    <section class="card stack">
      <h2>Regla 50/30/20</h2>
      <p class="sub">Sobre tu ingreso después de impuestos (${fmt(afterTax)}): máximo 50% necesidades, 30% gustos, mínimo 20% ahorro.</p>
      ${rule.map((r) => {
        const p = afterTax > 0 ? r.v / afterTax : 0;
        const ok = r.max ? p <= r.goal + 0.001 : p >= r.goal - 0.001;
        return `<div class="stack" style="gap:6px">
          <div class="row between small"><strong>${r.k}</strong><span class="num">${fmt(r.v)} · <strong>${pct(p)}</strong> <span class="${ok ? 'ok-ink' : 'warn-ink'}">${ok ? '✓' : '✗'} ${r.max ? 'máx' : 'mín'} ${pct(r.goal)}</span></span></div>
          ${meter(p, { color: r.color })}
        </div>`;
      }).join('')}
    </section>

    <section class="stack">
      <div class="row between"><h2>Sobres</h2><button class="btn sm" data-action="add-env">${sym('plus')} Agregar sobre</button></div>
      <p class="small ink-2">Las necesidades reciben dinero a la par; con “Se paga el día” un sobre se completa primero cuando su fecha está cerca. Las metas y el fondo de emergencia se calculan solos.</p>
      ${editor}
    </section>`;
}

function envEditor(e, m) {
  const auto = e.role === 'emergencia' || e.goal || (e.role === 'comida' && state.food.linked) || e.role === 'libre' || e.role === 'inversion' || E.isMonthlyList(e);
  const target = E.monthlyTarget(state, e, m);
  const autoText = e.role === 'emergencia' ? 'Automático (fondo de emergencia)'
    : e.goal ? 'Automático (según la meta)'
    : e.role === 'comida' ? 'Automático (pestaña Comida)'
    : E.isMonthlyList(e) ? 'Automático (lista de compra fija)'
    : 'Recibe el excedente';
  return `<div class="env-edit">
    <div class="row" style="align-items:flex-start">
      <input class="input" style="width:40px;text-align:center;padding:0 4px" aria-label="Ícono" value="${esc(e.icon)}" ${envBind(e.id, 'icon', 'text')}>
      <div class="stack" style="flex:1;gap:8px;min-width:0">
        <input class="input" aria-label="Nombre del sobre" value="${esc(e.name)}" ${envBind(e.id, 'name', 'text')}>
        ${auto ? `<div class="small ink-2">${autoText}${target ? `: <strong>${fmt(target)}</strong>/mes` : ''}</div>` : `<div class="row">${money(`aria-label="Monto mensual de ${esc(e.name)}" ${envBind(e.id, 'monthly')}`, e.monthly || '', '', E.envCurrency(state, e))}${isDual() ? `<span class="popup" style="min-width:88px"><select class="input" aria-label="Moneda de ${esc(e.name)}" data-env-currency="${e.id}">${[costCode(), baseCode()].map((c) => `<option ${c === E.envCurrency(state, e) ? 'selected' : ''}>${c}</option>`).join('')}</select></span>` : ''}<span class="small muted" style="white-space:nowrap">/ mes${isDual() && num(e.monthly) && !envIsBase(e) ? ` ${inBase(e.monthly)}` : ''}${Math.abs(target - E.envToBase(state, e, e.monthly)) > 0.005 ? ` · tú: ${fmt(target)}` : ''}</span></div>`}
        ${e.order ? `<div class="row" style="flex-wrap:wrap"><span class="small">Aporte fijo de tu pareja</span>${money(`aria-label="Aporte de tu pareja a ${esc(e.name)}" ${envBind(e.id, 'partnerAmount')}`, e.partnerAmount || '', '', E.envCurrency(state, e))}<button class="btn sm" data-action="go" data-view="pedido">Ver lista…</button></div>` : ''}
        <div class="row" style="flex-wrap:wrap;gap:4px 16px">
          ${e.role ? '' : `<label class="check"><span class="small">Grupo</span><span class="popup"><select class="input" ${envBind(e.id, 'group', 'text')}>${GROUP_ORDER.filter((g) => g !== 'impuestos').map((g) => `<option value="${g}" ${g === e.group ? 'selected' : ''}>${E.GROUPS[g].label}</option>`).join('')}</select></span></label>`}
          ${e.group === 'necesidad' ? `<label class="check"><input type="checkbox" ${e.shared ? 'checked' : ''} ${envBind(e.id, 'shared', 'bool')}>Gasto del hogar</label>` : ''}
          ${e.group === 'necesidad' ? `<label class="check"><input type="checkbox" ${e.pending ? 'checked' : ''} ${envBind(e.id, 'pending', 'bool')}>Aún no contratado</label>` : ''}
          ${e.group === 'necesidad' && !auto ? `<label class="check" title="Si un pago llega en los ${E.DUE_WINDOW_DAYS} días previos a esta fecha, este sobre se completa primero"><span class="small">Se paga el día</span><input class="input" type="number" min="1" max="31" placeholder="—" style="width:56px" value="${e.dueDay ? esc(e.dueDay) : ''}" ${envBind(e.id, 'dueDay')}></label>` : ''}
          ${e.role ? '' : `<button class="btn ghost sm danger" data-action="del-env" data-id="${e.id}">Eliminar</button>`}
        </div>
      </div>
    </div>
  </div>`;
}

function viewComida() {
  const f = state.food;
  const t = E.foodTotals(f);
  const mt = E.mealTotals(f);
  const fromMeals = mt.count > 0 || !f.items.length;
  const tg = f.targets;
  const macros = [
    ['kcal', 'Calorías', 'kcal', 0.03], ['protein', 'Proteína', 'g', 0.03], ['fat', 'Grasas', 'g', 0.05],
    ['carbs', f.netCarbs ? 'Carbohidratos netos' : 'Carbohidratos', 'g', 0.05], ['fiber', 'Fibra', 'g', 0],
  ];
  const cheap = f.items.filter((i) => i.protein >= 5 && num(i.price) > 0)
    .map((i) => ({ name: i.name, cost: (num(i.price) / num(i.priceGrams || 1000)) * 100 / i.protein * 100 }))
    .sort((a, b) => a.cost - b.cost).slice(0, 3);

  return `<div class="page-head"><div><h1>Alimentación</h1><p>Tu plan diario de nutrición convertido en presupuesto de súper.</p></div></div>
    <section class="card stack">
      <h2>Metas diarias de nutrición</h2>
      <p class="sub">${fromMeals ? 'Suma de todas las comidas de tu menú (por persona). Ajusta las porciones hasta que todo quede en ✓.' : 'Ajusta los gramos de cada alimento hasta que todo quede en ✓.'} Las metas se pueden editar.</p>
      ${macros.map(([k, label, unit, tol]) => {
        const src = fromMeals ? mt.day : t;
        const v = k === 'carbs' && f.netCarbs ? src.netCarbs : src[k]; const goal = num(tg[k]);
        const diff = v - goal;
        const ok = k === 'fiber' ? v >= goal : Math.abs(diff) <= goal * tol || (k === 'protein' && diff >= 0 && diff <= goal * 0.08);
        return `<div class="macro">
          <label for="tg-${k}"><strong>${label}</strong> <span class="state ${ok ? 'ok-ink' : 'warn-ink'}">${ok ? '✓ en meta' : diff < 0 ? `faltan ${Math.round(-diff)} ${unit}` : `sobran ${Math.round(diff)} ${unit}`}</span></label>
          <div class="vals num">${Math.round(v)} / <input id="tg-${k}" class="input" style="display:inline-block;width:72px;min-height:30px;padding:2px 6px" type="number" value="${esc(goal)}" aria-label="Meta de ${label}" ${bind(`food.targets.${k}`)}> ${unit}</div>
          ${meter(goal ? v / goal : 0, { color: ok ? 'var(--g-ahorro)' : 'var(--g-profesional)' })}
        </div>`;
      }).join('')}
    </section>

    ${mealPlanner()}

    <section class="card stack">
      <h2>Costo</h2>
      <div class="stats">
        <div class="stat"><div class="k">Por día${t.people > 1 ? ` (${t.people} personas)` : ''}</div><div class="v">${fmtCost(t.dailyCost)}</div>${isDual() ? `<div class="k">${inBase(t.dailyCost)}</div>` : ''}</div>
        <div class="stat"><div class="k">Al mes${t.people > 1 ? ` (${t.people} personas)` : ''}</div><div class="v">${fmtCost(t.monthlyCost)}</div>${isDual() ? `<div class="k">${inBase(t.monthlyCost)}</div>` : ''}</div>
      </div>
      <div class="form-grid">
        <div class="field"><label for="waste">Margen por merma</label>${percent(`id="waste" ${bind('food.wastePct')}`, f.wastePct)}<span class="help">Comida que se daña o sobra. 10% es razonable.</span></div>
        <div class="field"><label for="extra">Extras al mes</label>${money(`id="extra" ${bind('food.extraMonthly')}`, f.extraMonthly, '', 'cost')}<span class="help">Condimentos, café, salsas.</span></div>
      </div>
      <div class="form-grid">
        <div class="field"><label for="people">Personas que comen este menú</label><input id="people" class="input" type="number" inputmode="numeric" min="1" max="10" step="1" value="${esc(t.people)}" ${bind('food.people')}><span class="help">Los gramos del menú son por persona; la compra y el costo se multiplican.</span></div>
      </div>
      <label class="check switch-row"><span>Contar carbohidratos netos (sin fibra)</span><input type="checkbox" switch ${f.netCarbs ? 'checked' : ''} ${bind('food.netCarbs', 'bool')}></label>
      ${E.isMonthlyList(foodEnvelope() || {}) ? '<p class="small ink-2">El presupuesto del sobre “Alimentación” lo define tu lista de compras de alimentación (abajo).</p>' : `<label class="check switch-row"><span>Usar este costo como presupuesto del sobre “Alimentación”</span><input type="checkbox" switch ${f.linked ? 'checked' : ''} ${bind('food.linked', 'bool')}></label>`}
      ${cheap.length ? `<div class="tipcard info"><span class="ic">${sym('lightbulb')}</span><div><strong>Tu proteína más barata</strong><p>${cheap.map((c) => `${esc(c.name)}: ${fmtCost(c.cost)} por cada 100 g de proteína`).join(' · ')}. Comprar estos en cantidad es donde más ahorras.</p></div></div>` : ''}
    </section>

    ${f.items.length ? `<section class="card stack">
      <div class="row between"><h2>Menú del día</h2><button class="btn sm" data-action="open" data-modal="alimento">${sym('plus')} Agregar alimento…</button></div>
      <p class="sub">Elige cómo se vende cada producto y escribe su precio. La compra se redondea hacia arriba para una semana${t.people > 1 ? ` y ${t.people} personas` : ''}. Toca el nombre de un producto para cambiar cuánto trae su pieza o paquete.</p>
      <div class="table-wrap"><table class="table card-table food-table">
        <thead><tr><th>Alimento</th><th class="r">g/día${t.people > 1 ? ' por persona' : ''}</th><th class="r">Compra/semana</th><th>Se vende por</th><th class="r">Precio${isDual() ? ` (${costCode()})` : ''}</th><th class="r">Costo/semana</th><th></th></tr></thead>
        <tbody>${f.items.map((it, i) => `<tr>
          <td class="c-name"><button class="btn link food-name" data-action="open" data-modal="alimento" data-index="${i}" title="Editar ${esc(it.name)}">${esc(it.name)}</button><div class="tiny muted">${Math.round(it.protein * it.grams / 100)} g prot · ${Math.round(it.kcal * it.grams / 100)} kcal</div></td>
          <td class="r c-qty" data-label="g/día"><input class="input num" style="width:64px" type="number" inputmode="decimal" min="0" value="${esc(it.grams)}" aria-label="Gramos al día de ${esc(it.name)}" data-food="${i}" data-field="grams" data-k="f:${i}:g"></td>
          <td class="r num c-buy" data-label="Compra/semana">${purchase(it, t.people, i)}</td>
          <td class="c-type"><span class="popup" style="min-width:126px"><select class="input" aria-label="Cómo se vende ${esc(it.name)}" data-food="${i}" data-field="priceUnit" data-type="text" data-k="f:${i}:u">${PRICE_UNITS.map((u) => `<option value="${u}" ${u === it.priceUnit ? 'selected' : ''}>${UNIT_NAMES[u].por}</option>`).join('')}</select></span></td>
          <td class="r c-price" data-label="Precio"><input class="input num" style="width:76px" type="number" inputmode="decimal" min="0" step="0.01" value="${num(it.price) ? esc(it.price) : ''}" placeholder="—" aria-label="Precio de ${esc(it.name)} ${UNIT_NAMES[it.priceUnit].por}" data-food="${i}" data-field="price" data-k="f:${i}:p"></td>
          <td class="r num c-sub" data-label="Costo/semana">${E.weeklyCost(it, t.people) ? fmtCost(E.weeklyCost(it, t.people)) : '<span class="muted">—</span>'}</td>
          <td class="c-del"><button class="icon-btn" data-action="del-food" data-i="${i}" aria-label="Quitar ${esc(it.name)}" title="Quitar">${sym('trash')}</button></td>
        </tr>`).join('')}</tbody>
      </table></div>
      <p class="tiny muted">Valores nutricionales aproximados por 100 g en crudo (base USDA). Tu app de nutrición sigue siendo la referencia exacta.</p>
    </section>` : ''}
    ${foodListSection()}`;
}

// ---------- Menú por comidas ----------
const MEAL_NAMES = { desayuno: 'Desayuno', merienda: 'Merienda', almuerzo: 'Almuerzo', preentreno: 'Preentreno', cena: 'Cena' };
const foodProducts = () => foodEnvelope()?.order?.items || [];
const macroLine = (n) => `${Math.round(n.kcal)} kcal · ${Math.round(n.protein)} g prot · ${Math.round(n.fat)} g grasa · ${Math.round(n.carbs)} g carbs`;

function mealPlanner() {
  const f = state.food;
  const products = foodProducts();
  if (!products.length) {
    return `<section class="card stack"><h2>Menú por comidas</h2>
      <p class="sub">Primero agrega los productos que compras a tu lista de compras de alimentación (abajo); luego arma aquí el desayuno, la merienda, el almuerzo, el preentreno y la cena con porciones de esos productos.</p></section>`;
  }
  const mt = E.mealTotals(f);
  const goalKcal = num(f.targets.kcal);
  const cards = E.MEALS.map((m) => {
    const entries = (f.meals || {})[m] || [];
    const tot = mt.meals[m];
    const share = goalKcal ? Math.round((tot.kcal / goalKcal) * 100) : 0;
    const rows = entries.map((e, i) => {
      const p = products.find((x) => x.id === e.productId);
      const n = (f.nutrition || {})[e.productId];
      const g = E.portionGrams(f, e);
      const units = n && num(n.pieceGrams) ? ['g', 'pza'] : ['g'];
      return `<div class="portion">
        <button class="btn link portion-name" data-action="open" data-modal="nutricion" data-product="${e.productId}" title="Datos nutricionales">${esc(p ? p.name : 'Producto eliminado')}</button>
        <div class="portion-amount"><input class="input num" type="number" inputmode="decimal" min="0" step="any" value="${esc(e.amount)}" aria-label="Cantidad" data-meal="${m}" data-meal-i="${i}" data-field="amount" data-k="m:${m}:${i}:a">
          <span class="popup" style="min-width:76px"><select class="input" aria-label="Unidad" data-meal="${m}" data-meal-i="${i}" data-field="unit" data-k="m:${m}:${i}:u">${units.map((u) => `<option value="${u}" ${(e.unit || 'g') === u ? 'selected' : ''}>${u === 'g' ? 'g' : 'pzas'}</option>`).join('')}</select></span></div>
        <div class="tiny muted portion-macros">${n ? `${e.unit === 'pza' ? `${Math.round(g)} g · ` : ''}${Math.round(n.kcal * g / 100)} kcal · ${Math.round(n.protein * g / 100)} g prot` : '<span class="warn-ink">Faltan datos nutricionales</span>'}</div>
        <button class="icon-btn portion-del" data-action="del-portion" data-meal="${m}" data-i="${i}" aria-label="Quitar" title="Quitar">${sym('trash')}</button>
      </div>`;
    }).join('');
    return `<div class="meal-card">
      <div class="row between" style="flex-wrap:wrap"><h3>${MEAL_NAMES[m]}</h3><span class="small ink-2">${entries.length ? `${macroLine(tot)} · <strong>${share}% del día</strong>` : 'Sin alimentos'}</span></div>
      ${rows}
      <div><button class="btn sm" data-action="open" data-modal="porcion" data-meal="${m}">${sym('plus')} Agregar a ${MEAL_NAMES[m].toLowerCase()}…</button></div>
    </div>`;
  }).join('');
  const check = E.consumptionCheck(f, products);
  const statusText = { 'de-mas': ['warn-ink', 'Compras de más'], falta: ['warn-ink', 'No alcanza'], bien: ['ok-ink', '✓ Justo'], 'sin-dato': ['muted', 'Falta cuánto trae'] };
  const qtyText = (g, c) => (c.pieceGrams ? `${Math.round(g / c.pieceGrams)} pzas` : g >= 1000 ? `${Math.round(g / 100) / 10} kg` : `${g} g`);
  return `<section class="card stack">
      <h2>Menú por comidas</h2>
      <p class="sub">Porciones por persona. Toca un producto para ver o cambiar sus datos nutricionales.</p>
      <div class="stack" style="gap:10px">${cards}</div>
      <div class="small"><strong>Total del día:</strong> ${macroLine(mt.day)} · fibra ${Math.round(mt.day.fiber)} g</div>
    </section>
    ${check.length ? `<section class="card stack">
      <h2>¿Compras lo que comes?</h2>
      <p class="sub">Lo que comen en una semana (${num(f.people) || 1} ${num(f.people) === 1 ? 'persona' : 'personas'}) contra lo que compras por semana.</p>
      <div class="table-wrap"><table class="table check-table">
        <thead><tr><th>Producto</th><th class="r">Comen/sem</th><th class="r">Compras/sem</th><th class="r">Estado</th></tr></thead>
        <tbody>${check.map((c) => `<tr><td class="c-name">${esc(c.name)}</td><td class="r num" data-label="Comen/sem">${qtyText(c.eatWeek, c)}</td><td class="r num" data-label="Compras/sem">${c.buyWeek == null ? '—' : qtyText(c.buyWeek, c)}</td><td class="r c-state ${statusText[c.status][0]}">${c.status === 'sin-dato' ? `<button class="btn link sm" data-action="open" data-modal="nutricion" data-product="${c.id}">Falta cuánto trae…</button>` : statusText[c.status][1]}</td></tr>`).join('')}</tbody>
      </table></div>
    </section>` : ''}`;
}

// Lista de compras de alimentación (las mismas funciones que Listas de compra).
function foodListSection() {
  const env = foodEnvelope();
  if (!env) return '';
  if (!env.order) {
    return `<section class="card stack">
      <h2>Compras de alimentación</h2>
      <p class="sub">Una lista de compras propia para la comida, con productos semanales, quincenales, mensuales y ocasionales, como la del hogar. También puedes mover productos desde otra lista con “Mover marcados…”.</p>
      <div><button class="btn primary" data-action="create-food-list">${sym('plus')} Crear lista de alimentación</button></div>
    </section>`;
  }
  return `<div class="page-head" style="margin-top:12px"><div><h1 style="font-size:22px;line-height:26px">Compras de alimentación</h1><p>${esc(env.icon)} ${esc(env.name)}${env.order.store ? ` · ${esc(env.order.store)}` : ''}</p></div></div>
    ${viewPedido(env)}`;
}

// Cómo se vende cada alimento: por kg o litro (precio de 1000 g/ml), por pieza (con su peso) o por paquete (con su contenido).
const UNIT_NAMES = {
  kg: { por: 'por kg', one: 'kg', many: 'kg' },
  litro: { por: 'por litro', one: 'L', many: 'L' },
  pieza: { por: 'por pieza', one: 'pieza', many: 'piezas' },
  paquete: { por: 'por paquete', one: 'paquete', many: 'paquetes' },
  monto: { por: 'por monto ($)', one: 'vez', many: 'veces' },
};
const isWeighed = (it) => it.priceUnit === 'kg' || it.priceUnit === 'litro';

// Compra de la semana en unidades redondeadas (½ kg, 3 paquetes, 42 piezas, 1 L cada 7 semanas).
function purchase(it, people, index) {
  const p = E.weeklyPurchase(it, people);
  if (!p) return `<button class="btn link" data-action="open" data-modal="alimento" data-index="${index}">${it.priceUnit === 'monto' ? 'Falta cuántas veces…' : 'Falta cuánto trae…'}</button>`;
  if (!p.amount) return '<span class="muted">—</span>';
  if (it.priceUnit === 'monto') {
    const each = num(it.price) ? ` de ${fmtCost(it.price)}` : '';
    return p.everyWeeks > 1 ? `1${each} <span class="muted">cada ${p.everyWeeks} semanas</span>` : `${p.amount} ${p.amount === 1 ? 'vez' : 'veces'}${each}`;
  }
  const names = UNIT_NAMES[it.priceUnit];
  const amount = p.amount === 0.5 ? '½' : String(p.amount).replace(/\.5$/, '½').replace(/^0½$/, '½');
  const text = `${amount} ${p.amount <= 1 ? names.one : names.many}`;
  return p.everyWeeks > 1 ? `${text} <span class="muted">cada ${p.everyWeeks} semanas</span>` : text;
}

// ---------- Listas de compra ----------
// Cada lista vive en un sobre (`env.order`): productos habituales con precio y veces comprado. En cada compra
// se marcan los que se llevan, se suma el envío (si hay) y se registra como gasto (tu parte, si tu pareja aporta).

// La lista de Alimentación vive en su pestaña; las demás en Listas de compra.
const foodEnvelope = () => state.envelopes.find((e) => e.role === 'comida');
const orderLists = () => state.envelopes.filter((e) => e.order && e.role !== 'comida');
const currentOrder = () => {
  if (ui.view === 'comida') { const f = foodEnvelope(); return f && f.order ? f : null; }
  return orderLists().find((e) => e.id === ui.orderId) || orderLists()[0];
};

// Tarjeta "Esta semana puedes gastar" de una lista fija (solo en el mes actual).
function weeklyCard(env, compact = false) {
  const today = E.todayISO();
  if (ui.month !== today.slice(0, 7)) return '';
  const cur = E.envCurrency(state, env);
  const w = E.weeklyAllowance(state, env, today);
  if (!w.budget) return '';
  const over = w.canSpend < 0;
  return `<section class="card stack">
      <div class="row between" style="flex-wrap:wrap"><h2>${esc(env.icon)} ${esc(env.name)} · semana ${w.week} de ${w.weeks}</h2>${compact ? `<button class="btn link sm" data-action="go-list" data-id="${env.id}">Ver lista</button>` : ''}</div>
      <div><div class="small ink-2">${over ? 'Esta semana te pasaste por' : 'Esta semana puedes gastar'}</div><div class="num ${over ? 'warn-ink' : ''}" style="font-size:22px;line-height:28px;font-weight:700">${fmtIn(Math.abs(w.canSpend), cur)}</div></div>
      ${meter(w.forWeek ? w.spentWeek / w.forWeek : w.spentWeek ? 1 : 0, { color: over ? 'var(--red)' : 'var(--g-necesidad)' })}
      <div class="tiny ink-2">${E.isMonthlyList(env)
        ? `Gastado esta semana ${fmtIn(w.spentWeek, cur)} de ${fmtIn(w.forWeek, cur)} (${fmtIn(w.perWeek, cur)} de semanales + ${fmtIn(w.forWeek - w.perWeek, cur)} de margen) · margen restante del mes ${fmtIn(w.occasionalLeft, cur)}`
        : `Gastado esta semana ${fmtIn(w.spentWeek, cur)} de ${fmtIn(w.forWeek, cur)} · quedan ${fmtIn(w.leftMonth, cur)} del mes para ${w.weeksLeft} ${w.weeksLeft === 1 ? 'semana' : 'semanas'}`}</div>
      ${E.isMonthlyList(env) ? monthlyStatus(env, cur) : ''}
      <div class="row" style="flex-wrap:wrap"><button class="btn sm" data-action="open" data-modal="gasto" data-env="${env.id}">${sym('minus')} Gasto ocasional…</button>${compact ? pendingNote(env) : ''}</div>
    </section>`;
}
const weeklyCards = () => state.envelopes.filter(E.isMonthlyList).map((e) => weeklyCard(e, true)).join('');

const FREQ_NAMES = { semanal: 'Semanal', quincenal: 'Quincenal', mensual: 'Mensual', ocasional: 'Ocasional' };
const FREQ_PERIOD = { semanal: 'esta semana', quincenal: 'esta quincena', mensual: 'este mes' };
const FREQ_QTY = { semanal: 'por semana', quincenal: 'por quincena', mensual: 'por mes', ocasional: 'por compra' };

// Filas de la lista; en una compra fija se agrupan por frecuencia con un encabezado por grupo.
function orderRows(o, row) {
  const indexed = o.items.map((it, i) => ({ it, i }));
  if (!o.monthly) return indexed.map(({ it, i }) => row(it, i)).join('');
  const cols = 7 + (o.items.some((x) => num(x.times) > 0) ? 1 : 0);
  const today = E.todayISO();
  return E.FREQUENCIES.map((f) => {
    const group = indexed.filter(({ it }) => E.itemFrequency(it) === f);
    if (!group.length) return '';
    const done = group.filter(({ it }) => E.isBought(it, today)).length;
    const cost = group.reduce((s, { it }) => s + num(it.price) * num(it.qty), 0);
    const note = f === 'ocasional' ? ' · los cubre el margen' : ` · ${fmtIn(cost, E.envCurrency(state, currentOrder()))} ${FREQ_QTY[f]} · ${done} de ${group.length} comprados ${FREQ_PERIOD[f]}`;
    return `<tr class="group-row"><td colspan="${cols}">${FREQ_NAMES[f]}es${note}</td></tr>${group.map(({ it, i }) => row(it, i)).join('')}`;
  }).join('');
}

// Barra fija al inicio de los productos: lo marcado contra el dinero disponible ahora en el sobre.
function selectionBar(env, r, cur) {
  if (!r.items && !r.missingPrices) return '';
  const available = E.envToBase(state, env, 1) ? E.envelopeBalance(state, env.id) / E.envToBase(state, env, 1) : 0; // en la moneda del sobre
  const left = Math.round((available - r.mine) * 100) / 100;
  const over = left < -0.005;
  return `<div class="selection-bar ${over ? 'over' : 'ok'}" role="status">
      <div><span class="k">Marcados (${r.items})</span><strong class="num">${fmtIn(r.mine, cur)}</strong>${r.partner ? `<span class="tiny muted"> tu parte</span>` : ''}</div>
      <div><span class="k">Disponible</span><strong class="num">${fmtIn(available, cur)}</strong></div>
      <div><span class="k">${over ? 'Te excedes' : 'Te quedan'}</span><strong class="num">${fmtIn(Math.abs(left), cur)}</strong></div>
      ${r.missingPrices ? `<div class="tiny muted" style="grid-column:1/-1">${r.missingPrices} marcado${r.missingPrices === 1 ? '' : 's'} sin precio no se suma${r.missingPrices === 1 ? '' : 'n'}.</div>` : ''}
    </div>`;
}

// Etiqueta de estado debajo del nombre: comprado (con fecha) o última compra de un ocasional.
function boughtTag(it, i) {
  if (!it.lastBought) return '';
  const when = dateLabel(it.lastBought);
  if (E.isBought(it, E.todayISO())) return `<div class="bought-tag">✓ Comprado el ${when} <button class="btn link sm" data-action="order-unbuy" data-i="${i}">Quitar</button></div>`;
  return `<div class="tiny muted">Última compra: ${when}</div>`;
}

// Estado de las compras quincenal y mensual: hechas o cuánto falta.
function monthlyStatus(env, cur) {
  const today = E.todayISO();
  return [['quincenal', 'de la quincena'], ['mensual', 'del mes']].map(([f, label]) => {
    const items = env.order.items.filter((it) => E.itemFrequency(it) === f);
    if (!items.length) return '';
    const pending = items.filter((it) => !E.isBought(it, today));
    if (!pending.length) return `<div class="small ok-ink">✓ Compra ${label} hecha</div>`;
    const cost = pending.reduce((s, it) => s + num(it.price) * num(it.qty), 0);
    return `<div class="small ink-2">Compra ${label} pendiente: <strong>${fmtIn(cost, cur)}</strong> (${pending.length} ${pending.length === 1 ? 'producto' : 'productos'})</div>`;
  }).join('');
}

// Resumen de pendientes para la tarjeta de Inicio.
function pendingNote(env) {
  const today = E.todayISO();
  const count = (f) => env.order.items.filter((it) => E.itemFrequency(it) === f && !E.isBought(it, today)).length;
  const parts = [['semanal', 'semanales'], ['quincenal', 'quincenales'], ['mensual', 'mensuales']].map(([f, n]) => (count(f) ? `${count(f)} ${n}` : '')).filter(Boolean);
  if (!parts.length) return '<span class="small ink-2">Todo comprado ✓</span>';
  return `<span class="small ink-2">Pendientes: ${parts.join(' · ')}</span>`;
}

// `embedded`: la lista se muestra dentro de otra pestaña (Alimentación), sin título ni selector.
function viewPedido(embedded = null) {
  const env = embedded || currentOrder();
  const lists = orderLists();
  const switcher = `<div class="row" style="flex-wrap:wrap">
      ${lists.length > 1 ? `<div class="segmented" role="radiogroup" aria-label="Lista">${lists.map((l) => `<label><input type="radio" name="olist" value="${l.id}" ${l.id === env?.id ? 'checked' : ''} data-order-list><span>${esc(l.icon)} ${esc(l.name)}</span></label>`).join('')}</div>` : ''}
      <button class="btn sm" data-action="open" data-modal="nueva-lista">${sym('plus')} Nueva lista…</button>
    </div>`;
  if (!env) {
    return `<div class="page-head"><div><h1>Listas de compra</h1><p>Tus compras habituales: súper, pedidos a tu familia…</p></div></div>
      <section class="card stack">
        <h2>Crea tu primera lista</h2>
        <p class="sub">Guarda los productos que compras seguido con su precio. En cada compra marcas qué llevar, la app suma el total, te dice si cabe en el presupuesto y lo registra como gasto.</p>
        <div><button class="btn primary" data-action="open" data-modal="nueva-lista">${sym('plus')} Nueva lista…</button></div>
      </section>`;
  }
  const hasTimes = env.order.items.some((it) => num(it.times) > 0);
  const o = env.order;
  const cur = E.envCurrency(state, env);
  const r = E.orderSummary(env);
  const m = ui.month;
  const history = state.expenses.filter((x) => x.envId === env.id && x.order).sort((a, b) => b.date.localeCompare(a.date));
  const lastThree = history.slice(0, 3);
  const avg = lastThree.length ? lastThree.reduce((s, x) => s + num(x.order.total), 0) / lastThree.length : 0;
  const status = !r.total ? null
    : r.diff >= 0 ? { level: 'good', icon: 'checkmark.circle.fill', title: `Cabe en el presupuesto: sobran ${fmtIn(r.diff, cur)}`, text: `Presupuesto del mes: ${fmtIn(r.budget, cur)}.` }
    : { level: 'warning', icon: 'exclamationmark.triangle.fill', title: `Te pasas por ${fmtIn(-r.diff, cur)}`, text: `Presupuesto del mes: ${fmtIn(r.budget, cur)}. Quita algún producto o mueve dinero de otro sobre.` };

  return `${embedded ? '' : `<div class="page-head"><div><h1>${esc(env.name)}</h1><p>${esc(env.icon)} Lista de compra${o.store ? ` · ${esc(o.store)}` : ''}</p></div></div>
    ${switcher}`}

    <section class="card stack">
      <h2>Presupuesto</h2>
      <label class="check switch-row"><span><strong>Compra fija mensual</strong><span class="small ink-2" style="display:block">Los mismos productos cada mes (cantidades para un mes) más un margen para compras ocasionales.</span></span><input type="checkbox" switch ${o.monthly ? 'checked' : ''} data-order="monthly" data-k="o:monthly"></label>
      ${o.monthly ? (() => {
        const b = E.monthlyListBudget(env);
        return `<div class="form-grid">
          <div class="field"><span class="label">Compras fijas al mes</span><div class="num" style="font-size:17px;font-weight:600;line-height:24px">${fmtIn(b.fixed, cur)}</div><span class="help">Semanales ${fmtIn(b.perWeek, cur)} × ${Math.round(E.WEEKS_PER_MONTH * 100) / 100} semanas + quincenales ${fmtIn(b.perFortnight, cur)} × 2 + mensuales ${fmtIn(b.monthly, cur)}.</span></div>
          <div class="field"><label for="o-occ">Margen para ocasionales al mes</label>${money(`id="o-occ" data-order="occasionalBudget" data-k="o:occ"`, o.occasionalBudget || '', '', cur)}<span class="help">Para lo que surge: un antojo, algo que se acabó antes.</span></div>
          <div class="field"><span class="label">Presupuesto del mes</span><div class="num" style="font-size:17px;font-weight:600;line-height:24px">${fmtIn(b.total, cur)}</div><span class="help">Cada semana: ${fmtIn(b.perWeek, cur)} de semanales más tu parte del margen.</span></div>
        </div>`;
      })() : ''}
      <div class="form-grid">
        ${o.monthly ? '' : `<div class="field"><label for="o-budget">Presupuesto mensual</label>${money(`id="o-budget" ${envBind(env.id, 'monthly')}`, env.monthly || '', '', cur)}<span class="help">Lo que suelen gastar al mes en esta lista${o.shipping ? ', con envío' : ''}.</span></div>`}
        <div class="field"><label for="o-partner">Aporte fijo de tu pareja (opcional)</label>${money(`id="o-partner" ${envBind(env.id, 'partnerAmount')}`, env.partnerAmount || '', '', cur)}<span class="help">Tu sobre solo aparta el resto.</span></div>
        <div class="field"><label for="o-store">Tienda</label><input id="o-store" class="input" value="${esc(o.store || '')}" placeholder="Nombre de la tienda" data-order="store" data-k="o:store"></div>
      </div>
      <div class="stats">
        <div class="stat"><div class="k">Tu parte al mes</div><div class="v">${fmt(E.monthlyTarget(state, env, m))}</div></div>
        <div class="stat"><div class="k">Disponible en el sobre</div><div class="v">${fmt(E.envelopeBalance(state, env.id))}</div></div>
      </div>
    </section>
    ${o.monthly ? weeklyCard(env) : ''}

    <section class="card stack">
      <div class="row between"><h2>Productos habituales</h2><button class="btn sm" data-action="open" data-modal="producto">${sym('plus')} Agregar producto…</button></div>
      ${selectionBar(env, r, cur)}
      <p class="sub">Marca lo que llevan en esta compra y ajusta las cantidades. Los precios se guardan para la siguiente.</p>
      ${hasTimes ? `<div class="row" style="flex-wrap:wrap"><span class="small">Quitar los comprados menos de</span><span class="popup" style="min-width:72px"><select class="input" aria-label="Veces" id="o-min">${[2, 3, 4, 5].map((n) => `<option ${n === 3 ? 'selected' : ''}>${n}</option>`).join('')}</select></span><span class="small">veces</span><button class="btn sm" data-action="order-prune">Quitar…</button></div>` : ''}
      ${o.items.length ? `<div class="table-wrap"><table class="table card-table list-table">
        <thead><tr><th></th><th>Producto</th>${hasTimes ? '<th class="r">Veces</th>' : ''}${o.monthly ? '<th>Tipo</th>' : ''}<th class="r">Precio (${cur})</th><th class="r" ${o.monthly ? 'title="Semanal: por semana · Quincenal: por quincena · Mensual: por mes"' : ''}>Cantidad</th><th class="r">Subtotal</th><th></th></tr></thead>
        <tbody>${orderRows(o, (it, i) => `<tr class="${o.monthly && E.isBought(it, E.todayISO()) ? 'bought' : ''}">
          <td class="check-cell c-check"><input type="checkbox" ${it.selected ? 'checked' : ''} aria-label="Llevar ${esc(it.name)}" data-order-item="${i}" data-field="selected" data-k="oi:${i}:s"></td>
          <td class="c-name"><input class="input" value="${esc(it.name)}" aria-label="Nombre del producto" data-order-item="${i}" data-field="name" data-k="oi:${i}:n">${o.monthly ? boughtTag(it, i) : ''}</td>
          ${hasTimes ? `<td class="r num muted c-times" data-label="Veces">${num(it.times) ? `${it.times}${it.timesPlus ? '+' : ''}` : '—'}</td>` : ''}
          ${o.monthly ? `<td class="c-type"><span class="popup" style="min-width:116px"><select class="input" aria-label="Tipo de ${esc(it.name)}" data-order-item="${i}" data-field="frequency" data-k="oi:${i}:o">${E.FREQUENCIES.map((f) => `<option value="${f}" ${E.itemFrequency(it) === f ? 'selected' : ''}>${FREQ_NAMES[f]}</option>`).join('')}</select></span></td>` : ''}
          <td class="r c-price" data-label="Precio"><input class="input num" style="width:84px" type="number" inputmode="decimal" min="0" step="0.01" value="${num(it.price) ? esc(it.price) : ''}" placeholder="—" aria-label="Precio de ${esc(it.name)}" data-order-item="${i}" data-field="price" data-k="oi:${i}:p"></td>
          <td class="r c-qty" data-label="Cantidad"><input class="input num" style="width:64px" type="number" inputmode="decimal" min="0" step="any" value="${esc(it.qty)}" aria-label="Cantidad de ${esc(it.name)}" data-order-item="${i}" data-field="qty" data-k="oi:${i}:q"></td>
          <td class="r num c-sub ${it.selected ? '' : 'muted'}" data-label="Subtotal">${num(it.price) ? fmtIn(num(it.price) * num(it.qty), cur) : '—'}</td>
          <td class="c-del"><button class="icon-btn" data-action="del-order-item" data-i="${i}" aria-label="Quitar ${esc(it.name)}" title="Quitar">${sym('trash')}</button></td>
        </tr>`)}</tbody>
      </table></div>
      <div class="row" style="flex-wrap:wrap">${o.monthly ? '<button class="btn sm" data-action="order-mark" data-v="semanal">Marcar semanales de esta semana</button><button class="btn sm" data-action="order-mark" data-v="quincenal">Marcar quincenales pendientes</button><button class="btn sm" data-action="order-mark" data-v="mensual">Marcar mensuales pendientes</button>' : ''}<button class="btn sm" data-action="order-mark" data-v="1">Marcar todo</button><button class="btn sm" data-action="order-mark" data-v="0">Desmarcar todo</button><button class="btn sm" data-action="open" data-modal="mover-lista" ${o.items.some((it) => it.selected) ? '' : 'disabled'} title="Mueve los productos marcados a otra lista">${sym('arrow.left.arrow.right')} Mover marcados…</button></div>` : '<p class="muted">Aún no hay productos. Agrega los que más suelen necesitar.</p>'}
    </section>

    <section class="card stack">
      <h2>Esta compra</h2>
      <div class="field" style="max-width:240px"><label for="o-ship">Envío (si aplica)</label>${money(`id="o-ship" data-order="shipping" data-k="o:ship"`, o.shipping || '', '', cur)}</div>
      <div>
        <div class="step-line"><span>Productos (${r.units} en ${r.items} ${r.items === 1 ? 'renglón' : 'renglones'})</span><span class="num">${fmtIn(r.products, cur)}</span></div>
        <div class="step-line"><span>Envío</span><span class="num">${fmtIn(r.shipping, cur)}</span></div>
        <div class="step-line"><strong>Total</strong><strong class="num">${fmtIn(r.total, cur)}</strong></div>
        <div class="step-line"><span>Aporte de tu pareja</span><span class="num">−${fmtIn(r.partner, cur)}</span></div>
        <div class="step-line"><strong>Tu parte</strong><strong class="num">${fmtIn(r.mine, cur)}</strong></div>
      </div>
      ${status ? `<div class="tipcard ${status.level}"><span class="ic">${sym(status.icon)}</span><div><strong>${status.title}</strong><p>${status.text}</p></div></div>` : ''}
      ${r.missingPrices ? `<div class="tipcard info"><span class="ic">${sym('info.circle.fill')}</span><div><strong>${r.missingPrices} ${r.missingPrices === 1 ? 'producto marcado sin precio' : 'productos marcados sin precio'}</strong><p>No se suman al total hasta que les pongas precio.</p></div></div>` : ''}
      <div><button class="btn primary" data-action="save-order" ${r.total > 0 ? '' : 'disabled'}>Registrar compra…</button></div>
    </section>

    <section class="card stack">
      <h2>Compras anteriores</h2>
      ${history.length ? `<div>${history.slice(0, 12).map((x) => `<div class="mov"><div><strong>${dateLabel(x.date)}</strong><div class="meta">${x.order.units} productos · total ${fmtIn(x.order.total, x.order.currency || cur)}${x.order.partner ? ` · tu pareja ${fmtIn(x.order.partner, x.order.currency || cur)}` : ''}</div></div><div class="amt num">−${fmt(x.amount)}</div></div>`).join('')}</div>
        <div class="row between" style="flex-wrap:wrap"><span class="small ink-2">${lastThree.length === 1 ? 'Última compra' : `Promedio de las últimas ${lastThree.length} compras`}: <strong>${fmtIn(avg, cur)}</strong></span>${Math.abs(avg - num(env.monthly)) > 1 ? `<button class="btn sm" data-action="order-use-avg">Usar ${lastThree.length === 1 ? 'ese monto' : 'el promedio'} como presupuesto</button>` : ''}</div>`
      : '<p class="muted">Cuando registres tu primera compra aparecerá aquí.</p>'}
    </section>`;
}

// Campos de precio de la hoja de alimento: solo los que aplican a la forma de compra elegida.
function foodPriceFields(d) {
  const price = (label, help = 'Puedes dejarlo vacío y ponerlo después.') =>
    `<div class="field"><label for="a-price">${label}</label>${money('id="a-price" data-draft="price"', d.price, '', 'cost')}<span class="help">${help}</span></div>`;
  const number = (key, label, help, attrs = 'min="1" step="any"') =>
    `<div class="field"><label for="a-${key}">${label}</label><input id="a-${key}" class="input" type="number" inputmode="decimal" ${attrs} data-draft="${key}" value="${esc(d[key])}"><span class="help">${help}</span></div>`;
  switch (d.priceUnit) {
    case 'pieza': return price('Precio de una pieza') + number('priceGrams', 'Peso aproximado de una pieza (g)', 'No tiene que ser exacto: un huevo ≈ 50 g, un plátano ≈ 120 g. Sirve para saber cuántas comprar.');
    case 'paquete': return price('Precio del paquete') + number('priceGrams', 'Contenido del paquete (g o ml)', 'Viene en la etiqueta: bolsa de pan 680 g, cartón de leche 1000 ml.');
    case 'monto': return price('¿Cuánto pides cada vez?', 'Lo que pagas, p. ej. “deme $200 de pechuga”.') + number('perWeek', '¿Cuántas veces por semana?', 'Si es cada 2 semanas, escribe 0.5.', 'min="0.1" step="0.5"');
    case 'litro': return price('Precio por litro');
    default: return price('Precio por kg');
  }
}

// Buscador de alimentos: coincide en cualquier parte del nombre, sin acentos ni mayúsculas.
const fold = (t) => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
function searchProducts(query) {
  const words = fold(query).split(/\s+/).filter(Boolean);
  const products = foodProducts();
  if (!words.length) return products;
  return products
    .map((p) => ({ p, name: fold(p.name) }))
    .filter(({ name }) => words.every((w) => name.includes(w)))
    .sort((a, b) => (a.name.startsWith(words[0]) ? 0 : 1) - (b.name.startsWith(words[0]) ? 0 : 1))
    .map(({ p }) => p);
}
function productResults(query) {
  const found = searchProducts(query);
  if (!found.length) return '<p class="small muted" style="padding:8px 4px">Sin resultados. Agrega el producto a tu lista de compras de alimentación.</p>';
  return found.map((p, i) => {
    const n = (state.food.nutrition || {})[p.id];
    return `<button class="search-item ${i === 0 && query ? 'first' : ''}" role="option" data-action="pick-product" data-id="${p.id}"><span>${esc(p.name)}</span><span class="tiny muted">${n ? `${Math.round(n.kcal)} kcal · ${Math.round(n.protein)} g prot /100 g` : 'sin datos nutricionales'}</span></button>`;
  }).join('');
}

// Datos nutricionales de un producto (por 100 g), peso de una pieza y contenido de cada unidad comprada.
const NUTRITION_FIELDS = [['kcal', 'Calorías'], ['protein', 'Proteína (g)'], ['fat', 'Grasa (g)'], ['carbs', 'Carbohidratos (g)'], ['fiber', 'Fibra (g)']];
function nutritionDraft(productId) {
  const n = (state.food.nutrition || {})[productId] || {};
  return { n_kcal: n.kcal ?? '', n_protein: n.protein ?? '', n_fat: n.fat ?? '', n_carbs: n.carbs ?? '', n_fiber: n.fiber ?? '', n_pieceGrams: n.pieceGrams || '', n_packGrams: n.packGrams || '' };
}
function nutritionFields(d) {
  const field = (k, label, help = '') => `<div class="field"><label for="nf-${k}">${label}</label><input id="nf-${k}" class="input" type="number" inputmode="decimal" min="0" step="any" data-draft="n_${k}" value="${esc(d[`n_${k}`])}">${help ? `<span class="help">${help}</span>` : ''}</div>`;
  return `<div class="form-grid">${NUTRITION_FIELDS.map(([k, l]) => field(k, `${l} por 100 g`)).join('')}</div>
    <div class="form-grid">
      ${field('pieceGrams', 'Peso de una pieza (g)', 'Opcional: para porciones en piezas (un huevo ≈ 50 g).')}
      ${field('packGrams', 'Cuánto trae cada unidad que compras (g)', 'Para comparar con lo que comen (cartón de 30 huevos ≈ 1,500 g).')}
    </div>`;
}
function saveNutrition(d) {
  if (!(num(d.n_kcal) > 0)) { toast('Escribe al menos las calorías por 100 g'); return false; }
  (state.food.nutrition ||= {})[d.productId] = {
    kcal: num(d.n_kcal), protein: num(d.n_protein), fat: num(d.n_fat), carbs: num(d.n_carbs), fiber: num(d.n_fiber),
    pieceGrams: num(d.n_pieceGrams), packGrams: num(d.n_packGrams),
  };
  touch('food');
  return true;
}

function viewMas() {
  const item = (view, ico, t, d) => `<button data-action="go" data-view="${view}"><span class="ico">${sym(ico)}</span><span><span class="t">${t}</span><br><span class="d">${d}</span></span><span class="chev">${sym('chevron.forward')}</span></button>`;
  return `<div class="page-head"><div><h1>Más</h1></div></div>
    <section class="card menu">
      ${item('hogar', 'person.2', 'Hogar en pareja', 'Reparto justo de los gastos de la casa')}
      ${item('pedido', 'cart', 'Listas de compra', 'Súper, pedido familiar y compras habituales')}
      ${item('consejos', 'lightbulb', 'Recomendaciones', 'Todo lo que la app detecta en tu plan')}
      ${item('historial', 'clock.arrow.circlepath', 'Historial', 'Pagos recibidos y gastos')}
      ${item('ajustes', 'gearshape', 'Ajustes y respaldo', 'Impuestos, moneda, exportar datos')}
      ${item('guia', 'book', 'Cómo funciona', 'El método financiero detrás de la app')}
    </section>`;
}

function viewHogar() {
  const m = ui.month;
  const p = state.partner;
  const ps = E.partnerShare(state, m);
  const shared = state.envelopes.filter((e) => e.shared);
  const name = esc(p.name || 'Tu pareja');
  return `<div class="page-head"><div><h1>Hogar en pareja</h1><p>Que la casa no pese sobre quien gana menos.</p></div></div>
    <section class="card stack">
      <div class="form-grid">
        <div class="field"><label for="pn">Nombre</label><input id="pn" class="input" value="${esc(p.name)}" ${bind('partner.name', 'text')}></div>
        <div class="field"><label for="pi">Su ingreso mensual</label>${money(`id="pi" ${bind('partner.income')}`, p.income)}</div>
      </div>
      <div class="choice" role="radiogroup" aria-label="Cómo repartir los gastos del hogar">
        <label><input type="radio" name="mode" value="yo100" ${p.mode === 'yo100' ? 'checked' : ''} ${bind('partner.mode', 'text')}><span><strong>Yo cubro el 100% de la casa <span class="rec">(recomendado)</span></strong><span class="small ink-2">Si ganas bastante más, es lo más justo. Su dinero queda para su independencia y su propio ahorro.</span></span></label>
        <label><input type="radio" name="mode" value="simbolico" ${p.mode === 'simbolico' ? 'checked' : ''} ${bind('partner.mode', 'text')}><span><strong>Aporte simbólico fijo</strong><span class="small ink-2">Si a ${name} le importa aportar, que sea un monto pequeño (máximo 10% de su ingreso).</span></span></label>
        <label><input type="radio" name="mode" value="proporcional" ${p.mode === 'proporcional' ? 'checked' : ''} ${bind('partner.mode', 'text')}><span><strong>Proporcional al ingreso</strong><span class="small ink-2">Cada uno aporta el mismo porcentaje de lo que gana. Es el estándar de equidad cuando ambos ingresos son estables.</span></span></label>
      </div>
      ${p.mode === 'simbolico' ? `<div class="field"><label for="ps">Su aporte mensual</label>${money(`id="ps" ${bind('partner.symbolic')}`, p.symbolic)}<span class="help">Sugerido: ${fmt(num(p.income) * 0.1)} (10% de su ingreso).</span></div>` : ''}
    </section>

    <section class="card stack">
      <h2>Quién paga qué</h2>
      <div class="table-wrap"><table class="table">
        <thead><tr><th></th><th class="r">Aporta</th><th class="r">% del ingreso</th></tr></thead>
        <tbody>
          <tr><td><strong>Tú</strong></td><td class="r num">${fmt(ps.myAmount)}</td><td class="r num">${pct(ps.myPctOfIncome)}</td></tr>
          <tr><td><strong>${name}</strong></td><td class="r num">${fmt(ps.herAmount)}</td><td class="r num">${pct(ps.herPctOfIncome)}</td></tr>
          <tr><td class="muted">Total gastos del hogar</td><td class="r num">${fmt(ps.sharedTotal)}</td><td></td></tr>
        </tbody>
      </table></div>
      <div class="tipcard ${ps.herPctOfIncome > ps.myPctOfIncome + 0.001 ? 'warning' : 'good'}"><span class="ic">${sym(ps.herPctOfIncome > ps.myPctOfIncome + 0.001 ? 'exclamationmark.triangle.fill' : 'checkmark.circle.fill')}</span><div><strong>${ps.herPctOfIncome > ps.myPctOfIncome + 0.001 ? 'Ojo: le pesa más a ella' : 'Reparto justo'}</strong><p>Regla de equidad: quien gana menos nunca debería aportar un porcentaje mayor de su ingreso. Sugiérele que guarde al menos el 20% de lo que gana en un ahorro propio.</p></div></div>
      <p class="small ink-2">Gastos marcados como “del hogar”: ${shared.map((e) => `${esc(e.icon)} ${esc(e.name)}`).join(', ') || 'ninguno'}. Cámbialos en la pestaña Plan.</p>
    </section>`;
}

function viewHistorial() {
  const m = ui.month;
  const pays = state.payments.filter((p) => E.monthKey(p.date) === m).map((p) => ({ ...p, t: 'in' }));
  const exps = state.expenses.filter((e) => E.monthKey(e.date) === m && e.kind !== 'transfer').map((e) => ({ ...e, t: 'out' }));
  const items = [...pays, ...exps].sort((a, b) => b.date.localeCompare(a.date));
  const byClient = {};
  for (const p of pays.filter(E.isIncome)) byClient[p.client || 'Sin nombre'] = (byClient[p.client || 'Sin nombre'] || 0) + num(p.amount);

  const row = (x) => {
    if (x.t === 'in') {
      const title = x.kind === 'saldo' ? 'Saldo inicial' : x.kind === 'transfer' ? 'Movimiento entre sobres' : esc(x.client || 'Pago');
      return `<div class="mov">
        <div><strong>${title}</strong><div class="meta">${dateLabel(x.date)}${x.note ? ` · ${esc(x.note)}` : ''}</div></div>
        <div class="amt num ${E.isIncome(x) ? 'in' : ''}">+${fmt(x.amount)}${x.original ? `<span class="meta">${fmtIn(x.original.amount, x.original.currency)}</span>` : ''}<button class="icon-btn" data-action="del-pay" data-id="${x.id}" aria-label="Borrar" title="Borrar">${sym('trash')}</button></div>
        <details><summary>Ver reparto</summary>${Object.entries(x.alloc).map(([id, v]) => { const e = envById(id); return `<div class="step-line"><span class="l">${e ? `${esc(e.icon)} ${esc(e.name)}` : 'Sobre eliminado'}</span><span class="num">${fmt(v)}</span></div>`; }).join('')}</details>
      </div>`;
    }
    const e = envById(x.envId);
    return `<div class="mov">
      <div><strong>${e ? `${esc(e.icon)} ${esc(e.name)}` : 'Sobre eliminado'}</strong><div class="meta">${dateLabel(x.date)}${x.note ? ` · ${esc(x.note)}` : ''}</div></div>
      <div class="amt num">−${fmt(x.amount)}${x.original ? `<span class="meta">${fmtIn(x.original.amount, x.original.currency)}</span>` : ''}<button class="icon-btn" data-action="del-exp" data-id="${x.id}" aria-label="Borrar" title="Borrar">${sym('trash')}</button></div>
    </div>`;
  };

  return `<div class="page-head"><div><h1>Historial</h1></div>${monthNav()}</div>
    <section class="card stack">
      <div class="stats">
        <div class="stat"><div class="k">Ingresos</div><div class="v">${fmt(E.incomeInMonth(state, m))}</div></div>
        <div class="stat"><div class="k">Gastos</div><div class="v">${fmt(sumBy(exps, (e) => num(e.amount)))}</div></div>
      </div>
      ${Object.keys(byClient).length ? `<div class="small ink-2">Por cliente: ${Object.entries(byClient).sort((a, b) => b[1] - a[1]).map(([c, v]) => `<strong>${esc(c)}</strong> ${fmt(v)}`).join(' · ')}</div>` : ''}
    </section>
    <section class="card">${items.length ? items.map(row).join('') : '<p class="muted">Sin movimientos este mes.</p>'}</section>`;
}

const CURRENCIES = ['USD', 'EUR', 'MXN', 'DOP', 'COP', 'PEN', 'CLP', 'ARS', 'GTQ', 'HNL', 'NIO', 'CRC', 'PAB', 'BOB', 'PYG', 'UYU', 'VES', 'CUP'];

function viewAjustes() {
  const s = state.settings;
  const theme = readTheme();
  return `<div class="page-head"><div><h1>Ajustes</h1></div></div>
    <section class="card stack">
      <h2>Ingresos e impuestos</h2>
      <div class="form-grid">
        <div class="field"><label for="name">Tu nombre</label><input id="name" class="input" value="${esc(s.name || '')}" ${bind('settings.name', 'text')}></div>
        <div class="field"><label for="cur">Moneda de tus ingresos</label><span class="popup"><select id="cur" class="input" ${bind('settings.currency', 'text')}>${CURRENCIES.map((c) => `<option ${c === s.currency ? 'selected' : ''}>${c}</option>`).join('')}</select></span></div>
        <div class="field"><label for="cost-cur">Moneda de tus gastos</label><span class="popup"><select id="cost-cur" class="input" ${bind('settings.costCurrency', 'text')}>${CURRENCIES.map((c) => `<option ${c === costCode() ? 'selected' : ''}>${c}</option>`).join('')}</select></span><span class="help">En la que pagas renta, súper y servicios.</span></div>
        ${isDual() ? `<div class="field"><label for="fx">Tipo de cambio: 1 ${baseCode()} =</label><div class="money" data-sym="" data-code="${costCode()}"><input id="fx" class="input" type="number" inputmode="decimal" min="0.0001" step="0.01" value="${esc(s.fxRate)}" ${bind('settings.fxRate')}></div><span class="help">Cambiarlo no altera tus montos en ${costCode()}; solo su equivalente en ${baseCode()}.</span></div>` : ''}
        <div class="field"><label for="inc">Ingreso mensual promedio</label>${money(`id="inc" ${bind('settings.incomeEstimate')}`, s.incomeEstimate || '')}<span class="help">Se usa hasta que tengas 1 mes de historial. Sé conservador.</span></div>
        <div class="field"><label for="tax">Reserva para impuestos</label>${percent(`id="tax" ${bind('settings.taxPct')}`, s.taxPct)}<span class="help">Pregunta a un contador qué te corresponde como trabajador independiente.</span></div>
        <div class="field"><label for="pf">Págate primero</label>${percent(`id="pf" ${bind('settings.payFirstPct')}`, s.payFirstPct)}<span class="help">${E.emergencyEnabled(state) ? 'Va al ahorro antes que cualquier gasto. 10% mínimo.' : 'No se aplica mientras el fondo de emergencia está en pausa.'}</span></div>
      </div>
    </section>
    <section class="card stack">
      <h2>Fondo de emergencia</h2>
      <label class="check switch-row"><span><strong>Fondo de emergencia activo</strong><span class="small ink-2" style="display:block">Si lo pausas no recibe aporte mensual, “págate primero” ni excedente; su saldo se conserva.</span></span><input type="checkbox" switch ${E.emergencyEnabled(state) ? 'checked' : ''} ${bind('settings.emergencyEnabled', 'bool')}></label>
      <div class="form-grid">
        <div class="field"><label for="efm">Meses de necesidades</label><input id="efm" class="input" type="number" min="1" max="24" value="${esc(s.emergencyMonths)}" ${bind('settings.emergencyMonths')}><span class="help">Con ingresos variables: 6.</span></div>
        <div class="field"><label for="efh">Completarlo en (meses)</label><input id="efh" class="input" type="number" min="1" max="60" value="${esc(s.emergencyHorizon)}" ${bind('settings.emergencyHorizon')}></div>
      </div>
    </section>
    <section class="card stack">
      <h2>Excedente</h2>
      <p class="sub">Cuando un pago cubre todo el mes, lo que sobra se divide así (debe sumar 100%).</p>
      <div class="form-grid">
        <div class="field"><label for="se">Fondo de emergencia / inversión</label>${percent(`id="se" ${bind('settings.surplus.emergencia')}`, s.surplus.emergencia)}</div>
        <div class="field"><label for="sm">Adelantar metas</label>${percent(`id="sm" ${bind('settings.surplus.metas')}`, s.surplus.metas)}</div>
        <div class="field"><label for="sl">Dinero libre</label>${percent(`id="sl" ${bind('settings.surplus.libre')}`, s.surplus.libre)}</div>
      </div>
      ${num(s.surplus.emergencia) + num(s.surplus.metas) + num(s.surplus.libre) !== 100 ? '<p class="small warn-ink">⚠️ Los tres porcentajes deben sumar 100%. Lo que sobre irá a dinero libre.</p>' : ''}
    </section>
    <section class="card stack">
      <h2>Apariencia</h2>
      <div class="segmented" role="radiogroup" aria-label="Apariencia">
        ${[['auto', 'Automático'], ['light', 'Claro'], ['dark', 'Oscuro']].map(([v, l]) => `<label><input type="radio" name="theme" value="${v}" ${theme === v ? 'checked' : ''} data-theme-pick><span>${l}</span></label>`).join('')}
      </div>
    </section>
    <section class="card stack">
      <h2>Papelera</h2>
      <p class="sub">Lo que borras se guarda aquí 30 días. Puedes restaurarlo con todo su reparto.</p>
      ${(state.trash || []).length ? `<div class="group-box">${state.trash.map((t) => `<div class="mov"><div><strong>${esc(t.label)}</strong><div class="meta">${TRASH_KINDS[t.kind]} · borrado ${new Date(t.at).toLocaleString('es', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</div></div><div class="amt"><button class="btn sm" data-action="trash-restore" data-id="${t.id}">Restaurar</button></div></div>`).join('')}</div>
        <div><button class="btn sm destructive" data-action="trash-empty">Vaciar papelera…</button></div>` : '<p class="muted">La papelera está vacía.</p>'}
    </section>
    <section class="card stack">
      <h2>Sincronización</h2>
      <p class="sub">Usa la app en la Mac y en el iPhone con los mismos datos. Se guardan cifrados en un repositorio privado de GitHub con una contraseña que solo tú conoces: ni GitHub puede leerlos.</p>
      ${syncState.config ? `
        <div class="row between" style="flex-wrap:wrap"><span>Repositorio: <strong>${esc(syncState.config.repo)}</strong></span><span id="sync-status" class="small ${syncState.error ? 'warn-ink' : 'ink-2'}">${esc(syncStatusText())}</span></div>
        <div class="row" style="flex-wrap:wrap">
          <button class="btn" data-action="sync-now">${sym('arrow.counterclockwise')} Sincronizar ahora</button>
          <button class="btn destructive" data-action="sync-off">Desconectar…</button>
        </div>` : `<div><button class="btn primary" data-action="open" data-modal="sync">Configurar sincronización…</button></div>`}
    </section>
    <section class="card stack">
      <h2>Tus datos</h2>
      <p class="sub">${isNative ? 'Tus datos se guardan en tu Mac (Archivo → Mostrar carpeta de datos), con una copia automática por día de los últimos 30 días.' : 'Todo se guarda solo en este dispositivo; nada sale a internet.'} Exporta un respaldo cada mes y guárdalo en un lugar seguro.</p>
      <div class="actions">
        <button class="btn" data-action="export">${sym('square.and.arrow.up')} Exportar respaldo…</button>
        <label class="btn" for="import-file">${sym('square.and.arrow.down')} Importar respaldo…</label>
        <button class="btn" data-action="open" data-modal="copias">${sym('clock.arrow.circlepath')} Restaurar una copia…</button>
      </div>
      <input type="file" id="import-file" accept="application/json,.json" hidden>
      <div class="row" style="flex-wrap:wrap">
        <button class="btn" data-action="replay-onb">${sym('arrow.counterclockwise')} Repetir configuración inicial</button>
        <button class="btn destructive" data-action="reset">Borrar todos los datos…</button>
      </div>
    </section>`;
}

function viewGuia() {
  return `<div class="page-head"><div><h1>Cómo funciona</h1><p>El método detrás de cada reparto.</p></div></div>
    <section class="card guide">
      <h3>1. Presupuesto por sobres, a la par</h3>
      <p>Como tus ingresos llegan de clientes en montos y fechas variables, no sirve un porcentaje fijo para todo. Cada pago se reparte por sobres siguiendo estas reglas, hasta cubrir lo que el mes necesita; los pagos siguientes completan lo que falte. Es el presupuesto por sobres que recomiendan los planificadores financieros para trabajadores independientes, ajustado para ingresos que llegan en varias semanas.</p>
      <ol>
        <li><strong>Impuestos</strong> (${state.settings.taxPct}%): ese dinero no es tuyo; se aparta antes de todo.</li>
        <li><strong>Págate primero</strong> (${state.settings.payFirstPct}%): el ahorro no es lo que sobra, es lo primero.</li>
        <li><strong>Lo que vence pronto</strong>: si un sobre tiene día de pago (p. ej. la renta) y faltan ${E.DUE_WINDOW_DAYS} días o menos, se completa primero.</li>
        <li><strong>Necesidades a la par</strong>: renta, comida, servicios, internet, transporte y gimnasio reciben el mismo porcentaje de lo que les falta. Así ninguna se queda en cero mientras llegan los pagos.</li>
        <li><strong>Ahorro, imagen y gustos a la par</strong>: con las necesidades del mes cubiertas, el fondo de emergencia, tus metas, la ropa y las salidas avanzan juntos.</li>
        <li><strong>Excedente</strong>: si un pago cubre todo, lo que sobra se reparte entre fondo de emergencia, adelantar metas y dinero libre.</li>
      </ol>
      <h3>2. Regla 50/30/20</h3>
      <p>Popularizada por Elizabeth Warren en <em>All Your Worth</em>: del ingreso después de impuestos, hasta 50% a necesidades, hasta 30% a gustos y al menos 20% a ahorro. La app la usa como termómetro de tu plan.</p>
      <h3>3. Fondo de emergencia de 6 meses</h3>
      <p>La recomendación general es 3 a 6 meses de gastos esenciales; con ingresos variables se recomienda el extremo alto. Cuando tengas 1 mes completo, empieza a vivir con el dinero que entró el mes anterior: así un cliente que paga tarde ya no te afecta.</p>
      <h3>4. Ahorro con fecha para compras grandes</h3>
      <p>Para la Mac y el iPhone (tus herramientas de trabajo) se divide el precio entre los meses que faltan. Comprar al contado evita intereses; si hay una oferta de meses sin intereses, úsala solo si el dinero ya está en el sobre.</p>
      <h3>5. Vivienda máximo 30%</h3>
      <p>Una referencia clásica de asequibilidad: que la renta no pase del 30% de tus ingresos.</p>
      <h3>6. Reparto justo del hogar</h3>
      <p>El criterio de equidad más usado es que cada miembro aporte la misma proporción de su ingreso, nunca más. Con la diferencia actual de ingresos, cubrir tú el 100% es justo, y que tu pareja ahorre lo suyo fortalece a ambos.</p>
      <h3>7. Internet</h3>
      <p>Destina como máximo 3% de tu ingreso a internet (casa + móvil). Para crear y subir contenido importa más la velocidad de <strong>subida</strong> que la de bajada: busca fibra óptica con 50 Mbps de subida o más. Con Wi-Fi en casa puedes bajar tu plan móvil.</p>
      <p class="tiny muted" style="margin-top:12px">Esta app es una herramienta de organización basada en reglas reconocidas de finanzas personales; no sustituye la asesoría fiscal o legal de un profesional en tu país.</p>
    </section>`;
}

// ---------- Bienvenida ----------

function viewOnb() {
  const s = state.settings;
  const env = (id) => envById(id) || {};
  const step = ui.onbStep;
  const field = (id, label, help = '') => `<div class="field"><label for="o-${id}">${label}</label>${money(`id="o-${id}" ${envBind(id, 'monthly')}`, env(id).monthly || '', '', 'cost')}${help ? `<span class="help">${help}</span>` : ''}</div>`;
  const steps = [
    `<h1>Te damos la bienvenida</h1>
     <p class="lead">Vamos a armar tu plan en 4 pasos. Cada vez que un cliente te pague, la app te dirá exactamente a dónde va cada peso.</p>
     <div><button class="btn link" data-action="open" data-modal="sync" style="padding:0">¿Ya usas la app en otro dispositivo? Conectar sincronización…</button></div>
     <div class="pill-list"><span>Reparto automático</span><span>Fondo de emergencia</span><span>Mac e iPhone</span><span>Súper según tu dieta</span><span>Hogar justo</span></div>
     <div class="form-grid">
       <div class="field"><label for="o-name">¿Cómo te llamas?</label><input id="o-name" class="input" value="${esc(s.name || '')}" ${bind('settings.name', 'text')}></div>
       <div class="field"><label for="o-cur">Moneda de tus ingresos</label><span class="popup"><select id="o-cur" class="input" ${bind('settings.currency', 'text')}>${CURRENCIES.map((c) => `<option ${c === s.currency ? 'selected' : ''}>${c}</option>`).join('')}</select></span></div>
       <div class="field"><label for="o-cost-cur">Moneda de tus gastos</label><span class="popup"><select id="o-cost-cur" class="input" ${bind('settings.costCurrency', 'text')}>${CURRENCIES.map((c) => `<option ${c === costCode() ? 'selected' : ''}>${c}</option>`).join('')}</select></span></div>
       ${isDual() ? `<div class="field"><label for="o-fx">Tipo de cambio: 1 ${baseCode()} =</label><div class="money" data-sym="" data-code="${costCode()}"><input id="o-fx" class="input" type="number" inputmode="decimal" min="0.0001" step="0.01" value="${esc(s.fxRate)}" ${bind('settings.fxRate')}></div></div>` : ''}
       <div class="field"><label for="o-inc">Ingreso mensual promedio</label>${money(`id="o-inc" ${bind('settings.incomeEstimate')}`, s.incomeEstimate || '')}<span class="help">Usa un mes normal, no el mejor.</span></div>
       <div class="field"><label for="o-tax">Reserva para impuestos</label>${percent(`id="o-tax" ${bind('settings.taxPct')}`, s.taxPct)}<span class="help">Pon 0 si no aplica en tu país.</span></div>
     </div>`,
    `<h1>Gastos del mes</h1>
     <p class="lead">Lo que necesitas para vivir y trabajar. La comida de tu plan de nutrición se calcula sola en la pestaña Comida.</p>
     <div class="form-grid">
       ${field('renta', '🏠 Renta')}${field('hogar', '🛒 Súper y gastos del hogar', 'Lo que no es tu plan de comida: limpieza, comida de ella, etc.')}
       ${field('servicios', '💡 Luz, agua y gas')}${field('internet', '📶 Internet de casa', 'Aún no lo tienes: pon lo que estimas pagar. Se ahorrará desde ya.')}
       ${field('movil', '📱 Plan del móvil')}${field('taxis', '🚕 Taxis y transporte')}
       ${field('gym', '🏋️ Gimnasio')}${field('salidas', '🍽️ Salidas en pareja')}
     </div>`,
    `<h1>Metas e imagen</h1>
     <p class="lead">Tus herramientas de trabajo y tu imagen. Pon el precio y para cuándo lo quieres.</p>
     <div class="form-grid">
       <div class="field"><label for="o-mac">💻 Precio de la Mac</label>${money(`id="o-mac" ${envBind('mac', 'goal.target')}`, env('mac').goal?.target || '', '', 'cost')}</div>
       <div class="field"><label for="o-macd">Para</label><input id="o-macd" class="input" type="month" value="${esc(env('mac').goal?.date)}" ${envBind('mac', 'goal.date', 'text')}></div>
       <div class="field"><label for="o-iph">📲 Precio del iPhone</label>${money(`id="o-iph" ${envBind('iphone', 'goal.target')}`, env('iphone').goal?.target || '', '', 'cost')}</div>
       <div class="field"><label for="o-iphd">Para</label><input id="o-iphd" class="input" type="month" value="${esc(env('iphone').goal?.date)}" ${envBind('iphone', 'goal.date', 'text')}></div>
       ${field('ropa', '👔 Ropa y accesorios al mes', 'Sugerido 5–10% de tu ingreso; compra pocas piezas versátiles y de calidad.')}
       ${field('cuidado', '💈 Cuidado personal al mes')}
     </div>
     <h2>¿Ya tienes algo ahorrado?</h2>
     <div class="form-grid">
       ${['emergencia', 'mac', 'iphone'].map((id) => `<div class="field"><label for="os-${id}">${esc(env(id).icon)} ${id === 'emergencia' ? 'Ahorros generales' : `Para ${id === 'mac' ? 'la Mac' : 'el iPhone'}`}</label>${money(`id="os-${id}" data-onb-saldo="${id}" data-k="os:${id}"`, ui.onbSaldo[id])}</div>`).join('')}
     </div>`,
    `<h1>Tu hogar</h1>
     <p class="lead">Si ganas bastante más que tu pareja, lo justo es que cubras los gastos de la casa y que tu pareja use su dinero para su propio ahorro.</p>
     <div class="form-grid">
       <div class="field"><label for="o-pn">Nombre de tu pareja</label><input id="o-pn" class="input" value="${esc(state.partner.name)}" ${bind('partner.name', 'text')}></div>
       <div class="field"><label for="o-pi">Su ingreso mensual</label>${money(`id="o-pi" ${bind('partner.income')}`, state.partner.income)}</div>
     </div>
     <div class="choice">
       <label><input type="radio" name="o-mode" value="yo100" ${state.partner.mode === 'yo100' ? 'checked' : ''} ${bind('partner.mode', 'text')}><span><strong>Yo cubro la casa <span class="rec">Recomendado</span></strong><span class="small ink-2">Puedes cambiarlo cuando quieras en Más → Hogar.</span></span></label>
       <label><input type="radio" name="o-mode" value="simbolico" ${state.partner.mode === 'simbolico' ? 'checked' : ''} ${bind('partner.mode', 'text')}><span><strong>Ella aporta algo simbólico</strong></span></label>
       <label><input type="radio" name="o-mode" value="proporcional" ${state.partner.mode === 'proporcional' ? 'checked' : ''} ${bind('partner.mode', 'text')}><span><strong>Proporcional a lo que gana cada uno</strong></span></label>
     </div>`,
  ];
  return `<div class="onb">
    <div class="steps" aria-label="Paso ${step + 1} de 4">${[0, 1, 2, 3].map((i) => `<span class="${i <= step ? 'on' : ''}"></span>`).join('')}</div>
    <section class="card stack">${steps[step]}</section>
    <div class="onb-actions">
      ${step > 0 ? '<button class="btn" data-action="onb-back">Atrás</button>' : ''}
      <button class="btn primary" data-action="onb-next">${step < 3 ? 'Continuar' : 'Comenzar'}</button>
    </div>
  </div>`;
}

// ---------- Modales ----------

const STAGE_TITLES = { impuestos: 'Impuestos', primero: 'Págate primero', vence: 'Vence pronto', mes: 'Necesidades del mes, a la par', resto: 'Ahorro, imagen y gustos, a la par', excedente: 'Excedente' };

// Moneda del dinero que entra (pago o ahorro existente): la de ingresos o la de gastos, con su tipo de cambio.
const draftBase = (d) => E.toBase(state, num(d.amount), d.currency, d.rate);
function incomeCurrencyFields(d) {
  if (!isDual()) return '';
  const other = d.currency !== baseCode();
  return `<div class="form-grid">
      <div class="field"><label for="d-cur">Moneda</label><span class="popup"><select id="d-cur" class="input" data-draft="currency">${[baseCode(), costCode()].map((c) => `<option ${c === d.currency ? 'selected' : ''}>${c}</option>`).join('')}</select></span></div>
      ${other ? `<div class="field"><label for="d-rate">Tipo de cambio: 1 ${baseCode()} =</label><div class="money" data-sym="" data-code="${d.currency}"><input id="d-rate" class="input" type="number" inputmode="decimal" min="0.0001" step="0.01" value="${esc(d.rate)}" data-draft="rate"></div><span class="help" id="fx-equiv">${fxEquiv(d)}</span></div>` : ''}
    </div>`;
}
const fxEquiv = (d) => (num(d.amount) ? `= ${fmt(draftBase(d))} para tus sobres` : 'Se convierte a la moneda de tus sobres.');

function paymentPreview() {
  const d = ui.draft;
  const amount = draftBase(d);
  if (amount <= 0) return '<p class="muted small">Escribe el monto para ver cómo se reparte.</p>';
  const r = E.allocate(state, amount, d.date);
  const byGroup = {};
  for (const [id, v] of Object.entries(r.alloc)) { const g = envById(id).group; byGroup[g] = (byGroup[g] || 0) + v; }
  const stages = {};
  for (const st of r.steps) (stages[st.stage] ||= {})[st.envId] = ((stages[st.stage] || {})[st.envId] || 0) + st.amount;
  return `${stackBar(byGroup, amount)}
    ${Object.entries(STAGE_TITLES).filter(([k]) => stages[k]).map(([k, title], i) => `<div class="step-title">${i + 1} · ${title}</div>
      ${Object.entries(stages[k]).map(([id, v]) => { const e = envById(id); return `<div class="step-line"><span class="l"><i class="dot" style="background:var(--g-${e.group})"></i>${esc(e.icon)} ${esc(e.name)}</span><span class="num"><strong>${fmt(v)}</strong></span></div>`; }).join('')}`).join('')}`;
}

const moveEquiv = (d) => (num(d.amount) && d.currency !== baseCode() ? `= ${fmt(E.toBase(state, num(d.amount), d.currency))}` : '');

function envOptions(selected, { exclude } = {}) {
  return GROUP_ORDER.map((g) => `<optgroup label="${E.GROUPS[g].label}">${state.envelopes.filter((e) => e.group === g && e.id !== exclude).map((e) => `<option value="${e.id}" ${e.id === selected ? 'selected' : ''}>${esc(e.icon)} ${esc(e.name)} — ${fmt(E.envelopeBalance(state, e.id))}</option>`).join('')}</optgroup>`).join('');
}

function modalHTML() {
  const d = ui.draft;
  const head = (t) => `<div class="sheet-head"><h2 id="sheet-title">${t}</h2></div>`;
  const foot = (label, action) => `<div class="sheet-foot"><button class="btn" data-action="close">Cancelar</button><button class="btn primary" data-action="${action}">${label}</button></div>`;
  const dateField = `<div class="field"><label for="d-date">Fecha</label><input id="d-date" class="input" type="date" value="${esc(d.date)}" data-draft="date"></div>`;
  const noteField = (ph) => `<div class="field"><label for="d-note">Nota (opcional)</label><input id="d-note" class="input" value="${esc(d.note)}" placeholder="${ph}" data-draft="note"></div>`;
  switch (ui.modal) {
    case 'pago': {
      const clients = [...new Set(state.payments.filter(E.isIncome).map((p) => p.client).filter(Boolean))];
      return `${head('Recibí un pago')}
        <div class="field"><label for="d-amount">¿Cuánto recibiste?</label>${money('id="d-amount" data-draft="amount" autofocus', d.amount, 'amount', d.currency)}</div>
        ${incomeCurrencyFields(d)}
        <div class="form-grid">
          <div class="field"><label for="d-client">Cliente</label><input id="d-client" class="input" list="clients" value="${esc(d.client)}" data-draft="client" placeholder="Nombre del cliente"><datalist id="clients">${clients.map((c) => `<option value="${esc(c)}">`).join('')}</datalist></div>
          ${dateField}
        </div>
        <div class="card" style="background:var(--surface-2);box-shadow:none"><h3 style="margin-bottom:8px">Así se reparte</h3><div id="pay-preview">${paymentPreview()}</div></div>
        ${foot('Repartir y guardar', 'save-pago')}`;
    }
    case 'gasto': {
      const e = envById(d.envId);
      const bal = e ? E.envelopeBalance(state, e.id) : 0;
      return `${head('Registrar gasto')}
        <div class="field"><label for="d-amount">¿Cuánto gastaste?</label>${money('id="d-amount" data-draft="amount" autofocus', d.amount, 'amount', e ? E.envCurrency(state, e) : 'cost')}</div>
        <div class="field"><label for="d-env">¿De qué sobre sale?</label><span class="popup"><select id="d-env" class="input" data-draft="envId">${envOptions(d.envId)}</select></span>
          <span class="help" id="exp-help">${expenseHelp()}</span></div>
        <div class="form-grid">${dateField}${noteField('Ej. súper semanal')}</div>
        ${foot('Guardar gasto', 'save-gasto')}`;
    }
    case 'mover':
      return `${head('Mover dinero entre sobres')}
        <p class="small ink-2">Útil cuando un sobre se queda corto. Sacar del fondo de emergencia debería ser solo para emergencias reales.</p>
        <div class="field"><label for="d-amount">Monto</label>${money('id="d-amount" data-draft="amount"', d.amount, 'amount', d.currency)}
          ${isDual() ? `<div class="segmented" role="radiogroup" aria-label="Moneda" style="margin-top:8px">${[costCode(), baseCode()].map((c) => `<label><input type="radio" name="mv-cur" value="${c}" ${c === d.currency ? 'checked' : ''} data-draft="currency"><span>${c}</span></label>`).join('')}</div>
          <span class="help" id="mv-equiv">${moveEquiv(d)}</span>` : ''}</div>
        <div class="field"><label for="d-from">Desde</label><span class="popup"><select id="d-from" class="input" data-draft="from">${envOptions(d.from)}</select></span></div>
        <div class="field"><label for="d-to">Hacia</label><span class="popup"><select id="d-to" class="input" data-draft="to">${envOptions(d.to)}</select></span></div>
        ${foot('Mover', 'save-mover')}`;
    case 'saldo':
      return `${head('Registrar ahorro existente')}
        <p class="small ink-2">Registra dinero que ya tenías antes de usar la app. No cuenta como ingreso del mes.</p>
        <div class="field"><label for="d-amount">Monto</label>${money('id="d-amount" data-draft="amount"', d.amount, 'amount', d.currency)}</div>
        ${incomeCurrencyFields(d)}
        <div class="field"><label for="d-env">Sobre</label><span class="popup"><select id="d-env" class="input" data-draft="envId">${envOptions(d.envId)}</select></span></div>
        ${foot('Guardar', 'save-saldo')}`;
    case 'sobre': {
      const e = envById(d.id);
      if (!e) return '';
      const m = ui.month;
      const movs = [
        ...state.payments.filter((p) => p.alloc[e.id]).map((p) => ({ date: p.date, amt: p.alloc[e.id], label: p.kind === 'saldo' ? 'Saldo inicial' : p.kind === 'transfer' ? 'Movimiento' : (p.client || 'Pago') })),
        ...state.expenses.filter((x) => x.envId === e.id).map((x) => ({ date: x.date, amt: -num(x.amount), label: `${x.note || 'Gasto'}${x.original ? ` · ${fmtIn(x.original.amount, x.original.currency)}` : ''}` })),
      ].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 12);
      return `${head(`${esc(e.icon)} ${esc(e.name)}`)}
        <div class="stats">
          <div class="stat"><div class="k">Disponible</div><div class="v">${fmt(E.envelopeBalance(state, e.id))}</div></div>
          <div class="stat"><div class="k">Necesita este mes</div><div class="v">${fmt(E.monthlyTarget(state, e, m))}</div></div>
          <div class="stat"><div class="k">Gastado este mes</div><div class="v">${fmt(E.spentInMonth(state, e.id, m))}</div></div>
        </div>
        ${e.pending ? '<p class="small ink-2">Aún no contratado: lo que se acumula aquí cubrirá la instalación y el primer mes.</p>' : ''}
        <div><h3 style="margin-bottom:4px">Últimos movimientos</h3><div class="group-box">${movs.length ? movs.map((x) => `<div class="mov"><div>${esc(x.label)}<div class="meta">${dateLabel(x.date)}</div></div><div class="amt num ${x.amt > 0 ? 'in' : ''}">${x.amt > 0 ? '+' : '−'}${fmt(Math.abs(x.amt))}</div></div>`).join('') : '<p class="muted small" style="padding:8px 12px">Aún no hay movimientos.</p>'}</div></div>
        <div class="sheet-foot">
          <button class="btn" data-action="open" data-modal="mover" data-from="${e.id}">Mover dinero…</button>
          ${e.order ? '<button class="btn" data-action="go" data-view="pedido">Ver lista…</button>' : ''}
          <span style="flex:1"></span>
          <button class="btn" data-action="open" data-modal="gasto" data-env="${e.id}">Registrar gasto…</button>
          <button class="btn primary" data-action="close">Listo</button>
        </div>`;
    }
    case 'sync':
      if (d.step === 'elegir') {
        const when = (t) => (t > 1e12 ? new Date(t).toLocaleString('es', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
        const rows = [['Pagos', 'pagos'], ['Gastos', 'gastos'], ['Sobres', 'sobres'], ['Alimentos del menú', 'alimentos'], ['Productos del pedido familiar', 'productos']];
        const option = (mode, title, text, primary = false) => `<button class="sync-option ${primary ? 'primary' : ''}" data-action="sync-choose" data-mode="${mode}"><strong>${title}</strong><span>${text}</span></button>`;
        return `${head('Ya hay datos sincronizados')}
          <p class="small ink-2">Este dispositivo y la copia sincronizada tienen datos. Elige qué hacer; antes de cambiar nada se guarda una copia de los datos de este dispositivo.</p>
          <div class="table-wrap"><table class="table">
            <thead><tr><th></th><th class="r">Este dispositivo</th><th class="r">Sincronizados</th></tr></thead>
            <tbody>${rows.map(([label, k]) => `<tr><td>${label}</td><td class="r num">${d.local[k]}</td><td class="r num">${d.remote[k]}</td></tr>`).join('')}
              <tr><td>Última modificación</td><td class="r">${when(d.local.modificado)}</td><td class="r">${when(d.remote.modificado)}</td></tr></tbody>
          </table></div>
          <div class="stack" style="gap:8px">
            ${option('merge', 'Combinar (recomendado)', 'Une los dos: no se pierde nada. Si un ajuste cambió en ambos, gana el más reciente.', true)}
            ${option('local', 'Usar los de este dispositivo', 'Reemplaza la copia sincronizada; los otros dispositivos recibirán esta versión.')}
            ${option('remote', 'Usar los sincronizados', 'Reemplaza los datos de este dispositivo (se guarda una copia antes).')}
          </div>
          <div class="sheet-foot"><button class="btn" data-action="close">Cancelar</button></div>`;
      }
      return `${head('Configurar sincronización')}
        <p class="small ink-2">Necesitas un repositorio <strong>privado</strong> de GitHub y un token con permiso de <em>Contenido: lectura y escritura</em> solo para ese repositorio. Usa los mismos datos en cada dispositivo.</p>
        <div class="field"><label for="s-repo">Repositorio</label><input id="s-repo" class="input" placeholder="usuario/repositorio" autocapitalize="off" autocorrect="off" spellcheck="false" value="${esc(d.repo)}" data-draft="repo"></div>
        <div class="field"><label for="s-token">Token de GitHub</label><input id="s-token" class="input" type="password" autocomplete="off" placeholder="github_pat_…" value="${esc(d.token)}" data-draft="token"></div>
        <div class="field"><label for="s-pass">Contraseña de cifrado</label><input id="s-pass" class="input" type="password" autocomplete="new-password" value="${esc(d.passphrase)}" data-draft="passphrase">
          <span class="help">Mínimo 8 caracteres. Si la olvidas, los datos sincronizados no se pueden recuperar (los de cada dispositivo siguen ahí).</span></div>
        <p id="sync-msg" class="small warn-ink" role="status"></p>
        ${foot('Conectar', 'save-sync')}`;
    case 'copias': {
      const when = (t) => new Date(t).toLocaleString('es', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
      const labels = { datos: 'Copia diaria', 'antes-de-sincronizar': 'Antes de sincronizar', 'antes-de-adoptar': 'Antes de usar los datos sincronizados', 'antes-de-restaurar': 'Antes de restaurar' };
      const nice = (label) => labels[label] || label;
      return `${head('Restaurar una copia')}
        <p class="small ink-2">Elige una copia para volver a ese momento. Antes se guarda una copia de tus datos actuales, y si usas sincronización, los otros dispositivos quedarán igual.</p>
        ${d.list == null ? '<p class="muted">Cargando copias…</p>' : d.list.length ? `<div class="group-box">${d.list.map((c, i) => `<div class="mov"><div><strong>${esc(nice(c.label))}</strong><div class="meta">${when(c.at)}</div></div><div class="amt"><button class="btn sm" data-action="backup-pick" data-i="${i}">Restaurar…</button></div></div>`).join('')}</div>` : `<p class="muted">Todavía no hay copias${isNative ? '' : ' en este dispositivo. Puedes importar un respaldo exportado.'}</p>`}
        <div class="sheet-foot"><button class="btn" data-action="close">Cerrar</button></div>`;
    }
    case 'porcion': {
      const products = foodProducts();
      const n = (state.food.nutrition || {})[d.productId];
      return `${head(`Agregar a ${MEAL_NAMES[d.meal].toLowerCase()}`)}
        ${d.productId ? `<div class="picked"><span>${esc(foodProducts().find((x) => x.id === d.productId)?.name || '')}</span><button class="btn link sm" data-action="pick-clear">Cambiar</button></div>`
          : `<div class="field"><label for="po-q">Buscar alimento</label><input id="po-q" class="input" type="search" autocomplete="off" autocorrect="off" spellcheck="false" placeholder="Escribe, p. ej. huevo, atún, avena…" value="${esc(d.query)}" data-draft="query" autofocus>
          <div id="po-results" class="search-results" role="listbox">${productResults(d.query)}</div></div>`}
        <div class="form-grid">
          <div class="field"><label for="po-amt">Cantidad por persona</label><input id="po-amt" class="input" type="number" inputmode="decimal" min="0" step="any" data-draft="amount" value="${esc(d.amount)}"></div>
          <div class="field"><label for="po-unit">Unidad</label><span class="popup"><select id="po-unit" class="input" data-draft="unit"><option value="g" ${d.unit === 'g' ? 'selected' : ''}>gramos</option><option value="pza" ${d.unit === 'pza' ? 'selected' : ''}>piezas</option></select></span></div>
        </div>
        ${!d.productId ? '' : n ? `<p class="small ink-2">Por 100 g: ${macroLine(n)}.${num(n.pieceGrams) ? ` Una pieza ≈ ${n.pieceGrams} g.` : ''}</p>` : `<p class="small warn-ink">Este producto aún no tiene datos nutricionales; agrégalos para que cuente en tus metas.</p>${nutritionFields(d)}`}
        ${d.unit === 'pza' && n && !num(n.pieceGrams) ? '<p class="small warn-ink">Para usar piezas, indica el peso de una pieza en sus datos nutricionales.</p>' : ''}
        ${foot('Agregar', 'save-porcion')}`;
    }
    case 'nutricion': {
      const p = foodProducts().find((x) => x.id === d.productId);
      return `${head('Datos nutricionales')}
        <p class="small ink-2"><strong>${esc(p ? p.name : '')}</strong>. Valores por 100 g (de la etiqueta o de tu app de nutrición).</p>
        ${nutritionFields(d)}
        ${foot('Guardar', 'save-nutricion')}`;
    }
    case 'mover-lista': {
      const from = currentOrder();
      const count = from ? from.order.items.filter((it) => it.selected).length : 0;
      const food = foodEnvelope();
      const targets = [...(food && food.id !== from?.id ? [food] : []), ...orderLists().filter((e) => e.id !== from?.id)];
      return `${head(`Mover ${count} ${count === 1 ? 'producto' : 'productos'}`)}
        <p class="small ink-2">Se llevan su tipo (semanal, quincenal…), precio, cantidad y estado de comprado.</p>
        <div class="field"><label for="mv-to">A la lista</label><span class="popup"><select id="mv-to" class="input" data-draft="to">${targets.map((e) => `<option value="${e.id}" ${e.id === d.to ? 'selected' : ''}>${esc(e.icon)} ${e.role === 'comida' ? 'Alimentación' : esc(e.name)}${e.order ? '' : ' (se crea la lista)'}</option>`).join('')}</select></span></div>
        ${foot('Mover', 'save-mover-lista')}`;
    }
    case 'nueva-lista': {
      const candidates = state.envelopes.filter((e) => !e.order && E.isManualEnvelope(e));
      return `${head('Nueva lista de compra')}
        <p class="small ink-2">Cada lista se paga desde un sobre. Puedes usar uno que ya tienes (p. ej. “Súper y gastos del hogar”) o crear uno nuevo.</p>
        <div class="field"><label for="l-env">Sobre</label><span class="popup"><select id="l-env" class="input" data-draft="envId">${candidates.map((e) => `<option value="${e.id}" ${e.id === d.envId ? 'selected' : ''}>${esc(e.icon)} ${esc(e.name)}</option>`).join('')}<option value="nuevo" ${d.envId === 'nuevo' ? 'selected' : ''}>＋ Crear un sobre nuevo</option></select></span></div>
        ${d.envId === 'nuevo' ? `<div class="field"><label for="l-name">Nombre</label><input id="l-name" class="input" data-draft="name" value="${esc(d.name)}" placeholder="Ej. Súper Walmart"></div>` : ''}
        ${foot('Crear lista', 'save-lista')}`;
    }
    case 'producto': {
      const env = currentOrder();
      return `${head('Agregar producto')}
        <div class="field"><label for="p-name">Producto</label><input id="p-name" class="input" data-draft="name" value="${esc(d.name)}" placeholder="Ej. Leche en polvo 1 kg"></div>
        <div class="form-grid">
          <div class="field"><label for="p-price">Precio</label>${money('id="p-price" data-draft="price"', d.price, '', env ? E.envCurrency(state, env) : 'base')}<span class="help">Puedes dejarlo vacío y ponerlo después.</span></div>
          <div class="field"><label for="p-qty">Cantidad habitual</label><input id="p-qty" class="input" type="number" inputmode="numeric" min="1" step="1" data-draft="qty" value="${esc(d.qty)}"></div>
        </div>
        ${foot('Agregar', 'save-producto')}`;
    }
    case 'alimento':
      return `${head(d.index != null ? 'Editar alimento' : 'Agregar alimento')}
        <p class="small ink-2">Copia los valores por 100 g de la etiqueta o de tu app de nutrición.</p>
        <div class="field"><label for="a-name">Nombre</label><input id="a-name" class="input" data-draft="name" value="${esc(d.name)}"></div>
        <div class="form-grid">
          ${[['kcal', 'Calorías'], ['protein', 'Proteína (g)'], ['fat', 'Grasa (g)'], ['carbs', 'Carbohidratos (g)'], ['fiber', 'Fibra (g)'], ['grams', 'Gramos al día por persona']]
            .map(([k, l]) => `<div class="field"><label for="a-${k}">${l}</label><input id="a-${k}" class="input" type="number" inputmode="decimal" min="0" step="any" data-draft="${k}" value="${esc(d[k])}"></div>`).join('')}
        </div>
        <div class="form-grid">
          <div class="field"><label for="a-unit">Se vende por</label><span class="popup"><select id="a-unit" class="input" data-draft="priceUnit">${PRICE_UNITS.map((u) => `<option value="${u}" ${u === d.priceUnit ? 'selected' : ''}>${UNIT_NAMES[u].por}</option>`).join('')}</select></span></div>
          ${foodPriceFields(d)}
        </div>
        ${foot(d.index != null ? 'Guardar' : 'Agregar', 'save-alimento')}`;
    default:
      return '';
  }
}

function openModal(name, data = {}) {
  ui.modal = name;
  const base = { date: E.todayISO(), amount: '', note: '', client: '' };
  if (name === 'gasto') base.envId = data.env || 'comida';
  if (name === 'mover') {
    base.currency = isDual() ? costCode() : baseCode();
    base.from = data.from || 'libre';
    base.to = data.to || state.envelopes.find((e) => e.id !== base.from)?.id;
    if (data.amount) base.amount = isDual() ? Math.round(E.baseToCost(state, data.amount) * 100) / 100 : data.amount;
  }
  if (name === 'saldo') base.envId = 'emergencia';
  if (name === 'pago' || name === 'saldo') Object.assign(base, { currency: baseCode(), rate: E.fxRate(state) === 1 ? state.settings.fxRate : E.fxRate(state) });
  if (name === 'sobre') base.id = data.id;
  if (name === 'sync') Object.assign(base, { repo: syncState.config?.repo || '', token: '', passphrase: '' });
  if (name === 'producto') Object.assign(base, { name: '', price: '', qty: 1 });
  if (name === 'porcion') {
    const first = foodProducts()[0];
    Object.assign(base, { meal: data.meal, productId: null, query: '', amount: '', unit: 'g' });
  }
  if (name === 'nutricion') Object.assign(base, { productId: data.product, ...nutritionDraft(data.product) });
  if (name === 'mover-lista') { const f = foodEnvelope(); base.to = f && f.id !== currentOrder()?.id ? f.id : orderLists().find((e) => e.id !== currentOrder()?.id)?.id; }
  if (name === 'nueva-lista') {
    const free = state.envelopes.filter((e) => !e.order && E.isManualEnvelope(e));
    const pick = free.find((e) => e.id === 'hogar' || /súper|super/i.test(e.name)) || free.find((e) => e.role !== 'renta') || free[0];
    Object.assign(base, { name: '', envId: pick?.id || 'nuevo' });
  }
  if (name === 'copias') { base.list = null; setTimeout(loadBackupList, 0); } // después de abrir la hoja
  if (name === 'alimento') {
    const existing = data.index != null ? state.food.items[Number(data.index)] : null;
    Object.assign(base, existing
      ? { ...existing, index: Number(data.index), price: num(existing.price) || '', priceGrams: E.weeklyPurchase(existing) === null || isWeighed(existing) ? '' : existing.priceGrams }
      : { name: '', kcal: '', protein: '', fat: '', carbs: '', fiber: 0, grams: 100, price: '', priceUnit: 'kg', priceGrams: '' });
  }
  ui.draft = base;
  renderModal();
  setTimeout(() => $modal.querySelector('[autofocus], input, select')?.focus(), 50);
}
function closeModal() {
  ui.modal = null;
  renderModal();
}
function renderModal() {
  if (!ui.modal) { $modal.innerHTML = ''; document.body.style.overflow = ''; return; }
  $modal.innerHTML = `<div class="backdrop"><div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title">${modalHTML()}</div></div>`;
  document.body.style.overflow = 'hidden';
}

// ---------- Render principal ----------

const NAV = [['inicio', 'house', 'Inicio'], ['metas', 'target', 'Metas'], ['plan', 'chart.pie', 'Plan'], ['comida', 'fork.knife', 'Comida'], ['mas', 'ellipsis.circle', 'Más']];
// Títulos cortos para la barra de herramientas de macOS (HIG: menos de 15 caracteres).
const VIEW_TITLES = { inicio: 'Inicio', metas: 'Metas', plan: 'Plan mensual', comida: 'Alimentación', mas: 'Más', hogar: 'Hogar en pareja', pedido: 'Listas de compra', historial: 'Historial', ajustes: 'Ajustes', guia: 'Cómo funciona', consejos: 'Recomendaciones' };
const MONTH_VIEWS = ['inicio', 'plan', 'historial', 'consejos'];
const VIEWS = { inicio: viewInicio, metas: viewMetas, plan: viewPlan, comida: viewComida, mas: viewMas, hogar: viewHogar, pedido: viewPedido, historial: viewHistorial, ajustes: viewAjustes, guia: viewGuia, consejos: viewConsejos };

function render() {
  const active = document.activeElement?.dataset?.k;
  let caret = null;
  try { caret = document.activeElement.selectionStart; } catch { /* inputs numéricos */ }

  if (isNative && ui.view === 'mas') ui.view = 'inicio';
  if (!state.onboarded) {
    $app.innerHTML = viewOnb();
    postNative({ type: 'ui', view: '', title: 'Bienvenida', subtitle: `Paso ${ui.onbStep + 1} de 4`, onboarded: false });
  } else {
    const view = VIEWS[ui.view] ? ui.view : 'inicio';
    postNative({ type: 'ui', view, title: VIEW_TITLES[view], subtitle: MONTH_VIEWS.includes(view) ? monthLabel(ui.month) : '', onboarded: true });
    const tab = NAV.some(([v]) => v === view) ? view : 'mas';
    $app.innerHTML = `<div class="shell">
      <nav class="nav" aria-label="Secciones">
        <div class="brand"><img src="icons/icon.svg" alt="">Mis Finanzas</div>
        ${NAV.map(([v, ico, label]) => `<button data-action="go" data-view="${v}" ${v === tab ? 'aria-current="page"' : ''}><span class="ico">${sym(ico)}</span>${label}</button>`).join('')}
      </nav>
      <main>${VIEWS[view]()}</main>
    </div>`;
  }
  if (active) {
    const el = $app.querySelector(`[data-k="${CSS.escape(active)}"]`);
    if (el) { el.focus({ preventScroll: true }); try { if (caret != null) el.setSelectionRange(caret, caret); } catch { /* */ } }
  }
}

// ---------- Eventos ----------

// Al cambiar la moneda de gastos se convierten los costos guardados para que conserven su valor real.
function changeCostCurrency(el) {
  const previous = costCode();
  const oldRate = E.fxRate(state);
  state.settings.costCurrency = el.value;
  const factor = E.fxRate(state) / oldRate;
  if (factor !== 1 && !confirm(`Tus montos de sobres, metas y alimentos se convertirán de ${previous} a ${el.value} (1 ${baseCode()} = ${E.fxRate(state) === 1 ? oldRate : E.fxRate(state)} ${E.fxRate(state) === 1 ? previous : el.value}) para que conserven su valor. Revisa el tipo de cambio antes de continuar. ¿Convertir?`)) {
    state.settings.costCurrency = previous;
    render();
    return;
  }
  if (factor !== 1) { E.convertCosts(state, factor); touch('food'); }
  touch('settings');
  persist();
  render();
  if (factor !== 1) toast(`Costos convertidos a ${el.value}`);
}

function expenseHelp() {
  const e = envById(ui.draft.envId);
  if (!e) return '';
  const bal = E.envelopeBalance(state, e.id);
  const spend = E.envToBase(state, e, num(ui.draft.amount));
  const equiv = isDual() && !envIsBase(e) && num(ui.draft.amount) ? `= ${fmt(spend)} · ` : '';
  return `${equiv}Disponible: ${fmt(bal)}${spend > bal ? ' · ⚠️ No alcanza: mueve dinero de otro sobre (no del fondo de emergencia, salvo una emergencia real).' : ''}`;
}

function setPath(obj, path, value) {
  const keys = path.split('.');
  let o = obj;
  for (const k of keys.slice(0, -1)) o = o[k] ||= {};
  o[keys.at(-1)] = value;
}
function readValue(el) {
  if (el.dataset.type === 'bool') return el.checked;
  if (el.dataset.type === 'number') return num(el.value);
  return el.value;
}

document.addEventListener('change', (ev) => {
  const el = ev.target;
  if (el.dataset.bind) {
    if (el.dataset.bind === 'settings.costCurrency') return changeCostCurrency(el);
    if (el.dataset.bind === 'settings.currency' && costCode() === baseCode()) state.settings.costCurrency = el.value;
    setPath(state, el.dataset.bind, readValue(el));
    const section = el.dataset.bind.split('.')[0];
    if (['settings', 'partner', 'food'].includes(section)) touch(section);
    persist();
    scheduleRender();
  } else if (el.dataset.env) {
    const e = envById(el.dataset.env);
    if (!e) return;
    let v = readValue(el);
    if (el.dataset.field === 'name' && !String(v).trim()) v = e.name;
    setPath(e, el.dataset.field, v);
    e.updatedAt = Date.now();
    persist();
    scheduleRender();
  } else if (el.dataset.food) {
    const item = state.food.items[Number(el.dataset.food)];
    if (el.dataset.field === 'priceUnit') {
      item.priceUnit = el.value;
      if (isWeighed(item)) {
        item.priceGrams = 1000;
      } else {
        // Pieza, paquete o monto necesitan un dato más (peso, contenido o veces por semana): se abre la hoja.
        item.priceGrams = 0;
        touch('food');
        persist();
        render();
        openModal('alimento', { index: el.dataset.food });
        return;
      }
    } else {
      item[el.dataset.field] = num(el.value);
    }
    touch('food');
    persist();
    scheduleRender();
  } else if (el.dataset.orderItem != null || el.dataset.order) {
    const env = currentOrder();
    if (!env) return;
    if (el.dataset.order) {
      const k = el.dataset.order;
      env.order[k] = k === 'store' ? el.value : k === 'monthly' ? el.checked : num(el.value);
      // Al activar la compra fija, los productos existentes empiezan como fijos.
      if (k === 'monthly' && el.checked) for (const it of env.order.items) if (!it.frequency) it.frequency = E.itemFrequency(it);
    } else {
      const it = env.order.items[Number(el.dataset.orderItem)];
      const f = el.dataset.field;
      it[f] = f === 'selected' ? el.checked : f === 'name' ? (el.value.trim() || it.name) : f === 'frequency' ? el.value : num(el.value);
      if (f === 'frequency') delete it.occasional;
    }
    env.updatedAt = Date.now();
    persist();
    scheduleRender();
  } else if (el.dataset.envCurrency) {
    // Cambiar la moneda de un sobre convierte su monto para conservar su valor.
    const env = envById(el.dataset.envCurrency);
    const before = E.envToBase(state, env, 1);
    env.currency = el.value === costCode() ? undefined : el.value;
    const factor = before / E.envToBase(state, env, 1);
    const round = (n) => Math.round(num(n) * factor * 100) / 100;
    env.monthly = round(env.monthly);
    if (num(env.partnerAmount)) env.partnerAmount = round(env.partnerAmount);
    env.updatedAt = Date.now();
    persist();
    scheduleRender();
  } else if (el.dataset.onbSaldo) {
    ui.onbSaldo[el.dataset.onbSaldo] = el.value;
  } else if (el.matches('[data-theme-pick]')) {
    applyTheme(el.value);
  } else if (el.id === 'import-file' && el.files[0]) {
    importBackup(el.files[0]);
    el.value = '';
  } else if (el.matches('[data-order-list]')) {
    ui.orderId = el.value;
    render();
  } else if (el.dataset.meal && el.dataset.mealI != null) {
    const e = state.food.meals[el.dataset.meal][Number(el.dataset.mealI)];
    e[el.dataset.field] = el.dataset.field === 'unit' ? el.value : num(el.value);
    touch('food');
    persist();
    scheduleRender();
  } else if ((el.dataset.draft === 'productId' || el.dataset.draft === 'unit') && ui.modal === 'porcion') {
    ui.draft[el.dataset.draft] = el.value;
    if (el.dataset.draft === 'productId') Object.assign(ui.draft, nutritionDraft(el.value));
    renderModal();
  } else if (el.dataset.draft === 'to' && ui.modal === 'mover-lista') {
    ui.draft.to = el.value;
  } else if (el.dataset.draft === 'envId' && ui.modal === 'nueva-lista') {
    ui.draft.envId = el.value;
    renderModal();
  } else if (el.dataset.draft === 'priceUnit' && ui.modal === 'alimento') {
    ui.draft.priceUnit = el.value;
    renderModal();
  } else if (el.dataset.draft === 'currency') {
    // Al cambiar de moneda en Mover dinero se convierte el monto escrito.
    if (ui.modal === 'mover' && num(ui.draft.amount)) {
      const usd = E.toBase(state, num(ui.draft.amount), ui.draft.currency);
      ui.draft.amount = el.value === baseCode() ? usd : Math.round(E.baseToCost(state, usd) * 100) / 100;
    }
    ui.draft.currency = el.value;
    renderModal();
  } else if (el.dataset.draft && ui.modal === 'gasto' && el.dataset.draft === 'envId') {
    ui.draft.envId = el.value;
    renderModal();
  }
});

document.addEventListener('input', (ev) => {
  const el = ev.target;
  if (!el.dataset.draft) return;
  ui.draft[el.dataset.draft] = el.value;
  if (ui.modal === 'porcion' && el.dataset.draft === 'query') {
    document.getElementById('po-results').innerHTML = productResults(el.value);
  }
  if ((ui.modal === 'pago' || ui.modal === 'saldo') && ['amount', 'rate'].includes(el.dataset.draft)) {
    const eq = document.getElementById('fx-equiv');
    if (eq) eq.textContent = fxEquiv(ui.draft);
  }
  if (ui.modal === 'pago' && ['amount', 'date', 'rate'].includes(el.dataset.draft)) {
    document.getElementById('pay-preview').innerHTML = paymentPreview();
  }
  if (ui.modal === 'gasto' && el.dataset.draft === 'amount') {
    document.getElementById('exp-help').textContent = expenseHelp();
  }
});

const ACTIONS = {
  go: (el) => { ui.view = el.dataset.view; render(); window.scrollTo(0, 0); },
  month: (el) => { ui.month = E.addMonths(ui.month, Number(el.dataset.d)); render(); },
  open: (el) => openModal(el.dataset.modal, el.dataset),
  close: closeModal,
  'save-pago': () => {
    const d = ui.draft; const amount = draftBase(d);
    if (amount <= 0) return toast('Escribe un monto mayor a 0');
    if (!d.date) return toast('Elige una fecha');
    const r = E.allocate(state, amount, d.date);
    const payment = { id: E.uid(), kind: 'pago', date: d.date, amount, client: (d.client || '').trim(), note: d.note || '', alloc: r.alloc };
    if (d.currency !== baseCode()) payment.original = { amount: num(d.amount), currency: d.currency, rate: num(d.rate) };
    state.payments.push(payment);
    ui.month = E.monthKey(d.date);
    closeModal(); commit(`Repartido ${fmt(amount)} ✓`);
  },
  'save-gasto': () => {
    const d = ui.draft; const amount = num(d.amount);
    if (amount <= 0) return toast('Escribe un monto mayor a 0');
    // Se guarda en la moneda de ingresos con el tipo de cambio del día, y el monto original para mostrarlo.
    const target = envById(d.envId);
    const expense = { id: E.uid(), date: d.date, envId: d.envId, amount: Math.round(E.envToBase(state, target, amount) * 100) / 100, note: d.note || '' };
    if (isDual() && !envIsBase(target)) expense.original = { amount, currency: E.envCurrency(state, target), rate: E.fxRate(state) };
    state.expenses.push(expense);
    closeModal(); commit('Gasto guardado ✓');
  },
  'save-mover': () => {
    const d = ui.draft;
    if (num(d.amount) <= 0 || d.from === d.to) return toast('Elige un monto y dos sobres distintos');
    const amount = E.toBase(state, num(d.amount), d.currency || baseCode());
    const from = envById(d.from); const to = envById(d.to);
    const pair = E.uid();
    const original = d.currency && d.currency !== baseCode() ? { amount: num(d.amount), currency: d.currency, rate: E.fxRate(state) } : undefined;
    state.expenses.push({ id: E.uid(), pair, kind: 'transfer', date: d.date, envId: d.from, amount, note: `Movido a ${to.name}`, original });
    state.payments.push({ id: E.uid(), pair, kind: 'transfer', date: d.date, amount, client: '', note: `Desde ${from.name}`, alloc: { [d.to]: amount }, original });
    closeModal(); commit('Dinero movido ✓');
  },
  'save-saldo': () => {
    const d = ui.draft; const amount = draftBase(d);
    if (amount <= 0) return toast('Escribe un monto mayor a 0');
    const saldo = { id: E.uid(), kind: 'saldo', date: d.date, amount, client: '', note: 'Saldo inicial', alloc: { [d.envId]: amount } };
    if (d.currency !== baseCode()) saldo.original = { amount: num(d.amount), currency: d.currency, rate: num(d.rate) };
    state.payments.push(saldo);
    closeModal(); commit('Saldo registrado ✓');
  },
  'save-alimento': () => {
    const d = ui.draft;
    if (!d.name.trim()) return toast('Escribe el nombre del alimento');
    const priceUnit = PRICE_UNITS.includes(d.priceUnit) ? d.priceUnit : 'kg';
    const weighed = priceUnit === 'kg' || priceUnit === 'litro';
    if ((priceUnit === 'pieza' || priceUnit === 'paquete') && !num(d.priceGrams)) return toast(priceUnit === 'pieza' ? 'Escribe el peso aproximado de una pieza' : 'Escribe el contenido del paquete');
    if (priceUnit === 'monto' && !(num(d.perWeek) > 0)) return toast('Escribe cuántas veces por semana lo compras');
    const item = { name: d.name.trim(), grams: num(d.grams), kcal: num(d.kcal), protein: num(d.protein), fat: num(d.fat), carbs: num(d.carbs), fiber: num(d.fiber), price: num(d.price), priceUnit, priceGrams: weighed ? 1000 : priceUnit === 'monto' ? 0 : num(d.priceGrams) };
    if (priceUnit === 'monto') item.perWeek = num(d.perWeek);
    if (d.index != null) Object.assign(state.food.items[d.index], item);
    else state.food.items.push({ id: E.uid(), ...item });
    touch('food');
    closeModal(); commit(d.index != null ? 'Alimento actualizado ✓' : 'Alimento agregado ✓');
  },
  'order-unbuy': (el) => {
    const env = currentOrder();
    const it = env.order.items[Number(el.dataset.i)];
    delete it.lastBought;
    env.updatedAt = Date.now();
    commit(`“${it.name}” vuelve a estar pendiente`);
  },
  'ef-toggle': (el) => {
    const on = el.dataset.v === '1';
    if (!on && !confirm('¿Pausar el fondo de emergencia? Dejará de recibir dinero (aporte mensual, págate primero y excedente) hasta que lo actives. Su saldo se conserva.')) return;
    state.settings.emergencyEnabled = on;
    touch('settings');
    commit(on ? 'Fondo de emergencia activado ✓' : 'Fondo de emergencia en pausa');
  },
  'go-list': (el) => { ui.orderId = el.dataset.id; ui.view = envById(el.dataset.id)?.role === 'comida' ? 'comida' : 'pedido'; render(); window.scrollTo(0, 0); },
  'pick-product': (el) => {
    const n = (state.food.nutrition || {})[el.dataset.id];
    Object.assign(ui.draft, { productId: el.dataset.id, ...nutritionDraft(el.dataset.id), unit: n && num(n.pieceGrams) ? 'pza' : 'g' });
    renderModal();
    $modal.querySelector('#po-amt')?.focus();
  },
  'pick-clear': () => {
    ui.draft.productId = null;
    renderModal();
    $modal.querySelector('#po-q')?.focus();
  },
  'save-porcion': () => {
    const d = ui.draft;
    if (!d.productId) return toast('Busca y elige un alimento');
    if (!(num(d.amount) > 0)) return toast('Escribe la cantidad');
    if (!state.food.nutrition?.[d.productId]) {
      if (!saveNutrition(d)) return;
    }
    if (d.unit === 'pza' && !num(state.food.nutrition[d.productId].pieceGrams)) return toast('Indica el peso de una pieza en los datos nutricionales');
    (state.food.meals ||= {});
    (state.food.meals[d.meal] ||= []).push({ id: E.uid(), productId: d.productId, amount: num(d.amount), unit: d.unit });
    touch('food');
    closeModal(); commit('Agregado ✓');
  },
  'save-nutricion': () => { if (saveNutrition(ui.draft)) { closeModal(); commit('Datos nutricionales guardados ✓'); } },
  'del-portion': (el) => {
    const list = state.food.meals[el.dataset.meal];
    const index = Number(el.dataset.i);
    const [entry] = list.splice(index, 1);
    touch('food');
    commit();
    toast('Quitado del menú', { label: 'Deshacer', run: () => { list.splice(index, 0, entry); touch('food'); commit(); } });
  },
  'create-food-list': () => {
    const env = foodEnvelope();
    env.order = { monthly: true, store: '', shipping: 0, occasionalBudget: 0, items: [] };
    env.updatedAt = Date.now();
    commit('Lista de alimentación creada ✓');
  },
  'save-mover-lista': () => {
    const from = currentOrder();
    const to = envById(ui.draft.to);
    if (!from || !to) return;
    if (!to.order) to.order = { monthly: from.order.monthly, store: from.order.store || '', shipping: 0, occasionalBudget: 0, items: [] };
    const moved = from.order.items.map((item, index) => ({ item, index })).filter(({ item }) => item.selected);
    if (!moved.length) return toast('Marca primero los productos que quieres mover');
    const set = new Set(moved.map((m) => m.item));
    from.order.items = from.order.items.filter((it) => !set.has(it));
    for (const { item } of moved) { item.selected = false; to.order.items.push(item); }
    from.updatedAt = to.updatedAt = Date.now();
    closeModal();
    commit();
    const name = to.role === 'comida' ? 'Alimentación' : to.name;
    toast(`${moved.length} ${moved.length === 1 ? 'producto movido' : 'productos movidos'} a ${name}`, { label: 'Deshacer', run: () => {
      to.order.items = to.order.items.filter((it) => !set.has(it));
      for (const { item, index } of moved) from.order.items.splice(Math.min(index, from.order.items.length), 0, item);
      from.updatedAt = to.updatedAt = Date.now();
      commit('Movimiento deshecho');
    } });
  },
  'save-lista': () => {
    const d = ui.draft;
    const blank = { store: '', shipping: 0, items: [] };
    let env;
    if (d.envId === 'nuevo') {
      if (!d.name.trim()) return toast('Escribe el nombre de la lista');
      env = { id: E.uid(), name: d.name.trim(), icon: '🛒', group: 'necesidad', monthly: 0, priority: 9, partnerAmount: 0, order: blank, updatedAt: Date.now() };
      state.envelopes.push(env);
    } else {
      env = envById(d.envId);
      env.order = blank;
      env.updatedAt = Date.now();
    }
    ui.orderId = env.id;
    closeModal(); commit('Lista creada ✓');
  },
  'order-prune': () => {
    const env = currentOrder();
    const min = Number(document.getElementById('o-min')?.value) || 3;
    const removed = env.order.items.map((item, index) => ({ item, index })).filter(({ item }) => !item.timesPlus && num(item.times) < min);
    if (!removed.length) return toast(`Todos se compraron ${min} veces o más`);
    if (!confirm(`¿Quitar ${removed.length} productos comprados menos de ${min} veces? Quedarán ${env.order.items.length - removed.length}. Podrás deshacerlo.`)) return;
    const gone = new Set(removed.map((r) => r.item));
    env.order.items = env.order.items.filter((it) => !gone.has(it));
    env.updatedAt = Date.now();
    undoable(toTrash('productos', `${removed.length} productos de ${env.name}`, removed, { envId: env.id }), `${removed.length} productos quitados`);
  },
  'save-producto': () => {
    const d = ui.draft;
    const env = currentOrder();
    if (!env || !d.name.trim()) return toast('Escribe el nombre del producto');
    env.order.items.push({ id: E.uid(), name: d.name.trim(), price: num(d.price), qty: Math.max(1, Math.round(num(d.qty)) || 1), selected: true });
    env.updatedAt = Date.now();
    closeModal(); commit('Producto agregado ✓');
  },
  'del-order-item': (el) => {
    const env = currentOrder();
    const index = Number(el.dataset.i);
    const [item] = env.order.items.splice(index, 1);
    env.updatedAt = Date.now();
    undoable(toTrash('producto', item.name, item, { envId: env.id, index }), `“${item.name}” quitado de la lista`);
  },
  'order-mark': (el) => {
    const env = currentOrder();
    const v = el.dataset.v;
    const today = E.todayISO();
    for (const it of env.order.items) {
      if (E.FREQUENCIES.includes(v)) it.selected = E.itemFrequency(it) === v && !E.isBought(it, today);
      else it.selected = v === '1';
    }
    env.updatedAt = Date.now();
    commit();
  },
  'order-use-avg': () => {
    const env = currentOrder();
    const last = state.expenses.filter((x) => x.envId === env.id && x.order).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 3);
    if (!last.length) return;
    env.monthly = Math.ceil(last.reduce((s, x) => s + num(x.order.total), 0) / last.length);
    env.updatedAt = Date.now();
    commit('Presupuesto actualizado al promedio');
  },
  'save-order': () => {
    const env = currentOrder();
    const r = E.orderSummary(env);
    if (!r.total) return;
    const cur = E.envCurrency(state, env);
    if (!confirm(`¿Registrar la compra de ${fmtIn(r.total, cur)}? Se anotará ${r.partner ? `tu parte (${fmtIn(r.mine, cur)})` : 'ese monto'} como gasto del sobre “${env.name}”.`)) return;
    const expense = {
      id: E.uid(), date: E.todayISO(), envId: env.id,
      amount: Math.round(E.envToBase(state, env, r.mine) * 100) / 100,
      note: `${env.name} (${r.units} productos)`,
      order: { total: r.total, partner: r.partner, units: r.units, currency: cur, ...(env.order.monthly ? E.orderParts(env) : {}), items: env.order.items.filter((it) => it.selected && num(it.qty) > 0).map((it) => `${it.qty} × ${it.name}`) },
    };
    if (isDual() && !envIsBase(env)) expense.original = { amount: r.mine, currency: cur, rate: E.fxRate(state) };
    state.expenses.push(expense);
    // Los productos comprados quedan como "Comprado" y se desmarcan para la siguiente compra.
    for (const it of env.order.items) if (it.selected && num(it.qty) > 0) { it.lastBought = expense.date; it.selected = false; }
    env.updatedAt = Date.now();
    commit('Compra registrada ✓');
  },
  resolve: (el) => {
    const id = el.dataset.rec;
    const d = el.dataset;
    if (NAV_FIXES[id]) return NAV_FIXES[id](d);
    const fix = E.FIXES[id];
    if (!fix) return;
    const draft = structuredClone(state);
    const changes = fix(draft, ui.month, fmt);
    if (!changes) return (FIX_FALLBACK[id] || (() => toast('No hay nada que corregir automáticamente.')))(d);
    if (!confirm(`Resolver: ${d.title}\n\n• ${changes.join('\n• ')}\n\n¿Aplicar estos cambios?`)) return;
    state = draft;
    for (const section of E.FIX_SECTIONS[id] || []) touch(section);
    commit('Recomendación resuelta ✓');
  },
  'del-food': (el) => {
    const index = Number(el.dataset.i);
    const [item] = state.food.items.splice(index, 1);
    touch('food');
    undoable(toTrash('alimento', item.name, item, { index }), `“${item.name}” quitado del menú`);
  },
  'del-pay': (el) => {
    const pay = state.payments.find((p) => p.id === el.dataset.id);
    if (!pay) return;
    state.payments = state.payments.filter((p) => p.id !== pay.id);
    markDeleted(pay.id);
    // Un movimiento entre sobres tiene dos mitades: se borran juntas.
    const pairs = pay.pair ? state.expenses.filter((x) => x.pair === pay.pair) : [];
    if (pairs.length) {
      markDeleted(...pairs.map((x) => x.id));
      state.expenses = state.expenses.filter((x) => x.pair !== pay.pair);
    }
    const label = pay.kind === 'pago' ? `${pay.client || 'Pago'} · ${fmt(pay.amount)}` : `${pay.note || 'Movimiento'} · ${fmt(pay.amount)}`;
    undoable(toTrash('pago', label, pay, { expenses: pairs }), 'Movimiento borrado');
  },
  'del-exp': (el) => {
    const exp = state.expenses.find((x) => x.id === el.dataset.id);
    if (!exp) return;
    state.expenses = state.expenses.filter((x) => x.id !== exp.id);
    markDeleted(exp.id);
    const env = envById(exp.envId);
    undoable(toTrash('gasto', `${env ? env.name : 'Gasto'} · ${fmt(exp.amount)}${exp.note ? ` · ${exp.note}` : ''}`, exp), 'Gasto borrado');
  },
  'del-env': (el) => {
    const e = envById(el.dataset.id);
    const bal = E.envelopeBalance(state, e.id);
    if (bal > 0) return toast(`Primero mueve los ${fmt(bal)} de este sobre a otro`);
    const index = state.envelopes.findIndex((x) => x.id === e.id);
    state.envelopes = state.envelopes.filter((x) => x.id !== e.id);
    markDeleted(e.id);
    undoable(toTrash('sobre', e.name, e, { index }), `Sobre “${e.name}” eliminado`);
  },
  'add-env': () => {
    state.envelopes.push({ id: E.uid(), name: 'Nuevo sobre', icon: '✨', group: 'gusto', monthly: 0, priority: 10, updatedAt: Date.now() });
    commit('Sobre agregado al final de Gustos');
  },
  'add-goal': () => {
    state.envelopes.push({ id: E.uid(), name: 'Nueva meta', icon: '🎯', group: 'ahorro', monthly: 0, priority: 5, goal: { target: 0, date: E.addMonths(E.monthKey(new Date()), 11) }, updatedAt: Date.now() });
    commit('Meta creada: ponle precio y fecha. Cambia el nombre en Plan.');
  },
  'onb-next': () => {
    if (ui.onbStep < 3) { ui.onbStep += 1; render(); window.scrollTo(0, 0); return; }
    for (const [id, v] of Object.entries(ui.onbSaldo)) {
      if (num(v) > 0 && envById(id)) state.payments.push({ id: E.uid(), kind: 'saldo', date: E.todayISO(), amount: num(v), client: '', note: 'Saldo inicial', alloc: { [id]: num(v) } });
    }
    ui.onbSaldo = { emergencia: '', mac: '', iphone: '' };
    state.onboarded = true; touch('onboarded'); ui.view = 'inicio';
    commit('¡Tu plan está listo!');
  },
  'onb-back': () => { ui.onbStep -= 1; render(); },
  'save-sync': async (el) => {
    const d = ui.draft;
    const config = { repo: (d.repo || '').trim(), token: (d.token || '').trim(), passphrase: d.passphrase || '' };
    const msg = document.getElementById('sync-msg');
    const say = (text, ok = false) => { msg.textContent = text; msg.className = `small ${ok ? 'ink-2' : 'warn-ink'}`; };
    if (!config.repo || !config.token || config.passphrase.length < 8) return say('Completa los tres campos; la contraseña debe tener al menos 8 caracteres.');
    el.disabled = true;
    say('Conectando…', true);
    try {
      await Sync.checkRepo(config);
      const remoteState = await Sync.fetchRemoteState(config);
      const localHasData = Sync.hasMovements(state) || state.onboarded;
      if (remoteState && localHasData) {
        // Los dos lados tienen datos: nunca se reemplaza nada sin preguntar.
        Object.assign(ui.draft, { step: 'elegir', config, local: Sync.summarize(state), remote: Sync.summarize(remoteState) });
        renderModal();
        return;
      }
      await connectSync(config, remoteState ? 'remote' : 'merge');
    } catch (err) {
      el.disabled = false;
      say(err?.message || String(err));
    }
  },
  'sync-choose': async (el) => {
    const mode = el.dataset.mode;
    if (mode !== 'merge' && !confirm(mode === 'remote'
      ? '¿Reemplazar los datos de este dispositivo por los sincronizados? Se guardará una copia de los actuales.'
      : '¿Reemplazar los datos sincronizados por los de este dispositivo? Los otros dispositivos recibirán esta versión.')) return;
    for (const b of $modal.querySelectorAll('[data-action="sync-choose"]')) b.disabled = true;
    try {
      await connectSync(ui.draft.config, mode);
    } catch (err) {
      toast(err?.message || String(err));
      for (const b of $modal.querySelectorAll('[data-action="sync-choose"]')) b.disabled = false;
    }
  },
  'trash-restore': (el) => restoreTrash(el.dataset.id),
  'backup-pick': async (el) => {
    const entry = ui.draft.list[Number(el.dataset.i)];
    let data;
    try { data = JSON.parse(await readBackup(entry)); } catch { return toast('No se pudo leer esa copia.'); }
    const r = Sync.summarize(data);
    if (!confirm(`¿Restaurar la copia del ${new Date(entry.at).toLocaleString('es', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}?\n\nTiene ${r.pagos} pagos, ${r.gastos} gastos, ${r.sobres} sobres y ${r.alimentos} alimentos. Tus datos actuales se guardarán en una copia antes.`)) return;
    applyRestore(data);
  },
  'trash-empty': () => {
    if (!confirm('¿Vaciar la papelera? Lo que contiene ya no se podrá restaurar.')) return;
    state.trash = [];
    commit('Papelera vaciada');
  },
  'sync-now': () => runSync(),
  'sync-off': () => {
    if (!confirm('¿Desconectar la sincronización en este dispositivo? Tus datos locales se conservan.')) return;
    saveSyncConfig(null);
    syncState.config = null;
    render();
    toast('Sincronización desactivada');
  },
  export: () => { exportFile(state); if (!isNative) toast('Respaldo descargado'); },
  'replay-onb': () => { state.onboarded = false; touch('onboarded'); ui.onbStep = 0; commit(); },
  reset: () => {
    if (!confirm('Esto borra todos tus pagos, gastos y ajustes de este dispositivo y desconecta la sincronización (los datos sincronizados no se tocan). ¿Exportaste un respaldo?')) return;
    saveSyncConfig(null); syncState.config = null;
    state = defaultState(); ui.onbStep = 0; ui.view = 'inicio'; commit('Datos borrados');
  },
};

document.addEventListener('click', (ev) => {
  const el = ev.target.closest('[data-action]');
  if (!el) return;
  const fn = ACTIONS[el.dataset.action];
  if (fn) fn(el, ev);
});

document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && ui.modal) closeModal();
  if (ev.key === 'Enter' && ui.modal === 'porcion' && ev.target.id === 'po-q') {
    ev.preventDefault();
    $modal.querySelector('[data-action="pick-product"]')?.click();
    return;
  }
  if (ev.key === 'Enter' && ui.modal && ev.target.tagName === 'INPUT') {
    const btn = $modal.querySelector('.sheet-foot .btn.primary');
    if (btn) { ev.preventDefault(); btn.click(); }
  }
});

// Órdenes desde la barra lateral, la barra de herramientas y los menús de la app de Mac.
window.nativeAPI = {
  // La Mac avisa que datos.json cambió fuera de la app: se recargan esos datos en vez de sobrescribirlos.
  reloadData: (text) => {
    try { state = migrate(JSON.parse(text)); } catch { return; }
    ui.modal = null;
    renderModal();
    render();
    toast('Datos actualizados desde el archivo');
    scheduleSync(500);
  },
  go: (view) => { if (!state.onboarded) return; ui.modal = null; renderModal(); ui.view = view; render(); window.scrollTo(0, 0); },
  open: (modal) => { if (state.onboarded) openModal(modal); },
  month: (delta) => { ui.month = E.addMonths(ui.month, delta); render(); if (ui.modal === 'sobre') renderModal(); },
};

async function importBackup(file) {
  try {
    const data = migrate(JSON.parse(await file.text()));
    if (!confirm('Esto reemplaza los datos actuales con los del respaldo. Se guardará una copia de los actuales antes. ¿Continuar?')) return;
    applyRestore(data, 'Respaldo importado ✓');
  } catch {
    toast('Ese archivo no es un respaldo válido');
  }
}

// ---------- Tema ----------

function readTheme() {
  try { return localStorage.getItem('economia:theme') || 'auto'; } catch { return 'auto'; }
}
function applyTheme(v) {
  try { localStorage.setItem('economia:theme', v); } catch { /* sin almacenamiento */ }
  if (v === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.dataset.theme = v;
  postNative({ type: 'theme', value: v });
}
applyTheme(readTheme());

render();

// Sincroniza al abrir, al volver a la app, al recuperar la conexión y cada minuto mientras está visible.
if (syncState.config) runSync();
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') scheduleSync(300); });
window.addEventListener('online', () => scheduleSync(300));
setInterval(() => { if (document.visibilityState === 'visible') scheduleSync(0); }, 60000);

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
