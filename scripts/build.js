// Bündelt die App in eine einzige HTML-Datei (dist/forex-signal-ai.html),
// die man ohne Server per Doppelklick öffnen kann.
//   node scripts/build.js            -> vollständiges HTML-Dokument
//   node scripts/build.js --fragment -> nur Inhalt (ohne <html>/<head>/<body>)
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const fragment = process.argv.includes('--fragment');
const out = process.argv.find((a) => a.startsWith('--out='));

const html = read('index.html');
const head = html.match(/<head>([\s\S]*)<\/head>/)[1];
let body = html.match(/<body>([\s\S]*)<\/body>/)[1];

const css = read('css/style.css');
const scripts = [...body.matchAll(/<script src="(js\/[^"]+)"><\/script>\n?/g)].map((m) => m[1]);
body = body.replace(/\s*<script src="js\/[^"]+"><\/script>/g, '');
const js = scripts.map((f) => `// ---- ${f}\n${read(f)}`).join('\n');

const headInline = head
  .replace(/<link rel="stylesheet" href="css\/style.css">/, `<style>\n${css}</style>`)
  .replace(/^\s*<meta[^>]*>\n/gm, fragment ? '' : '$&');

const content = `${headInline.trim()}\n${body.trim()}\n<script>\n${js}</script>\n`;
const result = fragment
  ? content
  : `<!doctype html>\n<html lang="de">\n<head>\n${headInline.trim()}\n</head>\n<body>\n${body.trim()}\n<script>\n${js}</script>\n</body>\n</html>\n`;

const file = out ? out.slice(6) : path.join(root, 'dist', 'forex-signal-ai.html');
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, result);
console.log(`geschrieben: ${file} (${(result.length / 1024).toFixed(0)} KB)`);
