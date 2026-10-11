// Motor financiero: funciones puras sin acceso al DOM ni al almacenamiento.
// Todo el dinero se calcula en centavos para evitar errores de redondeo.

export const GROUPS = {
  necesidad: { label: 'Necesidades', hint: 'Lo que te mantiene vivo, sano y trabajando' },
  profesional: { label: 'Imagen profesional', hint: 'Inversión en tu presencia en el medio' },
  ahorro: { label: 'Ahorro y metas', hint: 'Fondo de emergencia, herramientas e inversión' },
  gusto: { label: 'Gustos', hint: 'Disfrute sin culpa, ya presupuestado' },
  impuestos: { label: 'Impuestos', hint: 'Dinero que no es tuyo: se aparta primero' },
};
// Orden en que la cascada llena los sobres de cada mes.
export const WATERFALL_ORDER = ['necesidad', 'ahorro', 'profesional', 'gusto'];

export const toCents = (n) => Math.round((Number(n) || 0) * 100);
export const fromCents = (c) => c / 100;

export function monthKey(date) {
  const d = typeof date === 'string' ? new Date(date + 'T12:00:00') : date;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function todayISO() {
  const d = new Date();
  return `${monthKey(d)}-${String(d.getDate()).padStart(2, '0')}`;
}

export function addMonths(month, n) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return monthKey(d);
}

// Meses entre `from` y `to` contando ambos extremos (mínimo 1).
export function monthsBetween(from, to) {
  const [fy, fm] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  return Math.max(1, (ty - fy) * 12 + (tm - fm) + 1);
}

export const uid = () => Math.random().toString(36).slice(2, 10);

// Solo los pagos de clientes son ingreso; saldos iniciales y transferencias entre sobres no.
export const isIncome = (p) => !p.kind || p.kind === 'pago';

// ---------- Saldos ----------

export function envelopeBalance(state, envId, beforeMonth = null) {
  let cents = 0;
  for (const p of state.payments) {
    if (beforeMonth && p.kind !== 'saldo' && monthKey(p.date) >= beforeMonth) continue;
    cents += toCents(p.alloc[envId] || 0);
  }
  for (const e of state.expenses) {
    if (e.envId !== envId) continue;
    if (beforeMonth && monthKey(e.date) >= beforeMonth) continue;
    cents -= toCents(e.amount);
  }
  return fromCents(cents);
}

// Lo que recibió un sobre por pagos de clientes en un mes (sin contar saldos iniciales).
export function fundedInMonth(state, envId, month) {
  let cents = 0;
  for (const p of state.payments) {
    if (p.kind === 'saldo' || monthKey(p.date) !== month) continue;
    cents += toCents(p.alloc[envId] || 0);
  }
  // Lo que se movió a otro sobre ya no cuenta como recibido por este.
  for (const x of state.expenses) {
    if (x.kind === 'transfer' && x.envId === envId && monthKey(x.date) === month) cents -= toCents(x.amount);
  }
  return fromCents(Math.max(0, cents));
}

export function spentInMonth(state, envId, month) {
  return fromCents(state.expenses
    .filter((e) => e.envId === envId && e.kind !== 'transfer' && monthKey(e.date) === month)
    .reduce((s, e) => s + toCents(e.amount), 0));
}

// ---------- Ingresos ----------

export function incomeInMonth(state, month) {
  return fromCents(state.payments
    .filter((p) => isIncome(p) && monthKey(p.date) === month)
    .reduce((s, p) => s + toCents(p.amount), 0));
}

// Ingreso de referencia: promedio de los últimos 3 meses cerrados con datos;
// si no hay historial, la estimación que diste en ajustes.
export function referenceIncome(state, month) {
  const values = [1, 2, 3].map((i) => incomeInMonth(state, addMonths(month, -i))).filter((v) => v > 0);
  if (values.length === 0) return Number(state.settings.incomeEstimate) || 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

// ---------- Pareja ----------

export function partnerShare(state, month) {
  const p = state.partner;
  const shared = state.envelopes.filter((e) => e.shared);
  const sharedTotal = shared.reduce((s, e) => s + baseMonthly(state, e, month), 0);
  const herIncome = Number(p.income) || 0;
  const myIncome = referenceIncome(state, month);
  let share = 0;
  if (p.mode === 'proporcional' && herIncome + myIncome > 0) share = herIncome / (herIncome + myIncome);
  if (p.mode === 'simbolico' && sharedTotal > 0) share = Math.min(1, (Number(p.symbolic) || 0) / sharedTotal);
  const herAmount = sharedTotal * share;
  return {
    share,
    sharedTotal,
    herAmount,
    myAmount: sharedTotal - herAmount,
    herPctOfIncome: herIncome > 0 ? herAmount / herIncome : 0,
    myPctOfIncome: myIncome > 0 ? (sharedTotal - herAmount) / myIncome : 0,
  };
}

// ---------- Monedas ----------
// Los ingresos y saldos están en la moneda de ingresos (settings.currency, p. ej. USD).
// Los costos (montos de sobres, precios de metas y de las listas) se capturan en la moneda de gastos
// (settings.costCurrency, p. ej. MXN). fxRate = unidades de la moneda de gastos por 1 de ingresos.

export function fxRate(state) {
  const s = state.settings;
  if (!s.costCurrency || s.costCurrency === s.currency) return 1;
  return Number(s.fxRate) > 0 ? Number(s.fxRate) : 1;
}
export const costToBase = (state, amount) => (Number(amount) || 0) / fxRate(state);

// Convierte dinero recibido en otra moneda a la de ingresos. `rate` = unidades de esa moneda por 1 de ingresos
// (si no se indica, el tipo de cambio de Ajustes).
export function toBase(state, amount, currency, rate) {
  const n = Number(amount) || 0;
  if (!currency || currency === state.settings.currency) return n;
  const r = Number(rate) > 0 ? Number(rate) : fxRate(state);
  return Math.round((n / r) * 100) / 100;
}
export const baseToCost = (state, amount) => (Number(amount) || 0) * fxRate(state);

// Envelopes cuyo monto mensual se escribe a mano (los demás se calculan solos).
export const isManualEnvelope = (env) => !env.goal && !['emergencia', 'inversion', 'libre', 'impuestos'].includes(env.role);

export function goalTarget(state, env) {
  return costToBase(state, env.goal?.target);
}

// Convierte todos los costos guardados por un factor (al cambiar la moneda de gastos) para conservar su valor.
// Un sobre puede tener su propia moneda (p. ej. un pedido que se paga en USD); si no, usa la moneda de gastos.
export const envCurrency = (state, env) => env.currency || state.settings.costCurrency || state.settings.currency;
export function envToBase(state, env, amount) {
  return envCurrency(state, env) === state.settings.currency ? Number(amount) || 0 : costToBase(state, amount);
}

// Resumen del pedido de un sobre con lista de productos (en la moneda del sobre).
// ---------- Compra fija mensual ----------
// Una lista puede ser "fija mensual": sus productos fijos (precio × cantidad para un mes) más un margen
// para compras ocasionales forman el presupuesto del sobre, y se reparte semana a semana.

export const isMonthlyList = (env) => Boolean(env.order && env.order.monthly);
// Frecuencia de un producto: semanal, mensual u ocasional (los antiguos "fijos" son mensuales).
// La cantidad de cada producto es por periodo: semanal = por semana, quincenal = por quincena,
// mensual = por mes, ocasional = por compra (lo cubre el margen de ocasionales).
export const FREQUENCIES = ['semanal', 'quincenal', 'mensual', 'ocasional'];
export const WEEKS_PER_MONTH = 52 / 12;
const lineCost = (it) => (Number(it.price) || 0) * (Number(it.qty) || 0);
export const itemFrequency = (it) => (FREQUENCIES.includes(it.frequency) ? it.frequency : it.occasional ? 'ocasional' : 'mensual');
export const isFixedItem = (it) => itemFrequency(it) !== 'ocasional';

// Lunes de la semana de una fecha (semanas de lunes a domingo, aunque crucen de mes).
export function mondayOf(dateISO) {
  const d = new Date(dateISO + 'T12:00:00');
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ¿Ya se compró en el periodo actual? Mensual: este mes. Semanal: esta semana. Ocasional: nunca "pendiente".
// Un producto queda como comprado durante su periodo completo contado desde la compra: semanal 7 días,
// quincenal 15 días y mensual hasta el mismo día del mes siguiente (o el último día si ese mes es más corto).
export function nextBuyDate(it) {
  if (!it.lastBought) return null;
  const f = itemFrequency(it);
  if (f === 'ocasional') return null;
  const [y, m, d] = it.lastBought.split('-').map(Number);
  const date = f === 'mensual'
    ? new Date(y, m, Math.min(d, new Date(y, m + 1, 0).getDate()), 12)
    : new Date(y, m - 1, d + (f === 'semanal' ? 7 : 15), 12);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
export function isBought(it, todayISO) {
  const next = nextBuyDate(it);
  return Boolean(next) && todayISO < next;
}

export function monthlyListBudget(env) {
  const items = (env.order && env.order.items) || [];
  const r = (n) => Math.round(n * 100) / 100;
  const sumOf = (f) => items.filter((it) => itemFrequency(it) === f).reduce((s, it) => s + lineCost(it), 0);
  const perWeek = sumOf('semanal');
  const perFortnight = sumOf('quincenal');
  const weekly = perWeek * WEEKS_PER_MONTH;           // equivalente al mes
  const fortnightly = perFortnight * 2;
  const monthly = sumOf('mensual');
  const occasional = Number(env.order && env.order.occasionalBudget) || 0;
  const fixed = weekly + fortnightly + monthly;
  return { perWeek: r(perWeek), perFortnight: r(perFortnight), weekly: r(weekly), fortnightly: r(fortnightly), monthly: r(monthly), fixed: r(fixed), occasional, total: r(fixed + occasional) };
}

// Partes de una compra registrada desde la lista (en la moneda del sobre) para separar la semana de lo periódico.
export function orderParts(env) {
  const chosen = ((env.order && env.order.items) || []).filter((it) => it.selected && (Number(it.qty) || 0) > 0);
  const part = (f) => Math.round(chosen.filter((it) => itemFrequency(it) === f).reduce((s, it) => s + lineCost(it), 0) * 100) / 100;
  return { weeklyPart: part('semanal'), fortnightPart: part('quincenal'), monthlyPart: part('mensual') };
}

// Monto de un gasto en la moneda del sobre (los gastos se guardan en la moneda de ingresos).
export function expenseInEnvCurrency(state, env, x) {
  const cur = envCurrency(state, env);
  if (x.original && x.original.currency === cur) return Number(x.original.amount) || 0;
  return cur === state.settings.currency ? Number(x.amount) || 0 : baseToCost(state, x.amount);
}

// Semanas de lunes a domingo dentro del mes: índice (0…) de cada día y total de semanas.
function weekIndex(dateISO) {
  const d = new Date(dateISO + 'T12:00:00');
  const first = new Date(d.getFullYear(), d.getMonth(), 1, 12);
  const offset = (first.getDay() + 6) % 7; // lunes = 0
  return Math.floor((d.getDate() - 1 + offset) / 7);
}
function weeksInMonth(month) {
  const [y, m] = month.split('-').map(Number);
  const last = new Date(y, m, 0, 12).getDate();
  return weekIndex(`${month}-${String(last).padStart(2, '0')}`) + 1;
}

// Cuánto se puede gastar en la semana de `dateISO` (en la moneda del sobre): lo que queda del presupuesto
// del mes al empezar la semana, repartido entre las semanas que faltan, menos lo gastado esta semana.
// En una lista fija, la semana reparte solo semanales y ocasionales: la compra mensual va aparte
// (de cada compra registrada se descuenta la parte de productos mensuales, `order.monthlyPart`).
export function weeklyAllowance(state, env, dateISO, budget = null) {
  const month = dateISO.slice(0, 7);
  const r = (n) => Math.round(n * 100) / 100;
  if (isMonthlyList(env) && budget == null) return listWeek(state, env, dateISO);
  const total = budget ?? (Number(env.monthly) || 0);
  const wk = weekIndex(dateISO);
  const weeks = weeksInMonth(month);
  let before = 0;
  let thisWeek = 0;
  for (const x of state.expenses) {
    if (x.envId !== env.id || x.kind === 'transfer' || monthKey(x.date) !== month) continue;
    const amount = expenseInEnvCurrency(state, env, x);
    if (weekIndex(x.date) < wk) before += amount; else if (weekIndex(x.date) === wk) thisWeek += amount;
  }
  const weeksLeft = weeks - wk;
  const forWeek = Math.max(0, (total - before) / weeksLeft);
  return { budget: total, week: wk + 1, weeks, weeksLeft, forWeek: r(forWeek), spentWeek: r(thisWeek), canSpend: r(forWeek - thisWeek), spentMonth: r(before + thisWeek), leftMonth: r(total - before - thisWeek) };
}

// Semana de una lista fija: el costo semanal exacto (cantidades por semana) más el margen de ocasionales
// que queda, repartido entre las semanas restantes. Quincenales y mensuales se compran aparte.
function listWeek(state, env, dateISO) {
  const month = dateISO.slice(0, 7);
  const b = monthlyListBudget(env);
  const wk = weekIndex(dateISO);
  const weeksLeft = weeksInMonth(month) - wk;
  let occBefore = 0;
  let weekSpent = 0;
  let occSpent = 0;
  for (const x of state.expenses) {
    if (x.envId !== env.id || x.kind === 'transfer' || monthKey(x.date) !== month) continue;
    const amount = expenseInEnvCurrency(state, env, x);
    const o = x.order;
    const total = o && Number(o.total) > 0 ? Number(o.total) : 0;
    // Gasto sin detalle (ocasional rápido) o la parte de una compra que no era semanal ni periódica.
    const periodic = total ? Math.min(1, ((Number(o.fortnightPart) || 0) + (Number(o.monthlyPart) || 0)) / total) : 0;
    const weeklyShare = total ? Math.min(1 - periodic, (Number(o.weeklyPart) || 0) / total) : 0;
    const occasional = amount * (1 - periodic - weeklyShare);
    occSpent += occasional;
    if (weekIndex(x.date) < wk) occBefore += occasional;
    else if (weekIndex(x.date) === wk) weekSpent += occasional + amount * weeklyShare;
  }
  const r = (n) => Math.round(n * 100) / 100;
  const occLeft = Math.max(0, b.occasional - occBefore);
  const forWeek = b.perWeek + occLeft / weeksLeft;
  return {
    budget: b.total, week: wk + 1, weeks: weeksInMonth(month), weeksLeft,
    perWeek: b.perWeek, occasionalLeft: r(Math.max(0, b.occasional - occSpent)),
    forWeek: r(forWeek), spentWeek: r(weekSpent), canSpend: r(forWeek - weekSpent),
    leftMonth: r(b.perWeek * weeksLeft + occLeft - weekSpent),
  };
}

// Saldo de un sobre en su propia moneda.
export function balanceInEnv(state, env) {
  const usdPerUnit = envToBase(state, env, 1);
  return usdPerUnit ? envelopeBalance(state, env.id) / usdPerUnit : 0;
}

export function orderSummary(env) {
  const order = env.order || { items: [], shipping: 0 };
  const chosen = (order.items || []).filter((it) => it.selected && Number(it.qty) > 0);
  const products = chosen.reduce((s, it) => s + (Number(it.price) || 0) * (Number(it.qty) || 0), 0);
  const shipping = chosen.length ? Number(order.shipping) || 0 : 0;
  const total = Math.round((products + shipping) * 100) / 100;
  const partner = Math.min(total, Number(env.partnerAmount) || 0);
  const budget = isMonthlyList(env) ? monthlyListBudget(env).total : Number(env.monthly) || 0;
  return {
    items: chosen.length,
    units: chosen.reduce((s, it) => s + (Number(it.qty) || 0), 0),
    products, shipping, total, partner,
    mine: Math.round((total - partner) * 100) / 100,
    budget,
    diff: Math.round((budget - total) * 100) / 100,
    missingPrices: chosen.filter((it) => !(Number(it.price) > 0)).length,
  };
}

export function convertCosts(state, factor) {
  const round = (n) => Math.round((Number(n) || 0) * factor * 100) / 100;
  const now = Date.now();
  for (const env of state.envelopes) {
    if (env.currency) continue; // los sobres con moneda propia no cambian
    if (env.order) {
      for (const it of env.order.items || []) it.price = round(it.price);
      env.order.shipping = round(env.order.shipping);
      if (env.order.occasionalBudget) env.order.occasionalBudget = round(env.order.occasionalBudget);
      env.updatedAt = now;
    }
    if (isManualEnvelope(env) && Number(env.partnerAmount)) env.partnerAmount = round(env.partnerAmount);
    if (isManualEnvelope(env) && Number(env.monthly)) { env.monthly = round(env.monthly); env.updatedAt = now; }
    if (env.goal && Number(env.goal.target)) { env.goal.target = round(env.goal.target); env.updatedAt = now; }
  }
}

// ---------- Metas mensuales ----------

function baseMonthly(state, env, month) {
  // Lista fija mensual: el presupuesto es lo fijo más el margen para ocasionales.
  const monthly = isMonthlyList(env) ? monthlyListBudget(env).total : Number(env.monthly) || 0;
  // El aporte fijo de la pareja (si lo hay) se descuenta: el sobre solo aparta tu parte.
  return envToBase(state, env, Math.max(0, monthly - (Number(env.partnerAmount) || 0)));
}

export function needsMonthly(state, month) {
  return state.envelopes
    .filter((e) => e.group === 'necesidad')
    .reduce((s, e) => s + monthlyTarget(state, e, month), 0);
}

// El fondo de emergencia se puede pausar (p. ej. mientras los ingresos no cubren todo); su saldo se conserva.
export const emergencyEnabled = (state) => state.settings.emergencyEnabled !== false;

export function emergencyTarget(state, month) {
  return needsMonthly(state, month) * (Number(state.settings.emergencyMonths) || 6);
}

// Cuánto debería recibir un sobre este mes (tu parte, ya descontado lo que aporte tu pareja).
export function monthlyTarget(state, env, month) {
  if (env.role === 'impuestos') return 0;
  if (env.role === 'emergencia') {
    if (!emergencyEnabled(state)) return 0;
    const remaining = emergencyTarget(state, month) - envelopeBalance(state, env.id, month);
    if (remaining <= 0) return 0;
    return Math.ceil(remaining / (Number(state.settings.emergencyHorizon) || 12));
  }
  if (env.goal && Number(env.goal.target) > 0) {
    const remaining = goalTarget(state, env) - envelopeBalance(state, env.id, month);
    if (remaining <= 0) return 0;
    return Math.ceil(remaining / monthsBetween(month, env.goal.date || addMonths(month, 11)));
  }
  let amount = baseMonthly(state, env, month);
  if (env.shared) amount *= 1 - partnerShare(state, month).share;
  return Math.round(amount * 100) / 100;
}

export function monthPlan(state, month) {
  const lines = state.envelopes.map((e) => ({ env: e, target: monthlyTarget(state, e, month) }));
  const byGroup = {};
  for (const l of lines) byGroup[l.env.group] = (byGroup[l.env.group] || 0) + l.target;
  const total = lines.reduce((s, l) => s + l.target, 0);
  return { lines, byGroup, total };
}

// ---------- Reparto de un pago (cascada) ----------

function findRole(state, role) {
  return state.envelopes.find((e) => e.role === role);
}

// Días antes del día de pago en que un sobre pasa a ser urgente.
export const DUE_WINDOW_DAYS = 7;

// ¿El sobre vence pronto (o ya venció) en la fecha dada? Requiere `dueDay` (día del mes en que se paga).
export function isDueSoon(env, date) {
  const due = Number(env.dueDay);
  if (!due) return false;
  const day = Number(String(date).slice(8, 10)) || new Date(date).getDate();
  return day >= due - DUE_WINDOW_DAYS;
}

// Reparte `amount` según: impuestos → págate primero → lo que vence pronto → necesidades a la par
// → ahorro, imagen y gustos a la par → excedente.
export function allocate(state, amount, date) {
  const month = monthKey(date);
  const s = state.settings;
  const alloc = {};
  const steps = [];
  let rem = toCents(amount);
  const give = (env, cents, stage) => {
    if (!env || cents <= 0) return 0;
    const c = Math.min(cents, rem);
    if (c <= 0) return 0;
    alloc[env.id] = (alloc[env.id] || 0) + c;
    steps.push({ envId: env.id, cents: c, stage });
    rem -= c;
    return c;
  };

  // 1. Impuestos: un porcentaje fijo de todo lo que facturas.
  give(findRole(state, 'impuestos'), Math.round(toCents(amount) * (Number(s.taxPct) || 0) / 100), 'impuestos');

  // 2. Págate primero: un porcentaje va al ahorro antes de cualquier gasto.
  const emergency = findRole(state, 'emergencia');
  const invest = findRole(state, 'inversion');
  const efFull = emergency && envelopeBalance(state, emergency.id) >= emergencyTarget(state, month);
  // Con el fondo pausado no se aparta "págate primero": ese dinero se queda para los gastos del mes.
  if (emergencyEnabled(state)) give(efFull ? invest || emergency : emergency, Math.round(toCents(amount) * (Number(s.payFirstPct) || 0) / 100), 'primero');

  // Lo que le falta a un sobre este mes (en centavos), contando lo que ya recibió en este reparto.
  const missingOf = (env) => Math.max(0, toCents(monthlyTarget(state, env, month)) - toCents(fundedInMonth(state, env.id, month)) - (alloc[env.id] || 0));

  // Reparte el dinero disponible entre varios sobres en proporción a lo que le falta a cada uno,
  // de modo que todos avancen el mismo porcentaje. Los centavos sobrantes van a los que más necesitan.
  const giveEvenly = (envs, stage) => {
    const list = envs.map((env) => ({ env, miss: missingOf(env) })).filter((x) => x.miss > 0);
    const total = list.reduce((sum, x) => sum + x.miss, 0);
    if (!total || rem <= 0) return;
    if (rem >= total) { for (const x of list) give(x.env, x.miss, stage); return; }
    const pool = rem;
    for (const x of list) x.got = give(x.env, Math.floor((pool * x.miss) / total), stage);
    for (const x of list.sort((a, b) => b.miss - a.miss)) {
      if (rem <= 0) break;
      give(x.env, Math.min(rem, x.miss - x.got), stage);
    }
  };

  const active = state.envelopes.filter((e) => e.role !== 'impuestos');
  const needs = active.filter((e) => e.group === 'necesidad');

  // 3. Lo que vence pronto (p. ej. la renta del día 15) se completa primero, en orden de fecha.
  for (const env of needs.filter((e) => isDueSoon(e, date)).sort((a, b) => Number(a.dueDay) - Number(b.dueDay))) {
    give(env, missingOf(env), 'vence');
  }

  // 4. Necesidades a la par: renta, comida, transporte y servicios avanzan el mismo porcentaje.
  giveEvenly(needs, 'mes');

  // 5. Con las necesidades cubiertas: ahorro, imagen y gustos a la par.
  giveEvenly(active.filter((e) => e.group !== 'necesidad'), 'resto');

  // 4. Excedente: se divide entre fondo de emergencia, metas y dinero libre.
  if (rem > 0) {
    const surplus = rem;
    const split = s.surplus || { emergencia: 50, metas: 30, libre: 20 };
    const efBalance = emergency ? envelopeBalance(state, emergency.id) + fromCents(alloc[emergency.id] || 0) : 0;
    const efMissing = Math.max(0, toCents(emergencyTarget(state, month) - efBalance));
    const efPart = Math.round(surplus * split.emergencia / 100);
    if (emergencyEnabled(state)) {
      const toEf = Math.min(efPart, efMissing);
      give(emergency, toEf, 'excedente');
      give(invest, efPart - toEf, 'excedente');
    } else {
      give(findRole(state, 'libre') || invest, efPart, 'excedente'); // fondo pausado: esa parte queda libre
    }

    const goals = state.envelopes
      .filter((e) => e.goal && Number(e.goal.target) > 0)
      .map((e) => ({ env: e, missing: toCents(goalTarget(state, e) - envelopeBalance(state, e.id)) - (alloc[e.id] || 0) }))
      .filter((g) => g.missing > 0);
    const goalsPart = Math.round(surplus * split.metas / 100);
    const missingTotal = goals.reduce((a, g) => a + g.missing, 0);
    let given = 0;
    for (const g of goals) given += give(g.env, Math.min(g.missing, Math.floor(goalsPart * g.missing / missingTotal)), 'excedente');
    give(invest || emergency, goalsPart - given, 'excedente');

    // El resto (incluye centavos de redondeo) es dinero libre.
    give(findRole(state, 'libre') || invest || emergency, rem, 'excedente');
  }

  const out = {};
  for (const [k, v] of Object.entries(alloc)) out[k] = fromCents(v);
  return { month, alloc: out, steps: steps.map((x) => ({ ...x, amount: fromCents(x.cents) })), unassigned: fromCents(rem) };
}

// ---------- Recomendaciones ----------

export function recommendations(state, month, fmt, today = new Date()) {
  const out = [];
  // `id` identifica la recomendación para su botón Resolver; `data` lleva lo que la corrección necesita.
  const add = (level, title, text, id, data = {}) => out.push({ level, title, text, id, data });
  const income = referenceIncome(state, month);
  const plan = monthPlan(state, month);
  const needs = plan.byGroup.necesidad || 0;
  const s = state.settings;
  const env = (role) => findRole(state, role);

  if (income <= 0) {
    add('warning', 'Falta tu ingreso estimado', 'Escribe en Ajustes cuánto recibes al mes en promedio para poder evaluar tu plan.', 'ingreso');
    return out;
  }

  // Sobres con día de pago próximo a los que todavía les falta dinero (solo en el mes actual).
  if (month === monthKey(today)) {
    const todayISO = `${month}-${String(today.getDate()).padStart(2, '0')}`;
    for (const e of state.envelopes.filter((x) => x.dueDay && isDueSoon(x, todayISO))) {
      const missing = monthlyTarget(state, e, month) - fundedInMonth(state, e.id, month);
      if (missing > 0.005) add('critical', `${e.name}: faltan ${fmt(missing)}`, `Se paga el día ${e.dueDay}. Los próximos pagos que registres irán primero a este sobre hasta completarlo.`, 'vence', { envId: e.id, missing });
    }
  }

  if (plan.total > income) {
    add('critical', 'Tu plan supera tu ingreso', `El plan pide ${fmt(plan.total)} y tu ingreso de referencia es ${fmt(income)}. Alarga la fecha de las metas (Mac, iPhone) o baja gustos hasta que cuadre.`, 'plan-excede');
  }

  const ef = env('emergencia');
  if (ef && !emergencyEnabled(state)) {
    add('info', 'Fondo de emergencia en pausa', 'No recibe dinero mientras tus ingresos cubren tus gastos. Cuando puedas, actívalo en Ajustes, aunque sea con una meta más pequeña (p. ej. 1 o 3 meses).');
  } else if (ef && needs > 0) {
    const months = envelopeBalance(state, ef.id) / needs;
    const target = Number(s.emergencyMonths) || 6;
    const pf = Number(s.payFirstPct) || 0;
    const pfText = pf ? ` Hoy apartas el ${pf}% de cada pago para él.` : '';
    if (months < 1) add('critical', 'Fondo de emergencia: prioridad #1', `Cubres ${months.toFixed(1)} meses de necesidades. Con ingresos de clientes (variables) la meta es ${target} meses: ${fmt(needs * target)}.${pfText}`, 'fondo');
    else if (months < 3) add('warning', 'Fondo de emergencia en construcción', `Llevas ${months.toFixed(1)} de 6 meses. Cuando llegues a 1 mes completo, empieza a vivir con el dinero del mes anterior: así un cliente que paga tarde no te afecta.`, 'fondo');
    else if (months < 6) add('info', 'Buen colchón', `Tu fondo cubre ${months.toFixed(1)} meses. Sigue hasta 6.`, 'fondo');
    else add('good', 'Fondo de emergencia completo', 'Lo que antes iba al fondo ahora se dirige a inversión a largo plazo (sobre "Inversión").');
  }

  const needsPct = needs / income;
  if (needsPct > 0.6) add('critical', `Necesidades: ${Math.round(needsPct * 100)}% del ingreso`, 'La guía 50/30/20 sugiere que las necesidades no pasen del 50%. Revisa renta y transporte, que suelen ser los más grandes.', 'necesidades');
  else if (needsPct > 0.5) add('warning', `Necesidades: ${Math.round(needsPct * 100)}% del ingreso`, 'Un poco por encima del 50% recomendado. Es manejable si mantienes el ahorro en 20% o más.', 'necesidades');
  else add('good', `Necesidades: ${Math.round(needsPct * 100)}% del ingreso`, 'Dentro del 50% recomendado por la regla 50/30/20.');

  const savingsPct = ((plan.byGroup.ahorro || 0) + (emergencyEnabled(state) ? income * (Number(s.payFirstPct) || 0) / 100 : 0)) / income;
  if (savingsPct < 0.2) add('warning', `Ahorro: ${Math.round(savingsPct * 100)}% del ingreso`, 'Apunta a ahorrar al menos 20% (fondo de emergencia, herramientas e inversión).', 'ahorro');

  const rent = state.envelopes.find((e) => e.role === 'renta');
  if (rent) {
    const pct = monthlyTarget(state, rent, month) / income;
    if (pct > 0.3) add('warning', `Renta: ${Math.round(pct * 100)}% del ingreso`, 'Lo recomendable es que la vivienda no pase del 30% de tus ingresos.', 'renta', { envId: rent.id });
  }

  if (!(Number(s.taxPct) > 0)) add('warning', 'No estás apartando impuestos', 'Como trabajas con clientes, aparta un porcentaje de cada pago para impuestos o cuotas de seguridad social. Consulta con un contador cuánto te corresponde y configúralo en Ajustes.', 'impuestos');

  const net = state.envelopes.find((e) => e.role === 'internet');
  const mobile = state.envelopes.find((e) => e.role === 'movil');
  if (net && net.pending) {
    const cap = income * 0.03;
    add('info', 'Internet en casa: cómo elegir', `Presupuesto sano para internet (casa + móvil): hasta ${fmt(cap)} al mes (3% de tu ingreso). Prefiere fibra óptica y fíjate en la velocidad de subida (50 Mbps o más) porque subes contenido y haces videollamadas. Ahorra el monto desde ya en su sobre para cubrir la instalación. Cuando llegue el Wi-Fi, baja tu plan móvil a uno con menos datos.`, 'internet', { envId: net.id });
  } else if (net && mobile) {
    const total = monthlyTarget(state, net, month) + monthlyTarget(state, mobile, month);
    if (total > income * 0.05) add('warning', 'Internet caro para tu ingreso', `Pagas ${fmt(total)} entre casa y móvil (más del 5%). Con Wi-Fi en casa, el plan móvil puede ser más pequeño.`, 'internet-caro', { envId: mobile.id });
  }

  // Concentración de clientes en los últimos 3 meses.
  const since = addMonths(month, -2);
  const recent = state.payments.filter((p) => isIncome(p) && monthKey(p.date) >= since);
  const byClient = {};
  for (const p of recent) byClient[p.client || 'Sin nombre'] = (byClient[p.client || 'Sin nombre'] || 0) + Number(p.amount);
  const total = Object.values(byClient).reduce((a, b) => a + b, 0);
  const top = Object.entries(byClient).sort((a, b) => b[1] - a[1])[0];
  if (top && total > 0 && top[1] / total > 0.5 && Object.keys(byClient).length >= 1 && recent.length >= 2) {
    const title = `${top[0]} es el ${Math.round(top[1] / total * 100)}% de tus ingresos`;
    if (!emergencyEnabled(state)) add('info', title, 'Depender de un solo cliente es riesgoso. Cuando actives el fondo de emergencia, considera una meta de 8 meses.');
    else if ((Number(s.emergencyMonths) || 6) >= 8) add('info', title, `Ya reforzaste tu fondo de emergencia a ${s.emergencyMonths} meses. Conseguir más clientes es lo que reduce este riesgo.`);
    else add('warning', title, 'Depender de un solo cliente es riesgoso. Mientras diversificas, refuerza el fondo de emergencia.', 'cliente');
  }

  const ps = partnerShare(state, month);
  const partnerName = state.partner.name || 'tu pareja';
  if (state.partner.mode === 'yo100') {
    add('good', 'Hogar: cubres el 100%', `${partnerName} no carga con los gastos fijos. Recomiéndale guardar parte de su ingreso en su propio fondo de emergencia: su independencia también protege a la pareja.`, 'hogar-ok');
  } else if (ps.herPctOfIncome > ps.myPctOfIncome + 0.001) {
    add('warning', 'Reparto del hogar desigual', `${partnerName} aporta el ${Math.round(ps.herPctOfIncome * 100)}% de su ingreso y tú el ${Math.round(ps.myPctOfIncome * 100)}% del tuyo. Lo justo es que nadie aporte un porcentaje mayor que el otro.`, 'hogar-desigual');
  }

  return out;
}

// ---------- Correcciones automáticas (botón Resolver) ----------
// Cada corrección modifica el estado que recibe (la interfaz le pasa una copia) y devuelve la lista
// de cambios en palabras para confirmarlos, o null si no hay nada que se pueda corregir solo.

const roundUp = (n) => Math.ceil(n * 100) / 100;

// Monto en la moneda propia de un sobre a partir de uno en la moneda de ingresos.
function baseToEnv(state, env, amount) {
  return envCurrency(state, env) === state.settings.currency ? amount : baseToCost(state, amount);
}

export const FIXES = {
  ingreso(state, month, fmt) {
    const months = [0, 1, 2, 3, 4, 5].map((i) => incomeInMonth(state, addMonths(month, -i))).filter((v) => v > 0).slice(0, 3);
    if (!months.length) return null;
    const avg = Math.round(months.reduce((a, b) => a + b, 0) / months.length);
    state.settings.incomeEstimate = avg;
    return [`Ingreso mensual estimado: ${fmt(avg)} (promedio de tus últimos ${months.length} ${months.length === 1 ? 'mes' : 'meses'} con pagos).`];
  },

  'plan-excede'(state, month, fmt) {
    const income = referenceIncome(state, month);
    const over = () => monthPlan(state, month).total - income;
    if (over() <= 0.005) return null;
    const changes = [];
    // 1. Alargar las metas con fecha (de la que más pide a la que menos), hasta 24 meses cada una.
    const goals = state.envelopes.filter((e) => e.goal && Number(e.goal.target) > 0)
      .sort((a, b) => monthlyTarget(state, b, month) - monthlyTarget(state, a, month));
    for (const g of goals) {
      const from = g.goal.date || addMonths(month, 11);
      let added = 0;
      while (over() > 0.005 && added < 24) { g.goal.date = addMonths(g.goal.date || from, 1); added++; }
      if (added) { g.updatedAt = Date.now(); changes.push(`${g.name}: fecha de ${from} a ${g.goal.date}.`); }
    }
    // 2. Completar el fondo de emergencia más despacio (hasta 24 meses).
    const horizon = Number(state.settings.emergencyHorizon) || 12;
    let h = horizon;
    while (over() > 0.005 && h < 24) { h++; state.settings.emergencyHorizon = h; }
    if (h !== horizon) changes.push(`Fondo de emergencia: completarlo en ${h} meses en lugar de ${horizon}.`);
    // 3. Recortar gustos en proporción.
    if (over() > 0.005) {
      const gustos = state.envelopes.filter((e) => e.group === 'gusto' && isManualEnvelope(e) && Number(e.monthly) > 0);
      const totalBase = gustos.reduce((s, e) => s + monthlyTarget(state, e, month), 0);
      const cut = Math.min(over(), totalBase);
      for (const e of gustos) {
        const share = cut * monthlyTarget(state, e, month) / totalBase;
        const before = Number(e.monthly);
        e.monthly = Math.max(0, Math.floor((before - baseToEnv(state, e, share)) * 100) / 100);
        e.updatedAt = Date.now();
        changes.push(`${e.name}: de ${before} a ${e.monthly} ${envCurrency(state, e)} al mes.`);
      }
    }
    if (over() > 0.005) changes.push(`Aún faltan ${fmt(over())} al mes: revisa tus necesidades en Plan.`);
    return changes.length ? changes : null;
  },

  fondo(state) {
    const before = Number(state.settings.payFirstPct) || 0;
    const next = Math.min(20, before + 5);
    if (next <= before) return null;
    state.settings.payFirstPct = next;
    return [`Págate primero: de ${before}% a ${next}% de cada pago, directo al fondo de emergencia.`];
  },

  ahorro(state, month) {
    const income = referenceIncome(state, month);
    if (!(income > 0)) return null;
    const plan = monthPlan(state, month);
    const before = Number(state.settings.payFirstPct) || 0;
    const needed = Math.ceil(((0.2 * income - (plan.byGroup.ahorro || 0)) / income) * 100);
    const next = Math.min(30, Math.max(before, needed));
    if (next <= before) return null;
    state.settings.payFirstPct = next;
    return [`Págate primero: de ${before}% a ${next}% de cada pago, para llegar a ahorrar el 20% de tu ingreso.`];
  },

  impuestos(state) {
    if (Number(state.settings.taxPct) > 0) return null;
    state.settings.taxPct = 10;
    return ['Reserva para impuestos: 10% de cada pago (estimación prudente; confírmala con tu contador).'];
  },

  internet(state, month, fmt) {
    const net = state.envelopes.find((e) => e.role === 'internet');
    if (!net) return null;
    const mobile = state.envelopes.find((e) => e.role === 'movil');
    const cap = referenceIncome(state, month) * 0.03 - (mobile ? monthlyTarget(state, mobile, month) : 0);
    const current = monthlyTarget(state, net, month);
    if (cap <= 0 || (current > 0 && current <= cap + 0.005)) return null;
    const before = Number(net.monthly) || 0;
    net.monthly = roundUp(baseToEnv(state, net, cap));
    net.updatedAt = Date.now();
    return [`${net.name}: presupuesto de ${before} a ${net.monthly} ${envCurrency(state, net)} al mes (${fmt(cap)}), para que internet y móvil no pasen del 3% de tu ingreso. Se ahorra desde ya para la instalación.`];
  },

  cliente(state) {
    const before = Number(state.settings.emergencyMonths) || 6;
    if (before >= 8) return null;
    state.settings.emergencyMonths = 8;
    return [`Fondo de emergencia: meta de 8 meses de necesidades en lugar de ${before}, mientras dependas de un solo cliente.`];
  },

  'hogar-desigual'(state) {
    if (state.partner.mode === 'proporcional') return null;
    state.partner.mode = 'proporcional';
    return ['Hogar en pareja: reparto proporcional al ingreso, para que cada uno aporte el mismo porcentaje de lo que gana.'];
  },
};

// Secciones del estado que toca cada corrección (para la sincronización).
export const FIX_SECTIONS = { ingreso: ['settings'], 'plan-excede': ['settings'], fondo: ['settings'], ahorro: ['settings'], impuestos: ['settings'], internet: [], cliente: ['settings'], 'hogar-desigual': ['partner'] };
