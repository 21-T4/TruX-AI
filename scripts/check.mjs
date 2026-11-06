// Build-time sanity checks: syntax of every server/client script, the
// lock file matching package.json, and every asset index.html references.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';

const failures = [];
const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);

for (const file of walk('server').filter(f => f.endsWith('.js'))) {
  try { execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' }); }
  catch (error) { failures.push(file + ': ' + String(error.stderr || error.message).split('\n').slice(0, 5).join(' ')); }
}
for (const file of walk('public').filter(f => f.endsWith('.js'))) {
  try { new vm.Script(fs.readFileSync(file, 'utf8'), { filename: file }); }
  catch (error) { failures.push(file + ': ' + error.message); }
}

const html = fs.readFileSync('public/index.html', 'utf8');
[...html.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].forEach((m, i) => {
  try { new vm.Script(m[1], { filename: 'index.html:inline-' + (i + 1) }); } catch (error) { failures.push('inline script ' + (i + 1) + ': ' + error.message); }
});
for (const m of html.matchAll(/(?:src|href)="(\/[^"?#]+)"/g)) {
  if (m[1].startsWith('/download/')) continue; // server redirects
  if (!fs.existsSync(path.join('public', m[1]))) failures.push('index.html references missing ' + m[1]);
}

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));
const locked = lock.packages?.['']?.dependencies || {};
for (const [name, range] of Object.entries(pkg.dependencies || {})) if (locked[name] !== range) failures.push('package-lock mismatch for ' + name);
if (Object.keys(locked).length !== Object.keys(pkg.dependencies || {}).length) failures.push('package-lock dependency set differs');

const manifest = JSON.parse(fs.readFileSync('public/manifest.json', 'utf8'));
for (const icon of manifest.icons || []) if (!fs.existsSync(path.join('public', icon.src))) failures.push('missing manifest icon ' + icon.src);
JSON.parse(fs.readFileSync('database.rules.json', 'utf8'));

if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
console.log('All checks passed.');
