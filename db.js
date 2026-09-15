/* ==================================================================
   db.js — the component database (GPN datasheet extracts).

   Layout on disk, exactly as the extraction pipeline writes it:
       db/approved/<GPN>__<PN>__<sha>.json
       db/drafts/<GPN>__<PN>__<sha>.json
       db/figures/<GPN>/<figure>.png
   A browser cannot list a directory, so the app reads db/index.json
   (regenerate it with tools/build-db-index.js) and falls back to
   "Load files…", which parses the JSONs straight off the user's disk.
   ================================================================== */
'use strict';

const DB = {
  base: (() => { try { return localStorage.getItem('db_base') || 'db/'; } catch(e){ return 'db/'; } })(),
  records: [],                 // [{gpn, part_numbers, status, path, facts, ...}]
  byPn: new Map(),             // normalized part number → record
  loaded: false, error: null,

  setBase(b){
    this.base = b.endsWith('/') ? b : b + '/';
    try { localStorage.setItem('db_base', this.base); } catch(e){}
  },

  /* index.json is either {files:[…]} or a bare array; entries are paths or
     objects carrying the part numbers, so the index alone can answer a match
     and only the chosen record is fetched in full. */
  async loadIndex(){
    this.error = null;
    try {
      const res = await fetch(this.base + 'index.json', { cache:'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const raw = await res.json();
      const list = Array.isArray(raw) ? raw : (raw.files || raw.records || []);
      for (const it of list){
        const entry = typeof it === 'string' ? { path: it } : { ...it };
        entry.path = entry.path || entry.file || '';
        const base = entry.path.split('/').pop() || '';
        const bits = base.replace(/\.json$/i, '').split('__');
        entry.gpn = entry.gpn || bits[0] || base;
        entry.part_numbers = entry.part_numbers || (bits[1] ? [bits[1]] : []);
        entry.status = entry.status || (/drafts?\//.test(entry.path) ? 'draft' : 'approved');
        this.add(entry);
      }
      this.loaded = true;
      return this.records.length;
    } catch (e){
      this.error = e.message;
      return 0;
    }
  },

  /* Files picked by hand: parsed here and there, no server involved. */
  async loadFiles(fileList){
    let n = 0;
    for (const f of fileList){
      try {
        const rec = JSON.parse(await f.text());
        rec.path = f.name; rec.status = /draft/i.test(f.name) ? 'draft' : (rec.status || 'approved');
        this.add(rec); n++;
      } catch (e){ /* skip anything that is not one of ours */ }
    }
    this.loaded = this.loaded || n > 0;
    return n;
  },

  add(rec){
    const gpn = String(rec.gpn || '').toUpperCase();
    const pns = (rec.part_numbers && rec.part_numbers.length ? rec.part_numbers
                : (rec.facts && rec.facts.identity && rec.facts.identity.part_numbers) || []).map(String);
    const old = this.records.find(r => r.path === rec.path || (r.gpn === gpn && r.path === rec.path));
    if (old) Object.assign(old, rec); else this.records.push(rec);
    for (const pn of [gpn, ...pns]) if (pn) this.byPn.set(normPn(pn), rec);
  },

  /* Full record, fetched on demand when the index only carried the summary. */
  async fetchRecord(rec){
    if (rec.facts || !rec.path) return rec;
    const url = /^https?:|^\//.test(rec.path) ? rec.path : this.base + rec.path;
    const res = await fetch(url, { cache:'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + url);
    Object.assign(rec, await res.json());
    this.add(rec);
    return rec;
  },

  /* The datasheet behind a part number: exact first, then the GPN family
     ("BQ24075-Q1" → "BQ24075", "TPS7A20185PDBVR" → "TPS7A20"). */
  match(partNumber){
    const k = normPn(partNumber);
    if (!k) return null;
    if (this.byPn.has(k)) return this.byPn.get(k);
    let best = null;
    for (const [pn, rec] of this.byPn){
      if (pn.length < 5) continue;
      if (k.startsWith(pn) || pn.startsWith(k)){
        const score = Math.min(pn.length, k.length);
        if (!best || score > best.score) best = { rec, score };
      }
    }
    return best ? best.rec : null;
  },

  figureURL(rec, fig){
    if (fig.image_url) return fig.image_url;
    if (fig.file) return this.base + 'figures/' + (rec.gpn || '') + '/' + fig.file;
    return null;
  },
};
const normPn = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/* ------------------------------------------------------------------
   The datasheet's "external_components" list is a design rule: those
   parts MUST exist around the IC. This walks the imported netlist and
   reports which of them are actually there.
   ------------------------------------------------------------------ */
function requiredExternalsReport(rec, part, S){
  const out = [];
  const req = (rec.facts && rec.facts.external_components) || [];
  if (!req.length || !S.netlist) return out;
  const pinout = (rec.facts && rec.facts.pinout) || [];
  const pinNumberOf = name => {
    const hit = pinout.find(p => String(p.name).toUpperCase() === String(name).toUpperCase());
    return hit ? String(hit.pin) : null;
  };
  const ref = (part.ref || '').toUpperCase();
  const netOfPin = pinName => {
    const num = pinNumberOf(pinName);
    const node = num ? ref + '-' + num : null;
    let net = node && S.netlist.nets.find(n => n.nodes.includes(node));
    if (!net && pinName) net = S.netlist.nets.find(n => n.name.toUpperCase() === String(pinName).toUpperCase());
    return net || null;
  };
  const typeMatches = (comp, type) => {
    const pn = String(comp.partNumber || '').toLowerCase(), r = (comp.ref || '')[0];
    if (/^c$/i.test(type)) return pn.includes('capacitor') || r === 'C';
    if (/^r$/i.test(type)) return pn.includes('resistor') || r === 'R';
    if (/^l$/i.test(type)) return pn.includes('inductor') || r === 'L';
    if (/fet|mos/i.test(type)) return /mosfet|fet/.test(pn) || r === 'Q';
    if (/^d/i.test(type)) return pn.includes('diode') || r === 'D';
    return true;
  };
  const candidatesOn = net => (net ? [...new Set(net.nodes.map(nodeRef))] : []).filter(x => x !== ref)
    .map(x => S.netlist.components.find(c => c.ref === x)).filter(Boolean);
  for (const r of req){
    const a = netOfPin(r.from_pin_name), b = netOfPin(r.to_pin_name);
    let found = null, partial = null;
    if (a && b){
      const refsB = new Set(b.nodes.map(nodeRef));
      for (const comp of candidatesOn(a))
        if (refsB.has(comp.ref) && typeMatches(comp, r.type)){ found = comp; break; }
    }
    // Datasheets name the far end after a NODE ("VBAT", "PACK_NEG") as often as
    // after a pin. When only the IC side resolves, a part of the right type
    // hanging off that pin is reported as a probable — never as a fact.
    if (!found){
      const side = a || b;
      partial = candidatesOn(side).find(c => typeMatches(c, r.type)) || null;
    }
    out.push({
      req: r, found: found || partial, probable: !found && !!partial,
      nets: [a && a.name, b && b.name],
      state: found ? 'present' : partial ? 'probable' : (r.mandatory ? 'missing' : 'optional'),
    });
  }
  return out;
}

if (typeof module !== 'undefined') module.exports = { DB, normPn, requiredExternalsReport };
