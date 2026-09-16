/**
 * Netlify Function: POST /api/cliente-auth
 * ─────────────────────────────────────────────────────────────────────
 * Identificación liviana de clientes: solo celular + nombre.
 * Sin PIN, sin contraseña.
 *
 * Flujo unificado:
 *  1. Recibe { celular, nombre? }
 *  2. Busca en clientes-auth.json por celular normalizado
 *  3. Si existe → retorna el cliente existente (auto-reconocimiento)
 *  4. Si no existe → crea cuenta nueva (requiere nombre)
 *  5. Nunca duplica usuarios (unicidad por celular)
 *
 * También sincroniza (best-effort) con clientes.json para que el cliente
 * aparezca en el Panel de Ventas sin que el staff tenga que cargarlo a mano.
 *
 * body: { celular, nombre? }
 * (El campo "accion" ya no es necesario pero se acepta y se ignora
 *  para compatibilidad con versiones anteriores del frontend.)
 */

const axios = require('axios');

const HEADERS_CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const NOMBRE_ARCHIVO = 'clientes-auth.json';
const VACIO = { cuentas: [], actualizado: null };

function ocEnv() {
  return {
    ocUrl:  (process.env.OWNCLOUD_URL       || '').trim(),
    ocUser: (process.env.OWNCLOUD_USER      || '').trim(),
    ocPass: (process.env.OWNCLOUD_PASS      || '').trim(),
    ocBase: (process.env.OWNCLOUD_RUTA_BASE || '/MiTienda/Imagenes/').trim(),
  };
}

/** Misma ruta que costos-internos.json / clientes.json: carpeta padre de OWNCLOUD_RUTA_BASE */
function rutaPrivada(ocBase, nombreArchivo) {
  const rutaBase = '/' + ocBase.replace(/^\/|\/$/g, '');
  return rutaBase.replace(/\/[^/]+$/, '') + '/' + nombreArchivo;
}

async function leerJsonPrivadoGenerico(nombreArchivo, defaultValue) {
  const { ocUrl, ocUser, ocPass, ocBase } = ocEnv();
  if (!ocUrl || !ocUser || !ocPass) return defaultValue;
  try {
    const davBase = ocUrl.replace(/\/$/, '');
    const ruta    = rutaPrivada(ocBase, nombreArchivo);
    const { data } = await axios.get(davBase + encodeURI(ruta), {
      auth: { username: ocUser, password: ocPass },
      responseType: 'text',
      validateStatus: s => s === 200,
    });
    return JSON.parse(data);
  } catch (err) {
    console.error(`[cliente-auth] Error leyendo ${nombreArchivo}:`, err.message);
    return defaultValue;
  }
}

async function guardarJsonPrivadoGenerico(nombreArchivo, data) {
  const { ocUrl, ocUser, ocPass, ocBase } = ocEnv();
  if (!ocUrl || !ocUser || !ocPass) return { ok: false, error: 'ownCloud no configurado.' };
  try {
    const davBase = ocUrl.replace(/\/$/, '');
    const ruta    = rutaPrivada(ocBase, nombreArchivo);
    const json    = JSON.stringify(data, null, 2);
    await axios({
      method: 'PUT',
      url: davBase + encodeURI(ruta),
      auth: { username: ocUser, password: ocPass },
      data: Buffer.from(json, 'utf8'),
      headers: { 'Content-Type': 'application/json' },
      maxBodyLength: Infinity,
      validateStatus: s => [200, 201, 204].includes(s),
    });
    return { ok: true };
  } catch (err) {
    console.error(`[cliente-auth] Error guardando ${nombreArchivo}:`, err.message);
    return { ok: false, error: err.message };
  }
}

async function leerJsonPrivado() {
  const data = await leerJsonPrivadoGenerico(NOMBRE_ARCHIVO, VACIO);
  return {
    cuentas: Array.isArray(data.cuentas) ? data.cuentas : [],
    actualizado: data.actualizado || null,
  };
}
async function guardarJsonPrivado(data) {
  return guardarJsonPrivadoGenerico(NOMBRE_ARCHIVO, data);
}

/**
 * Best-effort: crea un cliente liviano en clientes.json si no existe ya
 * uno con ese celular. Nunca lanza — si falla, el registro igual se completa.
 */
async function sincronizarClientePublico(nombre, celular) {
  try {
    const data = await leerJsonPrivadoGenerico('clientes.json', { clientes: [], actualizado: null });
    const clientes = Array.isArray(data.clientes) ? data.clientes : [];
    if (clientes.some(c => c.celular === celular)) return; // ya existe, no se toca

    const ahora = new Date().toISOString();
    clientes.push({
      id: 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      nombre, rucCi: '', ciudad: '', direccion: '', datosEnvio: '', metodoEnvio: '',
      celular, notas: 'Se identificó solo desde la tienda web.',
      creadoEn: ahora, actualizadoEn: ahora,
    });
    await guardarJsonPrivadoGenerico('clientes.json', { clientes, actualizado: ahora });
  } catch (err) {
    console.error('[cliente-auth] No se pudo sincronizar con clientes.json:', err.message);
  }
}

/** Normaliza celular: solo dígitos, permite + inicial. */
function normalizarCelular(v) {
  const s = String(v || '').trim();
  const signo = s.startsWith('+') ? '+' : '';
  return signo + s.replace(/[^\d]/g, '');
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: HEADERS_CORS, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: HEADERS_CORS, body: JSON.stringify({ ok: false, error: 'Método no permitido' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, headers: HEADERS_CORS, body: JSON.stringify({ ok: false, error: 'JSON inválido.' }) };
  }

  const celular = normalizarCelular(body.celular);
  const nombre  = String(body.nombre || '').trim();

  if (!celular || celular.replace('+', '').length < 6) {
    return { statusCode: 400, headers: HEADERS_CORS, body: JSON.stringify({ ok: false, error: 'Celular inválido.' }) };
  }

  const data = await leerJsonPrivado();

  // ── Buscar cuenta existente por celular ──────────────────────────────
  const existente = data.cuentas.find(c => c.celular === celular);

  if (existente) {
    // Cliente ya conocido → auto-reconocimiento, sin PIN ni contraseña
    // Si viene nombre nuevo (distinto al guardado), actualizarlo
    if (nombre && nombre !== existente.nombre) {
      existente.nombre = nombre;
      existente.actualizadoEn = new Date().toISOString();
      data.actualizado = existente.actualizadoEn;
      await guardarJsonPrivado(data); // best-effort, no bloquea la respuesta si falla
    }
    await sincronizarClientePublico(existente.nombre, celular);
    return {
      statusCode: 200, headers: HEADERS_CORS,
      body: JSON.stringify({ ok: true, esNuevo: false, cliente: { id: existente.id, nombre: existente.nombre, celular: existente.celular } }),
    };
  }

  // ── Cuenta nueva → requiere nombre ──────────────────────────────────
  if (!nombre || nombre.length < 2) {
    return {
      statusCode: 400, headers: HEADERS_CORS,
      body: JSON.stringify({ ok: false, error: 'Ingresá tu nombre para continuar.', requiereNombre: true }),
    };
  }

  const nuevaCuenta = {
    id: 'ca' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    celular, nombre,
    creadoEn: new Date().toISOString(),
    actualizadoEn: new Date().toISOString(),
  };
  data.cuentas.push(nuevaCuenta);
  data.actualizado = nuevaCuenta.creadoEn;

  const resultado = await guardarJsonPrivado(data);
  if (!resultado.ok) {
    return { statusCode: 500, headers: HEADERS_CORS, body: JSON.stringify({ ok: false, error: resultado.error }) };
  }
  await sincronizarClientePublico(nombre, celular);
  return {
    statusCode: 200, headers: HEADERS_CORS,
    body: JSON.stringify({ ok: true, esNuevo: true, cliente: { id: nuevaCuenta.id, nombre: nuevaCuenta.nombre, celular: nuevaCuenta.celular } }),
  };
};
