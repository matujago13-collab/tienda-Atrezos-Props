/**
 * Netlify Function: /api/empaque
 * ─────────────────────────────────────────────────────────────────────
 * Vista de solo lectura (+ un check de estado) para los colaboradores que
 * empacan/guardan pedidos — para que puedan controlar qué se vendió, con
 * fotos y datos de contacto, SIN entrar al Panel de Ventas ni tocar
 * ventas.json. Totalmente separado a propósito:
 *
 *  - GET  -> junta ventas.json (pedidos reservados/pagados) + clientes.json
 *            (para el celular) + empaque-estado.json (empacado/etiquetado)
 *            y devuelve una lista lista para mostrar.
 *  - POST -> SOLO actualiza el estado de empacado/etiquetado de UN pedido
 *            (no reescribe la lista entera, así dos colaboradores marcando
 *            al mismo tiempo no se pisan uno a otro).
 *
 * Protegido con EMPAQUE_KEY (variable de entorno propia, distinta de
 * ADMIN_VENTAS_KEY) — así los colaboradores tienen una clave simple sin
 * acceso al resto del panel de administración. Mismo criterio de "si no
 * hay clave configurada, no bloquea" que el resto del proyecto.
 *
 * empaque-estado.json es un archivo NUEVO, separado de ventas.json a
 * propósito: ventas.json lo reescribe entero admin-server.js con una
 * whitelist de campos fija cada vez que se guarda algo del Panel de
 * Ventas — si el empacado/etiquetado viviera ahí, el próximo guardado del
 * panel lo borraría sin querer (mismo motivo por el que existen
 * pedidos-pendientes.json y clientes-auth.json como archivos separados).
 */

const axios = require('axios');

const HEADERS_CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-empaque-key',
};

const ESTADO_ARCHIVO = 'empaque-estado.json';

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

/** Misma clave compartida que ventas.js/pedido-pendiente.js, pero con su propia variable. */
function claveOk(event) {
  const esperada = (process.env.EMPAQUE_KEY || '').trim();
  if (!esperada) return true;
  const recibida = (event.headers && (event.headers['x-empaque-key'] || event.headers['X-Empaque-Key'])) || '';
  return recibida === esperada;
}

async function leerJsonPrivado(nombreArchivo, defaultValue) {
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
    console.error(`[empaque] Error leyendo ${nombreArchivo}:`, err.message);
    return defaultValue;
  }
}

async function guardarJsonPrivado(nombreArchivo, data) {
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
    console.error(`[empaque] Error guardando ${nombreArchivo}:`, err.message);
    return { ok: false, error: err.message };
  }
}

/** Antes era comprobanteUrl/fotoPedidoUrl (string). Ahora comprobanteUrls/fotoPedidoUrls (array). */
function fotosArray(arrayNuevo, urlVieja) {
  if (Array.isArray(arrayNuevo) && arrayNuevo.length) return arrayNuevo.filter(Boolean);
  if (urlVieja) return [urlVieja];
  return [];
}

const ESTADOS_PARA_EMPAQUE = ['reservado', 'pagada'];

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: HEADERS_CORS, body: '' };
  if (!claveOk(event)) {
    return { statusCode: 401, headers: HEADERS_CORS, body: JSON.stringify({ ok: false, error: 'Clave incorrecta.' }) };
  }

  if (event.httpMethod === 'GET') {
    const [ventasData, clientesData, estadoData] = await Promise.all([
      leerJsonPrivado('ventas.json', { ventas: [] }),
      leerJsonPrivado('clientes.json', { clientes: [] }),
      leerJsonPrivado(ESTADO_ARCHIVO, { estados: {} }),
    ]);
    const ventas    = Array.isArray(ventasData.ventas) ? ventasData.ventas : [];
    const clientes  = Array.isArray(clientesData.clientes) ? clientesData.clientes : [];
    const estados   = (estadoData && typeof estadoData.estados === 'object' && estadoData.estados) || {};

    const pedidos = ventas
      .filter(v => ESTADOS_PARA_EMPAQUE.includes(v.estado))
      .map(v => {
        const cliente = clientes.find(c => c.id === v.clienteId);
        const est = estados[v.id] || {};
        return {
          id: v.id,
          clienteNombre: v.clienteNombre || '',
          clienteCelular: cliente?.celular || '',
          vendedorNombre: v.vendedorNombre || '',
          items: (v.items || []).map(it => ({ nombre: it.nombre, cantidad: it.cantidad, precioUnit: it.precioUnit })),
          subtotal: v.subtotal || 0,
          recargoPct: v.recargoPct || 0,
          total: v.total || 0,
          conFactura: !!v.conFactura,
          conTarjeta: !!v.conTarjeta,
          notaInterna: v.notaInterna || '',
          comprobanteUrls: fotosArray(v.comprobanteUrls, v.comprobanteUrl),
          fotoPedidoUrls: fotosArray(v.fotoPedidoUrls, v.fotoPedidoUrl),
          estado: v.estado,
          fecha: v.confirmadaEn || v.reservadoEn || v.actualizadoEn || null,
          empacado: !!est.empacado,
          etiquetado: !!est.etiquetado,
        };
      })
      .sort((a, b) => new Date(b.fecha || 0) - new Date(a.fecha || 0));

    return { statusCode: 200, headers: HEADERS_CORS, body: JSON.stringify({ ok: true, pedidos }) };
  }

  if (event.httpMethod === 'POST') {
    try {
      const body = JSON.parse(event.body || '{}');
      const ventaId = String(body.ventaId || '').trim();
      if (!ventaId) {
        return { statusCode: 400, headers: HEADERS_CORS, body: JSON.stringify({ ok: false, error: 'Falta ventaId.' }) };
      }
      const estadoData = await leerJsonPrivado(ESTADO_ARCHIVO, { estados: {} });
      const estados = (estadoData && typeof estadoData.estados === 'object' && estadoData.estados) || {};
      const actual = estados[ventaId] || { empacado: false, etiquetado: false };
      if (typeof body.empacado === 'boolean') actual.empacado = body.empacado;
      if (typeof body.etiquetado === 'boolean') actual.etiquetado = body.etiquetado;
      actual.actualizadoEn = new Date().toISOString();
      estados[ventaId] = actual;

      const resultado = await guardarJsonPrivado(ESTADO_ARCHIVO, { estados, actualizado: new Date().toISOString() });
      return {
        statusCode: 200, headers: HEADERS_CORS,
        body: JSON.stringify({ ok: resultado.ok, error: resultado.error, estado: actual }),
      };
    } catch (err) {
      return { statusCode: 500, headers: HEADERS_CORS, body: JSON.stringify({ ok: false, error: err.message }) };
    }
  }

  return { statusCode: 405, headers: HEADERS_CORS, body: JSON.stringify({ ok: false, error: 'Método no permitido' }) };
};
