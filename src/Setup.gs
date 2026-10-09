/**
 * CONFIGURACIÓN INICIAL – Gestión de Ventas y Comisiones
 * Ejecutar setupDatabase() una sola vez (es idempotente: se puede relanzar sin perder datos).
 * La hoja "Contabilidad" también se crea sola desde la web app si no existe.
 */

const DB_NAME = 'Gestión de Ventas - Base de datos';
const ROOT_FOLDER_NAME = 'Gestión de Ventas';
const SUBFOLDERS = {
  FOLDER_ID_ETIQUETAS: 'Fotos_Etiquetas',
  FOLDER_ID_PRODUCTOS: 'Fotos_Productos',
  FOLDER_ID_PDFS: 'PDFs'
};

const SCHEMA = {
  Vendedores: {
    color: '#1a73e8',
    headers: ['ID_Vendedor', 'Nombre', 'Email', 'Password_Hash', 'Comision_Defecto_Porcentaje']
  },
  Ventas: {
    color: '#188038',
    headers: ['ID_Venta', 'ID_Vendedor', 'Fecha_Venta', 'Producto', 'Precio_Venta',
              'URL_Foto_Etiqueta', 'URL_Foto_Producto', 'Estado', 'Porcentaje_Comision',
              'Comision_Calculada', 'Fecha_Confirmacion', 'Costo_Producto']
  },
  Contabilidad: {
    color: '#6f42c1',
    headers: ['Clave', 'ID_Vendedor', 'Mes', 'Ajuste', 'Nota', 'Pagado', 'Fecha_Pago', 'Importe_Saldado']
  },
  Configuracion: {
    color: '#e37400',
    headers: ['Clave', 'Valor']
  }
};

function setupDatabase() {
  const ss = getOrCreateSpreadsheet_();

  // 1. Hojas
  Object.keys(SCHEMA).forEach(name => setupSheet_(ss, name, SCHEMA[name]));
  formatVendedores_(ss.getSheetByName('Vendedores'));
  formatVentas_(ss.getSheetByName('Ventas'));
  formatContabilidad_(ss.getSheetByName('Contabilidad'));
  formatConfiguracion_(ss.getSheetByName('Configuracion'));

  // Elimina la hoja por defecto vacía (Hoja 1 / Sheet1 / Foglio1)
  ['Hoja 1', 'Sheet1', 'Foglio1', 'Hoja1'].forEach(n => {
    const s = ss.getSheetByName(n);
    if (s && ss.getSheets().length > 1 && s.getLastRow() <= 1 && s.getLastColumn() <= 1) ss.deleteSheet(s);
  });

  // 2. Carpetas en Drive
  const root = getOrCreateFolder_(DriveApp.getRootFolder(), ROOT_FOLDER_NAME);
  const config = { FOLDER_ID_RAIZ: root.getId() };
  Object.keys(SUBFOLDERS).forEach(key => {
    config[key] = getOrCreateFolder_(root, SUBFOLDERS[key]).getId();
  });

  // 3. Valores iniciales de configuración (no sobrescribe los existentes)
  const cfg = ss.getSheetByName('Configuracion');
  seedConfig_(cfg, 'ADMIN_PASSWORD_HASH', '');
  seedConfig_(cfg, 'PASSWORD_SALT', Utilities.getUuid());
  seedConfig_(cfg, 'COMISION_DEFECTO_PORCENTAJE', 50);
  seedConfig_(cfg, 'SPREADSHEET_ID', ss.getId());
  Object.keys(config).forEach(k => seedConfig_(cfg, k, config[k]));

  // Copia en Script Properties para lectura rápida desde la web app
  PropertiesService.getScriptProperties().setProperties(
    Object.assign({ SPREADSHEET_ID: ss.getId() }, config), false);

  SpreadsheetApp.flush();
  Logger.log('✅ Base de datos lista: ' + ss.getUrl());
  Logger.log('✅ Carpeta raíz en Drive: ' + root.getUrl());
}

/** Establece la contraseña de administrador. Uso: editar el texto y ejecutar una vez. */
function setAdminPassword() {
  const NUEVA_PASSWORD = '00000000'; // <-- cámbiala y ejecuta la función
  const ss = getOrCreateSpreadsheet_();
  const cfg = ss.getSheetByName('Configuracion');
  upsertConfig_(cfg, 'ADMIN_PASSWORD_HASH', hashPassword_(NUEVA_PASSWORD));
  Logger.log('Contraseña de administrador actualizada.');
}

/** SHA-256 con salt (la misma función se usará para los vendedores). */
function hashPassword_(password) {
  const cfg = getOrCreateSpreadsheet_().getSheetByName('Configuracion');
  const salt = getConfigValue_(cfg, 'PASSWORD_SALT') || '';
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + password, Utilities.Charset.UTF_8);
  return bytes.map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
}

/* ----------------------------- Helpers ----------------------------- */

function getOrCreateSpreadsheet_() {
  const active = SpreadsheetApp.getActiveSpreadsheet();
  if (active) return active;
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('SPREADSHEET_ID');
  if (id) {
    try { return SpreadsheetApp.openById(id); } catch (e) { /* se recrea */ }
  }
  const ss = SpreadsheetApp.create(DB_NAME);
  props.setProperty('SPREADSHEET_ID', ss.getId());
  return ss;
}

function getOrCreateFolder_(parent, name) {
  const it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

function setupSheet_(ss, name, def) {
  const sheet = ss.getSheetByName(name) || ss.insertSheet(name);
  const n = def.headers.length;
  // Si la hoja tiene menos columnas de las necesarias, las añade
  if (sheet.getMaxColumns() < n) sheet.insertColumnsAfter(sheet.getMaxColumns(), n - sheet.getMaxColumns());
  // Claves y meses como texto antes de escribir (evita conversiones a fecha)
  if (name === 'Contabilidad') sheet.getRange('A:C').setNumberFormat('@');
  const header = sheet.getRange(1, 1, 1, n);
  header.setValues([def.headers])
        .setFontWeight('bold').setFontColor('#ffffff')
        .setBackground(def.color)
        .setHorizontalAlignment('center').setVerticalAlignment('middle');
  sheet.setFrozenRows(1);
  sheet.setRowHeight(1, 32);
  sheet.setTabColor(def.color);
  // Mantiene solo las columnas necesarias
  if (sheet.getMaxColumns() > n) sheet.deleteColumns(n + 1, sheet.getMaxColumns() - n);
  return sheet;
}

function formatVendedores_(sh) {
  sh.setColumnWidths(1, 1, 130); sh.setColumnWidth(2, 200); sh.setColumnWidth(3, 240);
  sh.setColumnWidth(4, 280); sh.setColumnWidth(5, 210);
  sh.getRange('A:A').setNumberFormat('@');
  sh.getRange('D:D').setNumberFormat('@');
  sh.getRange(2, 5, sh.getMaxRows() - 1).setNumberFormat('0.##"%"')
    .setDataValidation(SpreadsheetApp.newDataValidation()
      .requireNumberBetween(0, 100).setAllowInvalid(false)
      .setHelpText('Introduce un porcentaje entre 0 y 100 (por defecto 50).').build());
  addBanding_(sh);
}

function formatVentas_(sh) {
  const widths = [130, 130, 120, 220, 110, 260, 260, 120, 140, 140, 160, 130];
  widths.forEach((w, i) => sh.setColumnWidth(i + 1, w));
  const rows = sh.getMaxRows() - 1;
  sh.getRange('A:B').setNumberFormat('@');
  sh.getRange(2, 3, rows).setNumberFormat('dd/MM/yyyy');
  sh.getRange(2, 5, rows).setNumberFormat('#,##0.00 [$€-C0A]');
  sh.getRange(2, 9, rows).setNumberFormat('0.##"%"');
  sh.getRange(2, 10, rows).setNumberFormat('#,##0.00 [$€-C0A]');
  sh.getRange(2, 11, rows).setNumberFormat('dd/MM/yyyy HH:mm');
  sh.getRange(2, 12, rows).setNumberFormat('#,##0.00 [$€-C0A]');

  // Lista desplegable de Estado
  sh.getRange(2, 8, rows).setDataValidation(SpreadsheetApp.newDataValidation()
    .requireValueInList(['Pendiente', 'Confirmado'], true).setAllowInvalid(false).build());

  // Colores condicionales
  const estadoRange = sh.getRange(2, 8, rows);
  sh.setConditionalFormatRules([
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('Pendiente')
      .setBackground('#fff4ce').setFontColor('#8a5a00').setRanges([estadoRange]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('Confirmado')
      .setBackground('#d9f2e1').setFontColor('#0b6b2e').setRanges([estadoRange]).build()
  ]);
  addBanding_(sh);
}

function formatContabilidad_(sh) {
  [260, 130, 100, 120, 260, 90, 160, 130].forEach((w, i) => sh.setColumnWidth(i + 1, w));
  sh.getRange('A:C').setNumberFormat('@');
  const rows = sh.getMaxRows() - 1;
  sh.getRange(2, 4, rows).setNumberFormat('#,##0.00 [$€-C0A]');
  sh.getRange(2, 7, rows).setNumberFormat('dd/MM/yyyy HH:mm');
  sh.getRange(2, 8, rows).setNumberFormat('#,##0.00 [$€-C0A]');
  addBanding_(sh);
}

function formatConfiguracion_(sh) {
  sh.setColumnWidth(1, 260); sh.setColumnWidth(2, 460);
  sh.getRange('A:B').setNumberFormat('@');
}

function addBanding_(sh) {
  if (sh.getBandings().length) return;
  const range = sh.getRange(1, 1, sh.getMaxRows(), sh.getMaxColumns());
  range.applyRowBanding(SpreadsheetApp.BandingTheme.LIGHT_GREY, true, false);
}

function getConfigValue_(sh, key) {
  const last = sh.getLastRow();
  if (last < 2) return null;
  const data = sh.getRange(2, 1, last - 1, 2).getValues();
  const row = data.find(r => r[0] === key);
  return row ? row[1] : null;
}

function seedConfig_(sh, key, value) {
  const last = sh.getLastRow();
  const keys = last > 1 ? sh.getRange(2, 1, last - 1, 1).getValues().flat() : [];
  if (keys.indexOf(key) === -1) sh.appendRow([key, value]);
}

function upsertConfig_(sh, key, value) {
  const last = sh.getLastRow();
  const keys = last > 1 ? sh.getRange(2, 1, last - 1, 1).getValues().flat() : [];
  const idx = keys.indexOf(key);
  if (idx === -1) sh.appendRow([key, value]);
  else sh.getRange(idx + 2, 2).setValue(value);
}