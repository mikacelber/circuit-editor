#!/usr/bin/env node
/* Builds db/index.json from db/approved and db/drafts.
   A browser cannot list a directory, so the editor reads this index and
   fetches each record only when it is opened.
       node tools/build-db-index.js [dbDir]                               */
'use strict';
const fs = require('fs'), path = require('path');
const root = process.argv[2] || path.join(__dirname, '..', 'db');
const files = [];
for (const status of ['approved', 'drafts']){
  const dir = path.join(root, status);
  if (!fs.existsSync(dir)) continue;
  for (const name of fs.readdirSync(dir).filter(f => f.endsWith('.json'))){
    const rel = status + '/' + name;
    let gpn = name.split('__')[0], pns = [], manufacturer = '', description = '';
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      gpn = j.gpn || gpn;
      pns = j.part_numbers || (j.facts && j.facts.identity && j.facts.identity.part_numbers) || [];
      manufacturer = j.manufacturer || '';
      description = (j.facts && j.facts.identity && j.facts.identity.description || '').slice(0, 160);
    } catch (e){ console.warn('skipping', rel, e.message); continue; }
    files.push({ path: rel, gpn, part_numbers: pns, status: status === 'drafts' ? 'draft' : 'approved', manufacturer, description });
  }
}
files.sort((a, b) => a.gpn.localeCompare(b.gpn));
fs.writeFileSync(path.join(root, 'index.json'), JSON.stringify({ generated:new Date().toISOString(), files }, null, 2));
console.log(files.length + ' records → ' + path.join(root, 'index.json'));
