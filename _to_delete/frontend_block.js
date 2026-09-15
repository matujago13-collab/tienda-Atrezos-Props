
// ══════════════════════════════════════════════════════════════════════════════
//  PANEL DE COMPRAS — proveedores, pedidos de compra, recepción de stock y pagos
//  Mismo criterio que Ventas: SOLO local (node admin-server.js), protegido con
//  ADMIN_VENTAS_KEY (reutiliza ventasFetch/ventasClaveActual — una clave menos
//  que configurar). Datos en proveedores.json y compras.json, JSON local +
//  sync privado a ownCloud (sin share público), ver admin-server.js.
//  El incremento de stock al "recibir" una compra usa el MISMO mecanismo que
//  ya existe para ventas (ventasAplicarDeltaStock / ventasGuardarStockYPublicar)
//  — ver comprasAplicarDeltaStock más abajo — para que nunca haya dos caminos
//  distintos escribiendo productos.json.
// ══════════════════════════════════════════════════════════════════════════════

let comprasProveedores = [];
let comprasLista       = [];
let comprasCargado     = false;
let comprasCargando    = false;

const COMPRAS_VISTA_SK = 'ap_compras_vista_v1';
const COMPRAS_VISTAS_VALIDAS = ['nueva', 'lista', 'proveedores'];
let comprasVista = 'nueva';
try {
  const cv = localStorage.getItem(COMPRAS_VISTA_SK);
  if (cv && COMPRAS_VISTAS_VALIDAS.includes(cv)) comprasVista = cv;
} catch {}

function comprasDraftNueva() {
  return { proveedorId: '', proveedorNombre: '', fecha: new Date().toISOString().slice(0, 10), notas: '', items: [] };
}
let compraDraft = comprasDraftNueva();
let compraBusquedaProducto = '';
let proveedorEditId = null;             // null=form cerrado, ''=nuevo, id=editando
let compraAbiertaId = null;             // id de la compra expandida en la lista, o null
let compraItemsRecibidosOriginal = null; // snapshot de cantidadRecibida al abrir el detalle, para el delta de stock

// ── Carga inicial (lazy, al entrar a la pestaña) ─────────────────────
function comprasAlEntrar() {
  if (comprasCargado || comprasCargando) return;
  comprasCargando = true;
  Promise.all([
    ventasFetch('/api/proveedores').then(r => r.json()).catch(() => null),
    ventasFetch('/api/compras').then(r => r.json()).catch(() => null),
  ]).then(([dp, dc]) => {
    if (dp && dp.ok) comprasProveedores = dp.proveedores || [];
    if (dc && dc.ok) comprasLista = dc.compras || [];
    comprasCargado = true;
  }).catch(() => {
    toast('⚠ No se pudieron cargar Proveedores/Compras (revisá conexión)', 'err');
  }).finally(() => {
    comprasCargando = false;
    comprasRerenderPanel();
  });
}

// Usado desde el modal de producto (Proveedor asignado) — puede abrirse sin
// haber visitado nunca la pestaña Compras, así que carga los proveedores por
// su cuenta si hace falta (no pisa comprasLista/comprasCargado del panel).
async function asegurarProveedoresCargados() {
  if (!IS_LOCAL || comprasProveedores.length || comprasCargando) return;
  try {
    const res = await ventasFetch('/api/proveedores');
    const data = await res.json().catch(() => null);
    if (data && data.ok) comprasProveedores = data.proveedores || [];
  } catch {}
}
function poblarSelectProveedorProducto(selectedId) {
  const el = document.getElementById('f-proveedor');
  if (!el) return;
  el.innerHTML = '<option value="">— Sin proveedor asignado —</option>' +
    comprasProveedores.map(p => `<option value="${p.id}" ${p.id === selectedId ? 'selected' : ''}>${escHtml(p.nombre)}</option>`).join('');
}

// ── Stock: mismo mecanismo que ventasAplicarDeltaStock, pero SUMANDO en vez
// de restar (recibir mercadería aumenta stock; corregir una cantidad ya
// recibida hacia abajo lo devuelve). Se aplica sobre estado.categorias
// (misma fuente que Productos y Ventas) y se persiste con
// ventasGuardarStockYPublicar() — ya existente, genérico pese al nombre. ──
function comprasAplicarDeltaStock(itemsNuevos, itemsOriginales) {
  const mapaOriginal = new Map((itemsOriginales || []).map(i => [i.catId + '::' + i.prodId, i.cantidad]));
  const mapaNuevo    = new Map((itemsNuevos || []).map(i => [i.catId + '::' + i.prodId, i.cantidad]));
  const claves = new Set([...mapaOriginal.keys(), ...mapaNuevo.keys()]);
  let cambios = false;
  claves.forEach(clave => {
    const idx = clave.indexOf('::');
    const catId = clave.slice(0, idx);
    const prodIdRaw = clave.slice(idx + 2);
    const prodId = isNaN(Number(prodIdRaw)) ? prodIdRaw : Number(prodIdRaw);
    const antes = mapaOriginal.get(clave) || 0;
    const despues = mapaNuevo.get(clave) || 0;
    const delta = despues - antes; // + = llegó más mercadería · − = corrección hacia abajo
    if (delta === 0) return;
    const p = getProd(catId, prodId);
    if (!p) return;
    p.stock = Math.max(0, (typeof p.stock === 'number' ? p.stock : 0) + delta);
    cambios = true;
  });
  return cambios;
}

async function comprasGuardarListaEnServidor() {
  try {
    const res = await ventasFetch('/api/compras', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ compras: comprasLista }),
    });
    const data = await res.json().catch(() => null);
    if (data && data.ok) { if (Array.isArray(data.compras)) comprasLista = data.compras; return true; }
    return false;
  } catch { return false; }
}

// ── Proveedores: CRUD (form inline, mismo criterio que Vendedores) ───
function proveedorAbrirNuevo()    { proveedorEditId = '';  comprasRerenderSub(); }
function proveedorAbrirEditar(id) { proveedorEditId = id;  comprasRerenderSub(); }
function proveedorCerrarForm()    { proveedorEditId = null; comprasRerenderSub(); }

async function proveedorGuardar() {
  const nombre   = document.getElementById('pv-nombre').value.trim();
  const contacto = document.getElementById('pv-contacto').value.trim();
  const telefono = document.getElementById('pv-telefono').value.trim();
  const email    = document.getElementById('pv-email').value.trim();
  const notas    = document.getElementById('pv-notas').value.trim();
  const errEl    = document.getElementById('pv-error');
  if (!nombre) { errEl.textContent = 'El nombre es obligatorio.'; return; }
  errEl.textContent = '';

  const editando = proveedorEditId !== '';
  let listaActualizada = comprasProveedores.map(p => p.id === proveedorEditId
    ? { ...p, nombre, contacto, telefono, email, notas }
    : p);
  if (!editando) listaActualizada.push({ nombre, contacto, telefono, email, notas });

  try {
    const res  = await ventasFetch('/api/proveedores', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ proveedores: listaActualizada }),
    });
    const data = await res.json().catch(() => null);
    if (data && data.ok) {
      comprasProveedores = data.proveedores || [];
      proveedorEditId = null;
      toast('✓ Proveedor guardado');
      comprasRerenderSub();
    } else {
      errEl.textContent = data?.error || 'No se pudo guardar.';
    }
  } catch {
    errEl.textContent = 'Sin conexión con el servidor.';
  }
}

function proveedorEliminar(id) {
  const p = comprasProveedores.find(x => x.id === id);
  if (!p) return;
  const enUso = comprasLista.some(c => c.proveedorId === id);
  confirmar(`¿Eliminar al proveedor <strong>${escHtml(p.nombre)}</strong>? Esto no borra las compras ya registradas.${enUso ? ' Conservan su nombre igual.' : ''}`, async () => {
    const listaActualizada = comprasProveedores.filter(x => x.id !== id);
    try {
      const res  = await ventasFetch('/api/proveedores', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ proveedores: listaActualizada, eliminarIds: [id] }),
      });
      const data = await res.json().catch(() => null);
      if (data && data.ok) { comprasProveedores = data.proveedores || []; toast('Proveedor eliminado'); }
      else toast('⚠ No se pudo eliminar', 'err');
    } catch { toast('⚠ Sin conexión', 'err'); }
    comprasRerenderSub();
  });
}

function comprasRenderProveedores() {
  return `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:.7rem">
      <h4 style="margin:0">Proveedores</h4>
      <button class="btn btn-p btn-sm" onclick="proveedorAbrirNuevo()">+ Nuevo proveedor</button>
    </div>
    <div style="overflow-x:auto">
    <table style="width:100%;border-collapse:collapse;font-size:.8rem">
      <thead><tr><th style="text-align:left;padding:.4rem">Nombre</th><th style="text-align:left;padding:.4rem">Contacto</th><th style="text-align:left;padding:.4rem">Teléfono</th><th style="padding:.4rem"></th></tr></thead>
      <tbody>
        ${comprasProveedores.map(p => `
          <tr style="border-top:1px solid var(--border)">
            <td style="padding:.4rem">${escHtml(p.nombre)}</td>
            <td style="padding:.4rem">${escHtml(p.contacto || '—')}</td>
            <td style="padding:.4rem">${escHtml(p.telefono || '—')}</td>
            <td style="padding:.4rem;text-align:right;white-space:nowrap">
              <button class="btn btn-g btn-sm" onclick="proveedorAbrirEditar('${p.id}')">Editar</button>
              <button class="btn btn-danger btn-sm" onclick="proveedorEliminar('${p.id}')">Eliminar</button>
            </td>
          </tr>`).join('') || `<tr><td colspan="4" style="padding:.6rem;color:var(--muted)">Todavía no hay proveedores cargados.</td></tr>`}
      </tbody>
    </table>
    </div>
    ${comprasRenderProveedorForm()}`;
}
function comprasRenderProveedorForm() {
  if (proveedorEditId === null) return '';
  const editando = proveedorEditId !== '';
  const p = editando ? comprasProveedores.find(x => x.id === proveedorEditId) : null;
  return `
    <div class="config-form" style="border:1px solid var(--border);padding:.8rem;border-radius:4px;margin-top:1rem">
      <h4 style="margin:0 0 .6rem">${editando ? 'Editar proveedor' : 'Nuevo proveedor'}</h4>
      <div class="form-grid">
        <div><label class="field-lbl">Nombre *</label><input class="field-input" id="pv-nombre" value="${escHtml(p?.nombre || '')}"></div>
        <div><label class="field-lbl">Persona de contacto</label><input class="field-input" id="pv-contacto" value="${escHtml(p?.contacto || '')}"></div>
        <div><label class="field-lbl">Teléfono</label><input class="field-input" id="pv-telefono" value="${escHtml(p?.telefono || '')}"></div>
        <div><label class="field-lbl">Email</label><input class="field-input" id="pv-email" value="${escHtml(p?.email || '')}"></div>
      </div>
      <div style="margin-top:.6rem"><label class="field-lbl">Notas</label><textarea class="field-input" id="pv-notas" rows="2">${escHtml(p?.notas || '')}</textarea></div>
      <div style="display:flex;gap:.5rem;margin-top:.8rem">
        <button class="btn btn-g" onclick="proveedorCerrarForm()">Cancelar</button>
        <button class="btn btn-p" onclick="proveedorGuardar()">Guardar</button>
      </div>
      <p id="pv-error" style="font-size:.75rem;color:var(--danger);margin-top:.5rem"></p>
    </div>`;
}

// ── Nueva compra ───────────────────────────────────────────────────
function compraDraftCambiarProveedor(id) {
  const p = comprasProveedores.find(x => x.id === id);
  compraDraft.proveedorId = id;
  compraDraft.proveedorNombre = p ? p.nombre : '';
}
function compraBuscarProducto(v) {
  compraBusquedaProducto = v;
  const el = document.getElementById('compra-busqueda-resultados');
  if (el) el.innerHTML = comprasRenderResultadosBusqueda();
}
function comprasRenderResultadosBusqueda() {
  const q = normalizarTexto(compraBusquedaProducto.trim());
  if (!q) return '';
  const resultados = [];
  estado.categorias.forEach(cat => {
    cat.productos.forEach(p => {
      if (normalizarTexto(p.nombre).includes(q)) resultados.push({ cat, p });
    });
  });
  const top = resultados.slice(0, 12);
  if (!top.length) return `<div style="font-size:.78rem;color:var(--muted);padding:.4rem">Sin resultados.</div>`;
  return `<div style="border:1px solid var(--border);border-radius:6px;max-height:220px;overflow-y:auto;margin-top:.3rem">
    ${top.map(({ cat, p }) => `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:.4rem .6rem;border-bottom:1px solid var(--border);font-size:.8rem">
        <span>${escHtml(p.nombre)} <span style="color:var(--muted)">· ${escHtml(cat.nombre)} · stock ${typeof p.stock === 'number' ? p.stock : '—'}</span></span>
        <button class="btn btn-g btn-sm" onclick="compraItemAgregar('${cat.id}',${p.id})">+ Agregar</button>
      </div>`).join('')}
  </div>`;
}
function compraItemAgregar(catId, prodId) {
  const p = getProd(catId, prodId);
  if (!p) return;
  const existente = compraDraft.items.find(it => it.catId === catId && it.prodId === prodId);
  if (existente) existente.cantidadPedida += 1;
  else compraDraft.items.push({ catId, prodId, nombre: p.nombre, cantidadPedida: 1, costoUnitario: 0, cantidadRecibida: 0 });
  compraBusquedaProducto = '';
  comprasRerenderSub();
}
function compraItemCambiar(i, campo, valor) {
  const it = compraDraft.items[i];
  if (!it) return;
  const n = Number(valor);
  it[campo] = isNaN(n) ? 0 : Math.max(0, n);
}
function compraItemQuitar(i) {
  compraDraft.items.splice(i, 1);
  comprasRerenderSub();
}

function comprasRenderNueva() {
  const totalCompra = compraDraft.items.reduce((s, it) => s + it.cantidadPedida * it.costoUnitario, 0);
  return `
    <div class="form-grid">
      <div>
        <label class="field-lbl">Proveedor *</label>
        <select class="field-input" id="cd-proveedor" onchange="compraDraftCambiarProveedor(this.value)">
          <option value="">— Elegir proveedor —</option>
          ${comprasProveedores.map(p => `<option value="${p.id}" ${compraDraft.proveedorId === p.id ? 'selected' : ''}>${escHtml(p.nombre)}</option>`).join('')}
        </select>
      </div>
      <div><label class="field-lbl">Fecha</label><input type="date" class="field-input" id="cd-fecha" value="${compraDraft.fecha}" onchange="compraDraft.fecha=this.value"></div>
    </div>
    ${!comprasProveedores.length ? `<p style="font-size:.78rem;color:var(--muted);margin:.4rem 0">Todavía no cargaste proveedores — <a href="javascript:void(0)" onclick="comprasCambiarVista('proveedores')">creá uno acá</a>.</p>` : ''}

    <div style="margin-top:.8rem">
      <label class="field-lbl">Agregar producto</label>
      <input type="text" class="field-input" placeholder="Buscar producto del catálogo…" value="${escHtml(compraBusquedaProducto)}" oninput="compraBuscarProducto(this.value)">
      <div id="compra-busqueda-resultados">${comprasRenderResultadosBusqueda()}</div>
    </div>

    <div style="overflow-x:auto;margin-top:.8rem">
    <table style="width:100%;border-collapse:collapse;font-size:.8rem">
      <thead><tr><th style="text-align:left;padding:.4rem">Producto</th><th style="padding:.4rem">Cantidad</th><th style="padding:.4rem">Costo unit.</th><th style="padding:.4rem">Subtotal</th><th style="padding:.4rem"></th></tr></thead>
      <tbody>
        ${compraDraft.items.map((it, i) => `
          <tr style="border-top:1px solid var(--border)">
            <td style="padding:.4rem">${escHtml(it.nombre)}</td>
            <td style="padding:.4rem;text-align:center"><input type="number" min="1" class="field-input" style="width:70px" value="${it.cantidadPedida}" oninput="compraItemCambiar(${i},'cantidadPedida',this.value)"></td>
            <td style="padding:.4rem;text-align:center"><input type="number" min="0" class="field-input" style="width:90px" value="${it.costoUnitario}" oninput="compraItemCambiar(${i},'costoUnitario',this.value)"></td>
            <td style="padding:.4rem;text-align:right">Gs. ${Math.round(it.cantidadPedida * it.costoUnitario).toLocaleString('es-PY')}</td>
            <td style="padding:.4rem;text-align:right"><button class="btn btn-danger btn-sm" onclick="compraItemQuitar(${i})">✕</button></td>
          </tr>`).join('') || `<tr><td colspan="5" style="padding:.6rem;color:var(--muted)">Agregá productos con el buscador de arriba.</td></tr>`}
      </tbody>
    </table>
    </div>
    <div style="text-align:right;font-weight:600;margin-top:.4rem">Total: Gs. ${Math.round(totalCompra).toLocaleString('es-PY')}</div>

    <div style="margin-top:.6rem"><label class="field-lbl">Notas</label><textarea class="field-input" id="cd-notas" rows="2" oninput="compraDraft.notas=this.value">${escHtml(compraDraft.notas)}</textarea></div>

    <div style="display:flex;gap:.5rem;margin-top:.8rem">
      <button class="btn btn-p" onclick="compraGuardarNueva()">💾 Registrar compra</button>
    </div>
    <p id="cd-error" style="font-size:.75rem;color:var(--danger);margin-top:.5rem"></p>`;
}

async function compraGuardarNueva() {
  const errEl = document.getElementById('cd-error');
  if (errEl) errEl.textContent = '';
  if (!compraDraft.proveedorId) { if (errEl) errEl.textContent = 'Elegí un proveedor.'; return; }
  if (!compraDraft.items.length) { if (errEl) errEl.textContent = 'Agregá al menos un producto.'; return; }

  const nueva = {
    id: null,
    proveedorId: compraDraft.proveedorId,
    proveedorNombre: compraDraft.proveedorNombre,
    fecha: compraDraft.fecha,
    estado: 'pendiente',
    items: compraDraft.items.map(it => ({ catId: it.catId, prodId: it.prodId, nombre: it.nombre, cantidadPedida: it.cantidadPedida, cantidadRecibida: 0, costoUnitario: it.costoUnitario })),
    pagos: [],
    notas: compraDraft.notas,
  };

  const listaActualizada = [...comprasLista, nueva];
  try {
    const res = await ventasFetch('/api/compras', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ compras: listaActualizada }),
    });
    const data = await res.json().catch(() => null);
    if (data && data.ok) {
      comprasLista = data.compras || [];
      compraDraft = comprasDraftNueva();
      toast('✓ Compra registrada');
      comprasCambiarVista('lista');
    } else if (errEl) errEl.textContent = data?.error || 'No se pudo guardar.';
  } catch { if (errEl) errEl.textContent = 'Sin conexión con el servidor.'; }
}

// ── Lista de compras + detalle (recepción de stock y pagos) ──────────
function comprasEstadoBadge(c) {
  const map = {
    pendiente:        ['⏳ Pendiente', 'var(--muted)'],
    recibida_parcial: ['📦 Parcial', 'var(--feria)'],
    recibida:         ['✓ Recibida', 'var(--verde)'],
    cancelada:        ['✕ Cancelada', 'var(--danger)'],
  };
  const [txt, color] = map[c.estado] || map.pendiente;
  return `<span style="color:${color};font-weight:600">${txt}</span>`;
}
function comprasCompraTotal(c)  { return (c.items || []).reduce((s, it) => s + it.cantidadPedida * it.costoUnitario, 0); }
function comprasCompraPagado(c) { return (c.pagos || []).reduce((s, pg) => s + pg.monto, 0); }

function compraToggleDetalle(id) {
  if (compraAbiertaId === id) {
    compraAbiertaId = null;
    compraItemsRecibidosOriginal = null;
  } else {
    compraAbiertaId = id;
    const c = comprasLista.find(x => x.id === id);
    compraItemsRecibidosOriginal = c ? c.items.map(it => ({ catId: it.catId, prodId: it.prodId, cantidad: it.cantidadRecibida || 0 })) : null;
  }
  comprasRerenderSub();
}

function comprasRenderLista() {
  const lista = [...comprasLista].sort((a, b) => new Date(b.creadoEn || b.fecha) - new Date(a.creadoEn || a.fecha));
  return `
    <div style="display:flex;flex-direction:column;gap:.6rem">
    ${lista.map(c => {
      const total = comprasCompraTotal(c), pagado = comprasCompraPagado(c), saldo = total - pagado;
      const abierta = compraAbiertaId === c.id;
      return `
      <div style="border:1px solid var(--border);border-radius:8px;padding:.7rem .9rem">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:.6rem;cursor:pointer" onclick="compraToggleDetalle('${c.id}')">
          <div>
            <strong>${escHtml(c.proveedorNombre || '(proveedor eliminado)')}</strong>
            <span style="color:var(--muted);font-size:.78rem"> · ${c.fecha} · ${(c.items || []).length} ítem(s)</span>
            <div style="font-size:.78rem;margin-top:.15rem">${comprasEstadoBadge(c)}${saldo > 0 && c.estado !== 'cancelada' ? ` · <span style="color:var(--danger)">Saldo: Gs. ${Math.round(saldo).toLocaleString('es-PY')}</span>` : ''}</div>
          </div>
          <div style="text-align:right">
            <div style="font-weight:600">Gs. ${Math.round(total).toLocaleString('es-PY')}</div>
            <div style="font-size:.72rem;color:var(--muted)">${abierta ? '▲ cerrar' : '▼ ver detalle'}</div>
          </div>
        </div>
        ${abierta ? comprasRenderDetalle(c) : ''}
      </div>`;
    }).join('') || `<p style="color:var(--muted);font-size:.85rem">Todavía no hay compras registradas.</p>`}
    </div>`;
}

function comprasRenderDetalle(c) {
  const total = comprasCompraTotal(c), pagado = comprasCompraPagado(c), saldo = total - pagado;
  return `
    <div style="margin-top:.7rem;border-top:1px solid var(--border);padding-top:.7rem">
      <div style="overflow-x:auto">
      <table style="width:100%;border-collapse:collapse;font-size:.78rem">
        <thead><tr><th style="text-align:left;padding:.3rem">Producto</th><th style="padding:.3rem">Pedido</th><th style="padding:.3rem">Costo unit.</th><th style="padding:.3rem">Recibido</th></tr></thead>
        <tbody>
          ${c.items.map((it, i) => `
            <tr style="border-top:1px solid var(--border)">
              <td style="padding:.3rem">${escHtml(it.nombre)}</td>
              <td style="padding:.3rem;text-align:center">${it.cantidadPedida}</td>
              <td style="padding:.3rem;text-align:center">Gs. ${Math.round(it.costoUnitario).toLocaleString('es-PY')}</td>
              <td style="padding:.3rem;text-align:center">
                ${c.estado === 'cancelada'
                  ? it.cantidadRecibida
                  : `<input type="number" min="0" class="field-input" style="width:70px" value="${it.cantidadRecibida}" oninput="compraItemRecibidaCambiar('${c.id}',${i},this.value)">`}
              </td>
            </tr>`).join('')}
        </tbody>
      </table>
      </div>
      ${c.estado !== 'cancelada' ? `
      <div style="display:flex;gap:.5rem;margin-top:.5rem;flex-wrap:wrap">
        <button class="btn btn-g btn-sm" onclick="compraRecibirTodo('${c.id}')">📦 Marcar todo recibido</button>
        <button class="btn btn-p btn-sm" onclick="compraGuardarRecepcion('${c.id}')">💾 Guardar recepción (actualiza stock)</button>
      </div>` : ''}

      <div style="margin-top:1rem">
        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:.3rem">
          <h4 style="margin:0">Pagos</h4>
          <span style="font-size:.8rem">Total: Gs. ${Math.round(total).toLocaleString('es-PY')} · Pagado: Gs. ${Math.round(pagado).toLocaleString('es-PY')} · <strong style="color:${saldo > 0 ? 'var(--danger)' : 'var(--verde)'}">Saldo: Gs. ${Math.round(saldo).toLocaleString('es-PY')}</strong></span>
        </div>
        <div style="margin-top:.4rem">
          ${(c.pagos || []).map((pg, i) => `
            <div style="display:flex;justify-content:space-between;align-items:center;font-size:.78rem;padding:.3rem 0;border-bottom:1px solid var(--border);gap:.4rem">
              <span>${pg.fecha} · Gs. ${Math.round(pg.monto).toLocaleString('es-PY')}${pg.tipoPago ? ' · ' + escHtml(pg.tipoPago) : ''}${pg.nota ? ' · ' + escHtml(pg.nota) : ''}</span>
              <span style="white-space:nowrap">
                ${pg.comprobanteUrl ? `<a href="javascript:void(0)" onclick="compraVerComprobante('${pg.comprobanteUrl}')">Ver</a> · ` : ''}
                <a href="javascript:void(0)" style="color:var(--danger)" onclick="compraPagoQuitar('${c.id}',${i})">Quitar</a>
              </span>
            </div>`).join('') || `<p style="color:var(--muted);font-size:.78rem">Sin pagos registrados todavía.</p>`}
        </div>
        <div class="form-grid" style="margin-top:.6rem">
          <div><label class="field-lbl">Monto</label><input type="number" min="0" class="field-input" id="pg-monto-${c.id}"></div>
          <div><label class="field-lbl">Fecha</label><input type="date" class="field-input" id="pg-fecha-${c.id}" value="${new Date().toISOString().slice(0, 10)}"></div>
          <div><label class="field-lbl">Tipo de pago</label>
            <select class="field-input" id="pg-tipo-${c.id}">
              <option value="Efectivo">Efectivo</option>
              <option value="Transferencia">Transferencia</option>
              <option value="Tarjeta">Tarjeta</option>
              <option value="Cheque">Cheque</option>
              <option value="Consignación">Consignación</option>
              <option value="Otro">Otro</option>
            </select>
          </div>
          <div><label class="field-lbl">Nota</label><input class="field-input" id="pg-nota-${c.id}"></div>
        </div>
        <div style="margin-top:.4rem">
          <label class="field-lbl">Comprobante (imagen o PDF)</label>
          <input type="file" accept="image/*,.pdf" id="pg-archivo-${c.id}">
        </div>
        <button class="btn btn-p btn-sm" style="margin-top:.5rem" onclick="compraPagoAgregar('${c.id}')">+ Agregar pago</button>
      </div>

      <div style="margin-top:1rem;display:flex;gap:.5rem">
        ${c.estado !== 'cancelada' ? `<button class="btn btn-danger btn-sm" onclick="compraCancelar('${c.id}')">Cancelar compra</button>` : ''}
        <button class="btn btn-danger btn-sm" onclick="compraEliminar('${c.id}')">Eliminar</button>
      </div>
    </div>`;
}

function compraVerComprobante(url) {
  if (/\.pdf($|\?)/i.test(url) || url.startsWith('data:application/pdf')) window.open(url, '_blank');
  else abrirImagenLightbox(url, 'Comprobante de pago');
}

function compraItemRecibidaCambiar(compraId, i, valor) {
  const c = comprasLista.find(x => x.id === compraId);
  if (!c) return;
  const n = Number(valor);
  c.items[i].cantidadRecibida = isNaN(n) ? 0 : Math.max(0, n);
}
function compraRecibirTodo(compraId) {
  const c = comprasLista.find(x => x.id === compraId);
  if (!c) return;
  c.items.forEach(it => { it.cantidadRecibida = it.cantidadPedida; });
  comprasRerenderSub();
}

async function compraGuardarRecepcion(compraId) {
  const c = comprasLista.find(x => x.id === compraId);
  if (!c) return;
  const itemsNuevos = c.items.map(it => ({ catId: it.catId, prodId: it.prodId, cantidad: it.cantidadRecibida || 0 }));
  const huboCambiosStock = comprasAplicarDeltaStock(itemsNuevos, compraItemsRecibidosOriginal || []);
  if (huboCambiosStock) {
    const okStock = await ventasGuardarStockYPublicar();
    if (!okStock) toast('⚠ El stock no se pudo sincronizar con el catálogo público — revisá conexión', 'err');
  }
  const totalPedido   = c.items.reduce((s, it) => s + it.cantidadPedida, 0);
  const totalRecibido = c.items.reduce((s, it) => s + Math.min(it.cantidadRecibida, it.cantidadPedida), 0);
  c.estado = totalRecibido <= 0 ? 'pendiente' : (totalRecibido >= totalPedido ? 'recibida' : 'recibida_parcial');
  c.recibidoEn = new Date().toISOString();
  compraItemsRecibidosOriginal = c.items.map(it => ({ catId: it.catId, prodId: it.prodId, cantidad: it.cantidadRecibida || 0 }));
  const ok = await comprasGuardarListaEnServidor();
  toast(ok ? '✓ Recepción guardada — stock actualizado' : '⚠ No se pudo guardar la recepción', ok ? '' : 'err');
  comprasRerenderSub();
}

async function compraPagoAgregar(compraId) {
  const c = comprasLista.find(x => x.id === compraId);
  if (!c) return;
  const montoEl = document.getElementById(`pg-monto-${compraId}`);
  const monto = Number(montoEl?.value);
  if (!monto || monto <= 0) { toast('⚠ Ingresá un monto válido', 'err'); return; }
  const fecha    = document.getElementById(`pg-fecha-${compraId}`)?.value || new Date().toISOString().slice(0, 10);
  const tipoPago = document.getElementById(`pg-tipo-${compraId}`)?.value || '';
  const nota     = document.getElementById(`pg-nota-${compraId}`)?.value.trim() || '';
  const archivoEl = document.getElementById(`pg-archivo-${compraId}`);
  const archivo = archivoEl && archivoEl.files && archivoEl.files[0];

  let comprobanteUrl = '';
  if (archivo) {
    toast('⏳ Subiendo comprobante…');
    const fd = new FormData();
    fd.append('archivo', archivo);
    fd.append('compraId', compraId);
    fd.append('esPdf', archivo.type === 'application/pdf' ? 'true' : 'false');
    try {
      const res  = await ventasFetch('/api/upload-compra', { method: 'POST', body: fd });
      const data = await res.json().catch(() => null);
      if (data && data.ok) comprobanteUrl = data.url;
      else { toast('⚠ No se pudo subir el comprobante', 'err'); return; }
    } catch { toast('⚠ Sin conexión al subir el comprobante', 'err'); return; }
  }

  c.pagos = [...(c.pagos || []), { monto, fecha, tipoPago, comprobanteUrl, nota }];
  const ok = await comprasGuardarListaEnServidor();
  if (ok) toast('✓ Pago registrado');
  else toast('⚠ No se pudo guardar el pago', 'err');
  comprasRerenderSub();
}

function compraPagoQuitar(compraId, i) {
  const c = comprasLista.find(x => x.id === compraId);
  if (!c) return;
  confirmar('¿Quitar este pago?', async () => {
    c.pagos.splice(i, 1);
    const ok = await comprasGuardarListaEnServidor();
    toast(ok ? 'Pago quitado' : '⚠ No se pudo guardar', ok ? '' : 'err');
    comprasRerenderSub();
  });
}

function compraCancelar(compraId) {
  const c = comprasLista.find(x => x.id === compraId);
  if (!c) return;
  confirmar('¿Cancelar esta compra? No se modifica el stock ya recibido hasta ahora.', async () => {
    c.estado = 'cancelada';
    const ok = await comprasGuardarListaEnServidor();
    toast(ok ? 'Compra cancelada' : '⚠ No se pudo guardar', ok ? '' : 'err');
    comprasRerenderSub();
  });
}
function compraEliminar(compraId) {
  const c = comprasLista.find(x => x.id === compraId);
  if (!c) return;
  confirmar(`¿Eliminar esta compra de <strong>${escHtml(c.proveedorNombre)}</strong> del historial? Esto no afecta el stock ya recibido.`, async () => {
    const listaActualizada = comprasLista.filter(x => x.id !== compraId);
    try {
      const res = await ventasFetch('/api/compras', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ compras: listaActualizada, eliminarIds: [compraId] }),
      });
      const data = await res.json().catch(() => null);
      if (data && data.ok) { comprasLista = data.compras || []; compraAbiertaId = null; toast('Compra eliminada'); }
      else toast('⚠ No se pudo eliminar', 'err');
    } catch { toast('⚠ Sin conexión', 'err'); }
    comprasRerenderSub();
  });
}

// ── Render: contenedor del panel + sub-tabs ──────────────────────────
function comprasSubTabBtn(key, label) {
  return `<button class="btn ${comprasVista === key ? 'btn-p' : 'btn-g'} btn-sm" onclick="comprasCambiarVista('${key}')">${label}</button>`;
}
function comprasCambiarVista(key) {
  comprasVista = key;
  try { localStorage.setItem(COMPRAS_VISTA_SK, key); } catch {}
  comprasRerenderSub();
}
function comprasRenderSubVista() {
  switch (comprasVista) {
    case 'nueva':       return comprasRenderNueva();
    case 'lista':       return comprasRenderLista();
    case 'proveedores': return comprasRenderProveedores();
    default:             return '';
  }
}
function comprasRerenderSub()   { const el = document.getElementById('compras-subpanel'); if (el) el.innerHTML = comprasRenderSubVista(); }
function comprasRerenderPanel() { const el = document.querySelector('#paneles > .panel[data-key="__compras__"]'); if (el) el.innerHTML = renderComprasHTML(); }

function renderComprasHTML() {
  if (!comprasCargado) {
    comprasAlEntrar();
    return `<div class="config-form"><p style="color:var(--muted)">⏳ Cargando proveedores y compras…</p></div>`;
  }
  const activos = comprasLista.filter(c => c.estado === 'pendiente' || c.estado === 'recibida_parcial').length;
  return `
    <div class="config-form">
      <div style="margin-bottom:1rem">
        <h3 style="margin:0 0 .2rem">🛒 Proveedores y Compras</h3>
        <p style="font-size:.78rem;color:var(--muted);margin:0">Pedidos a proveedores, recepción de stock y pagos (con soporte para pagos parciales/consignación).</p>
      </div>
      <div style="display:flex;gap:.4rem;flex-wrap:wrap;margin-bottom:1rem;border-bottom:1px solid var(--border);padding-bottom:.6rem">
        ${comprasSubTabBtn('nueva', '+ Nueva compra')}
        ${comprasSubTabBtn('lista', `📋 Compras${activos ? ' (' + activos + ')' : ''}`)}
        ${comprasSubTabBtn('proveedores', '🏭 Proveedores')}
      </div>
      <div id="compras-subpanel">${comprasRenderSubVista()}</div>
    </div>`;
}

