// ════════════════════════════════════════════════════════════════════
//  admin-server.js — CMS local para Atrezos & Props
//  Uso:     node admin-server.js
//  Panel:   http://localhost:3333
//  NO se despliega a Netlify — solo corre en tu PC
// ════════════════════════════════════════════════════════════════════

'use strict';

const http    = require('http');
const fs      = require('fs');
const path    = require('path');
const { URL } = require('url');

// ── Verificar dependencias npm ─────────────────────────────────────
let sharp, axios, busboy;
try {
  sharp  = require('sharp');
  axios  = require('axios');
  busboy = require('busboy');
} catch (e) {
  console.error('\n❌  Dependencias faltantes. Ejecutá:\n\n    npm install\n\nluego volvé a ejecutar ARRANCAR-ADMIN.bat\n');
  process.exit(1);
}

// ── Configuración ──────────────────────────────────────────────────
const PORT = 3333;
const ROOT = __dirname; // raíz del proyecto (donde vive admin-server.js)

const PATH_PRODUCTOS   = path.join(ROOT, 'productos.json');
const PATH_SITECONFIG  = path.join(ROOT, 'siteConfig.json');
const PATH_ADMIN_HTML  = path.join(ROOT, 'admin.html');

// ── Tipos MIME para archivos estáticos ────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json',
  '.js':   'text/javascript',
  '.css':  'text/css',
  '.webp': 'image/webp',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
  '.svg':  'image/svg+xml',
  '.woff2':'font/woff2',
  '.woff': 'font/woff',
  '.txt':  'text/plain',
};

// ════════════════════════════════════════════════════════════════════
//  UTILIDADES
// ════════════════════════════════════════════════════════════════════

/** Escribe JSON de forma atómica (evita corrupción si se corta la escritura) */
function writeJsonAtomic(filePath, data) {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, filePath);
}

/** Responde con JSON + headers CORS (necesario si admin.html abre desde file://) */
function jsonRes(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type':                 'application/json',
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control':                'no-store',
  });
  res.end(body);
}

/** Lee el cuerpo de la request como JSON */
function readBodyJSON(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data',  chunk => { raw += chunk; });
    req.on('end',   () => {
      try { resolve(JSON.parse(raw || '{}')); }
      catch (e) { reject(new Error('JSON inválido en body')); }
    });
    req.on('error', reject);
  });
}

/** Sirve un archivo estático desde el sistema de archivos */
function serveFile(res, filePath) {
  const ext  = path.extname(filePath).toLowerCase();
  const mime = MIME[ext] || 'application/octet-stream';
  try {
    const content = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store' });
    res.end(content);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('404 Not Found');
  }
}

// ════════════════════════════════════════════════════════════════════
//  HELPERS WebDAV / ownCloud
// ════════════════════════════════════════════════════════════════════

/** Convierte texto a slug seguro para nombres de archivo */
function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'imagen';
}

/** Extrae la URL base del servidor ownCloud desde la URL WebDAV */
function owncloudServidorBase(davUrl) {
  return davUrl
    .replace(/\/(remote|index)\.php\/dav\/files\/[^/]+(\/.*)?$/i, '')
    .replace(/\/(remote|index)\.php\/webdav(\/.*)?$/i, '')
    .replace(/\/dav\/files\/[^/]+(\/.*)?$/i, '')
    .replace(/\/$/, '');
}

/**
 * PUT de un buffer a WebDAV.
 * Crea carpetas intermedias (MKCOL) si no existen.
 */
async function davPut(davBaseUrl, user, pass, ruta, buffer, contentType = 'image/webp') {
  const auth = { username: user, password: pass };
  const base = davBaseUrl.replace(/\/$/, '');

  // Crear carpetas intermedias
  const segmentos = ruta.split('/').filter(Boolean).slice(0, -1);
  let acum = '';
  for (const seg of segmentos) {
    acum += '/' + seg;
    try {
      await axios({
        method: 'MKCOL',
        url:    base + acum,
        auth,
        validateStatus: s => s === 201 || s === 405, // 405 = ya existe
      });
    } catch { /* ignorar errores de MKCOL */ }
  }

  // Subir archivo
  const r = await axios({
    method:  'PUT',
    url:     base + ruta,
    auth,
    data:    buffer,
    headers: { 'Content-Type': contentType },
    maxBodyLength:    Infinity,
    maxContentLength: Infinity,
    validateStatus: s => [200, 201, 204].includes(s),
  });

  if (![200, 201, 204].includes(r.status)) {
    throw new Error(`WebDAV PUT respondió HTTP ${r.status}`);
  }
}

/**
 * Obtiene (o crea) un link público en ownCloud vía OCS API.
 * Devuelve el token del share o null si falla.
 */
async function getOrCreateShareToken(servidorBase, user, pass, rutaArchivo) {
  const auth    = { username: user, password: pass };
  const headers = { 'OCS-APIRequest': 'true' }; // sin Accept:json — ownCloud devuelve XML de todas formas

  // ownCloud devuelve XML aunque se pida JSON. Extraemos el token con regex.
  function tokenDesdeRespuesta(data) {
    const xml = typeof data === 'string' ? data : JSON.stringify(data);
    // En respuesta POST: <data><token>XXX</token>...</data>
    // En respuesta GET:  <element><share_type>3</share_type>...<token>XXX</token></element>
    const match = xml.match(/<token>([^<]+)<\/token>/);
    return match ? match[1].trim() : null;
  }

  // encodeURI preserva "/" pero codifica espacios — ownCloud no acepta "%2F" en el path
  const pathEncoded = encodeURI(rutaArchivo);

  // Solo usamos los endpoints sin /index.php (los otros devuelven HTML de login)
  const endpoints = [
    '/ocs/v2.php/apps/files_sharing/api/v1/shares',
    '/ocs/v1.php/apps/files_sharing/api/v1/shares',
  ];

  for (const endpoint of endpoints) {
    const api = servidorBase + endpoint;

    // A. Buscar share público existente
    try {
      const r = await axios.get(`${api}?path=${pathEncoded}&reshares=false`, {
        auth, headers,
        validateStatus: () => true,
      });
      if (r.status === 404) continue;
      const token = tokenDesdeRespuesta(r.data);
      if (token) {
        console.log(`[ownCloud] ✓ Share existente: ${token}`);
        return token;
      }
    } catch (e) {
      console.warn(`[ownCloud] GET excepción:`, e.message);
      continue;
    }

    // B. Crear nuevo share
    try {
      const body = `path=${pathEncoded}&shareType=3&permissions=1`;
      const r = await axios.post(api, body, {
        auth,
        headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' },
        validateStatus: () => true,
      });
      const token = tokenDesdeRespuesta(r.data);
      if (token) {
        console.log(`[ownCloud] ✓ Share creado: ${token}`);
        return token;
      }
    } catch (e) {
      console.warn(`[ownCloud] POST excepción:`, e.message);
    }
  }

  console.error('[ownCloud] ❌ No se pudo obtener token para:', rutaArchivo);
  return null;
}

// ════════════════════════════════════════════════════════════════════
//  HANDLERS DE API
// ════════════════════════════════════════════════════════════════════

// GET /api/productos → devuelve productos.json completo
function apiGetProductos(res) {
  try {
    const data = JSON.parse(fs.readFileSync(PATH_PRODUCTOS, 'utf8'));
    jsonRes(res, 200, data);
  } catch {
    // Si el archivo no existe devolver estructura vacía válida
    jsonRes(res, 200, { config: {}, categorias: [] });
  }
}

// POST /api/guardar → escribe productos.json de forma segura (sin credenciales)
async function apiGuardar(req, res) {
  try {
    const body = await readBodyJSON(req);

    if (!body || typeof body !== 'object' || !Array.isArray(body.categorias)) {
      return jsonRes(res, 400, { ok: false, error: 'Estructura inválida: se requiere { config, categorias[] }' });
    }

    const c = body.config || {};

    // Lista blanca de campos seguros — NUNCA se guardan credenciales ownCloud aquí
    const safeData = {
      config: {
        nombreTienda:    c.nombreTienda    || 'Atrezos & Props',
        modoFeria:       c.modoFeria       ?? false,
        whatsapp:        c.whatsapp        || '',
        mensajeWhatsapp: c.mensajeWhatsapp || '',
        moneda:          c.moneda          || 'Gs.',
        telefono:        c.telefono        || '',
      },
      categorias: body.categorias,
    };

    writeJsonAtomic(PATH_PRODUCTOS, safeData);
    jsonRes(res, 200, { ok: true });
  } catch (e) {
    jsonRes(res, 500, { ok: false, error: e.message });
  }
}

// GET /api/config → devuelve siteConfig.json con defaults como fallback
function apiGetConfig(res) {
  const defaults = {
    modoFeria:      false,
    mostrarPrecios: true,
    bannerActivo:   false,
    textoBanner:    '¡Estamos en FERIA!',
    subtextoBanner: 'Precios especiales por tiempo limitado',
    carritoVisible: true,
    etiquetas:      { oferta: false, feria: true, nuevo: false },
  };
  try {
    const data = JSON.parse(fs.readFileSync(PATH_SITECONFIG, 'utf8'));
    jsonRes(res, 200, {
      ...defaults,
      ...data,
      etiquetas: { ...defaults.etiquetas, ...(data.etiquetas || {}) },
    });
  } catch {
    jsonRes(res, 200, defaults);
  }
}

// POST /api/config → escribe siteConfig.json (sin credenciales)
async function apiPostConfig(req, res) {
  try {
    const body = await readBodyJSON(req);
    const sc = {
      modoFeria:      body.modoFeria      ?? false,
      mostrarPrecios: body.mostrarPrecios  ?? true,
      bannerActivo:   body.bannerActivo    ?? false,
      textoBanner:    body.textoBanner     || '¡Estamos en FERIA!',
      subtextoBanner: body.subtextoBanner  || '',
      carritoVisible: body.carritoVisible  ?? true,
      etiquetas: {
        oferta: body.etiquetas?.oferta ?? false,
        feria:  body.etiquetas?.feria  ?? true,
        nuevo:  body.etiquetas?.nuevo  ?? false,
      },
    };
    writeJsonAtomic(PATH_SITECONFIG, sc);
    jsonRes(res, 200, { ok: true });
  } catch (e) {
    jsonRes(res, 500, { ok: false, error: e.message });
  }
}

// POST /api/upload → imagen → WebP → ownCloud → URL pública
async function apiUpload(req, res) {
  try {
    let fileBuffer   = null;
    const fields     = {};

    // Parsear multipart/form-data con busboy
    await new Promise((resolve, reject) => {
      const bb     = busboy({ headers: req.headers, limits: { fileSize: 25 * 1024 * 1024 } });
      const chunks = [];

      bb.on('file', (name, stream) => {
        stream.on('data', c => chunks.push(c));
        stream.on('end',  () => { fileBuffer = Buffer.concat(chunks); });
      });
      bb.on('field',  (name, val) => { fields[name] = val; });
      bb.on('finish', resolve);
      bb.on('error',  reject);
      req.pipe(bb);
    });

    if (!fileBuffer || fileBuffer.length === 0) {
      return jsonRes(res, 400, { ok: false, error: 'No se recibió ningún archivo.' });
    }

    // Extraer config de ownCloud (viene como campo JSON "config" en el FormData)
    let cfg = {};
    try { cfg = JSON.parse(fields.config || '{}'); } catch {}

    const ocUrl  = (cfg.owncloudUrl      || '').trim();
    const ocUser = (cfg.owncloudUser     || '').trim();
    const ocPass = (cfg.owncloudPass     || '').trim();
    const ocBase = (cfg.owncloudRutaBase || '/MiTienda/Imagenes/').trim();

    // ── Convertir a WebP con sharp ──────────────────────────────────
    const webpBuffer = await sharp(fileBuffer)
      .resize({ width: 1200, height: 1200, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 85 })
      .toBuffer();

    // Construir nombre de archivo único
    const catSlug  = slugify(fields.categoria || 'producto');
    const nomSlug  = slugify(fields.nombre    || 'item');
    const sufijo   = (fields.sufijo || 'p').replace(/[^a-z0-9]/gi, '').slice(0, 4);
    const filename = `${catSlug}-${nomSlug}-${sufijo}.webp`;

    // Sin credenciales → devolver data-URL (fallback sin ownCloud)
    if (!ocUrl || !ocUser || !ocPass) {
      return jsonRes(res, 200, {
        ok:               true,
        url:              `data:image/webp;base64,${webpBuffer.toString('base64')}`,
        owncloudGuardado: false,
        aviso:            'ownCloud no configurado. Imagen convertida a WebP pero no subida. Configurá las credenciales en Ajustes.',
      });
    }

    // ── Subir a ownCloud WebDAV ──────────────────────────────────────
    const davBase  = ocUrl.replace(/\/$/, '');
    const rutaBase = '/' + ocBase.replace(/^\/|\/$/g, '');
    const ruta     = `${rutaBase}/${filename}`;

    await davPut(davBase, ocUser, ocPass, ruta, webpBuffer);

    // ── Obtener URL pública (OCS API) ────────────────────────────────
    const servidor = owncloudServidorBase(davBase);
    const token    = await getOrCreateShareToken(servidor, ocUser, ocPass, ruta);

    if (!token) {
      return jsonRes(res, 200, {
        ok:        false,
        subidaOk:  true,
        ruta,
        error:     'Imagen subida pero no se pudo crear link público. Creá el link manualmente en ownCloud y pegá la URL en el campo 🔗.',
      });
    }

    jsonRes(res, 200, {
      ok:               true,
      url:              `${servidor}/s/${token}/download`,
      owncloudGuardado: true,
    });

  } catch (e) {
    jsonRes(res, 500, { ok: false, error: e.message });
  }
}

// POST /api/probar-owncloud → diagnóstico paso a paso de conexión WebDAV
async function apiProbarOwnCloud(req, res) {
  const body   = await readBodyJSON(req).catch(() => ({}));
  const ocUrl  = (body.owncloudUrl  || '').trim();
  const ocUser = (body.owncloudUser || '').trim();
  const ocPass = (body.owncloudPass || '').trim();
  const ocBase = (body.owncloudRutaBase || '/MiTienda/Imagenes/').trim();
  const pasos  = [];

  // Paso 1: verificar que hay credenciales
  const credOk = !!(ocUrl && ocUser && ocPass);
  pasos.push({
    nombre:  'Credenciales configuradas',
    ok:      credOk,
    detalle: credOk
      ? `URL: ${ocUrl}  |  Usuario: ${ocUser}`
      : 'Falta URL de WebDAV, usuario o contraseña.',
  });
  if (!credOk) return jsonRes(res, 200, { ok: false, pasos });

  // Paso 2: conexión WebDAV (PROPFIND a la raíz)
  try {
    const r = await axios({
      method:  'PROPFIND',
      url:     ocUrl.replace(/\/$/, ''),
      auth:    { username: ocUser, password: ocPass },
      headers: { Depth: '0' },
      timeout: 10000,
      validateStatus: s => s < 600,
    });
    const ok = r.status === 207 || r.status === 200;
    pasos.push({
      nombre:  'Conexión WebDAV',
      ok,
      detalle: ok
        ? `HTTP ${r.status} — conexión exitosa`
        : `HTTP ${r.status} — Verificá la URL y las credenciales.`,
    });
    if (!ok) return jsonRes(res, 200, { ok: false, pasos });
  } catch (e) {
    pasos.push({ nombre: 'Conexión WebDAV', ok: false, detalle: e.message });
    return jsonRes(res, 200, { ok: false, pasos });
  }

  // Paso 3: servidor base detectado
  const servidor = owncloudServidorBase(ocUrl);
  pasos.push({
    nombre:  'Servidor detectado',
    ok:      true,
    detalle: servidor,
  });

  // Paso 4: verificar carpeta de imágenes
  const rutaBase  = '/' + ocBase.replace(/^\/|\/$/g, '');
  const urlFolder = ocUrl.replace(/\/$/, '') + rutaBase;
  try {
    const r = await axios({
      method:  'PROPFIND',
      url:     urlFolder,
      auth:    { username: ocUser, password: ocPass },
      headers: { Depth: '0' },
      timeout: 8000,
      validateStatus: s => s < 600,
    });
    const ok = r.status === 207 || r.status === 200;
    pasos.push({
      nombre:  'Carpeta de imágenes',
      ok,
      detalle: ok
        ? `Ruta ${rutaBase} accesible`
        : `HTTP ${r.status} — la carpeta no existe o no tiene permisos. Creala en ownCloud.`,
    });
  } catch (e) {
    pasos.push({ nombre: 'Carpeta de imágenes', ok: false, detalle: e.message });
  }

  // Paso 5: verificar que OCS API responde (shares)
  try {
    const api = servidor + '/ocs/v2.php/apps/files_sharing/api/v1/shares';
    const r = await axios.get(api, {
      auth:    { username: ocUser, password: ocPass },
      headers: { 'OCS-APIRequest': 'true', Accept: 'application/json' },
      params:  { path: rutaBase, reshares: false },
      timeout: 8000,
      validateStatus: s => s < 600,
    });
    const ok = r.status === 200;
    pasos.push({
      nombre:  'API de shares (links públicos)',
      ok,
      detalle: ok
        ? 'OCS API disponible — se podrán crear links públicos'
        : `HTTP ${r.status} — no se podrá crear links automáticos`,
    });
  } catch (e) {
    pasos.push({ nombre: 'API de shares (links públicos)', ok: false, detalle: e.message });
  }

  const allOk = pasos.every(p => p.ok);
  const urlPrueba = allOk ? `${servidor}/s/TOKEN/download` : undefined;
  jsonRes(res, 200, { ok: allOk, pasos, ...(urlPrueba ? { urlPrueba } : {}) });
}

// ════════════════════════════════════════════════════════════════════
//  SERVIDOR HTTP
// ════════════════════════════════════════════════════════════════════

const server = http.createServer(async (req, res) => {
  const parsed   = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = parsed.pathname;
  const method   = req.method.toUpperCase();

  // Preflight CORS (para acceso desde file://)
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  // ── Rutas de API ─────────────────────────────────────────────────
  try {
    if (pathname === '/api/productos'       && method === 'GET')  return apiGetProductos(res);
    if (pathname === '/api/guardar'         && method === 'POST') return await apiGuardar(req, res);
    if (pathname === '/api/config'          && method === 'GET')  return apiGetConfig(res);
    if (pathname === '/api/config'          && method === 'POST') return await apiPostConfig(req, res);
    if (pathname === '/api/upload'          && method === 'POST') return await apiUpload(req, res);
    if (pathname === '/api/probar-owncloud' && method === 'POST') return await apiProbarOwnCloud(req, res);
  } catch (e) {
    console.error('[error]', method, pathname, e.message);
    return jsonRes(res, 500, { ok: false, error: e.message });
  }

  // ── Archivos estáticos ───────────────────────────────────────────
  let filePath;

  if (pathname === '/' || pathname === '/admin' || pathname === '/admin.html') {
    filePath = PATH_ADMIN_HTML;
  } else {
    // Protección contra path traversal
    const safe = path.normalize(pathname).replace(/^(\.\.[/\\])+/, '');
    filePath = path.join(ROOT, safe);
    // Bloquear cualquier ruta fuera de ROOT
    if (!filePath.startsWith(ROOT + path.sep) && filePath !== ROOT) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      return res.end('403 Forbidden');
    }
  }

  serveFile(res, filePath);
});

// Escuchar SOLO en localhost (no exponer a la red local)
server.listen(PORT, '127.0.0.1', () => {
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║   Atrezos & Props — CMS Local               ║');
  console.log('╠══════════════════════════════════════════════╣');
  console.log(`║   Panel admin:  http://localhost:${PORT}          ║`);
  console.log(`║   Catálogo:     http://localhost:${PORT}/index.html║`);
  console.log('║   Ctrl+C para detener el servidor           ║');
  console.log('╚══════════════════════════════════════════════╝\n');
  console.log('📂  Archivos del proyecto:', ROOT);
  console.log('📦  productos.json:',        PATH_PRODUCTOS);
  console.log('⚙️   siteConfig.json:',       PATH_SITECONFIG);
  console.log('');
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n❌  El puerto ${PORT} ya está en uso.`);
    console.error(`    Cerrá la otra ventana con el servidor, o cambiá PORT en admin-server.js\n`);
  } else {
    console.error('\n❌  Error del servidor:', err.message);
  }
  process.exit(1);
});

process.on('SIGINT', () => {
  console.log('\n\nServidor detenido. ¡Hasta la próxima!\n');
  process.exit(0);
});
