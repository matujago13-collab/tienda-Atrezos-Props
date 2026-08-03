/**
 * Netlify Function: POST /api/cliente-auth
 * ─────────────────────────────────────────────────────────────────────
 * Login liviano para clientes de la tienda pública: celular + PIN de 4-6
 * dígitos (sin contraseña tradicional, sin recuperación de clave — el
 * mismo criterio de "bajo costo, simplicidad" que el resto del proyecto).
 *
 * Guarda las cuentas en clientes-auth.json (privado, sin share público en
 * ownCloud — mismo criterio que costos-internos.json), un archivo NUEVO
 * y separado de clientes.json a propósito: clientes.json lo administra
 * el panel de Ventas (admin.html / netlify/functions/clientes.js), que
 * reescribe la lista completa con una whitelist fija de campos cada vez
 * que el staff guarda cambios. Si guardáramos el PIN ahí, el próximo
 * guardado del panel lo borraría sin querer. Este archivo nuevo no lo
 * toca nadie más, así que no hay riesgo de pisarlo.
 *
 * Cuando alguien se registra, ADEMÁS se crea (si no existe ya un cliente
 * con ese celular) un registro liviano en clientes.json — mismo esquema
 * exacto que usa netlify/functions/clientes.js y admin-server.js — para
 * que el cliente aparezca directo en la pestaña Clientes del Panel de
 * Ventas, sin que el staff tenga que cargarlo a mano. Si ya existe un
 * cliente con ese celular (cargado antes por el staff), no se toca —
 * nunca se pisan datos que el staff ya cargó (dirección, notas, etc.).
 *
 * body: { accion: 'registro', celular, nombre, pin }
 * body: { accion: 'login',    celular, pin }
 * Nunca expone pinHash/pinSalt en la respuesta.
 */

const axios  = require('axios');
const crypto = require('crypto');

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

/** Lee un JSON privado cualquiera de ownCloud (genérico — lo usan clientes-auth.json y clientes.json). */
async function leerJsonPrivadoGenerico(nombreArchivo, defaultValue) {
  const { ocUrl, ocUser, ocPass, ocBase } = ocEnv();
  if (!ocUrl || !ocUser || !ocPass) return defaultValue;
  try {
    const davBase = ocUrl.replace(/\/$/, '');
    const ruta    = rutaPrivada(ocBase, nombreArchivo);
    // encodeURI preserva "/" pero codifica espacios — ownCloud no acepta
    // espacios crudos en el path (mismo criterio que davPut() en admin-server.js).
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
  return { cuentas: Array.isArray(data.cuentas) ? data.cuentas : [], actualizado: data.actualizado || null };
}
async function guardarJsonPrivado(data) {
  return guardarJsonPrivadoGenerico(NOMBRE_ARCHIVO, data);
}

/**
 * Best-effort: crea un cliente liviano en clientes.json si no existe ya
 * uno con ese celular. Mismo esquema exacto que clientes.js/admin-server.js
 * para que el panel lo pueda editar y volver a guardar sin perder nada.
 * Nunca lanza — si falla, el registro de la cuenta igual se completa.
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
      celular, notas: 'Se registró solo desde la tienda web.',
      creadoEn: ahora, actualizadoEn: ahora,
    });
    await guardarJsonPrivadoGenerico('clientes.json', { clientes, actualizado: ahora });
  } catch (err) {
    console.error('[cliente-auth] No se pudo sincronizar con clientes.json:', err.message);
  }
}

/** Hash con salt (scrypt, módulo nativo de Node) — mismo criterio que lib/owncloud-privado.js */
function hashPin(pin, salt) {
  const s = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pin), s, 64).toString('hex');
  return { salt: s, hash };
}
function verificarPin(pin, salt, hashEsperado) {
  const { hash } = hashPin(pin, salt);
  try {
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(hashEsperado, 'hex'));
  } catch {
    return false;
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

  const accion  = String(body.accion || '').trim();
  const celular = normalizarCelular(body.celular);
  const pin     = String(body.pin || '').trim();
  const nombre  = String(body.nombre || '').trim();

  if (!celular || celular.replace('+', '').length < 6) {
    return { statusCode: 400, headers: HEADERS_CORS, body: JSON.stringify({ ok: false, error: 'Celular inválido.' }) };
  }
  if (!/^\d{4,6}$/.test(pin)) {
    return { statusCode: 400, headers: HEADERS_CORS, body: JSON.stringify({ ok: false, error: 'El PIN debe tener entre 4 y 6 dígitos.' }) };
  }

  const data = await leerJsonPrivado();

  if (accion === 'registro') {
    if (!nombre || nombre.length < 2) {
      return { statusCode: 400, headers: HEADERS_CORS, body: JSON.stringify({ ok: false, error: 'Ingresá tu nombre.' }) };
    }
    const existente = data.cuentas.find(c => c.celular === celular);
    if (existente) {
      return { statusCode: 409, headers: HEADERS_CORS, body: JSON.stringify({ ok: false, error: 'Ya existe una cuenta con este celular. Iniciá sesión.' }) };
    }
    const { salt, hash } = hashPin(pin);
    const nuevaCuenta = {
      id: 'ca' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      celular, nombre,
      pinHash: hash, pinSalt: salt,
      creadoEn: new Date().toISOString(),
      actualizadoEn: new Date().toISOString(),
    };
    data.cuentas.push(nuevaCuenta);
    data.actualizado = new Date().toISOString();
    const resultado = await guardarJsonPrivado(data);
    if (!resultado.ok) {
      return { statusCode: 500, headers: HEADERS_CORS, body: JSON.stringify({ ok: false, error: resultado.error }) };
    }
    await sincronizarClientePublico(nombre, celular); // best-effort, no bloquea la respuesta si falla
    return {
      statusCode: 200, headers: HEADERS_CORS,
      body: JSON.stringify({ ok: true, cliente: { id: nuevaCuenta.id, nombre: nuevaCuenta.nombre, celular: nuevaCuenta.celular } }),
    };
  }

  if (accion === 'login') {
    const cuenta = data.cuentas.find(c => c.celular === celular);
    if (!cuenta || !cuenta.pinHash || !cuenta.pinSalt || !verificarPin(pin, cuenta.pinSalt, cuenta.pinHash)) {
      return { statusCode: 401, headers: HEADERS_CORS, body: JSON.stringify({ ok: false, error: 'Celular o PIN incorrectos.' }) };
    }
    return {
      statusCode: 200, headers: HEADERS_CORS,
      body: JSON.stringify({ ok: true, cliente: { id: cuenta.id, nombre: cuenta.nombre, celular: cuenta.celular } }),
    };
  }

  return { statusCode: 400, headers: HEADERS_CORS, body: JSON.stringify({ ok: false, error: 'Acción inválida.' }) };
};
