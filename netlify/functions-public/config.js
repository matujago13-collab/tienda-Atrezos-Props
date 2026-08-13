/**
 * Netlify Function: GET /api/config
 * Lee siteConfig.json desde ownCloud y lo sirve al catálogo público.
 * Misma carpeta y mismo criterio de conexión que productos.js —
 * ver construirRutaSiteConfigOwncloud() en admin-server.js (mismo cálculo
 * de ruta, replicado acá porque las Netlify Functions no comparten código
 * con admin-server.js).
 */

const axios = require('axios');

exports.handler = async (event) => {
  const ocUrl  = (process.env.OWNCLOUD_URL      || '').trim();
  const ocUser = (process.env.OWNCLOUD_USER      || '').trim();
  const ocPass = (process.env.OWNCLOUD_PASS      || '').trim();
  const ocBase = (process.env.OWNCLOUD_RUTA_BASE || '/MiTienda/Imagenes/').trim();

  if (!ocUrl || !ocUser || !ocPass) {
    return { statusCode: 200, body: 'null',
             headers: { 'Content-Type': 'application/json' } };
  }

  try {
    const davBase  = ocUrl.replace(/\/$/, '');
    const rutaBase = '/' + ocBase.replace(/^\/|\/$/g, '/').replace(/\/$/, '');
    const rutaJson = rutaBase.replace(/\/[^/]+$/, '') + '/siteConfig.json';

    // encodeURI preserva "/" pero codifica espacios — ownCloud no acepta
    // espacios crudos en el path (mismo criterio que davPut() en admin-server.js).
    const { data } = await axios.get(davBase + encodeURI(rutaJson), {
      auth: { username: ocUser, password: ocPass },
      responseType: 'text',
      validateStatus: s => s === 200,
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: data,
    };
  } catch (err) {
    console.error('[api/config] Error leyendo siteConfig.json de ownCloud:', err.message);
    return { statusCode: 200, body: 'null',
             headers: { 'Content-Type': 'application/json' } };
  }
};
