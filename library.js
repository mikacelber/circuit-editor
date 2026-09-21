/* ==================================================================
   library.js — the component library.

   A library is an open-ended list of components. Each one is:

       part_number            the identity, and all that is required
       parameters{}           whatever the designer wants to record
       models{}               four optional attachments:
           datasheet          the PDF
           symbol             the Altium schematic symbol (.SchLib)
           footprint          the Altium footprint (.PcbLib)
           spice              the LTspice model (.lib/.mod/.sub/.asy)

   Where it comes from is a SOURCE, and the three kinds share one
   interface so a cloud repository drops straight in later:

       files    picked off a local disk (a folder or a handful of files);
                the models are read as blobs, nothing is fetched
       folder   a served directory holding library.json next to its models
       remote   a URL — a raw repository, an API, a cloud service. Adapters
                register themselves in LIB.adapters, so a future backend is
                a `LIB.registerAdapter('nexo-cloud', {load})` away.

   The symbol the editor draws comes from altium.js: the .SchLib is
   parsed into an IR and converted into a symbols.js def. While that
   parser is a placeholder the component still places — with a body
   generated from its pin list — and the panel says why.
   ================================================================== */
'use strict';

const LIB_FORMAT = 'circuit-editor/component-library/1';

/* The four attachments, in the order the UI lists them. `ext` is what a
   loose file must end in to be picked up as that model automatically. */
const LIB_MODEL_SLOTS = [
  { id:'datasheet', label:'Datasheet',        short:'PDF',   ext:['pdf'],
    keys:['datasheet','datasheet_url','pdf','doc'] },
  { id:'symbol',    label:'Altium symbol',    short:'SCHLIB',ext:['schlib','schdoc'],
    keys:['symbol','schlib','altium_symbol','sch'] },
  { id:'footprint', label:'Altium footprint', short:'PCBLIB',ext:['pcblib','pcbdoc'],
    keys:['footprint','pcblib','altium_footprint','pcb'] },
  { id:'spice',     label:'LTspice model',    short:'SPICE', ext:['lib','mod','sub','cir','asy','net','sp'],
    keys:['spice','ltspice','model','sim','spice_model'] },
];
const LIB_SLOT_IDS = LIB_MODEL_SLOTS.map(s => s.id);

const LIB = {
  source: null,            // {kind:'files'|'folder'|'remote', base, url, label, adapter}
  components: [],          // normalized, see normalizeLibComponent()
  byId: new Map(),
  byPn: new Map(),         // normalized part number → component
  loaded: false, error: null, name: '', dirty: false,
  adapters: Object.create(null),

  get connected(){ return this.components.length > 0; },
  get count(){ return this.components.length; },

  /* A cloud backend registers here; connectRemote({adapter}) then uses it.
     An adapter is { async load(cfg) → {name, components[], base} }. */
  registerAdapter(name, adapter){ this.adapters[name] = adapter; },

  /* ---------------- sources ---------------- */

  /* A served directory: library.json (or index.json) next to the models. */
  async connectFolder(base){
    const b = String(base || 'library/').replace(/\/*$/, '/');
    this.error = null;
    for (const name of ['library.json', 'index.json', 'components.json']){
      try {
        const res = await fetch(b + name, { cache:'no-store' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const raw = await res.json();
        this.reset();
        this.source = { kind:'folder', base:b, label:lastSegment(b) };
        this.ingest(raw, { base:b, source:'folder' });
        return this.finish(raw.name || lastSegment(b));
      } catch (e){ this.error = name + ': ' + e.message; }
    }
    return 0;
  },

  /* A URL — a raw repo file, an API endpoint, a cloud service. */
  async connectRemote(url, opts){
    const o = opts || {};
    this.error = null;
    try {
      let raw, base = String(url || '').replace(/[^/]*$/, '');
      if (o.adapter){
        const ad = this.adapters[o.adapter];
        if (!ad) throw new Error('no adapter named "' + o.adapter + '"');
        const got = await ad.load({ url, ...o });
        raw = got.components ? got : (got.data || {});
        base = got.base || base;
      } else {
        const headers = { ...(o.headers || {}) };
        if (o.token) headers.Authorization = 'Bearer ' + o.token;
        const res = await fetch(url, { cache:'no-store', headers });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        raw = await res.json();
      }
      this.reset();
      this.source = { kind:'remote', url:String(url), base, label:o.label || hostOf(url), adapter:o.adapter || null };
      this.ingest(raw, { base, source:'remote' });
      return this.finish(raw.name || o.label || hostOf(url));
    } catch (e){
      this.error = e.message;
      return 0;
    }
  },

  /* Files off a local disk: a folder picked whole, or a handful of files.
     Any JSON among them is read as a library (or as one component); the
     model files are matched to the components they belong to, and anything
     left over that looks like a model becomes a component of its own — so a
     bare folder of .SchLib/.pdf files is already a library. */
  async loadFiles(fileList, opts){
    const files = [...(fileList || [])];
    if (!files.length) return 0;
    const o = opts || {};
    const jsons = files.filter(f => /\.json$/i.test(f.name));
    const models = files.filter(f => !/\.json$/i.test(f.name));
    this.error = null;
    if (!o.merge) this.reset();
    if (!o.merge || !this.source) this.source = { kind:'files', label:o.label || folderOf(files) || 'local files' };

    let fromJson = 0;
    for (const f of jsons){
      try {
        const raw = JSON.parse(await readFileText(f));
        fromJson += this.ingest(raw, { source:'files', path:relPath(f) });
      } catch (e){ this.error = f.name + ': ' + e.message; }
    }
    // Attach the picked model files to the components that name them, then
    // let anything still unclaimed stand up a component of its own.
    const unclaimed = this.attachFiles(models);
    if (!fromJson || unclaimed.length) for (const c of componentsFromFiles(unclaimed)) this.add(c, { source:'files' });
    this.attachFiles(models);
    return this.finish(o.label || (this.source && this.source.label) || 'local files');
  },

  /* Match loose files against every component's declared model paths, and
     against its part number. Returns the files nothing claimed. */
  attachFiles(files){
    if (!files.length) return [];
    const byPath = new Map(), byBase = new Map();
    for (const f of files){
      byPath.set(relPath(f).toLowerCase(), f);
      byBase.set(f.name.toLowerCase(), f);
    }
    const claimed = new Set();
    for (const c of this.components){
      for (const slot of LIB_MODEL_SLOTS){
        const m = c.models[slot.id];
        if (m && m.file) { claimed.add(m.file); continue; }
        let f = null;
        if (m && m.path){
          const p = String(m.path).toLowerCase();
          f = byPath.get(p) || byPath.get(p.replace(/^\.?\//, '')) || byBase.get(p.split('/').pop());
        }
        if (!f){                                   // …or a file named after the part
          const stem = normPn(c.part_number);
          for (const [base, cand] of byBase){
            const ext = base.split('.').pop();
            if (slot.ext.includes(ext) && normPn(base.replace(/\.[^.]+$/, '')) === stem){ f = cand; break; }
          }
        }
        if (f){ c.models[slot.id] = modelFromFile(f, slot.id); claimed.add(f); }
      }
    }
    return files.filter(f => !claimed.has(f));
  },

  /* Read any of the shapes a library file comes in. */
  ingest(raw, ctx){
    const list = Array.isArray(raw) ? raw
      : (raw && (raw.components || raw.parts || raw.library || raw.items)) ||
        (raw && (raw.part_number || raw.partNumber || raw.mpn) ? [raw] : []);
    let n = 0;
    for (const item of list) if (this.add(item, ctx)) n++;
    return n;
  },

  add(raw, ctx){
    const c = normalizeLibComponent(raw, ctx);
    if (!c) return null;
    const old = this.byId.get(c.id);
    if (old){ mergeComponent(old, c); return old; }
    this.components.push(c);
    this.byId.set(c.id, c);
    this.byPn.set(normPn(c.part_number), c);
    return c;
  },

  reset(){
    this.components = []; this.byId = new Map(); this.byPn = new Map();
    this.dirty = false;
  },
  finish(name){
    this.components.sort((a, b) => String(a.part_number).localeCompare(String(b.part_number), undefined, { numeric:true }));
    this.loaded = this.components.length > 0;
    if (this.components.length){ this.name = name || 'library'; this.remember(); }
    return this.components.length;
  },
  disconnect(){
    for (const c of this.components) releaseComponent(c);
    this.reset();
    this.source = null; this.loaded = false; this.error = null; this.name = '';
    try { localStorage.removeItem('lib_source'); } catch(e){}
  },
  remember(){
    try {
      if (this.source && this.source.kind !== 'files')
        localStorage.setItem('lib_source', JSON.stringify({ ...this.source, name:this.name }));
    } catch(e){}
  },
  /* Only a folder or a remote can be reattached by itself: files picked off
     a disk cannot be reopened without the user. */
  async autoConnect(){
    let cfg = null;
    try { cfg = JSON.parse(localStorage.getItem('lib_source') || 'null'); } catch(e){}
    if (!cfg) return 0;
    if (cfg.kind === 'folder') return this.connectFolder(cfg.base);
    if (cfg.kind === 'remote') return this.connectRemote(cfg.url, { adapter:cfg.adapter, label:cfg.label });
    return 0;
  },

  /* ---------------- reading the library ---------------- */
  categories(){
    return [...new Set(this.components.map(c => c.category).filter(Boolean))].sort();
  },
  search(q, cat){
    const s = String(q || '').trim().toLowerCase();
    return this.components.filter(c => {
      if (cat && cat !== 'all' && c.category !== cat) return false;
      if (!s) return true;
      if (String(c.part_number).toLowerCase().includes(s)) return true;
      if (String(c.description || '').toLowerCase().includes(s)) return true;
      if (String(c.manufacturer || '').toLowerCase().includes(s)) return true;
      return Object.entries(c.parameters).some(([k, v]) =>
        k.toLowerCase().includes(s) || String(v).toLowerCase().includes(s));
    });
  },
  /* The component behind a part number: exact first, then the family — the
     longest shared head, which is what tells "BQ24075RGTR" and "BQ24075-Q1"
     apart from everything else in the library. */
  match(partNumber){
    const k = normPn(partNumber);
    if (!k) return null;
    if (this.byPn.has(k)) return this.byPn.get(k);
    let best = null;
    for (const [pn, c] of this.byPn){
      const score = commonHead(k, pn);
      if (score < LIB_FAMILY_MIN) continue;
      if (!best || score > best.score) best = { c, score };
    }
    return best ? best.c : null;
  },
  modelsOf(c){ return LIB_MODEL_SLOTS.filter(s => c.models[s.id]).map(s => ({ slot:s, model:c.models[s.id] })); },

  /* Where a model can be opened from: a blob for a local file, a URL for
     everything else. */
  modelURL(c, slotId){
    const m = c && c.models[slotId];
    if (!m) return null;
    if (m.url) return m.url;
    if (m.file){
      if (!m.blobURL && typeof URL !== 'undefined' && URL.createObjectURL)
        m.blobURL = URL.createObjectURL(m.file);
      return m.blobURL || null;
    }
    if (m.path){
      if (/^https?:|^\//.test(m.path)) return m.path;
      const base = (c.base || (this.source && this.source.base) || '');
      return base + m.path;
    }
    return null;
  },
  /* The bytes behind a model, wherever it lives. */
  async modelData(c, slotId, as){
    const m = c && c.models[slotId];
    if (!m) return null;
    if (m.file) return as === 'text' ? readFileText(m.file) : readFileBuffer(m.file);
    const url = this.modelURL(c, slotId);
    if (!url) return null;
    const res = await fetch(url, { cache:'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + url);
    return as === 'text' ? res.text() : res.arrayBuffer();
  },

  /* ---------------- editing ---------------- */
  upsert(raw){
    const c = normalizeLibComponent(raw, { source:(this.source && this.source.kind) || 'files' });
    if (!c) return null;
    const old = this.byId.get(c.id) || this.byPn.get(normPn(c.part_number));
    if (old){ mergeComponent(old, c); this.dirty = true; return old; }
    this.components.push(c); this.byId.set(c.id, c); this.byPn.set(normPn(c.part_number), c);
    if (!this.source) this.source = { kind:'files', label:'new library' };
    this.name = this.name || (this.source && this.source.label) || 'new library';
    this.loaded = true; this.dirty = true;
    return c;
  },
  remove(id){
    const c = this.byId.get(id);
    if (!c) return false;
    releaseComponent(c);
    this.components = this.components.filter(x => x !== c);
    this.byId.delete(id); this.byPn.delete(normPn(c.part_number));
    this.dirty = true;
    return true;
  },
  /* The library as a library.json — what "Export" writes, and what a cloud
     backend will be handed when pushing becomes a thing. */
  toJSON(){
    return {
      format: LIB_FORMAT,
      name: this.name || 'library',
      generated: new Date().toISOString(),
      components: this.components.map(serializeLibComponent),
    };
  },
  /* PLACEHOLDER: writing the library back to a cloud repository. */
  async push(){
    return { ok:false, implemented:false, reason:'pushing to a remote library is not implemented yet' };
  },

  /* ---------------- the symbol ----------------
     The Altium symbol is what the editor wants to draw. While the .SchLib
     parser is a placeholder this falls back to a body generated from the
     component's pin list, and says so. */
  async symbolFor(c){
    if (!c) return null;
    if (c.symbol && c.symbol.def) return c.symbol;
    const fallback = () => ({ def:null, kind:libFallbackKind(c), pinNames:libPinNames(c),
                              state:'fallback', reason:Altium.status('symbol').note });
    if (!c.models.symbol) { c.symbol = { ...fallback(), reason:'no Altium symbol attached' }; return c.symbol; }
    let parsed = null;
    try {
      const data = await this.modelData(c, 'symbol');
      parsed = Altium.parseSchLib(data, { name:c.part_number });
    } catch (e){
      c.symbol = { ...fallback(), reason:'could not read the .SchLib: ' + e.message };
      return c.symbol;
    }
    const sym = parsed && parsed.symbols && (parsed.symbols.find(s =>
      normPn(s.name) === normPn(c.part_number)) || parsed.symbols[0]);
    const def = sym ? Altium.symbolDefFromAltium(sym, { label:c.part_number }) : null;
    // kind stays a real symbols.js kind ('ic') so every consumer of
    // SYMBOLS[part.kind] keeps working; the parsed def rides on the part.
    c.symbol = def
      ? { def, kind:'ic', pinNames:def.pins.map(p => p.name), state:'altium', reason:'' }
      : { ...fallback(), reason:(parsed && parsed.reason) || 'the .SchLib held no usable symbol' };
    return c.symbol;
  },
};

/* ------------------------------------------------------------------
   Normalizing a record. Every shape a library file comes in lands here:
   part_number / partNumber / mpn, parameters / params / attributes /
   specs, models either under `models` or spread over the record.
   ------------------------------------------------------------------ */
const LIB_KNOWN_KEYS = new Set(['id','part_number','partNumber','pn','mpn','part','description','desc',
  'manufacturer','mfr','vendor','category','cat','group','value','package','footprint_name','pins','pin_count',
  'parameters','params','attributes','specs','properties','models','notes','base','path','source','symbol']);

function normalizeLibComponent(raw, ctx){
  if (!raw || typeof raw !== 'object') return null;
  const c = ctx || {};
  const pn = String(raw.part_number || raw.partNumber || raw.pn || raw.mpn || raw.part || '').trim();
  if (!pn) return null;
  const params = { ...(raw.parameters || raw.params || raw.attributes || raw.specs || raw.properties || {}) };
  // Anything the record carries that is not one of ours is a parameter too —
  // the point of the library is that the fields are the user's to choose.
  for (const [k, v] of Object.entries(raw))
    if (!LIB_KNOWN_KEYS.has(k) && !LIB_SLOT_IDS.includes(k) && (typeof v !== 'object' || v == null)) params[k] = v;

  const models = {};
  for (const slot of LIB_MODEL_SLOTS){
    const declared = (raw.models && (raw.models[slot.id] || slot.keys.map(k => raw.models[k]).find(Boolean))) ||
                     slot.keys.map(k => raw[k]).find(Boolean) || null;
    const m = normalizeModel(declared, slot.id);
    if (m) models[slot.id] = m;
  }
  const pins = Array.isArray(raw.pins) ? raw.pins.map(p => (typeof p === 'object' ? String(p.name || p.designator || '') : String(p))).filter(Boolean)
             : typeof raw.pins === 'string' ? raw.pins.split(/[,\s]+/).filter(Boolean) : [];
  return {
    id: String(raw.id || libId(pn)),
    part_number: pn,
    description: String(raw.description || raw.desc || ''),
    manufacturer: String(raw.manufacturer || raw.mfr || raw.vendor || ''),
    category: String(raw.category || raw.cat || raw.group || ''),
    value: raw.value != null ? String(raw.value) : '',
    package: String(raw.package || raw.footprint_name || ''),
    pins, pin_count: Number(raw.pin_count || pins.length || 0) || 0,
    parameters: params,
    models,
    notes: String(raw.notes || ''),
    base: raw.base || c.base || '',
    source: raw.source || c.source || 'files',
    path: raw.path || c.path || '',
    symbol: null,
  };
}
function normalizeModel(v, slotId){
  if (!v) return null;
  if (typeof v === 'string'){
    const s = v.trim();
    if (!s) return null;
    return /^https?:|^data:/.test(s) ? { url:s, name:lastSegment(s), slot:slotId }
                                     : { path:s, name:lastSegment(s), slot:slotId };
  }
  if (typeof v === 'object'){
    const m = { slot:slotId, name:v.name || lastSegment(v.path || v.url || v.file || ''), ...v };
    if (v.file && typeof v.file === 'object') m.file = v.file;
    else if (typeof v.file === 'string' && !m.path) m.path = v.file;
    return (m.path || m.url || m.file) ? m : null;
  }
  return null;
}
function modelFromFile(f, slotId){
  return { slot:slotId, file:f, name:f.name, path:relPath(f), size:f.size || 0 };
}
function mergeComponent(old, next){
  for (const k of ['description','manufacturer','category','value','package','notes'])
    if (next[k]) old[k] = next[k];
  if (next.pins && next.pins.length){ old.pins = next.pins; old.pin_count = next.pin_count; }
  Object.assign(old.parameters, next.parameters);
  for (const s of LIB_SLOT_IDS) if (next.models[s]) old.models[s] = next.models[s];
  old.symbol = null;                       // a new symbol file means a new drawing
  return old;
}
function serializeLibComponent(c){
  const models = {};
  for (const s of LIB_SLOT_IDS){
    const m = c.models[s];
    if (m) models[s] = m.url || m.path || m.name || '';
  }
  const out = { part_number:c.part_number };
  for (const k of ['description','manufacturer','category','value','package','notes'])
    if (c[k]) out[k] = c[k];
  if (c.pins && c.pins.length) out.pins = c.pins;
  out.parameters = c.parameters;
  if (Object.keys(models).length) out.models = models;
  return out;
}
function releaseComponent(c){
  for (const s of LIB_SLOT_IDS){
    const m = c.models && c.models[s];
    if (m && m.blobURL && typeof URL !== 'undefined' && URL.revokeObjectURL){
      URL.revokeObjectURL(m.blobURL); m.blobURL = null;
    }
  }
}

/* A folder of loose models with no index: every file whose stem is the same
   part number is one component, and the extension says which model it is. */
function componentsFromFiles(files){
  const groups = new Map();
  for (const f of files){
    const ext = (f.name.split('.').pop() || '').toLowerCase();
    const slot = LIB_MODEL_SLOTS.find(s => s.ext.includes(ext));
    if (!slot) continue;
    const stem = f.name.replace(/\.[^.]+$/, '').trim();
    if (!stem) continue;
    const key = normPn(stem);
    if (!groups.has(key)) groups.set(key, { part_number:stem, parameters:{}, models:{} });
    const g = groups.get(key);
    if (!g.models[slot.id]) g.models[slot.id] = modelFromFile(f, slot.id);
    const dir = relPath(f).split('/').slice(-2, -1)[0];
    if (dir && !g.category) g.category = dir;
  }
  return [...groups.values()];
}

/* ---- the symbol the editor draws while the .SchLib parser is a stub ---- */
function libPinNames(c){
  if (c.pins && c.pins.length) return c.pins.map(String);
  const n = c.pin_count || Number(c.parameters.pin_count || c.parameters.pins || 0) || 0;
  return n > 0 ? Array.from({ length:n }, (_, i) => String(i + 1)) : [];
}
/* A library capacitor should still be drawn as a capacitor: when the category
   (or a `type` parameter) names one of the generic component types, that type
   picks the symbol — "capacitor" + "X5R ceramic" gives a plain cap, "MOSFET" +
   "N-channel" an n-channel FET. Anything else — a real part number, a category
   that is only a description like "battery charger" — is an IC body, which is
   what the pin list is for. */
function libFallbackKind(c){
  for (const cand of [c.category, c.parameters.type, c.parameters.category]){
    const t = String(cand || '').trim().toLowerCase();
    if (t && (TYPE_BY_NAME.has(t) || TYPE_ALIASES[t]))
      return kindForComponent({ partNumber:t, ref:'', ...c.parameters });
  }
  return kindForComponent({ partNumber:c.part_number, ref:'', ...c.parameters });
}

/* ---- odds and ends ---- */
/* Two part numbers are of the same family when they share this much head. */
const LIB_FAMILY_MIN = 6;
const commonHead = (a, b) => {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
};
const libId = pn => 'lc_' + normPn(pn).toLowerCase();
const lastSegment = s => String(s || '').replace(/[?#].*$/, '').replace(/\/+$/, '').split('/').pop() || String(s || '');
const hostOf = u => { try { return new URL(u).host; } catch(e){ return lastSegment(u); } };
const relPath = f => String(f.webkitRelativePath || f.relativePath || f.name || '');
const folderOf = files => {
  const p = files.map(relPath).find(x => x.includes('/'));
  return p ? p.split('/')[0] : '';
};
function readFileText(f){
  if (typeof f.text === 'function') return f.text();
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result)); r.onerror = () => rej(r.error || new Error('read failed'));
    r.readAsText(f);
  });
}
function readFileBuffer(f){
  if (typeof f.arrayBuffer === 'function') return f.arrayBuffer();
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result); r.onerror = () => rej(r.error || new Error('read failed'));
    r.readAsArrayBuffer(f);
  });
}
const libFileSize = n => !n ? '' : n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' kB' : (n / 1048576).toFixed(1) + ' MB';

if (typeof module !== 'undefined') module.exports = {
  LIB, LIB_MODEL_SLOTS, LIB_FORMAT, normalizeLibComponent, componentsFromFiles,
  serializeLibComponent, libFallbackKind, libPinNames, libFileSize,
};
