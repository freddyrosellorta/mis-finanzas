// Estado inicial, guardado en el dispositivo y respaldos.
import { addMonths, monthKey } from './engine.js';

const KEY = 'economia:v1';

// En la app de Mac los datos viven en un archivo que administra el lado nativo (mac/main.swift).
const native = typeof window !== 'undefined' ? window.webkit?.messageHandlers?.store : null;
export const isNative = Boolean(native);
export const postNative = (msg) => native?.postMessage(msg);

// Configuración de sincronización (repositorio, token y contraseña): nunca viaja dentro de los datos.
// En la Mac la guarda el lado nativo en Application Support; en el iPhone, el almacenamiento del navegador.
const SYNC_KEY = 'economia:sincronizacion';
export function loadSyncConfig() {
  try {
    const raw = isNative ? window.__NATIVE__?.secrets : localStorage.getItem(SYNC_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
export function saveSyncConfig(config) {
  const raw = config ? JSON.stringify(config) : null;
  if (isNative) {
    native.postMessage({ type: 'secrets', value: raw });
    if (window.__NATIVE__) window.__NATIVE__.secrets = raw;
    return;
  }
  try {
    if (raw) localStorage.setItem(SYNC_KEY, raw);
    else localStorage.removeItem(SYNC_KEY);
  } catch { /* sin almacenamiento */ }
}

export function defaultState() {
  const month = monthKey(new Date());
  const inAYear = addMonths(month, 11);
  const env = (id, name, icon, group, extra = {}) => ({ id, name, icon, group, monthly: 0, priority: 50, ...extra });
  return {
    version: 1,
    onboarded: false,
    // Marcas de tiempo para fusionar entre dispositivos (ver js/sync.js).
    updatedAt: 0,
    meta: {},
    deleted: {},
    restored: {},
    trash: [],        // papelera de este dispositivo (30 días)
    settings: {
      name: '',
      currency: 'USD',
      // Moneda en la que se capturan los costos y tipo de cambio (unidades por 1 de la moneda de ingresos).
      costCurrency: 'USD',
      fxRate: 16,
      incomeEstimate: 0,
      taxPct: 10,
      payFirstPct: 10,
      emergencyMonths: 6,
      emergencyHorizon: 12,
      surplus: { emergencia: 50, metas: 30, libre: 20 },
    },
    partner: { name: 'Mi pareja', income: 0, mode: 'yo100', symbolic: 0 },
    envelopes: [
      env('renta', 'Renta', '🏠', 'necesidad', { role: 'renta', priority: 1, shared: true }),
      env('hogar', 'Súper y comida', '🛒', 'necesidad', { priority: 2, shared: true }),
      env('servicios', 'Luz, agua y gas', '💡', 'necesidad', { priority: 4, shared: true }),
      env('internet', 'Internet de la casa', '📶', 'necesidad', { role: 'internet', priority: 5, shared: true, pending: true }),
      env('movil', 'Plan del móvil', '📱', 'necesidad', { role: 'movil', priority: 6 }),
      env('taxis', 'Taxis y transporte', '🚕', 'necesidad', { priority: 7 }),
      env('gym', 'Gimnasio', '🏋️', 'necesidad', { priority: 8 }),
      env('emergencia', 'Fondo de emergencia', '🛟', 'ahorro', { role: 'emergencia', priority: 1 }),
      env('mac', 'Mac (herramienta de trabajo)', '💻', 'ahorro', { priority: 2, goal: { target: 0, date: inAYear } }),
      env('iphone', 'iPhone (herramienta de trabajo)', '📲', 'ahorro', { priority: 3, goal: { target: 0, date: inAYear } }),
      env('inversion', 'Inversión a largo plazo', '📈', 'ahorro', { role: 'inversion', priority: 9 }),
      env('ropa', 'Ropa y accesorios', '👔', 'profesional', { priority: 1 }),
      env('cuidado', 'Cuidado personal (barbería, piel)', '💈', 'profesional', { priority: 2 }),
      env('salidas', 'Salidas en pareja', '🍽️', 'gusto', { priority: 1 }),
      env('libre', 'Dinero libre', '🎉', 'gusto', { role: 'libre', priority: 2 }),
      env('impuestos', 'Impuestos', '🧾', 'impuestos', { role: 'impuestos', priority: 0 }),
    ],
    payments: [],
    expenses: [],
  };
}

export function load() {
  try {
    const raw = isNative ? window.__NATIVE__?.data : localStorage.getItem(KEY);
    if (!raw) return defaultState();
    const data = JSON.parse(raw);
    const state = migrate(data);
    // Datos de la versión con Alimentación aparte: se guardan ya unidos para no repetir la migración.
    if (data.food || data.envelopes.some((e) => e.role === 'comida')) save(state);
    return state;
  } catch {
    return defaultState();
  }
}

export function save(state) {
  try {
    if (isNative) {
      native.postMessage({ type: 'save', data: JSON.stringify(state, null, 2) });
      return true;
    }
    localStorage.setItem(KEY, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

// Antes la comida tenía su propio sobre y lista (Alimentación, con menú y nutrición) aparte del súper.
// Ahora todo va en una sola lista: los productos, el dinero y los gastos de Alimentación pasan al sobre
// del súper. Da el mismo resultado en cada dispositivo y deja una marca de borrado para que la
// sincronización no reviva el sobre viejo. Los movimientos entre ambos sobres ya no tienen sentido y se quitan.
export function mergeFoodIntoHome(state) {
  const food = state.envelopes.find((e) => e.role === 'comida');
  if (!food) return state;
  const home = state.envelopes.find((e) => e.id === 'hogar');
  const now = Date.now();
  if (!home) {
    delete food.role;
    food.updatedAt = now;
    return state;
  }
  if (food.order) {
    home.order ||= { monthly: true, items: [] };
    const ids = new Set(home.order.items.map((it) => it.id));
    home.order.items = [...food.order.items.filter((it) => !ids.has(it.id)), ...home.order.items];
    home.order.monthly = Boolean(home.order.monthly || food.order.monthly);
    const occasional = (Number(home.order.occasionalBudget) || 0) + (Number(food.order.occasionalBudget) || 0);
    if (occasional) home.order.occasionalBudget = occasional;
  }
  if (!home.order?.monthly) home.monthly = (Number(home.monthly) || 0) + (Number(food.monthly) || 0);
  home.priority = Math.min(Number(home.priority) || 99, Number(food.priority) || 99);
  if (home.name === 'Súper y gastos del hogar') home.name = 'Súper y comida';
  home.updatedAt = now;

  const both = new Set([food.id, home.id]);
  const internal = new Set(state.expenses.filter((x) => x.kind === 'transfer' && both.has(x.envId)).map((x) => x.pair)
    .filter((pair) => pair && state.payments.some((p) => p.pair === pair && Object.keys(p.alloc || {}).every((id) => both.has(id)))));
  state.deleted ||= {};
  const keep = (x) => {
    if (!(x.kind === 'transfer' && internal.has(x.pair))) return true;
    state.deleted[x.id] = now;
    return false;
  };
  state.expenses = state.expenses.filter(keep).map((x) => (x.envId === food.id ? { ...x, envId: home.id } : x));
  state.payments = state.payments.filter(keep).map((p) => {
    if (!p.alloc || !(food.id in p.alloc)) return p;
    const alloc = { ...p.alloc };
    alloc[home.id] = Math.round(((Number(alloc[home.id]) || 0) + (Number(alloc[food.id]) || 0)) * 100) / 100;
    delete alloc[food.id];
    return { ...p, alloc };
  });
  state.envelopes = state.envelopes.filter((e) => e !== food);
  state.deleted[food.id] = now;
  return state;
}

export function migrate(data) {
  const base = defaultState();
  if (!data || typeof data !== 'object' || !Array.isArray(data.envelopes)) throw new Error('Archivo no válido');
  const state = {
    ...base,
    ...data,
    settings: { ...base.settings, ...data.settings, surplus: { ...base.settings.surplus, ...(data.settings || {}).surplus } },
    partner: { ...base.partner, ...data.partner },
    payments: data.payments || [],
    expenses: data.expenses || [],
    meta: data.meta || {},
    restored: data.restored || {},
    trash: (data.trash || []).filter((t) => t.kind !== 'alimento' && Date.now() - (Number(t.at) || 0) < 30 * 86400000),
    deleted: data.deleted || {},
    updatedAt: Number(data.updatedAt) || 0,
  };
  // Ya no hay menú ni datos de nutrición.
  delete state.food;
  delete state.meta.food;
  return mergeFoodIntoHome(state);
}

export function exportFile(state) {
  const filename = `respaldo-finanzas-${new Date().toISOString().slice(0, 10)}.json`;
  if (isNative) {
    native.postMessage({ type: 'export', data: JSON.stringify(state, null, 2), filename });
    return;
  }
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
