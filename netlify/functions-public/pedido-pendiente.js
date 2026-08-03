/**
 * Netlify Function: /api/pedido-pendiente
 * ─────────────────────────────────────────────────────────────────────
 * POST -> Guarda el pedido del carrito público en el mismo instante en
 *         que el cliente lo manda por WhatsApp (pedirPorWhatsApp() en
 *         index.html llama acá en paralelo, sin tocar el flujo de
 *         WhatsApp que ya funciona). Así el vendedor lo ve en el panel
 *         y solo confirma, en vez de tipear el pedido de cero.
 * GET  -> Lista los pedidos pendientes (protegido con x-admin-key, igual
 *         criterio que ventas.js/clientes.js — si no hay clave configurada,
 *         no bloquea, misma "conveniencia" que el resto del panel).
 *
 * Guarda en pedidos-pendientes.json, un archivo NUEVO y separado de
 * ventas.json a propósito: ventas.json lo administra el panel de Ventas
 * (protegido con clave de admin, pensado para que solo el staff escriba).
 * Esta función necesita escritura pública (la llama la tienda, sin login
 * de admin), así que usa su propio archivo — el staff decide desde el
 * panel qué pedido pendiente se convierte en venta real, no se toca
 * ventas.json ni clientes.json automáticamente.
 */

const axios = require('axios');

const HEADERS_CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-admin-key',
};

const NOMBRE_ARCHIVO = 'pedidos-pendientes.json';
const VACIO = { pedidos: [], actualizado: null };

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

/** Misma clave compartida que ventas.js/clientes.js (ADMIN_VENTAS_KEY, o ADMIN_COSTOS_KEY como fallback). */
function claveOk(event) {
  const esperada = (process.env.ADMIN_VENTAS_KEY || process.env.ADMIN_COSTOS_KEY || '').trim();
  if (!esperada) return true;
  const recibida = (event.headers && (event.headers['x-admin-key'] || event.headers['X-Admin-Key'])) || '';
  return recibida === esperada;
}

async function leerJsonPrivado() {
  const { ocUrl, ocUser, ocPass, ocBase } = ocEnv();
  if (!ocUrl || !ocUser || !ocPass) return VACIO;
  try {
    const davBase = ocUrl.replace(/\/$/, '');
    const ruta    = rutaPrivada(ocBase, NOMBRE_ARCHIVO);
    const { data } = await axios.get(davBase + encodeURI(ruta), {
      auth: { username: ocUser, password: ocPass },
      responseType: 'text',
      validateStatus: s => s === 200,
    });
    const parsed = JSON.parse(data);
    return { pedidos: Array.isArray(parsed.pedidos) ? parsed.pedidos : [], actualizado: parsed.actualizado || null };
  } catch (err) {
    console.error('[pedido-pendiente] Error leyendo pedidos-pendientes.json:', err.message);
    return VACIO;
  }
}

async function guardarJsonPrivado(data) {
  const { ocUrl, ocUser, ocPass, ocBase } = ocEnv();
  if (!ocUrl || !ocUser || !ocPass) return { ok: false, error: 'ownCloud no configurado.' };
  try {
    const davBase = ocUrl.replace(/\/$/, '');
    const ruta    = rutaPrivada(ocBase, NOMBRE_ARCHIVO);
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
    console.error('[pedido-pendiente] Error guardando pedidos-pendientes.json:', err.message);
    return { ok: false, error: err.message };
  }
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: HEADERS_CORS, body: '' };

  if (event.httpMethod === 'GET') {
    if (!claveOk(event)) {
      return { statusCode: 401, headers: HEADERS_CORS, body: JSON.stringify({ ok: false, error: 'Clave incorrecta.' }) };
    }
    const data = await leerJsonPrivado();
    return { statusCode: 200, headers: HEADERS_CORS, body: JSON.stringify({ ok: true, ...data }) };
  }

  if (event.httpMethod === 'POST') {
    try {
      const body = JSON.parse(event.body || '{}');
      const itemsIn = Array.isArray(body.items) ? body.items : [];
      const items = itemsIn.map(it => ({
        catId:      it.catId,
        prodId:     it.prodId,
        nombre:     String(it.nombre || ''),
        cantidad:   Math.max(0, Number(it.cantidad) || 0),
        precioUnit: Math.max(0, Number(it.precioUnit) || 0),
      })).filter(it => it.cantidad > 0 && it.nombre !== '');

      if (!items.length) {
        return { statusCode: 400, headers: HEADERS_CORS, body: JSON.stringify({ ok: false, error: 'El pedido no tiene productos válidos.' }) };
      }

      const subtotal = items.reduce((acc, it) => acc + it.cantidad * it.precioUnit, 0);

      const nuevoPedido = {
        id:             'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
        clienteId:      String(body.clienteId || '').trim(),
        clienteNombre:  String(body.clienteNombre || '').trim(),
        celular:        String(body.celular || '').trim(),
        items,
        subtotal,
        notas:          String(body.notas || '').trim(),
        estado:         'pendiente',
        creadoEn:       new Date().toISOString(),
        actualizadoEn:  new Date().toISOString(),
      };

      const data = await leerJsonPrivado();
      data.pedidos.push(nuevoPedido);
      data.actualizado = new Date().toISOString();

      const resultado = await guardarJsonPrivado(data);
      return {
        statusCode: 200, headers: HEADERS_CORS,
        body: JSON.stringify({ ok: resultado.ok, error: resultado.error, pedido: nuevoPedido }),
      };
    } catch (err) {
      return { statusCode: 500, headers: HEADERS_CORS, body: JSON.stringify({ ok: false, error: err.message }) };
    }
  }

  return { statusCode: 405, headers: HEADERS_CORS, body: JSON.stringify({ ok: false, error: 'Método no permitido' }) };
};
