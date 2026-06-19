/**
 * Netlify Function: /api/guardar
 * ─────────────────────────────────────────────────────────────────────
 * Guarda productos.json en ownCloud (WebDAV PUT).
 * Así el catálogo siempre puede leer productos.json desde la URL pública.
 *
 * IMPORTANTE: en Netlify el sistema de archivos es de solo lectura,
 * por eso guardamos el JSON en ownCloud en lugar de en el disco.
 *
 * Variable de entorno requerida:
 *   OWNCLOUD_URL, OWNCLOUD_USER, OWNCLOUD_PASS
 * Opcional:
 *   OWNCLOUD_RUTA_BASE  (default: /MiTienda/Imagenes/)
 */

const axios = require('axios');

function servidorDesdeWebdavUrl(davUrl) {
  return davUrl
    .replace(/\/(remote|index)\.php\/dav\/files\/[^/]+(\/.*)?$/i, '')
    .replace(/\/(remote|index)\.php\/webdav(\/.*)?$/i, '')
    .replace(/\/dav\/files\/[^/]+(\/.*)?$/i, '')
    .replace(/\/$/, '');
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ ok:false }) };
  }

  try {
    const data = JSON.parse(event.body || '{}');
    if (!data?.config || !data?.categorias) {
      return { statusCode: 400, body: JSON.stringify({ ok:false, error:'Datos inválidos.' }) };
    }

    const cfg   = data.config;
    const ocUrl  = (process.env.OWNCLOUD_URL      || cfg.owncloudUrl      || '').trim();
    const ocUser = (process.env.OWNCLOUD_USER      || cfg.owncloudUser     || '').trim();
    const ocPass = (process.env.OWNCLOUD_PASS      || cfg.owncloudPass     || '').trim();
    const ocBase = (process.env.OWNCLOUD_RUTA_BASE || cfg.owncloudRutaBase || '/MiTienda/Imagenes/').trim();

    if (!ocUrl || !ocUser || !ocPass) {
      return { statusCode: 200, body: JSON.stringify({ ok:false, error:'ownCloud no configurado.' }) };
    }

    const json         = JSON.stringify(data, null, 2);
    const davBase      = ocUrl.replace(/\/$/, '');
    const rutaBase     = '/' + ocBase.replace(/^\/|\/$/g, '/').replace(/\/$/, '');
    const rutaJson     = rutaBase.replace(/\/[^/]+$/, '') + '/productos.json';

    await axios({
      method: 'PUT',
      url: davBase + rutaJson,
      auth: { username: ocUser, password: ocPass },
      data: Buffer.from(json, 'utf8'),
      headers: { 'Content-Type': 'application/json' },
      maxBodyLength: Infinity,
      validateStatus: s => [200,201,204].includes(s),
    });

    // Crear/buscar share público del JSON
    const servidor = servidorDesdeWebdavUrl(davBase);
    const headers  = { 'OCS-APIRequest':'true', 'Accept':'application/json' };
    const auth     = { username: ocUser, password: ocPass };

    for (const ocs of ['/ocs/v2.php', '/ocs/v1.php']) {
      const api = servidor + ocs + '/apps/files_sharing/api/v1/shares';
      try {
        const { data: d } = await axios.get(api, { auth, headers,
          params:{ path: rutaJson, reshares:false }, validateStatus: s => s === 200 });
        const pub = (d?.ocs?.data||[]).find(s => s.share_type === 3 && s.token);
        if (pub) break; // share ya existe
        // Crear
        const p = new URLSearchParams({ path: rutaJson, shareType:'3', permissions:'1' });
        await axios.post(api, p.toString(), {
          auth, headers: { ...headers, 'Content-Type':'application/x-www-form-urlencoded' },
          validateStatus: s => s === 200 || s === 201,
        });
        break;
      } catch {}
    }

    return { statusCode: 200, body: JSON.stringify({ ok:true }) };

  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ ok:false, error:err.message }) };
  }
};
