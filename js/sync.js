// Sincronización cifrada entre dispositivos usando un repositorio privado de GitHub como almacén.
// Los datos se cifran en el dispositivo (AES-GCM 256, clave derivada con PBKDF2-SHA256) antes de salir:
// GitHub solo guarda texto cifrado. Las funciones de fusión son puras y se prueban en tests/.

export const FILE = 'datos.cifrados.json';
const ITERATIONS = 310000;
const SECTIONS = ['settings', 'partner', 'food', 'onboarded'];

// ---------- Base64 y texto ----------

const enc = new TextEncoder();
const dec = new TextDecoder();

function bytesToB64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
function b64ToBytes(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// JSON con claves ordenadas, para comparar estados sin importar el orden de las propiedades.
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().filter((k) => value[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

// ---------- Cifrado ----------

const keyCache = new Map();
async function deriveKey(passphrase, saltB64) {
  const id = `${saltB64}:${passphrase}`;
  if (keyCache.has(id)) return keyCache.get(id);
  const base = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: b64ToBytes(saltB64), iterations: ITERATIONS },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  keyCache.set(id, key);
  return key;
}

export async function encryptState(state, passphrase, saltB64 = null) {
  const salt = saltB64 || bytesToB64(crypto.getRandomValues(new Uint8Array(16)));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt);
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(state)));
  return { formato: 'mis-finanzas', version: 1, kdf: { alg: 'PBKDF2-SHA256', iteraciones: ITERATIONS, salt }, iv: bytesToB64(iv), datos: bytesToB64(new Uint8Array(data)) };
}

export async function decryptState(file, passphrase) {
  if (!file || file.formato !== 'mis-finanzas') throw new Error('El archivo remoto no es de Mis Finanzas.');
  const key = await deriveKey(passphrase, file.kdf.salt);
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64ToBytes(file.iv) }, key, b64ToBytes(file.datos));
    return JSON.parse(dec.decode(plain));
  } catch {
    throw new Error('Contraseña de cifrado incorrecta.');
  }
}

// ---------- Fusión ----------

const ts = (x) => Number(x) || 0;

// Une listas por id: gana la versión editada más recientemente y se descartan los borrados.
function mergeById(local = [], remote = [], deleted = {}) {
  const out = new Map();
  for (const item of [...local, ...remote]) {
    if (!item || item.id == null || deleted[item.id]) continue;
    const prev = out.get(item.id);
    if (!prev || ts(item.updatedAt) > ts(prev.updatedAt)) out.set(item.id, item);
  }
  return [...out.values()];
}

export function mergeStates(local, remote) {
  const lm = local.meta || {};
  const rm = remote.meta || {};
  const deleted = { ...(remote.deleted || {}) };
  for (const [id, t] of Object.entries(local.deleted || {})) deleted[id] = Math.max(ts(deleted[id]), ts(t));

  const merged = { ...local, meta: {}, deleted };
  // Un estado remoto recién instalado nunca reemplaza los ajustes de un dispositivo en uso.
  const remoteFresh = isFresh(remote) && !isFresh(local);
  // Ajustes, pareja, alimentación y bienvenida: gana la sección modificada más recientemente.
  // En empate gana el estado guardado más recientemente.
  const remoteNewerOverall = ts(remote.updatedAt) > ts(local.updatedAt);
  for (const section of SECTIONS) {
    const l = ts(lm[section]);
    const r = ts(rm[section]);
    const useRemote = !remoteFresh && (r > l || (r === l && remoteNewerOverall));
    if (useRemote && remote[section] !== undefined) merged[section] = remote[section];
    merged.meta[section] = Math.max(l, r);
  }
  merged.envelopes = mergeById(local.envelopes, remote.envelopes, deleted);
  merged.payments = mergeById(local.payments, remote.payments, deleted);
  merged.expenses = mergeById(local.expenses, remote.expenses, deleted);
  merged.updatedAt = Math.max(ts(local.updatedAt), ts(remote.updatedAt));
  return merged;
}

export const hasMovements = (state) => Boolean((state.payments || []).length || (state.expenses || []).length);

// Un dispositivo recién instalado (sin bienvenida ni movimientos) adopta los datos remotos tal cual.
export function isFresh(state) {
  return !state.onboarded && !hasMovements(state);
}

// ---------- GitHub ----------

function headers(token) {
  return { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
}

async function explain(res) {
  if (res.status === 401) return new Error('El token de GitHub no es válido o venció.');
  if (res.status === 403) return new Error('El token no tiene permiso de escritura en el repositorio (o GitHub limitó las solicitudes).');
  if (res.status === 404) return new Error('No se encontró el repositorio o el token no tiene acceso a él.');
  let msg = '';
  try { msg = (await res.json()).message || ''; } catch { /* sin cuerpo */ }
  return new Error(`GitHub respondió ${res.status}${msg ? `: ${msg}` : ''}.`);
}

export async function checkRepo({ repo, token }, fetchFn = fetch) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo || '')) throw new Error('Escribe el repositorio como usuario/nombre.');
  const res = await fetchFn(`https://api.github.com/repos/${repo}`, { headers: headers(token), cache: 'no-store' });
  if (!res.ok) throw await explain(res);
  const info = await res.json();
  if (!info.private) throw new Error('El repositorio de datos debe ser privado.');
  return info;
}

async function getRemote({ repo, token }, fetchFn) {
  const res = await fetchFn(`https://api.github.com/repos/${repo}/contents/${FILE}?t=${Date.now()}`, { headers: headers(token), cache: 'no-store' });
  if (res.status === 404) return null;
  if (!res.ok) throw await explain(res);
  const json = await res.json();
  return { sha: json.sha, file: JSON.parse(dec.decode(b64ToBytes(json.content))) };
}

async function putRemote({ repo, token }, file, sha, device, fetchFn) {
  const body = { message: `Sincronización desde ${device}`, content: bytesToB64(enc.encode(JSON.stringify(file))) };
  if (sha) body.sha = sha;
  const res = await fetchFn(`https://api.github.com/repos/${repo}/contents/${FILE}`, {
    method: 'PUT', headers: { ...headers(token), 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (res.status === 409 || res.status === 422) return false; // otro dispositivo escribió antes: reintentar
  if (!res.ok) throw await explain(res);
  return true;
}

// Descarga, fusiona y sube. Devuelve el estado fusionado y si cambió respecto al local.
// `adoptRemote`: al conectar un dispositivo sin movimientos, toma los datos sincronizados en lugar de fusionar.
export async function synchronize(local, config, { device = 'un dispositivo', fetchFn = fetch, attempts = 3, adoptRemote = false } = {}) {
  for (let i = 0; i < attempts; i++) {
    const remote = await getRemote(config, fetchFn);
    let merged = mergeStates(local, local); // normalizado: con meta y borrados, igual que tras una fusión
    let remoteState = null;
    if (remote) {
      remoteState = await decryptState(remote.file, config.passphrase);
      merged = adoptRemote || isFresh(local) ? remoteState : mergeStates(local, remoteState);
    } else if (isFresh(local)) {
      // Todavía no hay nada que compartir: no se sube un estado vacío.
      return { state: local, changed: false, at: Date.now(), waiting: true };
    }
    const mergedKey = canonical(merged);
    if (!remoteState || canonical(remoteState) !== mergedKey) {
      const file = await encryptState(merged, config.passphrase, remote?.file?.kdf?.salt);
      if (!(await putRemote(config, file, remote?.sha, device, fetchFn))) continue;
    }
    return { state: merged, changed: canonical(local) !== mergedKey, at: Date.now() };
  }
  throw new Error('Otro dispositivo está sincronizando al mismo tiempo. Inténtalo de nuevo.');
}
