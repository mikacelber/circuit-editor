#!/usr/bin/env node
/* Builds library/library.json from a folder of components and models.

   A browser cannot list a directory, so a SERVED library needs an index.
   This walks the folder, keeps whatever an existing library.json already
   said (descriptions, parameters, hand-picked model paths) and fills in
   every model file it finds:

       <part number>.pdf      → datasheet
       <part number>.SchLib   → symbol
       <part number>.PcbLib   → footprint
       <part number>.lib|.mod|.sub|.cir|.asy → spice

   Files sitting in a subfolder take that folder's name as their category,
   and a per-component JSON (one file per part) is read as well.

       node tools/build-library-index.js [libraryDir]                     */
'use strict';
const fs = require('fs'), path = require('path');

const SLOTS = [
  { id:'datasheet', ext:['.pdf'] },
  { id:'symbol',    ext:['.schlib', '.schdoc'] },
  { id:'footprint', ext:['.pcblib', '.pcbdoc'] },
  { id:'spice',     ext:['.lib', '.mod', '.sub', '.cir', '.asy', '.net', '.sp'] },
];
const root = process.argv[2] || path.join(__dirname, '..', 'library');
const indexPath = path.join(root, 'library.json');
if (!fs.existsSync(root)){ console.error('no such folder: ' + root); process.exit(1); }

/* whatever the index already says, keyed by part number */
const byPn = new Map();
let libName = path.basename(root);
const keep = file => {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (j.name && file === indexPath) libName = j.name;
    const list = Array.isArray(j) ? j : (j.components || j.parts || (j.part_number || j.partNumber ? [j] : []));
    for (const c of list){
      const pn = String(c.part_number || c.partNumber || c.mpn || '').trim();
      if (!pn) continue;
      const old = byPn.get(pn) || {};
      byPn.set(pn, { ...old, ...c, part_number:pn,
                     parameters:{ ...(old.parameters || {}), ...(c.parameters || c.params || {}) },
                     models:{ ...(old.models || {}), ...(c.models || {}) } });
    }
  } catch (e){ console.warn('skipping ' + path.relative(root, file) + ': ' + e.message); }
};

const walk = dir => fs.readdirSync(dir, { withFileTypes:true }).flatMap(d => {
  const full = path.join(dir, d.name);
  return d.isDirectory() ? walk(full) : [full];
});
const files = walk(root);
for (const f of files) if (f.endsWith('.json')) keep(f);

let attached = 0;
for (const f of files){
  const ext = path.extname(f).toLowerCase();
  const slot = SLOTS.find(s => s.ext.includes(ext));
  if (!slot) continue;
  const stem = path.basename(f, path.extname(f));
  const rel = path.relative(root, f).split(path.sep).join('/');
  let c = byPn.get(stem);
  if (!c){
    // a model file whose name is not in the index yet is a component of its own
    const dir = path.dirname(rel).split('/').pop();
    c = { part_number:stem, parameters:{}, models:{} };
    if (dir && dir !== '.' && dir !== 'models') c.category = dir;
    byPn.set(stem, c);
  }
  c.models = c.models || {};
  if (!c.models[slot.id]){ c.models[slot.id] = rel; attached++; }
}

const components = [...byPn.values()]
  .sort((a, b) => String(a.part_number).localeCompare(String(b.part_number), undefined, { numeric:true }));
fs.writeFileSync(indexPath, JSON.stringify({
  format:'circuit-editor/component-library/1', name:libName,
  generated:new Date().toISOString(), components,
}, null, 2) + '\n');
console.log(components.length + ' components (' + attached + ' model files attached) → ' + indexPath);
