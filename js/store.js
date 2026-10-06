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

const FOOD_ITEMS = [
  // Valores por 100 g (crudo). priceUnit: cómo se vende (kg, litro, pieza o paquete);
  // priceGrams: gramos o ml que cubre el precio (1000 en kg y litro; peso de la pieza o contenido del paquete).
  { id: 'avena', name: 'Avena en hojuelas', grams: 100, kcal: 389, protein: 16.9, fat: 6.9, carbs: 66, fiber: 10.6, price: 3, priceGrams: 1000, priceUnit: 'kg' },
  { id: 'leche', name: 'Leche entera', grams: 500, kcal: 61, protein: 3.2, fat: 3.3, carbs: 4.8, fiber: 0, price: 1.5, priceGrams: 1000, priceUnit: 'litro' },
  { id: 'huevo', name: 'Huevos (4 unidades)', grams: 200, kcal: 143, protein: 12.6, fat: 9.5, carbs: 0.7, fiber: 0, price: 0.25, priceGrams: 50, priceUnit: 'pieza' },
  { id: 'pollo', name: 'Pechuga de pollo', grams: 400, kcal: 120, protein: 22.5, fat: 2.6, carbs: 0, fiber: 0, price: 6, priceGrams: 1000, priceUnit: 'kg' },
  { id: 'arroz', name: 'Arroz blanco (crudo)', grams: 150, kcal: 360, protein: 6.6, fat: 0.6, carbs: 79, fiber: 1.3, price: 1.8, priceGrams: 1000, priceUnit: 'kg' },
  { id: 'frijol', name: 'Frijoles negros (secos)', grams: 100, kcal: 341, protein: 21.6, fat: 1.4, carbs: 62, fiber: 15.5, price: 3, priceGrams: 1000, priceUnit: 'kg' },
  { id: 'platano', name: 'Plátano / banano (2)', grams: 240, kcal: 89, protein: 1.1, fat: 0.3, carbs: 23, fiber: 2.6, price: 1.5, priceGrams: 1000, priceUnit: 'kg' },
  { id: 'aceite', name: 'Aceite de oliva', grams: 20, kcal: 884, protein: 0, fat: 100, carbs: 0, fiber: 0, price: 9, priceGrams: 1000, priceUnit: 'litro' },
  { id: 'mani', name: 'Mantequilla de maní', grams: 30, kcal: 588, protein: 25, fat: 50, carbs: 20, fiber: 6, price: 8, priceGrams: 1000, priceUnit: 'kg' },
  { id: 'aguacate', name: 'Aguacate', grams: 100, kcal: 160, protein: 2, fat: 14.7, carbs: 8.5, fiber: 6.7, price: 4, priceGrams: 1000, priceUnit: 'kg' },
  { id: 'verdura', name: 'Verduras variadas', grams: 300, kcal: 34, protein: 2.8, fat: 0.4, carbs: 7, fiber: 2.6, price: 3, priceGrams: 1000, priceUnit: 'kg' },
  { id: 'creatina', name: 'Creatina (5 g)', grams: 5, kcal: 0, protein: 0, fat: 0, carbs: 0, fiber: 0, price: 25, priceGrams: 300, priceUnit: 'paquete' },
];

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
      env('comida', 'Alimentación', '🥗', 'necesidad', { role: 'comida', priority: 2 }),
      env('hogar', 'Súper y gastos del hogar', '🛒', 'necesidad', { priority: 3, shared: true }),
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
    food: {
      linked: true,
      wastePct: 10,
      people: 1,         // personas que comen este menú (la compra y el costo se multiplican)
      netCarbs: false,   // comparar carbohidratos netos (sin fibra) en lugar de totales
      extraMonthly: 20,
      targets: { kcal: 3150, protein: 197, fat: 105, carbs: 355, fiber: 44 },
      items: FOOD_ITEMS.map((x) => ({ ...x })),
    },
  };
}

export function load() {
  try {
    const raw = isNative ? window.__NATIVE__?.data : localStorage.getItem(KEY);
    if (!raw) return defaultState();
    return migrate(JSON.parse(raw));
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

// Completa campos que falten si el respaldo viene de una versión anterior.
export const PRICE_UNITS = ['kg', 'litro', 'pieza', 'paquete'];

// Completa la unidad de venta de alimentos guardados con la versión anterior (priceLabel).
export function normalizeFoodItem(item) {
  const it = { ...item };
  if (!PRICE_UNITS.includes(it.priceUnit)) {
    const legacy = { kg: 'kg', litro: 'litro', unidad: 'pieza' }[it.priceLabel];
    it.priceUnit = legacy || (Number(it.priceGrams) === 1000 || !it.priceGrams ? 'kg' : 'paquete');
  }
  if (it.priceUnit === 'kg' || it.priceUnit === 'litro') it.priceGrams = 1000;
  delete it.priceLabel;
  return it;
}

export function migrate(data) {
  const base = defaultState();
  if (!data || typeof data !== 'object' || !Array.isArray(data.envelopes)) throw new Error('Archivo no válido');
  return {
    ...base,
    ...data,
    settings: { ...base.settings, ...data.settings, surplus: { ...base.settings.surplus, ...(data.settings || {}).surplus } },
    partner: { ...base.partner, ...data.partner },
    food: {
      ...base.food,
      ...data.food,
      targets: { ...base.food.targets, ...(data.food || {}).targets },
      items: ((data.food || {}).items || base.food.items).map(normalizeFoodItem),
    },
    payments: data.payments || [],
    expenses: data.expenses || [],
    meta: data.meta || {},
    deleted: data.deleted || {},
    updatedAt: Number(data.updatedAt) || 0,
  };
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
