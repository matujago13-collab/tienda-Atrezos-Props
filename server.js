/**
 * server.js — Atrezos & Props
 * ────────────────────────────────────────────────────────────────────
 * Ejecutar: node server.js   (después de: npm install)
 *
 * Flujo de imagen:
 *   1. Admin sube imagen  →  se convierte a WebP (sharp)
 *   2. Se sube a ownCloud via WebDAV (PUT)
 *   3. Se crea link público via OCS API
 *   4. Se devuelve: https://cloud.atrezosprops.space/s/TOKEN/download
 *   5. Ese URL queda guardado en el producto y se muestra en el catálogo
 *
 * Si ownCloud no está configurado, guarda localmente en /imagenes/
 */

const express  = require('express');
const multer   = require('multer');
const sharp    = require('sharp');
const axios    = require('axios');
const fs       = require('fs');
const path     = require('path');

const app  = express();
const PORT = 3000;
const DIR  = __dirname;

// ── Carpeta local de respaldo ──────────────────────────────────────────
const IMAGENES = path.join(DIR, 'imagenes');
if (!fs.existsSync(IMAGENES)) fs.mkdirSync(IMAGENES, { recursive: true });

// ── Middleware ─────────────────────────────────────────────────────────
app.use(express.json({ limit: '50mb' }));
app.use(express.static(DIR));

// ── Multer: archivos en memoria ────────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 30 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = /^image\/(jpeg|png|gif|webp|avif)$/.test(file.mimetype);
    cb(ok ? null : new Error('Solo imágenes JPG, PNG, GIF, WebP o AVIF'), ok);
  }
});

// ── Sanitizar nombre para ruta de archivo ─────────────────────────────
function slug(s) {
  return String(s)
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    || 'sin-nombre';
}

// ══════════════════════════════════════════════════════════════════════
//  OWNCLOUD — subida WebDAV + share público OCS
// ══════════════════════════════════════════════════════════════════════

/**
 * Sube un buffer a ownCloud via WebDAV (PUT).
 * Crea la carpeta destino primero con MKCOL si no existe.
 */
async function webdavPut(davBase, user, pass, rutaCompleta, buffer) {
  const auth = { username: user, password: pass };

  // Crear carpetas intermedias (MKCOL)
  const segmentos = rutaCompleta.split('/').filter(Boolean);
  segmentos.pop(); // quitar el nombre del archivo
  let acumulado = '';
  for (const seg of segmentos) {
    acumulado += '/' + seg;
    try {
      await axios({
        method: 'MKCOL',
        url: davBase.replace(/\/$/, '') + acumulado,
        auth,
        validateStatus: s => s === 201 || s === 405, // 405 = ya existe
      });
    } catch { /* ignorar errores individuales de MKCOL */ }
  }

  // Subir archivo
  const urlArchivo = davBase.replace(/\/$/, '') + rutaCompleta;
  const resp = await axios({
    method: 'PUT',
    url: urlArchivo,
    auth,
    data: buffer,
    headers: { 'Content-Type': 'image/webp' },
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  });

  if (![200, 201, 204].includes(resp.status)) {
    throw new Error(`WebDAV PUT falló: HTTP ${resp.status}`);
  }
  return urlArchivo;
}

/**
 * Busca o crea un share público (OCS API).
 * Devuelve el token del share o null si falla.
 */
async function obtenerShareToken(servidorBase, user, pass, rutaArchivo) {
  const auth    = { username: user, password: pass };
  const headers = { 'OCS-APIRequest': 'true', 'Accept': 'application/json' };

  for (const ocsPath of ['/ocs/v2.php', '/ocs/v1.php']) {
    const apiBase = servidorBase + ocsPath + '/apps/files_sharing/api/v1/shares';

    // A. Buscar share existente
    try {
      const { data } = await axios.get(apiBase, {
        auth, headers,
        params: { path: rutaArchivo, reshares: false },
        validateStatus: s => s === 200,
      });
      const shares = data?.ocs?.data;
      if (Array.isArray(shares)) {
        const pub = shares.find(s => s.share_type === 3 && s.token);
        if (pub) {
          console.log(`[ownCloud] Share existente: ${pub.token} (via ${ocsPath})`);
          return pub.token;
        }
      }
    } catch { /* no hay share aún */ }

    // B. Crear nuevo share
    try {
      const params = new URLSearchParams({
        path: rutaArchivo, shareType: '3', permissions: '1'
      });
      const { data } = await axios.post(apiBase, params.toString(), {
        auth,
        headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' },
        validateStatus: s => s === 200 || s === 201,
      });
      const token = data?.ocs?.data?.token;
      if (token) {
        console.log(`[ownCloud] Share creado: ${token} (via ${ocsPath})`);
        return token;
      }
    } catch (e) {
      console.warn(`[ownCloud] OCS ${ocsPath} POST falló:`, e.message);
    }
  }
  return null;
}

/**
 * Extrae la base del servidor quitando el path WebDAV.
 * Ej: https://cloud.x.com/remote.php/dav/files/USER → https://cloud.x.com
 */
function servidorDesdeWebdavUrl(davUrl) {
  return davUrl
    .replace(/\/(remote|index)\.php\/dav\/files\/[^/]+(\/.*)?$/i, '')
    .replace(/\/(remote|index)\.php\/webdav(\/.*)?$/i, '')
    .replace(/\/dav\/files\/[^/]+(\/.*)?$/i, '')
    .replace(/\/$/, '');
}

// ══════════════════════════════════════════════════════════════════════
//  POST /api/upload
//
//  Campos multipart:
//    imagen      (file)
//    categoria   (string)
//    nombre      (string)
//    sufijo      (string)  "principal" | "muestra"
//    config      (JSON)    { owncloudUrl, owncloudUser, owncloudPass, owncloudRutaBase }
//
//  Respuesta:
//    { ok:true, url:"https://cloud.atrezosprops.space/s/TOKEN/download", ... }
// ══════════════════════════════════════════════════════════════════════
app.post('/api/upload', upload.single('imagen'), async (req, res) => {
  try {
    if (!req.file) return res.json({ ok: false, error: 'No se recibió ningún archivo.' });

    // Leer config de ownCloud (viene del admin)
    let cfg = {};
    try { cfg = JSON.parse(req.body.config || '{}'); } catch {}

    const ocUrl  = (cfg.owncloudUrl      || '').trim();
    const ocUser = (cfg.owncloudUser     || '').trim();
    const ocPass = (cfg.owncloudPass     || '').trim();
    const ocBase = (cfg.owncloudRutaBase || '/MiTienda/Imagenes/').trim();

    const categoria = slug(req.body.categoria || 'general');
    const nombre    = slug(req.body.nombre    || 'producto');
    const sufijo    = ['principal','muestra'].includes(req.body.sufijo) ? req.body.sufijo : 'imagen';
    const filename  = `${nombre}-${sufijo}.webp`;

    // ── 1. Convertir a WebP ────────────────────────────────────────
    let webpBuffer;
    try {
      webpBuffer = await sharp(req.file.buffer)
        .resize(1200, null, { withoutEnlargement: true })
        .webp({ quality: 82 })
        .toBuffer();
      console.log(`[upload] ✓ WebP generado (${Math.round(webpBuffer.length/1024)} KB)`);
    } catch (e) {
      return res.json({ ok: false, error: `Error convirtiendo imagen a WebP: ${e.message}` });
    }

    // ── 2. Guardar copia local (siempre, como respaldo) ───────────
    const localDir  = path.join(IMAGENES, categoria);
    const localFile = path.join(localDir, filename);
    if (!fs.existsSync(localDir)) fs.mkdirSync(localDir, { recursive: true });
    fs.writeFileSync(localFile, webpBuffer);
    const localUrl = `/imagenes/${categoria}/${filename}`;

    // ── 3. Subir a ownCloud si hay credenciales ───────────────────
    if (!ocUrl || !ocUser || !ocPass) {
      console.log('[upload] ownCloud no configurado → usando URL local');
      return res.json({ ok: true, url: localUrl, ruta: localUrl, nombre: filename, sufijo,
                        aviso: 'Guardado localmente (ownCloud no configurado).' });
    }

    const davBase      = ocUrl.replace(/\/$/, '');
    const rutaBase     = '/' + ocBase.replace(/^\/|\/$/g, '') + '/';
    const rutaCarpeta  = rutaBase + categoria + '/';
    const rutaCompleta = rutaCarpeta + filename;

    try {
      // Subir via WebDAV
      await webdavPut(davBase, ocUser, ocPass, rutaCompleta, webpBuffer);
      console.log(`[upload] ✓ Subido a ownCloud: ${rutaCompleta}`);
    } catch (e) {
      console.error('[upload] ✗ WebDAV PUT falló:', e.message);
      return res.json({
        ok: false,
        error: `No se pudo subir a ownCloud: ${e.message}. Verificá las credenciales en ⚙ Config.`,
        subidaOk: false,
        urlLocal: localUrl,
      });
    }

    // ── 4. Crear share público ─────────────────────────────────────
    const servidor = servidorDesdeWebdavUrl(davBase);
    const token    = await obtenerShareToken(servidor, ocUser, ocPass, rutaCompleta);

    if (!token) {
      console.warn('[upload] ⚠ Imagen subida pero no se pudo crear el share público');
      return res.json({
        ok: false,
        subidaOk: true,
        ruta: rutaCompleta,
        nombre: filename,
        error: `Imagen subida a ownCloud (${rutaCompleta}) pero no se pudo crear el link público. ` +
               `Verificá que "Files Sharing" esté activado en ownCloud, o creá el share manualmente ` +
               `y pegá la URL /s/TOKEN/download en el campo 🔗.`,
      });
    }

    // ── 5. URL pública final ───────────────────────────────────────
    // IMPORTANTE: /download al final para que el <img src> reciba el binario
    const urlPublica = `${servidor}/s/${token}/download`;
    console.log(`[upload] ✓ URL pública: ${urlPublica}`);

    return res.json({
      ok:     true,
      url:    urlPublica,
      ruta:   rutaCompleta,
      nombre: filename,
      sufijo,
    });

  } catch (err) {
    console.error('[upload] Error inesperado:', err);
    return res.json({ ok: false, error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════
//  POST /api/guardar  →  escribe productos.json
// ══════════════════════════════════════════════════════════════════════
app.post('/api/guardar', (req, res) => {
  try {
    const data = req.body;
    if (!data?.config || !data?.categorias) {
      return res.json({ ok: false, error: 'Datos inválidos.' });
    }
    fs.writeFileSync(path.join(DIR, 'productos.json'), JSON.stringify(data, null, 2), 'utf8');
    const total = data.categorias.reduce((s, c) => s + c.productos.length, 0);
    console.log(`[guardar] ✓ productos.json (${data.categorias.length} categorías, ${total} productos)`);
    return res.json({ ok: true });
  } catch (err) {
    return res.json({ ok: false, error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════
//  GET /api/productos  →  lee productos.json
// ══════════════════════════════════════════════════════════════════════
app.get('/api/productos', (req, res) => {
  try {
    const file = path.join(DIR, 'productos.json');
    if (fs.existsSync(file)) return res.json(JSON.parse(fs.readFileSync(file, 'utf8')));
    return res.json(null);
  } catch {
    return res.json(null);
  }
});

// ══════════════════════════════════════════════════════════════════════
//  POST /api/probar-owncloud  →  diagnóstico de conexión
// ══════════════════════════════════════════════════════════════════════
app.post('/api/probar-owncloud', async (req, res) => {
  const { owncloudUrl='', owncloudUser='', owncloudPass='', owncloudRutaBase='' } = req.body || {};
  const pasos = [];

  // Paso 1: campos completos
  const camposOk = owncloudUrl && owncloudUser && owncloudPass;
  pasos.push({
    nombre: 'Credenciales ingresadas',
    ok: !!camposOk,
    detalle: camposOk ? `URL: ${owncloudUrl} | Usuario: ${owncloudUser}` : 'Falta URL, usuario o contraseña en ⚙ Config.'
  });
  if (!camposOk) return res.json({ ok: false, pasos });

  // Paso 2: PROPFIND (verificar conexión WebDAV)
  const davBase = owncloudUrl.replace(/\/$/, '');
  try {
    const resp = await axios({
      method: 'PROPFIND',
      url: davBase,
      auth: { username: owncloudUser, password: owncloudPass },
      headers: { 'Depth': '0' },
      validateStatus: s => s < 500,
      timeout: 10000,
    });
    const ok = resp.status === 207 || resp.status === 200;
    pasos.push({
      nombre: 'Conexión WebDAV',
      ok,
      detalle: ok
        ? `✓ Conectado (HTTP ${resp.status})`
        : `HTTP ${resp.status} — Verificá la URL WebDAV y las credenciales.`
    });
    if (!ok) return res.json({ ok: false, pasos });
  } catch (e) {
    pasos.push({ nombre: 'Conexión WebDAV', ok: false, detalle: `No se pudo conectar: ${e.message}` });
    return res.json({ ok: false, pasos });
  }

  // Paso 3: subir imagen de prueba
  const rutaBase  = '/' + (owncloudRutaBase || 'MiTienda/Imagenes').replace(/^\/|\/$/g, '') + '/';
  const rutaPrueba = rutaBase + '.test-conexion.webp';
  let subidaOk = false;
  try {
    // Imagen 1x1 WebP mínima
    const pixel = Buffer.from(
      'UklGRlYAAABXRUJQVlA4IEoAAADQAQCdASoBAAEAAkA4JZACdAEO/gHOAAD' +
      'u/AAA/////wAAAAAAAA==', 'base64'
    );
    await webdavPut(davBase, owncloudUser, owncloudPass, rutaPrueba, pixel);
    subidaOk = true;
    pasos.push({ nombre: 'Subida de prueba (WebDAV PUT)', ok: true, detalle: `✓ Archivo de prueba subido a ${rutaPrueba}` });
  } catch (e) {
    pasos.push({ nombre: 'Subida de prueba (WebDAV PUT)', ok: false, detalle: `Error: ${e.message}` });
    return res.json({ ok: false, pasos });
  }

  // Paso 4: crear share público de prueba
  const servidor = servidorDesdeWebdavUrl(davBase);
  const token    = await obtenerShareToken(servidor, owncloudUser, owncloudPass, rutaPrueba);
  const urlPrueba = token ? `${servidor}/s/${token}/download` : null;

  pasos.push({
    nombre: 'Link público (OCS API)',
    ok: !!token,
    detalle: token
      ? `✓ Share creado: ${urlPrueba}`
      : 'No se pudo crear el link público. Verificá que "Files Sharing" esté activo en ownCloud → Apps.'
  });

  return res.json({ ok: !!token, pasos, urlPrueba: urlPrueba || undefined });
});

// ── Inicio ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('');
  console.log('  ✅  Atrezos & Props — servidor corriendo');
  console.log(`  🏪  Tienda:  http://localhost:${PORT}/index.html`);
  console.log(`  🔧  Admin:   http://localhost:${PORT}/admin.html`);
  console.log('');
  console.log('  Flujo de imágenes:');
  console.log('  Subís foto → WebP automático → sube a ownCloud → URL pública lista');
  console.log('');
  console.log('  Para detener: Ctrl + C');
  console.log('');
});
