import io, sys

PATH = "admin-server.js"
with io.open(PATH, "r", encoding="utf-8") as f:
    src = f.read()

def insert_before(src, anchor, block, label):
    idx = src.index(anchor)
    line_start = src.rfind("\n", 0, idx) + 1
    if block not in src:
        src = src[:line_start] + block + src[line_start:]
        print(f"[ok] insertado: {label}")
    else:
        print(f"[skip] ya presente: {label}")
    return src

def insert_after(src, anchor_line, block, label):
    idx = src.index(anchor_line)
    line_end = src.index("\n", idx) + 1
    if block not in src:
        src = src[:line_end] + block + src[line_end:]
        print(f"[ok] insertado: {label}")
    else:
        print(f"[skip] ya presente: {label}")
    return src

anchor1 = "const PATH_BACKUPS = path.join(ROOT, 'backups');"
block1 = (
    "const PATH_PROVEEDORES = path.join(ROOT, 'proveedores.json');\n"
    "const PATH_COMPRAS     = path.join(ROOT, 'compras.json');\n"
)
src = insert_before(src, anchor1, block1, "PATH_PROVEEDORES / PATH_COMPRAS")

anchor2 = "const VENTAS_ESTADOS_VALIDOS = ['reservado', 'pagada', 'cancelada', 'devuelta'];"
with io.open("/sessions/rcw-01g4ayjaqpbpkqckqyvbujn8/backend_block.js", "r", encoding="utf-8") as f:
    block2 = f.read()
src = insert_before(src, anchor2, block2, "funciones Proveedores/Compras")

anchor3 = "if (pathname === '/api/empaque'         && method === 'POST') return await apiPostEmpaque(req, res);"
block3 = (
    "\n    if (pathname === '/api/proveedores'     && method === 'GET')  return apiGetProveedores(req, res);\n"
    "    if (pathname === '/api/proveedores'     && method === 'POST') return await apiPostProveedores(req, res);\n"
    "    if (pathname === '/api/compras'         && method === 'GET')  return apiGetCompras(req, res);\n"
    "    if (pathname === '/api/compras'         && method === 'POST') return await apiPostCompras(req, res);\n"
    "    if (pathname === '/api/upload-compra'   && method === 'POST') return await apiUploadCompra(req, res);"
)
src = insert_after(src, anchor3, block3, "rutas /api/proveedores /api/compras /api/upload-compra")

anchor4 = "  pedidos:    { ruta: PATH_PEDIDOS_PENDIENTES, label: 'Pedidos web',               clave: 'ventas' },"
block4 = (
    "\n  proveedores: { ruta: PATH_PROVEEDORES, label: 'Proveedores',                       clave: 'ventas' },"
    "\n  compras:     { ruta: PATH_COMPRAS,     label: 'Compras',                           clave: 'ventas' },"
)
src = insert_after(src, anchor4, block4, "ARCHIVOS_HISTORIAL proveedores/compras")

with io.open(PATH, "w", encoding="utf-8") as f:
    f.write(src)

print("listo")
