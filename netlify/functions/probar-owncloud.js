/**
 * Netlify Function: POST /api/probar-owncloud
 * Diagnóstico de conexión ownCloud — misma lógica que server.js
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

  const body = JSON.parse(event.body || '{}');
  const ocUrl  = (process.env.OWNCLOUD_URL  || body.owncloudUrl  || '').trim();
  const ocUser = (process.env.OWNCLOUD_USER || body.owncloudUser || '').trim();
  const ocPass = (process.env.OWNCLOUD_PASS || body.owncloudPass || '').trim();
  const pasos  = [];

  const camposOk = ocUrl && ocUser && ocPass;
  pasos.push({
    nombre: 'Credenciales configuradas',
    ok: !!camposOk,
    detalle: camposOk ? `URL: ${ocUrl} | Usuario: ${ocUser}` : 'Falta URL, usuario o contraseña.'
  });
  if (!camposOk) return { statusCode:200, body: JSON.stringify({ ok:false, pasos }) };

  try {
    const resp = await axios({
      method: 'PROPFIND', url: ocUrl.replace(/\/$/, ''),
      auth: { username: ocUser, password: ocPass },
      headers: { 'Depth':'0' }, timeout: 10000,
      validateStatus: s => s < 500,
    });
    const ok = resp.status === 207 || resp.status === 200;
    pasos.push({ nombre: 'Conexión WebDAV', ok,
      detalle: ok ? `✓ HTTP ${resp.status}` : `HTTP ${resp.status} — Verificá URL y credenciales.` });
    if (!ok) return { statusCode:200, body: JSON.stringify({ ok:false, pasos }) };
  } catch(e) {
    pasos.push({ nombre:'Conexión WebDAV', ok:false, detalle: e.message });
    return { statusCode:200, body: JSON.stringify({ ok:false, pasos }) };
  }

  pasos.push({ nombre:'Subida de prueba', ok:true, detalle:'✓ (omitida en Netlify Function)' });

  const servidor = servidorDesdeWebdavUrl(ocUrl);
  pasos.push({ nombre:'Servidor detectado', ok:true, detalle:`Base: ${servidor}` });

  return { statusCode:200, body: JSON.stringify({ ok:true, pasos }) };
};
