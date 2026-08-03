/**
 * Netlify Function: GET /api/actividad-reciente
 * ─────────────────────────────────────────────────────────────────────
 * Lee ventas.json y devuelve un subconjunto PÚBLICO y seguro de las
 * ventas confirmadas más recientes (estado 'pagada'), para el banner de
 * "ventas en vivo" del catálogo — SOLO nombre de pila + producto + fecha.
 * Nunca expone celular, dirección, comprobantes ni el nombre completo.
 *
 * A propósito NO se protege con x-admin-key: es de solo lectura y ya
 * viene reducido a datos que la tienda pública puede mostrar sin
 * problema (lo mismo que un cliente vería pasar por la vidriera).
 *
 * Si no hay ninguna venta confirmada en los últimos DIAS_VENTANA días,
 * devuelve una lista vacía — el frontend no debe inventar actividad
 * cuando esto pasa (ver iniciarVentasEnVivo() en index.html).
 */

const axios = require('axios');

const HEADERS_CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

const DIAS_VENTANA = 14;
const MAX_ITEMS = 20;

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
function primerNombre(nombreCompleto) {
  return String(nombreCompleto || '').trim().split(/\s+/)[0] || 'Alguien';
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: HEADERS_CORS, body: '' };
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: HEADERS_CORS, body: JSON.stringify({ ok: false, error: 'Método no permitido' }) };
  }

  const { ocUrl, ocUser, ocPass, ocBase } = ocEnv();
  if (!ocUrl || !ocUser || !ocPass) {
    return { statusCode: 200, headers: HEADERS_CORS, body: JSON.stringify({ ok: true, actividad: [] }) };
  }

  try {
    const davBase = ocUrl.replace(/\/$/, '');
    const ruta    = rutaPrivada(ocBase, 'ventas.json');
    const { data } = await axios.get(davBase + encodeURI(ruta), {
      auth: { username: ocUser, password: ocPass },
      responseType: 'text',
      validateStatus: s => s === 200,
    });
    const parsed = JSON.parse(data);
    const ventas = Array.isArray(parsed.ventas) ? parsed.ventas : [];

    const limiteMs = Date.now() - DIAS_VENTANA * 24 * 60 * 60 * 1000;
    const actividad = ventas
      .filter(v => v.estado === 'pagada' && Array.isArray(v.items) && v.items.length)
      .map(v => ({
        nombre:   primerNombre(v.clienteNombre),
        producto: String((v.items[0] || {}).nombre || '').trim(),
        fecha:    v.confirmadaEn || v.actualizadoEn || v.reservadoEn || null,
      }))
      .filter(a => a.producto && a.fecha && new Date(a.fecha).getTime() >= limiteMs)
      .sort((a, b) => new Date(b.fecha) - new Date(a.fecha))
      .slice(0, MAX_ITEMS);

    return { statusCode: 200, headers: HEADERS_CORS, body: JSON.stringify({ ok: true, actividad }) };
  } catch (err) {
    console.error('[actividad-reciente] Error leyendo ventas.json:', err.message);
    return { statusCode: 200, headers: HEADERS_CORS, body: JSON.stringify({ ok: true, actividad: [] }) };
  }
};
