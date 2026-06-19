/**
 * Netlify Function: /api/config
 * ─────────────────────────────────────────────────────────────────────
 * GET  → Lee siteConfig.json desde ownCloud y lo devuelve al cliente.
 * POST → Guarda siteConfig.json en ownCloud.
 *
 * siteConfig.json controla la UI del catálogo sin tocar productos.json:
 *   modoFeria, mostrarPrecios, bannerActivo, textoBanner,
 *   subtextoBanner, carritoVisible, etiquetas
 *
 * Variables de entorno (mismas que el resto del sistema):
 *   OWNCLOUD_URL, OWNCLOUD_USER, OWNCLOUD_PASS, OWNCLOUD_RUTA_BASE
 */

const axios = require('axios');

// Ruta del archivo en ownCloud: misma carpeta que productos.json
function rutaSiteConfig(ocBase) {
  const base = '/' + ocBase.replace(/^\/|\/$/g, '');
  // productos.json está en la carpeta padre de Imagenes
  // Ej: /MiTienda/Imagenes/ → padre = /MiTienda → /MiTienda/siteConfig.json
  const padre = base.replace(/\/[^/]+\/?$/, '');
  return (padre || '/MiTienda') + '/siteConfig.json';
}

const CONFIG_DEFAULT = {
  modoFeria:       false,
  mostrarPrecios:  true,
  bannerActivo:    false,
  textoBanner:     '¡Estamos en FERIA!',
  subtextoBanner:  'Precios especiales por tiempo limitado',
  carritoVisible:  true,
  etiquetas: {
    oferta: false,
    feria:  true,
    nuevo:  false,
  },
};

const HEADERS_CORS = {
  'Content-Type':                'application/json',
  'Access-Control-Allow-Origin': '*',
};

exports.handler = async (event) => {
  // Preflight CORS
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: HEADERS_CORS, body: '' };
  }

  const ocUrl  = (process.env.OWNCLOUD_URL       || '').trim();
  const ocUser = (process.env.OWNCLOUD_USER       || '').trim();
  const ocPass = (process.env.OWNCLOUD_PASS       || '').trim();
  const ocBase = (process.env.OWNCLOUD_RUTA_BASE  || '/MiTienda/Imagenes/').trim();

  // ── GET ────────────────────────────────────────────────────────────
  if (event.httpMethod === 'GET') {
    if (!ocUrl || !ocUser || !ocPass) {
      // Sin credenciales → devolver defaults para que el catálogo funcione
      return {
        statusCode: 200,
        headers: HEADERS_CORS,
        body: JSON.stringify(CONFIG_DEFAULT),
      };
    }

    try {
      const davBase = ocUrl.replace(/\/$/, '');
      const ruta    = rutaSiteConfig(ocBase);

      const { data } = await axios.get(davBase + ruta, {
        auth: { username: ocUser, password: ocPass },
        responseType: 'text',
        validateStatus: s => s === 200,
      });

      // Mergear con defaults para tolerancia a campos nuevos
      const guardado = JSON.parse(data);
      const merged   = { ...CONFIG_DEFAULT, ...guardado,
        etiquetas: { ...CONFIG_DEFAULT.etiquetas, ...(guardado.etiquetas || {}) } };

      return { statusCode: 200, headers: HEADERS_CORS, body: JSON.stringify(merged) };

    } catch {
      // Archivo no existe aún → devolver defaults sin error
      return {
        statusCode: 200,
        headers: HEADERS_CORS,
        body: JSON.stringify(CONFIG_DEFAULT),
      };
    }
  }

  // ── POST ───────────────────────────────────────────────────────────
  if (event.httpMethod === 'POST') {
    try {
      let payload;
      try { payload = JSON.parse(event.body || '{}'); } catch {
        return { statusCode: 400, headers: HEADERS_CORS,
                 body: JSON.stringify({ ok: false, error: 'JSON inválido.' }) };
      }

      // Aceptar credenciales del body como fallback (igual que guardar.js)
      const cfg     = payload.config || {};
      const url     = (ocUrl  || cfg.owncloudUrl      || '').trim();
      const user    = (ocUser || cfg.owncloudUser     || '').trim();
      const pass    = (ocPass || cfg.owncloudPass     || '').trim();
      const base    = (ocBase !== '/MiTienda/Imagenes/' ? ocBase : (cfg.owncloudRutaBase || '/MiTienda/Imagenes/')).trim();

      if (!url || !user || !pass) {
        return { statusCode: 200, headers: HEADERS_CORS,
                 body: JSON.stringify({ ok: false, error: 'ownCloud no configurado.' }) };
      }

      // El objeto a guardar: solo los campos de siteConfig
      const siteConfig = {
        modoFeria:      Boolean(payload.modoFeria      ?? CONFIG_DEFAULT.modoFeria),
        mostrarPrecios: Boolean(payload.mostrarPrecios  ?? CONFIG_DEFAULT.mostrarPrecios),
        bannerActivo:   Boolean(payload.bannerActivo    ?? CONFIG_DEFAULT.bannerActivo),
        textoBanner:    String (payload.textoBanner     ?? CONFIG_DEFAULT.textoBanner),
        subtextoBanner: String (payload.subtextoBanner  ?? CONFIG_DEFAULT.subtextoBanner),
        carritoVisible: Boolean(payload.carritoVisible  ?? CONFIG_DEFAULT.carritoVisible),
        etiquetas: {
          oferta: Boolean((payload.etiquetas || {}).oferta ?? CONFIG_DEFAULT.etiquetas.oferta),
          feria:  Boolean((payload.etiquetas || {}).feria  ?? CONFIG_DEFAULT.etiquetas.feria),
          nuevo:  Boolean((payload.etiquetas || {}).nuevo  ?? CONFIG_DEFAULT.etiquetas.nuevo),
        },
      };

      const davBase = url.replace(/\/$/, '');
      const ruta    = rutaSiteConfig(base);
      const json    = JSON.stringify(siteConfig, null, 2);

      await axios({
        method: 'PUT',
        url:    davBase + ruta,
        auth:   { username: user, password: pass },
        data:   Buffer.from(json, 'utf8'),
        headers: { 'Content-Type': 'application/json' },
        maxBodyLength: Infinity,
        validateStatus: s => [200, 201, 204].includes(s),
      });

      return { statusCode: 200, headers: HEADERS_CORS,
               body: JSON.stringify({ ok: true }) };

    } catch (err) {
      return { statusCode: 500, headers: HEADERS_CORS,
               body: JSON.stringify({ ok: false, error: err.message }) };
    }
  }

  return { statusCode: 405, headers: HEADERS_CORS,
           body: JSON.stringify({ ok: false, error: 'Método no permitido' }) };
};
