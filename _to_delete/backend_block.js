// ── Proveedores / Compras ────────────────────────────────────────────
// Mismo criterio que Clientes: JSON local + sync privado a ownCloud (sin
// share público), protegido con ADMIN_VENTAS_KEY (misma clave que el resto
// del Panel de Ventas — una clave menos que configurar). combinarPorId
// evita que un guardado desde este panel pise un registro tocado desde
// otra pestaña/dispositivo mientras tanto. El incremento de stock al
// recibir una compra NO se hace acá — se aplica del lado del cliente sobre
// estado.categorias (comprasAplicarDeltaStock en admin.html), exactamente
// igual que ventasAplicarDeltaStock, y se persiste con el mismo
// ventasGuardarStockYPublicar() ya existente — así nunca hay dos caminos
// distintos escribiendo productos.json y arriesgando pisarse.

const COMPRA_ESTADOS_VALIDOS = ['pendiente', 'recibida_parcial', 'recibida', 'cancelada'];

async function apiGetProveedores(req, res) {
  if (!claveVentasOk(req)) return jsonRes(res, 401, { ok: false, error: 'Clave incorrecta.' });
  let local = { proveedores: [], actualizado: null };
  try { local = JSON.parse(fs.readFileSync(PATH_PROVEEDORES, 'utf8')); } catch {}
  try {
    const data = await leerJsonPrivadoOwnCloud('proveedores.json', local);
    if (data !== local) { try { writeJsonAtomic(PATH_PROVEEDORES, data); } catch {} }
    jsonRes(res, 200, { ok: true, proveedores: data.proveedores || [], actualizado: data.actualizado || null });
  } catch {
    jsonRes(res, 200, { ok: true, proveedores: local.proveedores || [], actualizado: local.actualizado || null });
  }
}

async function apiPostProveedores(req, res) {
  if (!claveVentasOk(req)) return jsonRes(res, 401, { ok: false, error: 'Clave incorrecta.' });
  try {
    const body = await readBodyJSON(req);
    const entrantes = (Array.isArray(body.proveedores) ? body.proveedores : []).map(p => ({
      id:            p.id || ('pr' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7)),
      nombre:        String(p.nombre   || '').trim(),
      contacto:      String(p.contacto || '').trim(),
      telefono:      String(p.telefono || '').trim(),
      email:         String(p.email    || '').trim(),
      notas:         String(p.notas    || '').trim(),
      creadoEn:      p.creadoEn || new Date().toISOString(),
      actualizadoEn: new Date().toISOString(),
    })).filter(p => p.nombre !== '');

    let local = { proveedores: [] };
    try { local = JSON.parse(fs.readFileSync(PATH_PROVEEDORES, 'utf8')); } catch {}
    const remoto = await leerJsonPrivadoOwnCloud('proveedores.json', local);
    const actual = Array.isArray(remoto.proveedores) ? remoto.proveedores : (local.proveedores || []);
    const idsAEliminar = new Set((Array.isArray(body.eliminarIds) ? body.eliminarIds : []).filter(Boolean));
    const proveedores = combinarPorId(actual, entrantes).filter(p => !idsAEliminar.has(p.id));

    const data = { proveedores, actualizado: new Date().toISOString() };
    writeJsonAtomic(PATH_PROVEEDORES, data);
    const sync = await subirJsonPrivadoOwnCloud('proveedores.json', data);
    jsonRes(res, 200, { ok: true, proveedores, actualizado: data.actualizado, ...sync });
  } catch (e) {
    jsonRes(res, 500, { ok: false, error: e.message });
  }
}

async function apiGetCompras(req, res) {
  if (!claveVentasOk(req)) return jsonRes(res, 401, { ok: false, error: 'Clave incorrecta.' });
  let local = { compras: [], actualizado: null };
  try { local = JSON.parse(fs.readFileSync(PATH_COMPRAS, 'utf8')); } catch {}
  try {
    const data = await leerJsonPrivadoOwnCloud('compras.json', local);
    if (data !== local) { try { writeJsonAtomic(PATH_COMPRAS, data); } catch {} }
    jsonRes(res, 200, { ok: true, compras: data.compras || [], actualizado: data.actualizado || null });
  } catch {
    jsonRes(res, 200, { ok: true, compras: local.compras || [], actualizado: local.actualizado || null });
  }
}

async function apiPostCompras(req, res) {
  if (!claveVentasOk(req)) return jsonRes(res, 401, { ok: false, error: 'Clave incorrecta.' });
  try {
    const body = await readBodyJSON(req);
    const entrantes = (Array.isArray(body.compras) ? body.compras : []).map(c => ({
      id:              c.id || ('co' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7)),
      proveedorId:     c.proveedorId || '',
      proveedorNombre: String(c.proveedorNombre || '').trim(),
      fecha:           c.fecha || new Date().toISOString().slice(0, 10),
      estado:          COMPRA_ESTADOS_VALIDOS.includes(c.estado) ? c.estado : 'pendiente',
      items: (Array.isArray(c.items) ? c.items : []).map(it => ({
        catId:            it.catId,
        prodId:           it.prodId,
        nombre:           String(it.nombre || '').trim(),
        cantidadPedida:   Math.max(0, Number(it.cantidadPedida) || 0),
        cantidadRecibida: Math.max(0, Number(it.cantidadRecibida) || 0),
        costoUnitario:    Math.max(0, Number(it.costoUnitario) || 0),
      })).filter(it => it.nombre !== ''),
      pagos: (Array.isArray(c.pagos) ? c.pagos : []).map(pg => ({
        id:             pg.id || ('pg' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7)),
        monto:          Math.max(0, Number(pg.monto) || 0),
        fecha:          pg.fecha || new Date().toISOString().slice(0, 10),
        tipoPago:       String(pg.tipoPago || '').trim(),
        comprobanteUrl: String(pg.comprobanteUrl || '').trim(),
        nota:           String(pg.nota || '').trim(),
      })),
      notas:         String(c.notas || '').trim(),
      creadoEn:      c.creadoEn || new Date().toISOString(),
      actualizadoEn: new Date().toISOString(),
      recibidoEn:    c.recibidoEn || null,
    })).filter(c => c.proveedorId !== '' || c.items.length > 0);

    let local = { compras: [] };
    try { local = JSON.parse(fs.readFileSync(PATH_COMPRAS, 'utf8')); } catch {}
    const remoto = await leerJsonPrivadoOwnCloud('compras.json', local);
    const actual = Array.isArray(remoto.compras) ? remoto.compras : (local.compras || []);
    const idsAEliminar = new Set((Array.isArray(body.eliminarIds) ? body.eliminarIds : []).filter(Boolean));
    const compras = combinarPorId(actual, entrantes).filter(c => !idsAEliminar.has(c.id));

    const data = { compras, actualizado: new Date().toISOString() };
    writeJsonAtomic(PATH_COMPRAS, data);
    const sync = await subirJsonPrivadoOwnCloud('compras.json', data);
    jsonRes(res, 200, { ok: true, compras, actualizado: data.actualizado, ...sync });
  } catch (e) {
    jsonRes(res, 500, { ok: false, error: e.message });
  }
}

// POST /api/upload-compra → comprobante de pago / factura de una compra:
// imagen (→ WebP, igual que /api/upload-venta) o PDF (se sube tal cual,
// sin convertir — una factura de proveedor suele venir en PDF).
async function apiUploadCompra(req, res) {
  if (!claveVentasOk(req)) return jsonRes(res, 401, { ok: false, error: 'Clave incorrecta.' });
  try {
    let fileBuffer = null;
    let mimeSubido = '';
    const fields = {};
    await new Promise((resolve, reject) => {
      const bb = busboy({ headers: req.headers, limits: { fileSize: 25 * 1024 * 1024 } });
      const chunks = [];
      bb.on('file', (name, stream, info) => {
        mimeSubido = (info && info.mimeType) || '';
        stream.on('data', c => chunks.push(c));
        stream.on('end', () => { fileBuffer = Buffer.concat(chunks); });
      });
      bb.on('field', (name, val) => { fields[name] = val; });
      bb.on('finish', resolve);
      bb.on('error', reject);
      req.pipe(bb);
    });
    if (!fileBuffer || fileBuffer.length === 0) {
      return jsonRes(res, 400, { ok: false, error: 'No se recibió ningún archivo.' });
    }

    const ocUrl  = (process.env.OWNCLOUD_URL      || '').trim();
    const ocUser = (process.env.OWNCLOUD_USER     || '').trim();
    const ocPass = (process.env.OWNCLOUD_PASS     || '').trim();
    const ocBase = (process.env.OWNCLOUD_RUTA_BASE || '/MiTienda/Imagenes/').trim();

    const esPdf = mimeSubido === 'application/pdf' || fields.esPdf === 'true';
    const compraId = slugify(fields.compraId || 'compra');

    let buffer, ext, contentType;
    if (esPdf) {
      buffer = fileBuffer; ext = 'pdf'; contentType = 'application/pdf';
    } else {
      buffer = await sharp(fileBuffer)
        .resize({ width: 1400, height: 1400, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 82 })
        .toBuffer();
      ext = 'webp'; contentType = 'image/webp';
    }
    const filename = `comprobante-${compraId}-${Date.now()}.${ext}`;

    if (!ocUrl || !ocUser || !ocPass) {
      return jsonRes(res, 200, {
        ok: true,
        url: `data:${contentType};base64,${buffer.toString('base64')}`,
        owncloudGuardado: false,
        esPdf,
        aviso: 'ownCloud no configurado. Archivo procesado pero no subido.',
      });
    }

    const davBase = ocUrl.replace(/\/$/, '');
    const rutaImagenesBase = '/' + ocBase.replace(/^\/|\/$/g, '');
    const rutaComprasBase  = rutaImagenesBase.replace(/\/[^/]+\/?$/, '') + '/Compras/comprobantes';
    const ruta = `${rutaComprasBase}/${filename}`;

    await davPut(davBase, ocUser, ocPass, ruta, buffer, contentType);

    const servidor = owncloudServidorBase(davBase);
    const token = await getOrCreateShareToken(servidor, ocUser, ocPass, ruta);

    if (!token) {
      return jsonRes(res, 200, { ok: false, subidaOk: true, ruta, error: 'Archivo subido pero no se pudo crear el link público.' });
    }

    jsonRes(res, 200, { ok: true, url: `${servidor}/s/${token}/download`, esPdf });
  } catch (e) {
    jsonRes(res, 500, { ok: false, error: e.message });
  }
}

