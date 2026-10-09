/**
 * Code.gs – Backend de "Gestión de Ventas y Comisiones"
 * Requiere haber ejecutado antes setupDatabase() (Setup.gs).
 *
 * Convenciones:
 *  - Todas las funciones públicas (llamables con google.script.run) reciben el `token`
 *    de sesión como primer parámetro, salvo login() y doGet().
 *  - Los errores se lanzan con `throw new Error('mensaje en español')`; en el cliente
 *    llegan a withFailureHandler(e => e.message).
 *  - Nunca se devuelven objetos Date (google.script.run no los serializa): las fechas
 *    salen como strings ISO.
 *  - Filtros: filtroMes = 'YYYY-MM' (<input type="month">),
 *             filtroSemana = 'YYYY-Www' semana ISO (<input type="week">).
 *    Vacío / null / 'Todos' = sin filtro.
 *
 * Modelo económico:
 *  - Base comisionable = Precio_Venta - Costo_Producto (el coste lo introduce el admin al confirmar).
 *  - Comisión = base * %.
 *  - Ganancia del admin = Precio - Coste - Comisión (solo ventas confirmadas).
 *  - El coste solo se envía al cliente cuando el usuario es admin.
 *
 * Contabilidad (el vendedor cobra al cliente y liquida con el admin):
 *  - Me debe (mes) = suma(Precio) - suma(Comisión) de las ventas confirmadas de ese mes.
 *  - Ajuste manual por vendedor y mes: positivo = el vendedor debe más; negativo = el admin le debe.
 *  - Total a liquidar = Me debe + Ajuste. Se marca "Saldado" con fecha e importe.
 *  - Datos manuales (ajuste, nota, pagado) en la hoja "Contabilidad" (se crea sola).
 *
 * Hojas Ventas y Contabilidad: se leen y escriben SIEMPRE por posición de columna.
 */

/* ============================== CONSTANTES ============================== */

const TZ = 'Europe/Madrid';
const SESSION_TTL_SEC = 6 * 60 * 60;       // máximo permitido por CacheService
const MAX_LOGIN_FAILS = 5;
const LOGIN_LOCK_SEC = 15 * 60;
const MAX_FILE_BYTES = 10 * 1024 * 1024;   // 10 MB por archivo
const COMISION_FALLBACK = 50;

const ESTADO_PENDIENTE = 'Pendiente';
const ESTADO_CONFIRMADO = 'Confirmado';

const VENTAS_COLS = ['ID_Venta', 'ID_Vendedor', 'Fecha_Venta', 'Producto', 'Precio_Venta',
  'URL_Foto_Etiqueta', 'URL_Foto_Producto', 'Estado', 'Porcentaje_Comision',
  'Comision_Calculada', 'Fecha_Confirmacion', 'Costo_Producto'];

const CONTAB_COLS = ['Clave', 'ID_Vendedor', 'Mes', 'Ajuste', 'Nota', 'Pagado', 'Fecha_Pago', 'Importe_Saldado'];

// Icono de la app (archivo de Drive compartido como "Cualquiera con el enlace")
const ICON_FILE_ID = '1sDwVKp6X592id9jcJlMiWt1ECNmsNba2';
// "-rp" forza il formato PNG (senza, Google può servire WEBP e setFaviconUrl lo rifiuta)
const ICON_URL = 'https://lh3.googleusercontent.com/d/' + ICON_FILE_ID + '=s256-rp';

function doGet(e) {
  if (e && e.parameter && e.parameter.api === 'ping') return jsonOut_({ ok: true, data: 'pong' });
  const out = HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Gestión de Ventas')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .addMetaTag('mobile-web-app-capable', 'yes')
    .addMetaTag('apple-mobile-web-app-capable', 'yes')
    .addMetaTag('apple-mobile-web-app-title', 'Ventas')
    .addMetaTag('theme-color', '#212529');
  try {
    out.setFaviconUrl(ICON_URL);
  } catch (e) {
    console.warn('No se pudo establecer el icono: ' + e.message);
  }
  return out;
}

/* ===================== API JSON (frontend en GitHub Pages) =====================
 * El frontend alojado fuera de Apps Script llama a este endpoint con
 *   fetch(URL_/exec, { method:'POST', headers:{'Content-Type':'text/plain'},
 *                      body: JSON.stringify({ fn:'nombreFuncion', args:[...] }) })
 * (text/plain evita el preflight CORS, que Apps Script no soporta).
 * Solo se pueden invocar las funciones de la lista blanca. */
const API_WHITELIST = [
  'login', 'validarSesion', 'logout', 'registrarVenta', 'getVentasVendedor',
  'getNuevasVentas', 'confirmarVenta', 'getReporteAdmin', 'getGananciasAdmin',
  'getContabilidad', 'guardarContabilidad', 'editarVenta', 'eliminarVenta',
  'updateComisionVendedor', 'crearVendedor', 'getVendedores',
  'cambiarMiPassword', 'resetPasswordVendedor'
];

function doPost(e) {
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const fn = String(body.fn || '');
    if (API_WHITELIST.indexOf(fn) < 0) throw new Error('Operación no permitida.');
    const args = Array.isArray(body.args) ? body.args : [];
    const result = apiFn_(fn).apply(null, args);
    return jsonOut_({ ok: true, data: result === undefined ? null : result });
  } catch (err) {
    return jsonOut_({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

function apiFn_(name) {
  const fns = { login: login, validarSesion: validarSesion, logout: logout, registrarVenta: registrarVenta,
    getVentasVendedor: getVentasVendedor, getNuevasVentas: getNuevasVentas, confirmarVenta: confirmarVenta,
    getReporteAdmin: getReporteAdmin, getGananciasAdmin: getGananciasAdmin, getContabilidad: getContabilidad,
    guardarContabilidad: guardarContabilidad, editarVenta: editarVenta, eliminarVenta: eliminarVenta,
    updateComisionVendedor: updateComisionVendedor, crearVendedor: crearVendedor, getVendedores: getVendedores,
    cambiarMiPassword: cambiarMiPassword, resetPasswordVendedor: resetPasswordVendedor };
  return fns[name];
}

function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* ============================ AUTH Y SESIONES =========================== */

/**
 * @param {string} email     Email del vendedor (se ignora si esAdmin).
 * @param {string} password
 * @param {boolean} esAdmin
 * @return {{token:string, usuario:{id,nombre,email,rol}, expiraEnSegundos:number}}
 */
function login(email, password, esAdmin) {
  password = String(password || '');
  if (!password) throw new Error('Introduce la contraseña.');

  const emailNorm = String(email || '').trim().toLowerCase();
  if (!esAdmin && !emailNorm) throw new Error('Introduce el correo electrónico.');

  const cache = CacheService.getScriptCache();
  const failKey = 'fail:' + (esAdmin ? 'admin' : emailNorm);
  if (Number(cache.get(failKey) || 0) >= MAX_LOGIN_FAILS) {
    throw new Error('Demasiados intentos fallidos. Inténtalo de nuevo en 15 minutos.');
  }

  const hash = hashPwd_(password);
  let user = null;

  if (esAdmin) {
    const stored = String(getConfig_().ADMIN_PASSWORD_HASH || '');
    if (!stored) throw new Error('El administrador aún no está configurado.');
    if (safeEq_(stored, hash)) {
      user = { id: 'ADMIN', nombre: 'Administrador', email: '', rol: 'admin' };
    }
  } else {
    const v = getTable_('Vendedores').find(r => String(r.Email).trim().toLowerCase() === emailNorm);
    if (v && v.Password_Hash && safeEq_(String(v.Password_Hash), hash)) {
      user = { id: String(v.ID_Vendedor), nombre: String(v.Nombre), email: String(v.Email), rol: 'vendedor' };
    }
  }

  if (!user) {
    cache.put(failKey, String(Number(cache.get(failKey) || 0) + 1), LOGIN_LOCK_SEC);
    throw new Error('Credenciales incorrectas.');
  }

  cache.remove(failKey);
  const token = Utilities.getUuid() + Utilities.getUuid().replace(/-/g, '');
  cache.put('sess:' + token, JSON.stringify(user), SESSION_TTL_SEC);
  return { token: token, usuario: user, expiraEnSegundos: SESSION_TTL_SEC };
}

/** Comprueba que el token sigue vivo (útil al recargar la página). */
function validarSesion(token) {
  return requireSession_(token);
}

function logout(token) {
  if (token) CacheService.getScriptCache().remove('sess:' + token);
  return true;
}

function requireSession_(token, rol) {
  if (!token) throw new Error('Sesión no válida. Inicia sesión de nuevo.');
  const cache = CacheService.getScriptCache();
  const raw = cache.get('sess:' + token);
  if (!raw) throw new Error('Sesión caducada. Inicia sesión de nuevo.');
  const user = JSON.parse(raw);
  if (rol && user.rol !== rol) throw new Error('No tienes permisos para realizar esta acción.');
  cache.put('sess:' + token, raw, SESSION_TTL_SEC); // sesión deslizante
  return user;
}

/* ============================ FUNCIONES VENDEDOR ======================== */

/**
 * @param {string} token
 * @param {{fecha:string, producto:string, precio:(number|string),
 *          fotoEtiqueta:{base64:string, nombre?:string},
 *          fotoProducto:{base64:string, nombre?:string}}} data
 *   `fecha` en formato 'yyyy-MM-dd' (o 'dd/MM/yyyy'). Los archivos van en Base64
 *   (con o sin prefijo "data:...;base64,"). La etiqueta puede ser imagen o PDF.
 */
function registrarVenta(token, data) {
  const user = requireSession_(token, 'vendedor');
  if (!data) throw new Error('No se han recibido datos.');

  const fecha = parseFecha_(data.fecha);
  const producto = cleanText_(data.producto, 200);
  const precio = parseNumber_(data.precio);
  if (!producto) throw new Error('Introduce el nombre del producto.');
  if (!isFinite(precio) || precio <= 0) throw new Error('El precio debe ser un número mayor que 0.');

  const vendedor = getTable_('Vendedores').find(r => String(r.ID_Vendedor) === user.id);
  if (!vendedor) throw new Error('Vendedor no encontrado.');

  const pct = getPorcentajeDefecto_(vendedor);
  const comision = 0; // se calcula al confirmar, cuando el admin introduce el coste
  const idVenta = 'V-' + Utilities.formatDate(new Date(), TZ, 'yyMMdd') + '-' +
    Utilities.getUuid().slice(0, 6).toUpperCase();

  // 1) Subida de archivos (fuera del lock: es la parte lenta)
  const creados = [];
  try {
    const fEtiqueta = saveFile_(data.fotoEtiqueta, idVenta + '_etiqueta', 'etiqueta');
    creados.push(fEtiqueta);
    const fProducto = saveFile_(data.fotoProducto, idVenta + '_producto', 'producto');
    creados.push(fProducto);

    // 2) Alta de la fila (con lock para evitar colisiones)
    const row = [idVenta, user.id, fecha, producto, round2_(precio),
      fEtiqueta.getUrl(), fProducto.getUrl(), ESTADO_PENDIENTE, pct, comision, '', ''];
    withLock_(() => appendValues_(getVentasSheet_(), row));

    return toDto_(rowToObj_(row), { [user.id]: user.nombre }); // sin coste
  } catch (err) {
    // Rollback: no dejar archivos huérfanos en Drive
    creados.forEach(f => { try { f.setTrashed(true); } catch (e) { /* ignorar */ } });
    throw err;
  }
}

/**
 * Ventas del vendedor con totales. Si el usuario es vendedor se ignora idVendedor
 * y se usa siempre el de la sesión. El admin puede consultar cualquier vendedor.
 * El coste y los datos de ganancia solo se devuelven al admin.
 */
function getVentasVendedor(token, idVendedor, filtroMes, filtroSemana) {
  const user = requireSession_(token);
  const adm = user.rol === 'admin';
  const id = adm ? String(idVendedor || '') : user.id;
  if (!id) throw new Error('Falta el ID del vendedor.');

  const ventas = filtrar_(getVentas_(), { idVendedor: id, mes: filtroMes, semana: filtroSemana })
    .sort((a, b) => time_(b.Fecha_Venta) - time_(a.Fecha_Venta));
  const map = getVendedoresMap_();
  return { ventas: ventas.map(v => toDto_(v, map, adm)), totales: calcTotales_(ventas, adm) };
}

/* ============================== FUNCIONES ADMIN ========================= */

/** Todas las ventas en estado "Pendiente" (las más antiguas primero). */
function getNuevasVentas(token) {
  requireSession_(token, 'admin');
  const map = getVendedoresMap_();
  return getVentas_()
    .filter(v => v.Estado === ESTADO_PENDIENTE)
    .sort((a, b) => time_(a.Fecha_Venta) - time_(b.Fecha_Venta))
    .map(v => toDto_(v, map, true));
}

/**
 * Confirma una venta. Base de comisión = precio - coste.
 *  - comisionMontoPersonalizado → comisión final; el % se recalcula sobre la base.
 *  - si no, porcentajeComisionPersonalizado → comisión = base * %.
 *  - si no se pasa ninguno → se mantiene el % guardado.
 */
function confirmarVenta(token, idVenta, costoProducto, porcentajeComisionPersonalizado, comisionMontoPersonalizado) {
  requireSession_(token, 'admin');
  const costo = parseNumber_(costoProducto);
  if (isBlank_(costoProducto) || !isFinite(costo) || costo < 0) {
    throw new Error('Introduce el coste del producto (0 si no tiene).');
  }
  const hayPct = !isBlank_(porcentajeComisionPersonalizado);
  const hayMonto = !isBlank_(comisionMontoPersonalizado);

  return withLock_(() => {
    const sh = getVentasSheet_();
    const row = findRow_(sh, idVenta);
    if (row < 0) throw new Error('Venta no encontrada.');

    const rec = rowToObj_(sh.getRange(row, 1, 1, VENTAS_COLS.length).getValues()[0]);
    const precio = Number(rec.Precio_Venta) || 0;
    const base = Math.max(round2_(precio - costo), 0);   // base comisionable
    let pct = Number(rec.Porcentaje_Comision) || 0;
    let comision;

    if (hayMonto) {
      comision = parseNumber_(comisionMontoPersonalizado);
      if (!isFinite(comision) || comision < 0) throw new Error('El importe de la comisión no es válido.');
      if (comision > base) throw new Error('La comisión no puede superar el beneficio (precio - coste).');
      comision = round2_(comision);
      pct = base > 0 ? round2_(comision / base * 100) : 0;
    } else {
      if (hayPct) {
        pct = parseNumber_(porcentajeComisionPersonalizado);
        if (!isFinite(pct) || pct < 0 || pct > 100) throw new Error('El porcentaje debe estar entre 0 y 100.');
      }
      comision = round2_(base * pct / 100);
    }

    const ahora = new Date();
    const c = VENTAS_COLS.indexOf('Estado') + 1; // Estado, %, Comisión, Fecha, Coste: contiguas
    sh.getRange(row, c, 1, 5).setValues([[ESTADO_CONFIRMADO, pct, comision, ahora, round2_(costo)]]);
    SpreadsheetApp.flush();

    rec.Estado = ESTADO_CONFIRMADO;
    rec.Porcentaje_Comision = pct;
    rec.Comision_Calculada = comision;
    rec.Fecha_Confirmacion = ahora;
    rec.Costo_Producto = round2_(costo);
    return toDto_(rec, getVendedoresMap_(), true);
  });
}

/**
 * Informe para el admin con filtros combinables (AND).
 * @return {{ventas:Array, totales:Object, porVendedor:Array}}
 *   comisionConfirmada = importe realmente a pagar;
 *   comisionPendiente  = comisión de ventas aún sin confirmar (0 si son nuevas: sin coste no se calcula).
 */
function getReporteAdmin(token, idVendedor, filtroEstado, filtroMes, filtroSemana) {
  requireSession_(token, 'admin');
  const ventas = filtrar_(getVentas_(), {
    idVendedor: idVendedor, estado: filtroEstado, mes: filtroMes, semana: filtroSemana
  }).sort((a, b) => time_(b.Fecha_Venta) - time_(a.Fecha_Venta));

  const map = getVendedoresMap_();
  const grupos = {};
  ventas.forEach(v => {
    const id = String(v.ID_Vendedor);
    (grupos[id] = grupos[id] || []).push(v);
  });
  const porVendedor = Object.keys(grupos).map(id =>
    Object.assign({ idVendedor: id, nombreVendedor: map[id] || id }, calcTotales_(grupos[id], true))
  ).sort((a, b) => b.comisionTotal - a.comisionTotal);

  return {
    ventas: ventas.map(v => toDto_(v, map, true)),
    totales: calcTotales_(ventas, true),
    porVendedor: porVendedor
  };
}

/**
 * Ganancias del admin (solo ventas confirmadas): ingresos - costes - comisiones.
 * Filtrable por vendedor, mes o semana. Incluye el desglose por vendedor.
 * totales.numSinCosto = ventas confirmadas sin coste registrado (la ganancia sería engañosa).
 */
function getGananciasAdmin(token, idVendedor, filtroMes, filtroSemana) {
  requireSession_(token, 'admin');
  const ventas = filtrar_(getVentas_(), {
    idVendedor: idVendedor, estado: ESTADO_CONFIRMADO, mes: filtroMes, semana: filtroSemana
  });
  const map = getVendedoresMap_();
  const grupos = {};
  ventas.forEach(v => {
    const id = String(v.ID_Vendedor);
    (grupos[id] = grupos[id] || []).push(v);
  });
  const porVendedor = Object.keys(grupos).map(id =>
    Object.assign({ idVendedor: id, nombreVendedor: map[id] || id }, calcTotales_(grupos[id], true))
  ).sort((a, b) => b.ganancia - a.ganancia);
  return { totales: calcTotales_(ventas, true), porVendedor: porVendedor };
}

/* ============================== CONTABILIDAD ============================ */

/**
 * Contabilidad por vendedor y mes solar (solo ventas confirmadas).
 * Filtros (AND): idVendedor, producto (contiene, sin distinguir mayúsculas), mes 'YYYY-MM', año 'YYYY'.
 * Con filtro de producto la vista es parcial (parcial=true): no incluye ajustes ni pagos.
 * @return {{filas:Array, productos:string[], parcial:boolean}}
 */
function getContabilidad(token, idVendedor, producto, filtroMes, filtroAnio) {
  requireSession_(token, 'admin');
  const anio = isBlank_(filtroAnio) ? '' : String(filtroAnio).trim();
  if (anio && !/^\d{4}$/.test(anio)) throw new Error('El año debe tener 4 cifras (ej. 2026).');
  const prod = isBlank_(producto) ? '' : String(producto).trim().toLowerCase();
  const mes = isBlank_(filtroMes) ? '' : String(filtroMes).trim();
  const idV = (isBlank_(idVendedor) || String(idVendedor).trim().toLowerCase() === 'todos') ? '' : String(idVendedor).trim();

  const todas = getVentas_();
  const extra = v => {
    const k = mesKey_(v.Fecha_Venta);
    if (!k) return false;
    if (anio && k.slice(0, 4) !== anio) return false;
    if (prod && String(v.Producto || '').toLowerCase().indexOf(prod) < 0) return false;
    return true;
  };
  const conf = filtrar_(todas, { idVendedor: idV, estado: ESTADO_CONFIRMADO, mes: mes }).filter(extra);
  const pend = filtrar_(todas, { idVendedor: idV, estado: ESTADO_PENDIENTE, mes: mes }).filter(extra);

  const map = getVendedoresMap_();
  const filas = {};
  const fila = (id, m) => {
    const k = id + '|' + m;
    return filas[k] || (filas[k] = nuevaFilaContab_(id, map[id] || id, m));
  };

  conf.forEach(v => {
    const f = fila(String(v.ID_Vendedor), mesKey_(v.Fecha_Venta));
    f.numVentas++;
    f.vendido += Number(v.Precio_Venta) || 0;
    f.comision += Number(v.Comision_Calculada) || 0;
  });

  // Ajustes, notas y pagos (solo sin filtro de producto)
  if (!prod) {
    const sh = getContabSheet_();
    const last = sh.getLastRow();
    if (last > 1) {
      sh.getRange(2, 1, last - 1, CONTAB_COLS.length).getValues().forEach(r => {
        if (r[0] === '' || r[0] === null) return;
        const rid = String(r[1]).trim(), rm = mesCell_(r[2]);
        if (idV && rid !== idV) return;
        if (mes && rm !== mes) return;
        if (anio && rm.slice(0, 4) !== anio) return;
        aplicarRegistroContab_(fila(rid, rm), r);
      });
    }
  }

  pend.forEach(v => {
    const f = filas[String(v.ID_Vendedor) + '|' + mesKey_(v.Fecha_Venta)];
    if (f) f.numPendientes++;
  });

  const lista = Object.keys(filas).map(k => {
    const f = filas[k];
    f.vendido = round2_(f.vendido);
    f.comision = round2_(f.comision);
    f.debe = round2_(f.vendido - f.comision);
    return f;
  }).sort((a, b) => a.nombreVendedor.localeCompare(b.nombreVendedor) || (a.mes < b.mes ? 1 : a.mes > b.mes ? -1 : 0));

  const nombres = {};
  todas.forEach(v => { const p = String(v.Producto || '').trim(); if (p) nombres[p] = true; });
  const productos = Object.keys(nombres).sort((a, b) => a.localeCompare(b));

  return { filas: lista, productos: productos, parcial: !!prod };
}

/**
 * Guarda el ajuste, la nota y el estado de pago de un vendedor en un mes.
 * ajuste: positivo = el vendedor debe más; negativo = el admin le debe. Vacío = 0.
 * Al marcar como saldado se guarda la fecha y el importe total a liquidar de ese momento.
 */
function guardarContabilidad(token, idVendedor, mes, ajuste, nota, pagado) {
  requireSession_(token, 'admin');
  const idV = String(idVendedor || '').trim();
  const m = String(mes || '').trim();
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(m)) throw new Error('Mes no válido (formato AAAA-MM).');
  const map = getVendedoresMap_();
  if (!map[idV]) throw new Error('Vendedor no encontrado.');

  let aj = isBlank_(ajuste) ? 0 : parseNumber_(ajuste);
  if (!isFinite(aj) || Math.abs(aj) > 10000000) throw new Error('El ajuste no es válido.');
  aj = round2_(aj);
  const nt = cleanText_(nota, 200);
  const pag = pagado === true || String(pagado).toLowerCase() === 'true';
  const clave = idV + '|' + m;

  return withLock_(() => {
    const sh = getContabSheet_();
    const row = findRow_(sh, clave);
    const prev = row > 0 ? sh.getRange(row, 1, 1, CONTAB_COLS.length).getValues()[0] : null;
    const prevPag = prev ? isTrue_(prev[5]) : false;

    const f = nuevaFilaContab_(idV, map[idV], m);
    resumenMes_(f, getVentas_());
    const total = round2_(f.debe + aj);

    let fechaPago = '', importe = '';
    if (pag) {
      if (prevPag) {
        fechaPago = prev[6] instanceof Date ? prev[6] : new Date();
        importe = isBlank_(prev[7]) ? total : Number(prev[7]);
      } else {
        fechaPago = new Date();
        importe = total;
      }
    }

    if (!pag && aj === 0 && !nt) {
      if (row > 0) sh.deleteRow(row);          // sin datos manuales: se limpia el registro
    } else {
      const vals = [clave, idV, m, aj, nt, pag, fechaPago, importe];
      if (row > 0) sh.getRange(row, 1, 1, vals.length).setValues([vals]);
      else appendValues_(sh, vals);
    }
    SpreadsheetApp.flush();

    f.ajuste = aj;
    f.nota = nt;
    f.pagado = pag;
    f.fechaPago = fechaPago instanceof Date ? isoDT_(fechaPago) : '';
    f.importeSaldado = pag ? round2_(importe) : null;
    return f;
  });
}

function nuevaFilaContab_(idV, nombre, mes) {
  return { clave: idV + '|' + mes, idVendedor: idV, nombreVendedor: nombre, mes: mes,
           numVentas: 0, numPendientes: 0, vendido: 0, comision: 0, debe: 0,
           ajuste: 0, nota: '', pagado: false, fechaPago: '', importeSaldado: null };
}

function aplicarRegistroContab_(f, r) {
  f.ajuste = round2_(Number(r[3]) || 0);
  f.nota = String(r[4] || '');
  f.pagado = isTrue_(r[5]);
  f.fechaPago = r[6] instanceof Date ? isoDT_(r[6]) : '';
  f.importeSaldado = (f.pagado && !isBlank_(r[7])) ? round2_(Number(r[7])) : null;
}

/** Rellena numVentas, numPendientes, vendido, comision y debe de la fila a partir de TODAS las ventas del mes. */
function resumenMes_(f, todas) {
  todas.forEach(v => {
    if (String(v.ID_Vendedor) !== f.idVendedor || mesKey_(v.Fecha_Venta) !== f.mes) return;
    if (v.Estado === ESTADO_CONFIRMADO) {
      f.numVentas++;
      f.vendido += Number(v.Precio_Venta) || 0;
      f.comision += Number(v.Comision_Calculada) || 0;
    } else {
      f.numPendientes++;
    }
  });
  f.vendido = round2_(f.vendido);
  f.comision = round2_(f.comision);
  f.debe = round2_(f.vendido - f.comision);
}

function mesKey_(d) {
  return d instanceof Date ? Utilities.formatDate(d, TZ, 'yyyy-MM') : '';
}

function mesCell_(x) {
  return x instanceof Date ? mesKey_(x) : String(x || '').trim();
}

function isoDT_(x) {
  return x instanceof Date ? Utilities.formatDate(x, TZ, "yyyy-MM-dd'T'HH:mm:ss") : '';
}

function isTrue_(x) {
  return x === true || String(x).toUpperCase() === 'TRUE';
}

/* ======================= EDICIÓN Y BAJA DE VENTAS ======================= */

/**
 * Edita una venta existente (admin). Se pueden cambiar fecha, producto, precio, estado,
 * coste y comisión. El vendedor y los archivos adjuntos no cambian.
 *  datos = { fecha, producto, precio, estado, costo, modo:'pct'|'eur', porcentaje, comision }
 *  - Confirmado: exige coste; base = precio - coste; comisión según `modo`.
 *  - Pendiente: sin coste, comisión 0 y sin fecha de confirmación.
 */
function editarVenta(token, idVenta, datos) {
  requireSession_(token, 'admin');
  datos = datos || {};
  const fecha = parseFecha_(datos.fecha);
  const producto = cleanText_(datos.producto, 200);
  const precio = parseNumber_(datos.precio);
  const estado = String(datos.estado || '');
  if (!producto) throw new Error('Introduce el nombre del producto.');
  if (!isFinite(precio) || precio <= 0) throw new Error('El precio debe ser un número mayor que 0.');
  if ([ESTADO_PENDIENTE, ESTADO_CONFIRMADO].indexOf(estado) < 0) throw new Error('Estado no válido.');

  return withLock_(() => {
    const sh = getVentasSheet_();
    const row = findRow_(sh, idVenta);
    if (row < 0) throw new Error('Venta no encontrada.');

    const rec = rowToObj_(sh.getRange(row, 1, 1, VENTAS_COLS.length).getValues()[0]);
    let pct = Number(rec.Porcentaje_Comision) || 0;
    let comision = 0, costo = '', fechaConf = '';

    if (estado === ESTADO_CONFIRMADO) {
      if (isBlank_(datos.costo)) throw new Error('Introduce el coste del producto (0 si no tiene).');
      costo = parseNumber_(datos.costo);
      if (!isFinite(costo) || costo < 0) throw new Error('El coste del producto no es válido.');
      costo = round2_(costo);
      const base = Math.max(round2_(precio - costo), 0);

      if (datos.modo === 'eur') {
        comision = parseNumber_(datos.comision);
        if (!isFinite(comision) || comision < 0) throw new Error('El importe de la comisión no es válido.');
        if (comision > base) throw new Error('La comisión no puede superar el beneficio (precio - coste).');
        comision = round2_(comision);
        pct = base > 0 ? round2_(comision / base * 100) : 0;
      } else {
        pct = parseNumber_(datos.porcentaje);
        if (!isFinite(pct) || pct < 0 || pct > 100) throw new Error('El porcentaje debe estar entre 0 y 100.');
        comision = round2_(base * pct / 100);
      }
      // Si ya estaba confirmada se conserva la fecha original de confirmación
      fechaConf = rec.Fecha_Confirmacion instanceof Date ? rec.Fecha_Confirmacion : new Date();
    }

    sh.getRange(row, 3, 1, 3).setValues([[fecha, producto, round2_(precio)]]);   // Fecha, Producto, Precio
    const c = VENTAS_COLS.indexOf('Estado') + 1;                                  // Estado..Coste (5 columnas)
    sh.getRange(row, c, 1, 5).setValues([[estado, pct, comision, fechaConf, costo]]);
    SpreadsheetApp.flush();

    rec.Fecha_Venta = fecha;
    rec.Producto = producto;
    rec.Precio_Venta = round2_(precio);
    rec.Estado = estado;
    rec.Porcentaje_Comision = pct;
    rec.Comision_Calculada = comision;
    rec.Fecha_Confirmacion = fechaConf;
    rec.Costo_Producto = costo;
    return toDto_(rec, getVendedoresMap_(), true);
  });
}

/**
 * Elimina una venta (admin): borra la fila y manda a la papelera de Drive sus archivos
 * (recuperables desde la papelera de Drive durante 30 días).
 */
function eliminarVenta(token, idVenta) {
  requireSession_(token, 'admin');

  const urls = withLock_(() => {
    const sh = getVentasSheet_();
    const row = findRow_(sh, idVenta);
    if (row < 0) throw new Error('Venta no encontrada.');
    const rec = rowToObj_(sh.getRange(row, 1, 1, VENTAS_COLS.length).getValues()[0]);
    sh.deleteRow(row);
    return [rec.URL_Foto_Etiqueta, rec.URL_Foto_Producto];
  });

  // Fuera del lock: la papelera de Drive es lenta y un fallo aquí no debe revertir el borrado
  let archivos = 0;
  urls.forEach(u => {
    const m = String(u || '').match(/[-\w]{25,}/);
    if (!m) return;
    try { DriveApp.getFileById(m[0]).setTrashed(true); archivos++; }
    catch (e) { console.warn('No se pudo mover a la papelera el archivo ' + m[0] + ': ' + e.message); }
  });
  return { idVenta: String(idVenta), archivosEliminados: archivos };
}

/** Cambia la comisión por defecto de un vendedor (solo afecta a ventas futuras). */
function updateComisionVendedor(token, idVendedor, nuevoPorcentaje) {
  requireSession_(token, 'admin');
  const pct = parseNumber_(nuevoPorcentaje);
  if (!isFinite(pct) || pct < 0 || pct > 100) throw new Error('El porcentaje debe estar entre 0 y 100.');

  return withLock_(() => {
    const sh = getDb_().getSheetByName('Vendedores');
    const row = findRow_(sh, idVendedor);
    if (row < 0) throw new Error('Vendedor no encontrado.');
    sh.getRange(row, 5).setValue(pct); // Comision_Defecto_Porcentaje
    return { idVendedor: String(idVendedor), comisionDefecto: pct };
  });
}

/** Alta de vendedor (necesaria para poder tener usuarios). */
function crearVendedor(token, datos) {
  requireSession_(token, 'admin');
  datos = datos || {};
  const nombre = cleanText_(datos.nombre, 100);
  const email = String(datos.email || '').trim().toLowerCase();
  const password = String(datos.password || '');
  const pct = isBlank_(datos.comision) ? getPorcentajeDefecto_({}) : parseNumber_(datos.comision);

  if (!nombre) throw new Error('Introduce el nombre del vendedor.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('El correo electrónico no es válido.');
  validarPassword_(password);
  if (!isFinite(pct) || pct < 0 || pct > 100) throw new Error('El porcentaje debe estar entre 0 y 100.');

  return withLock_(() => {
    const sh = getDb_().getSheetByName('Vendedores');
    if (getTable_('Vendedores').some(r => String(r.Email).trim().toLowerCase() === email)) {
      throw new Error('Ya existe un vendedor con ese correo.');
    }
    const id = 'S-' + Utilities.getUuid().slice(0, 6).toUpperCase();
    sh.appendRow([id, nombre, email, hashPwd_(password), pct]);
    return { idVendedor: id, nombre: nombre, email: email, comisionDefecto: pct };
  });
}

/** Lista de vendedores (sin hashes). */
function getVendedores(token) {
  requireSession_(token, 'admin');
  return getTable_('Vendedores').map(v => ({
    idVendedor: String(v.ID_Vendedor),
    nombre: String(v.Nombre),
    email: String(v.Email),
    comisionDefecto: getPorcentajeDefecto_(v)
  }));
}

/* ====================== CONTRASEÑAS (8 NÚMEROS) ======================== */

function validarPassword_(p) {
  if (!/^\d{8}$/.test(String(p || ''))) throw new Error('La contraseña debe tener exactamente 8 números.');
}

function falloPassword_(cache, failKey) {
  cache.put(failKey, String(Number(cache.get(failKey) || 0) + 1), LOGIN_LOCK_SEC);
  throw new Error('La contraseña actual no es correcta.');
}

/** Cambia la contraseña del usuario en sesión (administrador o vendedor). */
function cambiarMiPassword(token, actual, nueva) {
  const user = requireSession_(token);
  validarPassword_(nueva);

  const cache = CacheService.getScriptCache();
  const failKey = 'fail:' + (user.rol === 'admin' ? 'admin' : String(user.email).trim().toLowerCase());
  if (Number(cache.get(failKey) || 0) >= MAX_LOGIN_FAILS) {
    throw new Error('Demasiados intentos fallidos. Inténtalo de nuevo en 15 minutos.');
  }

  const hashActual = hashPwd_(String(actual || ''));
  const hashNueva = hashPwd_(String(nueva));

  return withLock_(() => {
    if (user.rol === 'admin') {
      const stored = String(getConfig_().ADMIN_PASSWORD_HASH || '');
      if (!stored || !safeEq_(stored, hashActual)) falloPassword_(cache, failKey);
      guardarConfig_('ADMIN_PASSWORD_HASH', hashNueva);
    } else {
      const sh = getDb_().getSheetByName('Vendedores');
      const row = findRow_(sh, user.id);
      if (row < 0) throw new Error('Vendedor no encontrado.');
      const stored = String(sh.getRange(row, 4).getValue());
      if (!stored || !safeEq_(stored, hashActual)) falloPassword_(cache, failKey);
      sh.getRange(row, 4).setValue(hashNueva);
    }
    cache.remove(failKey);
    return true;
  });
}

/** El administrador restablece la contraseña de un vendedor. */
function resetPasswordVendedor(token, idVendedor, nueva) {
  requireSession_(token, 'admin');
  validarPassword_(nueva);
  return withLock_(() => {
    const sh = getDb_().getSheetByName('Vendedores');
    const row = findRow_(sh, idVendedor);
    if (row < 0) throw new Error('Vendedor no encontrado.');
    sh.getRange(row, 4).setValue(hashPwd_(String(nueva)));
    const email = String(sh.getRange(row, 3).getValue()).trim().toLowerCase();
    CacheService.getScriptCache().remove('fail:' + email); // desbloquea si estaba bloqueado
    return { idVendedor: String(idVendedor) };
  });
}

function guardarConfig_(key, value) {
  const sh = getDb_().getSheetByName('Configuracion');
  const last = sh.getLastRow();
  const keys = last > 1 ? sh.getRange(2, 1, last - 1, 1).getValues().flat() : [];
  const i = keys.indexOf(key);
  if (i === -1) sh.appendRow([key, value]);
  else sh.getRange(i + 2, 2).setValue(value);
  _cfgCache = null;
}

/* ============================ ARCHIVOS EN DRIVE ========================= */

/**
 * Decodifica Base64, valida el tipo REAL por firma binaria (no se confía en el mimeType
 * del cliente), lo guarda en la carpeta correcta y lo comparte por enlace.
 * Etiqueta: imagen → Fotos_Etiquetas, PDF → PDFs. Producto: solo imagen → Fotos_Productos.
 */
function saveFile_(f, baseName, tipo) {
  if (!f || !f.base64) {
    throw new Error(tipo === 'etiqueta' ? 'Falta la foto o PDF de la etiqueta.' : 'Falta la foto del producto.');
  }
  const b64 = String(f.base64).replace(/^data:[^;]+;base64,/, '').replace(/\s/g, '');
  if (Math.floor(b64.length * 3 / 4) > MAX_FILE_BYTES) {
    throw new Error('El archivo supera el tamaño máximo de 10 MB.');
  }

  let bytes;
  try { bytes = Utilities.base64Decode(b64); }
  catch (e) { throw new Error('El archivo está dañado o no tiene un formato válido.'); }

  const mime = sniffMime_(bytes);
  if (!mime) throw new Error('Formato no admitido. Usa JPG, PNG, WEBP, HEIC o PDF.');
  if (mime === 'application/pdf' && tipo !== 'etiqueta') {
    throw new Error('La foto del producto debe ser una imagen, no un PDF.');
  }

  const ext = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png',
                'image/webp': 'webp', 'image/heic': 'heic' }[mime];
  const blob = Utilities.newBlob(bytes, mime, baseName + '.' + ext);

  const folderKey = mime === 'application/pdf' ? 'FOLDER_ID_PDFS'
    : (tipo === 'etiqueta' ? 'FOLDER_ID_ETIQUETAS' : 'FOLDER_ID_PRODUCTOS');
  const file = DriveApp.getFolderById(getFolderId_(folderKey)).createFile(blob);

  try {
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  } catch (e) {
    console.warn('No se pudo compartir el archivo públicamente: ' + e.message);
  }
  return file;
}

function sniffMime_(b) {
  if (!b || b.length < 12) return null;
  const u = i => (b[i] & 0xff);
  if (u(0) === 0x25 && u(1) === 0x50 && u(2) === 0x44 && u(3) === 0x46) return 'application/pdf';
  if (u(0) === 0xff && u(1) === 0xd8 && u(2) === 0xff) return 'image/jpeg';
  if (u(0) === 0x89 && u(1) === 0x50 && u(2) === 0x4e && u(3) === 0x47) return 'image/png';
  if (u(0) === 0x52 && u(1) === 0x49 && u(2) === 0x46 && u(3) === 0x46 &&
      u(8) === 0x57 && u(9) === 0x45 && u(10) === 0x42 && u(11) === 0x50) return 'image/webp';
  if (u(4) === 0x66 && u(5) === 0x74 && u(6) === 0x79 && u(7) === 0x70) {
    const brand = String.fromCharCode(u(8), u(9), u(10), u(11));
    if (['heic', 'heix', 'hevc', 'heim', 'heis', 'mif1', 'msf1'].indexOf(brand) > -1) return 'image/heic';
  }
  return null;
}

function getFolderId_(key) {
  const id = PropertiesService.getScriptProperties().getProperty(key) || getConfig_()[key];
  if (!id) throw new Error('Carpeta de Drive no configurada (' + key + '). Ejecuta setupDatabase().');
  return String(id);
}

/** Miniatura incrustable en <img> a partir de la URL de Drive. */
function thumb_(url) {
  const m = String(url || '').match(/[-\w]{25,}/);
  return m ? 'https://drive.google.com/thumbnail?id=' + m[0] + '&sz=w800' : '';
}

/* ============================ ACCESO A DATOS ============================ */

let _ssCache = null;
let _cfgCache = null;
let _ventasOk = false;
let _contabOk = false;

function getDb_() {
  if (_ssCache) return _ssCache;
  const id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (!id) throw new Error('Base de datos no configurada. Ejecuta setupDatabase().');
  _ssCache = SpreadsheetApp.openById(id);
  return _ssCache;
}

/**
 * Devuelve la hoja Ventas garantizando que existen las 12 columnas y que la cabecera
 * coincide con VENTAS_COLS (repara la columna Costo_Producto si faltaba o tenía otro nombre).
 */
function getVentasSheet_() {
  const sh = getDb_().getSheetByName('Ventas');
  if (!sh) throw new Error('Falta la hoja "Ventas". Ejecuta setupDatabase().');
  if (_ventasOk) return sh;

  const n = VENTAS_COLS.length;
  if (sh.getMaxColumns() < n) sh.insertColumnsAfter(sh.getMaxColumns(), n - sh.getMaxColumns());

  const actual = sh.getRange(1, 1, 1, n).getValues()[0].map(x => String(x).trim());
  if (actual.join('|') !== VENTAS_COLS.join('|')) {
    sh.getRange(1, 1, 1, n).setValues([VENTAS_COLS]);
    // Copia el formato de la cabecera y de las celdas de la columna anterior
    sh.getRange(1, n - 1, 1, 1).copyTo(sh.getRange(1, n), SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false);
    sh.setColumnWidth(n, 130);
    const filas = sh.getMaxRows() - 1;
    if (filas > 0) sh.getRange(2, n, filas).setNumberFormat('#,##0.00 [$€-C0A]');
    SpreadsheetApp.flush();
  }
  _ventasOk = true;
  return sh;
}

/**
 * Devuelve la hoja Contabilidad; la crea (con cabecera y formato) si no existe
 * o repara la cabecera si no coincide con CONTAB_COLS.
 */
function getContabSheet_() {
  const ss = getDb_();
  let sh = ss.getSheetByName('Contabilidad');
  if (!sh) sh = ss.insertSheet('Contabilidad');
  if (_contabOk) return sh;

  const n = CONTAB_COLS.length;
  if (sh.getMaxColumns() < n) sh.insertColumnsAfter(sh.getMaxColumns(), n - sh.getMaxColumns());

  const actual = sh.getRange(1, 1, 1, n).getValues()[0].map(x => String(x).trim());
  if (actual.join('|') !== CONTAB_COLS.join('|')) {
    sh.getRange('A:C').setNumberFormat('@');   // Clave, ID y Mes como texto (evita que "2026-10" se convierta en fecha)
    sh.getRange(1, 1, 1, n).setValues([CONTAB_COLS])
      .setFontWeight('bold').setFontColor('#ffffff').setBackground('#6f42c1')
      .setHorizontalAlignment('center').setVerticalAlignment('middle');
    sh.setFrozenRows(1);
    sh.setTabColor('#6f42c1');
    [260, 130, 100, 120, 260, 90, 160, 130].forEach((w, i) => sh.setColumnWidth(i + 1, w));
    const filas = sh.getMaxRows() - 1;
    if (filas > 0) {
      sh.getRange(2, 4, filas).setNumberFormat('#,##0.00 [$€-C0A]');
      sh.getRange(2, 7, filas).setNumberFormat('dd/MM/yyyy HH:mm');
      sh.getRange(2, 8, filas).setNumberFormat('#,##0.00 [$€-C0A]');
    }
    SpreadsheetApp.flush();
  }
  _contabOk = true;
  return sh;
}

/** Añade una fila al final de la hoja (amplía la hoja si hace falta). */
function appendValues_(sh, values) {
  const r = sh.getLastRow() + 1;
  if (r > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), 100);
  sh.getRange(r, 1, 1, values.length).setValues([values]);
}

function getConfig_() {
  if (_cfgCache) return _cfgCache;
  const sh = getDb_().getSheetByName('Configuracion');
  const cfg = {};
  const last = sh.getLastRow();
  if (last > 1) {
    sh.getRange(2, 1, last - 1, 2).getValues().forEach(r => {
      if (r[0]) cfg[String(r[0]).trim()] = r[1];
    });
  }
  _cfgCache = cfg;
  return cfg;
}

/** Lee una hoja completa como array de objetos {Cabecera: valor}. (Vendedores, etc.) */
function getTable_(name) {
  const sh = getDb_().getSheetByName(name);
  if (!sh) throw new Error('Falta la hoja "' + name + '". Ejecuta setupDatabase().');
  const last = sh.getLastRow();
  if (last < 2) return [];
  const values = sh.getRange(1, 1, last, sh.getLastColumn()).getValues();
  const headers = values[0].map(h => String(h).trim());
  return values.slice(1)
    .filter(r => r[0] !== '' && r[0] !== null)
    .map(r => {
      const o = {};
      headers.forEach((h, i) => { o[h] = r[i]; });
      return o;
    });
}

/** Ventas leídas POR POSICIÓN (mismo orden que VENTAS_COLS, igual que se escriben). */
function getVentas_() {
  const sh = getVentasSheet_();
  const last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, VENTAS_COLS.length).getValues()
    .filter(r => r[0] !== '' && r[0] !== null)
    .map(r => rowToObj_(r));
}

function getVendedoresMap_() {
  const map = {};
  getTable_('Vendedores').forEach(v => { map[String(v.ID_Vendedor)] = String(v.Nombre); });
  return map;
}

function getPorcentajeDefecto_(vendedor) {
  const propio = parseNumber_(vendedor && vendedor.Comision_Defecto_Porcentaje);
  if (isFinite(propio) && propio >= 0 && propio <= 100) return propio;
  const global = parseNumber_(getConfig_().COMISION_DEFECTO_PORCENTAJE);
  return isFinite(global) && global >= 0 && global <= 100 ? global : COMISION_FALLBACK;
}

function findRow_(sheet, id) {
  const last = sheet.getLastRow();
  if (last < 2) return -1;
  const ids = sheet.getRange(2, 1, last - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(id)) return i + 2;
  }
  return -1;
}

function rowToObj_(arr) {
  const o = {};
  VENTAS_COLS.forEach((c, i) => { o[c] = arr[i]; });
  return o;
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  try { lock.waitLock(20000); }
  catch (e) { throw new Error('El sistema está ocupado. Inténtalo de nuevo en unos segundos.'); }
  try { return fn(); } finally { lock.releaseLock(); }
}

/* ======================= FILTROS, TOTALES Y DTO ========================= */

function filtrar_(ventas, f) {
  const norm = x => (isBlank_(x) || String(x).trim().toLowerCase() === 'todos') ? '' : String(x).trim();
  const idV = norm(f.idVendedor);
  const estado = norm(f.estado);
  const mes = norm(f.mes);
  const semana = norm(f.semana);

  if (estado && [ESTADO_PENDIENTE, ESTADO_CONFIRMADO].indexOf(estado) < 0) throw new Error('Estado no válido.');
  if (mes && !/^\d{4}-(0[1-9]|1[0-2])$/.test(mes)) throw new Error('Filtro de mes no válido (formato AAAA-MM).');
  if (semana && !/^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$/.test(semana)) throw new Error('Filtro de semana no válido (formato AAAA-Www).');

  return ventas.filter(v => {
    if (idV && String(v.ID_Vendedor) !== idV) return false;
    if (estado && String(v.Estado) !== estado) return false;
    if (mes || semana) {
      const d = v.Fecha_Venta;
      if (!(d instanceof Date)) return false;
      if (mes && Utilities.formatDate(d, TZ, 'yyyy-MM') !== mes) return false;
      if (semana && isoWeekKey_(d) !== semana) return false;
    }
    return true;
  });
}

/** Semana ISO 8601 ('2026-W41'), calculada en la zona horaria TZ. */
function isoWeekKey_(d) {
  const p = Utilities.formatDate(d, TZ, 'yyyy-M-d').split('-').map(Number);
  const dt = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
  dt.setUTCDate(dt.getUTCDate() - ((dt.getUTCDay() + 6) % 7) + 3); // jueves de esa semana
  const isoYear = dt.getUTCFullYear();
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const week = 1 + Math.round(((dt - jan4) / 86400000 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
  return isoYear + '-W' + ('0' + week).slice(-2);
}

/**
 * Totales. Con admin=true añade ingresos/costes/ganancia (solo ventas confirmadas)
 * y numSinCosto (ventas confirmadas cuyo coste no está registrado).
 */
function calcTotales_(ventas, admin) {
  const t = { numVentas: 0, numPendientes: 0, numConfirmadas: 0, totalVentas: 0,
              comisionConfirmada: 0, comisionPendiente: 0, comisionTotal: 0 };
  if (admin) { t.ingresosConfirmados = 0; t.costoConfirmado = 0; t.ganancia = 0; t.numSinCosto = 0; }
  ventas.forEach(v => {
    const precio = Number(v.Precio_Venta) || 0;
    const com = Number(v.Comision_Calculada) || 0;
    t.numVentas++;
    t.totalVentas += precio;
    if (v.Estado === ESTADO_CONFIRMADO) {
      t.numConfirmadas++; t.comisionConfirmada += com;
      if (admin) {
        t.ingresosConfirmados += precio;
        t.costoConfirmado += Number(v.Costo_Producto) || 0;
        if (isBlank_(v.Costo_Producto)) t.numSinCosto++;
      }
    } else {
      t.numPendientes++; t.comisionPendiente += com;
    }
  });
  t.comisionTotal = t.comisionConfirmada + t.comisionPendiente;
  if (admin) t.ganancia = t.ingresosConfirmados - t.costoConfirmado - t.comisionConfirmada;
  Object.keys(t).forEach(k => {
    if (/^(totalVentas|comision|ingresos|costo|ganancia)/.test(k)) t[k] = round2_(t[k]);
  });
  return t;
}

function toDto_(v, vendMap, incluirCosto) {
  const iso = x => x instanceof Date ? Utilities.formatDate(x, TZ, "yyyy-MM-dd'T'HH:mm:ss") : '';
  const dto = {
    idVenta: String(v.ID_Venta),
    idVendedor: String(v.ID_Vendedor),
    nombreVendedor: (vendMap && vendMap[String(v.ID_Vendedor)]) || '',
    fechaVenta: v.Fecha_Venta instanceof Date ? Utilities.formatDate(v.Fecha_Venta, TZ, 'yyyy-MM-dd') : '',
    producto: String(v.Producto || ''),
    precioVenta: Number(v.Precio_Venta) || 0,
    urlFotoEtiqueta: String(v.URL_Foto_Etiqueta || ''),
    urlFotoProducto: String(v.URL_Foto_Producto || ''),
    thumbEtiqueta: thumb_(v.URL_Foto_Etiqueta),
    thumbProducto: thumb_(v.URL_Foto_Producto),
    estado: String(v.Estado || ''),
    porcentajeComision: Number(v.Porcentaje_Comision) || 0,
    comisionCalculada: Number(v.Comision_Calculada) || 0,
    fechaConfirmacion: iso(v.Fecha_Confirmacion)
  };
  if (incluirCosto) dto.costoProducto = isBlank_(v.Costo_Producto) ? null : Number(v.Costo_Producto);
  return dto;
}

/* ============================== UTILIDADES ============================== */

function hashPwd_(password) {
  const salt = String(getConfig_().PASSWORD_SALT || '');
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + password, Utilities.Charset.UTF_8);
  return bytes.map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
}

function safeEq_(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function isBlank_(x) {
  return x === null || x === undefined || String(x).trim() === '';
}

function round2_(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

function time_(d) {
  return d instanceof Date ? d.getTime() : 0;
}

/** Acepta 1234.56 / "1234,56" / "1.234,56" / "12 €". Devuelve NaN si no es válido. */
function parseNumber_(x) {
  if (typeof x === 'number') return x;
  let s = String(x === null || x === undefined ? '' : x).replace(/[\s€%]/g, '');
  if (!s) return NaN;
  if (s.indexOf(',') > -1 && s.indexOf('.') > -1) s = s.replace(/\./g, '').replace(',', '.');
  else s = s.replace(',', '.');
  return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : NaN;
}

/** Fecha 'yyyy-MM-dd' o 'dd/MM/yyyy' → Date a las 12:00 (evita saltos por zona horaria). */
function parseFecha_(s) {
  const str = String(s || '').trim();
  let y, m, d, mt;
  if ((mt = str.match(/^(\d{4})-(\d{2})-(\d{2})$/))) { y = +mt[1]; m = +mt[2]; d = +mt[3]; }
  else if ((mt = str.match(/^(\d{2})\/(\d{2})\/(\d{4})$/))) { d = +mt[1]; m = +mt[2]; y = +mt[3]; }
  else throw new Error('La fecha de venta no es válida.');
  const date = new Date(y, m - 1, d, 12, 0, 0);
  if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d || y < 2000) {
    throw new Error('La fecha de venta no es válida.');
  }
  return date;
}

/** Recorta, limita longitud y neutraliza inyección de fórmulas en Sheets. */
function cleanText_(x, max) {
  let s = String(x === null || x === undefined ? '' : x).replace(/[\u0000-\u001f]/g, ' ').trim();
  if (s.length > max) s = s.slice(0, max);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}