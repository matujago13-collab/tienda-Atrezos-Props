/**
 * Netlify Function: /api/venta-rapida
 * ─────────────────────────────────────────────────────────────────────
 * Carga de una venta NUEVA desde el celular (fuera del Panel de Ventas),
 * pensada para vender sin estar frente a la PC. A propósito NO reemplaza
 * el panel completo de admin.html: no soporta edición de ventas ya
 * cargadas, ni tipoEntrega/direccionEntrega/transportadora, ni fotos de
 * comprobante — eso se sigue completando después desde el panel si hace
 * falta. Solo hace lo mínimo para: reservar/vender productos del celular
 * y que el stock del catálogo quede correcto de inmediato.
 *
 * Mismo criterio que empaque.js: JSON directo en ownCloud, protegido con
 * su propia clave (VENTA_RAPIDA_KEY, separada de EMPAQUE_KEY y de
 * ADMIN_VENTAS_KEY) — "si no hay clave configurada, no bloquea".
 *
 * Por qué escribe con If-Match (ETag):
 * admin-server.js (tu PC) y esta función pueden escribir productos.json
 * al mismo tiempo. Ninguna escritura de ownCloud en este proyecto usaba
 * bloqueo optimista hasta ahora (todo era "leer todo, pisar todo") — acá
 * sí lo agregamos porque una venta nueva TIENE que restar del stock que
 * había en ese instante, no de una copia vieja. Si otra escritura ganó la
 * carrera (412 Precondition Failed), se relee y se reintenta solo, hasta
 * 5 veces, aplicando el MISMO delta de nuevo sobre el estado más fresco.
 *
 * ventas.json en cambio se combina por id (mismo patrón que combinarPorId
 * en admin-server.js) — agregar una venta nueva nunca puede pisar otra.
 *
 * Cada venta creada acá lleva origen:'movil', para que admin-server.js la
 * distinga de las cargadas desde el panel (ver poller en admin-server.js:
 * las del panel ya avisan al grupo de WhatsApp al instante; las de acá
 * las avisa un poller aparte la próxima vez que la PC sincroniza).
 */

const axios = require('axios');

const HEADERS_CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-venta-key',
};

const VENTAS_ESTADOS_ACEPTADOS = ['reservado', 'pagada'];
const MAX_REINTENTOS_STOCK = 5;

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

/** Misma clave compartida que empaque.js, pero con su propia variable. */
function claveOk(event) {
  const esperada = (process.env.VENTA_RAPIDA_KEY || '').trim();
  if (!esperada) return true;
  const recibida = (event.headers && (event.headers['x-venta-key'] || event.headers['X-Venta-Key'])) || '';
  return recibida === esperada;
}

/** Lee un JSON de ownCloud y devuelve también el ETag (para escribir después con If-Match). */
async function leerJsonConEtag(nombreArchivo, defaultValue) {
  const { ocUrl, ocUser, ocPass, ocBase } = ocEnv();
  if (!ocUrl || !ocUser || !ocPass) return { data: defaultValue, etag: null };
  try {
    const davBase = ocUrl.replace(/\/$/, '');
    const ruta    = rutaPrivada(ocBase, nombreArchivo);
    const res = await axios.get(davBase + encodeURI(ruta), {
      auth: { username: ocUser, password: ocPass },
      responseType: 'text',
      validateStatus: s => s === 200,
    });
    return { data: JSON.parse(res.data), etag: res.headers['etag'] || null };
  } catch (err) {
    console.error(`[venta-rapida] Error leyendo ${nombreArchivo}:`, err.message);
    return { data: defaultValue, etag: null };
  }
}

/**
 * Escribe un JSON a ownCloud. Si se pasa etagEsperado, manda If-Match — si
 * ownCloud devuelve 412 (alguien más escribió antes), NO tira excepción:
 * devuelve { ok:false, conflicto:true } para que el llamador releea y
 * reintente con el estado fresco.
 */
async function guardarJsonConEtag(nombreArchivo, data, etagEsperado) {
  const { ocUrl, ocUser, ocPass, ocBase } = ocEnv();
  if (!ocUrl || !ocUser || !ocPass) return { ok: false, error: 'ownCloud no configurado.' };
  try {
    const davBase = ocUrl.replace(/\/$/, '');
    const ruta    = rutaPrivada(ocBase, nombreArchivo);
    const json    = JSON.stringify(data, null, 2);
    const headers = { 'Content-Type': 'application/json' };
    if (etagEsperado) headers['If-Match'] = etagEsperado;
    const r = await axios({
      method: 'PUT',
      url: davBase + encodeURI(ruta),
      auth: { username: ocUser, password: ocPass },
      data: Buffer.from(json, 'utf8'),
      headers,
      maxBodyLength: Infinity,
      validateStatus: s => [200, 201, 204, 412].includes(s),
    });
    if (r.status === 412) return { ok: false, conflicto: true };
    return { ok: true };
  } catch (err) {
    console.error(`[venta-rapida] Error guardando ${nombreArchivo}:`, err.message);
    return { ok: false, error: err.message };
  }
}

/** Busca categoría+producto por id, con la misma tolerancia string/number que admin.html. */
function buscarProducto(categorias, catId, prodId) {
  const cat = (categorias || []).find(c => String(c.id) === String(catId));
  if (!cat) return null;
  const producto = (cat.productos || []).find(p => String(p.id) === String(prodId));
  if (!producto) return null;
  return { cat, producto };
}

/**
 * Valida los items contra el catálogo (sin modificar nada todavía) y
 * devuelve los que no se encontraron, para poder rechazar la venta ENTERA
 * antes de tocar stock si algo no cierra (nunca aplicar una venta a medias).
 */
function validarItems(categorias, items) {
  const noEncontrados = [];
  items.forEach(it => {
    if (!buscarProducto(categorias, it.catId, it.prodId)) {
      noEncontrados.push(`${it.nombre || it.prodId}`);
    }
  });
  return noEncontrados;
}

/** Mismo criterio que ventasAplicarDeltaStock en admin.html, pero solo para venta nueva (sin original que restar). */
function aplicarStockVentaNueva(categorias, items) {
  items.forEach(it => {
    const encontrado = buscarProducto(categorias, it.catId, it.prodId);
    if (!encontrado) return; // ya validado antes — no debería pasar acá
    const { producto } = encontrado;
    if (it.preventa) {
      producto.preventaReservado = Math.max(0, (producto.preventaReservado || 0) + it.cantidad);
    } else {
      producto.stock = Math.max(0, (typeof producto.stock === 'number' ? producto.stock : 0) - it.cantidad);
    }
  });
}

function combinarPorId(listaFresca, listaEntrante) {
  const mapa = new Map((listaFresca || []).map(r => [r.id, r]));
  (listaEntrante || []).forEach(r => { if (r && r.id) mapa.set(r.id, r); });
  return [...mapa.values()];
}

function limpiarItemsEntrada(itemsCrudos) {
  return (Array.isArray(itemsCrudos) ? itemsCrudos : [])
    .map(it => ({
      catId: it.catId,
      prodId: it.prodId,
      nombre: String(it.nombre || ''),
      cantidad: Math.max(0, Number(it.cantidad) || 0),
      precioUnit: Math.max(0, Number(it.precioUnit) || 0),
      ...(it.preventa ? { preventa: true } : {}),
    }))
    .filter(it => it.catId != null && it.prodId != null && it.cantidad > 0);
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: HEADERS_CORS, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: HEADERS_CORS, body: JSON.stringify({ ok: false, error: 'Método no permitido' }) };
  }
  if (!claveOk(event)) {
    return { statusCode: 401, headers: HEADERS_CORS, body: JSON.stringify({ ok: false, error: 'Clave incorrecta.' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers: HEADERS_CORS, body: JSON.stringify({ ok: false, error: 'JSON inválido.' }) }; }

  // ── Reintento SOLO del registro de venta (sin volver a tocar stock) ──
  // Se usa cuando una venta anterior ya descontó el stock pero no se pudo
  // guardar en ventas.json (ver respuesta 207 más abajo) — reintenta nada
  // más que el paso 3, con la MISMA venta ya armada, para no descontar el
  // stock dos veces por la misma venta.
  if (body.soloGuardarVenta === true) {
    const ventaPrearmada = body.venta;
    if (!ventaPrearmada || !ventaPrearmada.id) {
      return { statusCode: 400, headers: HEADERS_CORS, body: JSON.stringify({ ok: false, error: 'Falta la venta a reintentar.' }) };
    }
    let intentoReintento = 0;
    while (intentoReintento < MAX_REINTENTOS_STOCK) {
      intentoReintento++;
      const { data: ventasData, etag } = await leerJsonConEtag('ventas.json', { ventas: [] });
      const ventasActuales = Array.isArray(ventasData.ventas) ? ventasData.ventas : [];
      const combinado = { ventas: combinarPorId(ventasActuales, [ventaPrearmada]), actualizado: new Date().toISOString() };
      const resultado = await guardarJsonConEtag('ventas.json', combinado, etag);
      if (resultado.ok) {
        return { statusCode: 200, headers: HEADERS_CORS, body: JSON.stringify({ ok: true, venta: ventaPrearmada }) };
      }
      if (resultado.conflicto) continue;
      return { statusCode: 503, headers: HEADERS_CORS, body: JSON.stringify({ ok: false, error: resultado.error || 'No se pudo guardar el registro, probá de nuevo.' }) };
    }
    return { statusCode: 503, headers: HEADERS_CORS, body: JSON.stringify({ ok: false, error: 'No se pudo guardar el registro por demasiados intentos simultáneos.' }) };
  }

  const items = limpiarItemsEntrada(body.items);
  if (!items.length) {
    return { statusCode: 400, headers: HEADERS_CORS, body: JSON.stringify({ ok: false, error: 'La venta no tiene productos.' }) };
  }
  const clienteNombre = String(body.clienteNombre || '').trim();
  if (!clienteNombre && !body.clienteId) {
    return { statusCode: 400, headers: HEADERS_CORS, body: JSON.stringify({ ok: false, error: 'Falta el nombre del cliente.' }) };
  }
  const estado = VENTAS_ESTADOS_ACEPTADOS.includes(body.estado) ? body.estado : 'reservado';

  // ── 1) Stock: leer, validar, aplicar delta, escribir con If-Match ──────
  let intento = 0;
  let stockOk = false;
  let errorStock = null;
  while (intento < MAX_REINTENTOS_STOCK && !stockOk) {
    intento++;
    const { data: productosData, etag } = await leerJsonConEtag('productos.json', null);
    if (!productosData) {
      errorStock = 'No se pudo leer el catálogo desde ownCloud.';
      break;
    }
    const categorias = Array.isArray(productosData.categorias) ? productosData.categorias : [];
    const noEncontrados = validarItems(categorias, items);
    if (noEncontrados.length) {
      return {
        statusCode: 400, headers: HEADERS_CORS,
        body: JSON.stringify({ ok: false, error: `No se encontró en el catálogo: ${noEncontrados.join(', ')}` }),
      };
    }
    aplicarStockVentaNueva(categorias, items);
    const resultado = await guardarJsonConEtag('productos.json', productosData, etag);
    if (resultado.ok) { stockOk = true; break; }
    if (resultado.conflicto) { continue; } // alguien escribió al mismo tiempo — reintentar con estado fresco
    errorStock = resultado.error || 'Error desconocido al guardar el stock.';
    break;
  }
  if (!stockOk) {
    const msg = errorStock
      ? `No se pudo actualizar el stock: ${errorStock}`
      : 'No se pudo actualizar el stock por demasiados intentos simultáneos — probá de nuevo en unos segundos.';
    return { statusCode: 503, headers: HEADERS_CORS, body: JSON.stringify({ ok: false, error: msg }) };
  }

  // ── 2) Armar la venta (mismo esquema que apiPostVentas en admin-server.js) ──
  const ahora = new Date().toISOString();
  const subtotalCalculado = items.reduce((acc, it) => acc + it.cantidad * it.precioUnit, 0);
  const venta = {
    id: 'v' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    clienteId: String(body.clienteId || ''),
    clienteNombre,
    vendedorId: String(body.vendedorId || ''),
    vendedorNombre: String(body.vendedorNombre || ''),
    items,
    subtotal: Number(body.subtotal) || subtotalCalculado,
    conFactura: !!body.conFactura,
    conTarjeta: !!body.conTarjeta,
    recargoPct: Number(body.recargoPct) || 0,
    total: Number(body.total) || subtotalCalculado,
    metodoPago: String(body.metodoPago || '').trim(),
    tipoEntrega: '',
    direccionEntrega: '',
    transportadora: '',
    comprobanteUrls: [],
    fotoPedidoUrls: [],
    notaInterna: String(body.notaInterna || ''),
    estado,
    reservadoEn: ahora,
    expiraEn: null,
    confirmadaEn: estado === 'pagada' ? ahora : null,
    canceladaEn: null,
    devueltaEn: null,
    editadaEn: null,
    actualizadoEn: ahora,
    origen: 'movil', // ver chequearVentasMovilNuevas() en admin-server.js
  };

  // ── 3) ventas.json: combinar por id (nunca pisa ventas de otro origen) ──
  intento = 0;
  let ventasOk = false;
  let errorVentas = null;
  while (intento < MAX_REINTENTOS_STOCK && !ventasOk) {
    intento++;
    const { data: ventasData, etag } = await leerJsonConEtag('ventas.json', { ventas: [] });
    const ventasActuales = Array.isArray(ventasData.ventas) ? ventasData.ventas : [];
    const combinado = { ventas: combinarPorId(ventasActuales, [venta]), actualizado: ahora };
    const resultado = await guardarJsonConEtag('ventas.json', combinado, etag);
    if (resultado.ok) { ventasOk = true; break; }
    if (resultado.conflicto) { continue; }
    errorVentas = resultado.error || 'Error desconocido al guardar la venta.';
    break;
  }

  if (!ventasOk) {
    // El stock YA quedó descontado — no lo revertimos automáticamente para
    // no arriesgar otra carrera; se avisa igual con la venta hecha, para
    // que se cargue el registro a mano desde el panel si hace falta.
    return {
      statusCode: 207, headers: HEADERS_CORS,
      body: JSON.stringify({
        ok: false,
        stockActualizado: true,
        error: `El stock se descontó pero la venta no se pudo guardar (${errorVentas || 'reintentos agotados'}). Cargala a mano desde el panel — el stock ya está correcto.`,
        venta,
      }),
    };
  }

  return { statusCode: 200, headers: HEADERS_CORS, body: JSON.stringify({ ok: true, venta }) };
};
