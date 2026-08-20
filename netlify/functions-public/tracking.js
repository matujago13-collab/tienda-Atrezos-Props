/**
 * Netlify Function: /api/tracking
 * ─────────────────────────────────────────────────────────────────────
 * GET ?id=<pedidoId> -> Devuelve el estado público de UN pedido, para la
 *         página de tracking del cliente (tutienda.com/pedido/ID o
 *         similar). SIN clave — la llama cualquier visitante que tenga
 *         el ID de su pedido, igual que la rama pública de
 *         pedido-pendiente.js.
 *
 * Lee tracking-publico.json desde ownCloud, con las MISMAS credenciales
 * (OWNCLOUD_URL/USER/PASS/RUTA_BASE) que ya usa pedido-pendiente.js — ese
 * archivo lo arma y sube admin-server.js cada vez que cambia el estado de
 * una venta (sincronizarTrackingPublico()), y a propósito NO incluye nada
 * sensible: sin costos, sin notaInterna, sin vendedorNombre, sin
 * comprobantes ni datos de otros clientes — solo lo que el cliente
 * necesita ver de SU pedido.
 *
 * Nunca se manda el archivo completo al navegador: se lee entero acá
 * (server-side, con las credenciales privadas) y se devuelve solo el
 * registro pedido por ID.
 */

const axios = require('axios');

const HEADERS_CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const NOMBRE_ARCHIVO = 'tracking-publico.json';

function ocEnv() {
  return {
    ocUrl:  (process.env.OWNCLOUD_URL       || '').trim(),
    ocUser: (process.env.OWNCLOUD_USER      || '').trim(),
    ocPass: (process.env.OWNCLOUD_PASS      || '').trim(),
    ocBase: (process.env.OWNCLOUD_RUTA_BASE || '/MiTienda/Imagenes/').trim(),
  };
}

function rutaPrivada(ocBase, nombreArchivo) {
  const rutaBase = '/' + ocBase.replace(/^\/|\/$/g, '');
  return rutaBase.replace(/\/[^/]+$/, '') + '/' + nombreArchivo;
}

async function leerTrackingPublico() {
  const { ocUrl, ocUser, ocPass, ocBase } = ocEnv();
  if (!ocUrl || !ocUser || !ocPass) return { pedidos: {}, actualizado: null };
  try {
    const davBase = ocUrl.replace(/\/$/, '');
    const ruta    = rutaPrivada(ocBase, NOMBRE_ARCHIVO);
    const { data } = await axios.get(davBase + encodeURI(ruta), {
      auth: { username: ocUser, password: ocPass },
      responseType: 'text',
      validateStatus: s => s === 200,
    });
    const parsed = JSON.parse(data);
    return { pedidos: parsed.pedidos && typeof parsed.pedidos === 'object' ? parsed.pedidos : {}, actualizado: parsed.actualizado || null };
  } catch (err) {
    console.error('[tracking] Error leyendo tracking-publico.json:', err.message);
    return { pedidos: {}, actualizado: null };
  }
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: HEADERS_CORS, body: '' };

  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: HEADERS_CORS, body: JSON.stringify({ ok: false, error: 'Método no permitido' }) };
  }

  const id = ((event.queryStringParameters || {}).id || '').trim();
  if (!id) {
    return { statusCode: 400, headers: HEADERS_CORS, body: JSON.stringify({ ok: false, error: 'Falta ?id=' }) };
  }

  const { pedidos } = await leerTrackingPublico();
  const pedido = pedidos[id];
  if (!pedido) {
    return { statusCode: 404, headers: HEADERS_CORS, body: JSON.stringify({ ok: false, error: 'No encontramos un pedido con ese número.' }) };
  }

  return { statusCode: 200, headers: HEADERS_CORS, body: JSON.stringify({ ok: true, pedido }) };
};
