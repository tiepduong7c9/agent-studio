// Vendors VS Code's leaf IPC layer (vs/base/parts/ipc + its vs/base/common
// transitive closure) from the reference checkout in ../../vscode into
// engine/src/vendor/vs. These files depend only on vs/base/common (verified:
// zero escapes into vs/platform), so they port like the vs/base widgets the
// renderer already reuses. Re-run this to re-sync when the checkout updates.
//
//   node scripts/vendor-vscode.mjs
//
// Provenance only — the copied files ARE committed so the engine builds without
// the vscode/ checkout present.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const vscodeRoot = path.join(repoRoot, 'vscode');
const outRoot = path.resolve(here, '..', 'src', 'vendor');

// Entry files whose import closure we vendor.
const ENTRIES = [
  'src/vs/base/parts/ipc/common/ipc.ts',
  'src/vs/base/parts/ipc/common/ipc.net.ts',
  'src/vs/base/parts/ipc/node/ipc.net.ts',
];

function resolveImport(fromFile, spec) {
  if (!spec.startsWith('.')) return null; // node builtin or bare package
  let p = path.normalize(path.join(path.dirname(fromFile), spec));
  if (p.endsWith('.js')) p = p.slice(0, -3) + '.ts';
  else if (!p.endsWith('.ts')) p += '.ts';
  return p;
}

const closure = new Set();
function trace(relFile) {
  if (closure.has(relFile)) return;
  const abs = path.join(vscodeRoot, relFile);
  if (!fs.existsSync(abs)) {
    console.warn('  ! missing (skipped):', relFile);
    return;
  }
  closure.add(relFile);
  const src = fs.readFileSync(abs, 'utf8');
  const re = /from\s+'([^']+)'/g;
  let m;
  while ((m = re.exec(src))) {
    const r = resolveImport(relFile, m[1]);
    if (r) trace(r);
  }
}

console.log('Tracing import closure from IPC entry points...');
ENTRIES.forEach(trace);

// Copy preserving the path under src/ (so relative .js imports still resolve).
let copied = 0;
for (const relFile of closure) {
  const rel = relFile.replace(/^src\//, ''); // e.g. vs/base/common/event.ts
  const dest = path.join(outRoot, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(path.join(vscodeRoot, relFile), dest);
  copied++;
}

console.log(`Vendored ${copied} files -> ${path.relative(repoRoot, outRoot)}/vs`);
