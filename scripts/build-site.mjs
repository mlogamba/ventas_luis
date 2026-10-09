// Genera la cartella _site/ (GitHub Pages) a partire da src/Index.html + web/.
// Uso: GAS_WEBAPP_URL="https://script.google.com/macros/s/XXXX/exec" node scripts/build-site.mjs
import { readFileSync, writeFileSync, mkdirSync, cpSync, rmSync } from 'node:fs';

const url = (process.env.GAS_WEBAPP_URL || '').trim();
if (!/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(url)) {
  console.error('GAS_WEBAPP_URL mancante o non valido (deve finire in /exec).');
  process.exit(1);
}
const build = process.env.GITHUB_SHA ? process.env.GITHUB_SHA.slice(0, 7) : String(Date.now());

rmSync('_site', { recursive: true, force: true });
mkdirSync('_site', { recursive: true });
cpSync('web/icons', '_site/icons', { recursive: true });
cpSync('web/manifest.webmanifest', '_site/manifest.webmanifest');
writeFileSync('_site/sw.js', readFileSync('web/sw.js', 'utf8').replace('__BUILD__', build));

let html = readFileSync('src/Index.html', 'utf8');

const head = `
  <meta name="theme-color" content="#212529">
  <meta name="mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-title" content="Ventas">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <link rel="manifest" href="manifest.webmanifest">
  <link rel="icon" type="image/png" sizes="32x32" href="icons/favicon-32.png">
  <link rel="apple-touch-icon" href="icons/apple-touch-icon.png">
  <style>body{padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)}</style>
  <script>window.APP_API_URL=${JSON.stringify(url)};</script>
`;
const sw = `
<script>
if ('serviceWorker' in navigator) {
  window.addEventListener('load', function () { navigator.serviceWorker.register('sw.js').catch(function () {}); });
}
</script>
`;

if (!html.includes('</head>') || !html.includes('</body>')) { console.error('Index.html non valido.'); process.exit(1); }
html = html
  .replace('content="width=device-width, initial-scale=1"', 'content="width=device-width, initial-scale=1, viewport-fit=cover"')
  .replace('</head>', head + '</head>')
  .replace('</body>', sw + '</body>');

writeFileSync('_site/index.html', html);
writeFileSync('_site/.nojekyll', '');
console.log('Sito generato in _site/ (build ' + build + ')');
