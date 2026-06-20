/**
 * Netlify Function: /api/config
 * GET  -> Lee siteConfig.json desde ownCloud.
 * POST -> Guarda siteConfig.json en ownCloud.
 */

const axios = require('axios');

function rutaSiteConfig(ocBase) {
  const base = '/' + ocBase.replace(/^\/|\/$/g, '');
  const padre = base.replace(/\/[^/]+\/?$/, '');
  return (padre || '/MiTienda') + '/siteConfig.json';
}

const CONFIG_DEFAULT = {
  modoFeria:             false,
  mostrarPrecios:        true,
  bannerActivo:          false,
  textoBanner:           '¡Estamos en FERIA!',
  subtextoBanner:        'Precios especiales por tiempo limitado',
  carritoVisible:        true,
  etiquetas:             { oferta: false, feria: true, nuevo: false },
  seleccionAsesorActivo: false,
  asesorDefecto:         '',
  asesores:              [],
  apariencia: {
    colorPrincipal:     '#506549',
    colorSecundario:    '#9CAF88',
    colorBotones:       '#506549',
    colorTexto:         '#1a1a1a',
    colorFondo:         '#ffffff',
    colorFondo2:        '#f5f0ea',
    colorEncabezados:   '#506549',
    colorEnlaces:       '#506549',
    tipografiaBody:     'Jost',
    tipografiaHeadings: 'Cormorant Garamond',
    tamañoTexto:        '16',
  },
  banners:      [],
  temaActivo:   null,
  infoContacto: { telefono: '', email: '', direccion: '', horario: '' },
  paginaInicio: {
    secciones: [
      { id: 'banner_global',  nombre: 'Banner Global',           activa: true,  orden: 0 },
      { id: 'banners_hero',   nombre: 'Banners Promocionales',   activa: false, orden: 1 },
      { id: 'catalogo',       nombre: 'Catalogo de Productos',   activa: true,  orden: 2 },
      { id: 'info_contacto',  nombre: 'Informacion de Contacto', activa: false, orden: 3 },
    ],
  },
};

const HEADERS_CORS = {
  'Content-Type':                'application/json',
  'Access-Control-Allow-Origin': '*',
};

function deepMerge(base, src) {
  if (!src || typeof src !== 'object') return base;
  return {
    ...base,
    ...src,
    etiquetas:    { ...(base.etiquetas    || {}), ...(src.etiquetas    || {}) },
    apariencia:   { ...(base.apariencia   || {}), ...(src.apariencia   || {}) },
    infoContacto: { ...(base.infoContacto || {}), ...(src.infoContacto || {}) },
    paginaInicio: src.paginaInicio || base.paginaInicio,
    banners:      Array.isArray(src.banners) ? src.banners : (base.banners || []),
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: HEADERS_CORS, body: '' };
  }

  const ocUrl  = (process.env.OWNCLOUD_URL      || '').trim();
  const ocUser = (process.env.OWNCLOUD_USER      || '').trim();
  const ocPass = (process.env.OWNCLOUD_PASS      || '').trim();
  const ocBase = (process.env.OWNCLOUD_RUTA_BASE || '/MiTienda/Imagenes/').trim();

  if (event.httpMethod === 'GET') {
    if (!ocUrl || !ocUser || !ocPass) {
      return { statusCode: 200, headers: HEADERS_CORS, body: JSON.stringify(CONFIG_DEFAULT) };
    }
    try {
      const davBase = ocUrl.replace(/\/$/, '');
      const ruta    = rutaSiteConfig(ocBase);
      const { data } = await axios.get(davBase + ruta, {
        auth: { username: ocUser, password: ocPass },
        responseType: 'text',
        validateStatus: s => s === 200,
      });
      const guardado = JSON.parse(data);
      const merged   = deepMerge(CONFIG_DEFAULT, guardado);
      return { statusCode: 200, headers: HEADERS_CORS, body: JSON.stringify(merged) };
    } catch {
      return { statusCode: 200, headers: HEADERS_CORS, body: JSON.stringify(CONFIG_DEFAULT) };
    }
  }

  if (event.httpMethod === 'POST') {
    try {
      let payload;
      try { payload = JSON.parse(event.body || '{}'); } catch {
        return { statusCode: 400, headers: HEADERS_CORS,
                 body: JSON.stringify({ ok: false, error: 'JSON invalido.' }) };
      }

      const cfg  = payload.config || {};
      const url  = (ocUrl  || cfg.owncloudUrl     || '').trim();
      const user = (ocUser || cfg.owncloudUser    || '').trim();
      const pass = (ocPass || cfg.owncloudPass    || '').trim();
      const base = (ocBase !== '/MiTienda/Imagenes/'
        ? ocBase : (cfg.owncloudRutaBase || '/MiTienda/Imagenes/')).trim();

      if (!url || !user || !pass) {
        return { statusCode: 200, headers: HEADERS_CORS,
                 body: JSON.stringify({ ok: false, error: 'ownCloud no configurado.' }) };
      }

      const { config: _c, ...p } = payload;
      const siteConfig = {
        ...deepMerge(CONFIG_DEFAULT, p),
        modoFeria:      Boolean(p.modoFeria      ?? CONFIG_DEFAULT.modoFeria),
        mostrarPrecios: Boolean(p.mostrarPrecios ?? CONFIG_DEFAULT.mostrarPrecios),
        bannerActivo:   Boolean(p.bannerActivo   ?? CONFIG_DEFAULT.bannerActivo),
        carritoVisible: Boolean(p.carritoVisible ?? CONFIG_DEFAULT.carritoVisible),
      };

      const davBase = url.replace(/\/$/, '');
      const ruta    = rutaSiteConfig(base);
      const json    = JSON.stringify(siteConfig, null, 2);

      await axios({
        method: 'PUT', url: davBase + ruta,
        auth:   { username: user, password: pass },
        data:   Buffer.from(json, 'utf8'),
        headers: { 'Content-Type': 'application/json' },
        maxBodyLength: Infinity,
        validateStatus: s => [200, 201, 204].includes(s),
      });

      return { statusCode: 200, headers: HEADERS_CORS, body: JSON.stringify({ ok: true }) };
    } catch (err) {
      return { statusCode: 500, headers: HEADERS_CORS,
               body: JSON.stringify({ ok: false, error: err.message }) };
    }
  }

  return { statusCode: 405, headers: HEADERS_CORS,
           body: JSON.stringify({ ok: false, error: 'Metodo no permitido' }) };
};
