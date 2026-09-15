import io

PATH = "admin.html"
with io.open(PATH, "r", encoding="utf-8") as f:
    src = f.read()

def insert_after_text(src, anchor, block, label, expect=1):
    n = src.count(anchor)
    if n == 0:
        print(f"[FALTA ANCLA] {label} — no se encontro el texto ancla")
        return src
    if n != expect:
        print(f"[AVISO] {label} — se esperaba {expect} ocurrencia(s) del ancla, se encontraron {n}")
    idx = src.index(anchor)
    pos = idx + len(anchor)
    if block.strip() not in src:
        src = src[:pos] + block + src[pos:]
        print(f"[ok] insertado: {label}")
    else:
        print(f"[skip] ya presente: {label}")
    return src

def replace_text(src, old, new, label, expect=1):
    n = src.count(old)
    if n == 0:
        print(f"[FALTA] {label} — texto original no encontrado")
        return src
    if n != expect:
        print(f"[AVISO] {label} — {n} ocurrencias (se esperaban {expect})")
    src = src.replace(old, new)
    print(f"[ok] reemplazado: {label}")
    return src

anchor_html = """      <div id="f-stock-wrap">
        <label class="field-lbl">Stock inicial</label>
        <input type="number" class="field-input" id="f-stock" placeholder="0" min="0" style="width:100%;text-align:left">
      </div>"""
block_html = """
      <div id="f-proveedor-wrap">
        <label class="field-lbl">Proveedor (opcional)</label>
        <select class="field-input" id="f-proveedor">
          <option value="">— Sin proveedor asignado —</option>
        </select>
      </div>"""
src = insert_after_text(src, anchor_html, block_html, "campo Proveedor en modal de producto")

anchor_tab = "    ...(IS_LOCAL ? [{ key: '__ventas__', label: '🧾 Ventas' }] : []),"
block_tab = "\n    ...(IS_LOCAL ? [{ key: '__compras__', label: '🛒 Compras' }] : []),"
src = insert_after_text(src, anchor_tab, block_tab, "tab __compras__ en getTabs()")

anchor_ct = "  if (key === '__ventas__') ventasAlEntrar(); else ventasAlSalir();"
block_ct = "\n  if (key === '__compras__') comprasAlEntrar();"
src = insert_after_text(src, anchor_ct, block_ct, "comprasAlEntrar() en cambiarTab()")

anchor_panel = """  if (IS_LOCAL) {
    const panelVentas = document.createElement('div');
    panelVentas.className = `panel${'__ventas__' === activa ? ' active' : ''}`;
    panelVentas.dataset.key = '__ventas__';
    panelVentas.innerHTML = renderVentasHTML();
    wrap.appendChild(panelVentas);
  }"""
block_panel = """

  // ── Panel COMPRAS (Proveedores y Compras, SOLO local — ver getTabs()) ──
  if (IS_LOCAL) {
    const panelCompras = document.createElement('div');
    panelCompras.className = `panel${'__compras__' === activa ? ' active' : ''}`;
    panelCompras.dataset.key = '__compras__';
    panelCompras.innerHTML = renderComprasHTML();
    wrap.appendChild(panelCompras);
  }"""
src = insert_after_text(src, anchor_panel, block_panel, "panel Compras en renderPaneles()")

anchor_fn = """      <div id="ventas-subpanel">${ventasRenderSubVista()}</div>
    </div>`;
}"""
with io.open("frontend_block.js", "r", encoding="utf-8") as f:
    block_fn = f.read()
src = insert_after_text(src, anchor_fn, "\n" + block_fn, "bloque de funciones Compras")

anchor_nuevo = """  document.getElementById('modal-titulo').textContent = 'Nuevo producto';
  document.getElementById('modal-bg').classList.add('open');
}"""
block_nuevo = """  document.getElementById('modal-titulo').textContent = 'Nuevo producto';
  poblarSelectProveedorProducto('');
  asegurarProveedoresCargados().then(() => poblarSelectProveedorProducto(''));
  document.getElementById('modal-bg').classList.add('open');
}"""
src = replace_text(src, anchor_nuevo, block_nuevo, "poblar Proveedor en abrirNuevoProducto()")

anchor_editar = """  restaurarSlotDesdeUrl('muestra3',  p.imagenMuestra3 || '');
  document.getElementById('modal-bg').classList.add('open');
}"""
block_editar = """  restaurarSlotDesdeUrl('muestra3',  p.imagenMuestra3 || '');
  poblarSelectProveedorProducto(p.proveedorId || '');
  asegurarProveedoresCargados().then(() => poblarSelectProveedorProducto(p.proveedorId || ''));
  document.getElementById('modal-bg').classList.add('open');
}"""
src = replace_text(src, anchor_editar, block_editar, "poblar Proveedor en abrirEditar()")

anchor_leer = "  const stock    = parseInt(document.getElementById('f-stock').value);"
block_leer = "\n  const proveedorId = document.getElementById('f-proveedor')?.value || '';"
src = insert_after_text(src, anchor_leer, block_leer, "leer proveedorId en guardarProductoModal()")

old_prod = "disponible: disp, sobrePedido, tematica, imagen: img, imagenMuestra: imgm,"
new_prod = "disponible: disp, sobrePedido, tematica, proveedorId, imagen: img, imagenMuestra: imgm,"
src = replace_text(src, old_prod, new_prod, "incluir proveedorId en objeto producto (editar+nuevo)", expect=2)

with io.open(PATH, "w", encoding="utf-8") as f:
    f.write(src)

print("listo")
