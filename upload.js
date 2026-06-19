/**
 * Netlify Function: /api/upload
 * ─────────────────────────────────────────────────────────────
 * Recibe imagen multipart, convierte a WebP, sube a ownCloud,
 * crea share público y devuelve la URL /s/TOKEN/download
 *
 * Variables de entorno en Netlify (Settings → Environment variables):
 *   OWNCLOUD_URL        https://cloud.atrezosprops.space/remote.php/dav/files/USUARIO
 *   OWNCLOUD_USER       tu-usuario
 *   OWNCLOUD_PASS       tu-contraseña-o-app-token
 *   OWNCLOUD_RUTA_BASE  /MiTienda/Imagenes/
 */

const sharp  = require('sharp');
const axios  = require('axios');
const busboy = require('busboy');

// ── Helpers WebDAV / OCS (misma lógica que server.js) ─────────────────

function slug(s) {
  return String(s)
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    || 'sin-nombre';
}

function servidorDesdeWebdavUrl(davUrl) {
  return davUrl
    .replace(/\/(remote|index)\.php\/dav\/files\/[^/]+(\/.*)?$/i, '')
    .replace(/\/(remote|index)\.php\/webdav(\/.*)?$/i, '')
    .replace(/\/dav\/files\/[^/]+(\/.*)?$/i, '')
    .replace(/\/$/, '');
}

async function webdavPut(davBase, user, pass, rutaCompleta, buffer) {
  const auth = { username: user, password: pass };
  const segs = rutaCompleta.split('/').filter(Boolean);
  segs.pop();
  let acum = '';
  for (const s of segs) {
    acum += '/' + s;
    try {
      await axios({ method: 'MKCOL', url: davBase.replace(/\/$/, '') + acum,
                    auth, validateStatus: c => c === 201 || c === 405 });
    } catch {}
  }
  const resp = await axios({
    method: 'PUT',
    url: davBase.replace(/\/$/, '') + rutaCompleta,
    auth, data: buffer,
    headers: { 'Content-Type': 'image/webp' },
    maxBodyLength: Infinity, maxContentLength: Infinity,
  });
  if (![200,201,204].includes(resp.status)) throw new Error(`WebDAV HTTP ${resp.status}`);
}

async function obtenerShareToken(servidor, user, pass, ruta) {
  const auth    = { username: user, password: pass };
  const headers = { 'OCS-APIRequest': 'true', 'Accept': 'application/json' };

  // Normaliza la respuesta OCS: puede ser array u objeto único según versión de ownCloud
  function normalizarShares(ocsData) {
    if (!ocsData) return [];
    return Array.isArray(ocsData) ? ocsData : [ocsData];
  }

  for (const ocs of ['/ocs/v2.php', '/ocs/v1.php']) {
    const api = servidor + ocs + '/apps/files_sharing/api/v1/shares';

    // 1. Buscar share público existente
    try {
      const { data } = await axios.get(api, { auth, headers,
        params: { path: ruta, reshares: false }, validateStatus: s => s === 200 });
      const shares = normalizarShares(data?.ocs?.data);
      const pub = shares.find(s => s.share_type === 3 && s.token);
      if (pub) return pub.token;
    } catch {}

    // 2. Crear share público nuevo
    try {
      const p = new URLSearchParams({ path: ruta, shareType:'3', permissions:'1' });
      const { data } = await axios.post(api, p.toString(), {
        auth, headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' },
        validateStatus: s => s === 200 || s === 201,
      });
      const token = data?.ocs?.data?.token;
      if (token) return token;
    } catch {}

    // 3. Por si el POST creó el share pero no devolvió el token, buscarlo de nuevo
    try {
      const { data } = await axios.get(api, { auth, headers,
        params: { path: ruta, reshares: false }, validateStatus: s => s === 200 });
      const shares = normalizarShares(data?.ocs?.data);
      const pub = shares.find(s => s.share_type === 3 && s.token);
      if (pub) return pub.token;
    } catch {}
  }
  return null;
}

// ── Parsear multipart en Lambda ────────────────────────────────────────
function parseMultipart(event) {
  return new Promise((resolve, reject) => {
    const fields = {}, files = {};
    const bb = busboy({
      headers: { 'content-type': event.headers['content-type'] || event.headers['Content-Type'] }
    });
    bb.on('field', (name, val) => { fields[name] = val; });
    bb.on('file',  (name, stream, info) => {
      const chunks = [];
      stream.on('data', d => chunks.push(d));
      stream.on('end',  () => { files[name] = { buffer: Buffer.concat(chunks), ...info }; });
    });
    bb.on('finish', () => resolve({ fields, files }));
    bb.on('error',  reject);
    const buf = event.isBase64Encoded
      ? Buffer.from(event.body, 'base64')
      : Buffer.from(event.body || '');
    bb.write(buf);
    bb.end();
  });
}

// ── Handler principal ──────────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ ok:false, error:'Método no permitido' }) };
  }

  try {
    const { fields, files } = await parseMultipart(event);
    const file = files['imagen'];
    if (!file?.buffer?.length) {
      return { statusCode: 400, body: JSON.stringify({ ok:false, error:'No se recibió imagen.' }) };
    }

    // Credenciales: variables de entorno tienen prioridad, luego config del admin
    let cfg = {};
    try { cfg = JSON.parse(fields.config || '{}'); } catch {}

    const ocUrl  = (process.env.OWNCLOUD_URL       || cfg.owncloudUrl      || '').trim();
    const ocUser = (process.env.OWNCLOUD_USER       || cfg.owncloudUser     || '').trim();
    const ocPass = (process.env.OWNCLOUD_PASS       || cfg.owncloudPass     || '').trim();
    const ocBase = (process.env.OWNCLOUD_RUTA_BASE  || cfg.owncloudRutaBase || '/MiTienda/Imagenes/').trim();

    const categoria = slug(fields.categoria || 'general');
    const nombre    = slug(fields.nombre    || 'producto');
    const sufijo    = ['principal','muestra'].includes(fields.sufijo) ? fields.sufijo : 'imagen';
    const filename  = `${nombre}-${sufijo}.webp`;

    // Convertir a WebP
    const webpBuffer = await sharp(file.buffer)
      .resize(1200, null, { withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer();

    if (!ocUrl || !ocUser || !ocPass) {
      return {
        statusCode: 200,
        body: JSON.stringify({ ok:false, error:'ownCloud no configurado. Agregá las variables de entorno en Netlify.' })
      };
    }

    const davBase      = ocUrl.replace(/\/$/, '');
    const rutaBase     = '/' + ocBase.replace(/^\/|\/$/g, '') + '/';
    const rutaCompleta = `${rutaBase}${categoria}/${filename}`;

    await webdavPut(davBase, ocUser, ocPass, rutaCompleta, webpBuffer);

    const servidor = servidorDesdeWebdavUrl(davBase);
    const token    = await obtenerShareToken(servidor, ocUser, ocPass, rutaCompleta);

    if (!token) {
      console.error('[upload] obtenerShareToken devolvió null para ruta:', rutaCompleta);
      console.error('[upload] servidor:', servidor, '| ocUser:', ocUser);
      return {
        statusCode: 200,
        body: JSON.stringify({ ok:false, subidaOk:true, ruta:rutaCompleta, nombre:filename,
          error:`Imagen subida pero no se pudo crear el link público. Revisá los logs de Netlify Functions.` })
      };
    }

    const urlPublica = `${servidor}/s/${token}/download`;
    return {
      statusCode: 200,
      body: JSON.stringify({ ok:true, url:urlPublica, ruta:rutaCompleta, nombre:filename, sufijo })
    };

  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ ok:false, error: err.message }) };
  }
};
