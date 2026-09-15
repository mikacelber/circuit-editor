/* ==================================================================
   netlist.js — the imported netlist is the GOLDEN connectivity.

   Import gives us components and nets ("R3-1", "U1-EP" style nodes).
   The sheet is then the drawing of that netlist: every part is placed
   as a symbol, and every wire the user draws is checked back against
   the imported nets, so the schematic can never silently drift from
   the circuit it is supposed to represent.
   ================================================================== */
'use strict';

/* ---- net classes: colour and meaning, from the imported `type` ---- */
const NET_CLASS = {
  GROUND:'ground', HIGH_VOLTAGE_PATH:'hv', POWER_DISTRIBUTION:'power', POWER_INTEGRITY:'power',
  SWITCHING_NODE:'switching', DIGITAL_LOGIC:'logic', TIMING_SIGNAL:'logic', CONTROL_SIGNAL:'control',
  ANALOG_SIGNAL:'analog', ANALOG_REFERENCE:'analog', ANALOG_FEEDBACK:'analog', ANALOG_COMPENSATION:'analog',
  QUIET_REFERENCE:'analog', SENSING_LINE:'analog', FEEDBACK_PATH:'analog', NO_CONNECT:'other', NA:'other',
};
const netClass = type => NET_CLASS[String(type || '').toUpperCase()] || 'other';
const GNDISH = /^(gnd|ground|agnd|dgnd|pgnd|vss|earth|chassis|return|rtn)/i;
const isGroundNet = n => String(n.type || '').toUpperCase() === 'GROUND' || GNDISH.test(String(n.name || ''));

/* ---- import: tolerant about how the netlist was wrapped ---- */
function parseCircuitData(raw){
  let d = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (Array.isArray(d)) d = d[0];
  if (d && d.circuit_data) d = d.circuit_data;
  if (d && d.output && !d.components) d = typeof d.output === 'string' ? JSON.parse(d.output) : d.output;
  if (!d || !Array.isArray(d.components)) throw new Error('No "components" array in this file');
  const nets = (d.nets || []).map(n => ({
    name: String(n.name || '').trim(),
    type: String(n.type || 'NA').toUpperCase(),
    nodes: (n.nodes || []).map(x => String(x).trim()).filter(Boolean),
  })).filter(n => n.name);
  const seen = new Map();
  const components = d.components.map((c, i) => {
    const ref = String(c.ref || ('X' + (i + 1))).trim().toUpperCase();
    const props = {};
    for (const [k, v] of Object.entries(c))
      if (!['ref','partNumber','role','group'].includes(k)) props[k] = v;
    const comp = {
      ref, partNumber: String(c.partNumber || '').trim(),
      role: c.role || '', group: c.group || 'UNGROUPED', props,
    };
    if (seen.has(ref)) comp.duplicate = true; else seen.set(ref, comp);
    return comp;
  });
  return { components, nets, title: d.title || d.id || '' };
}

/* Pin names per reference, read straight from the net nodes ("U1-EP" → "EP"). */
function pinsByRef(nl){
  const map = new Map();
  const add = (ref, pin) => {
    if (!map.has(ref)) map.set(ref, []);
    const a = map.get(ref);
    if (!a.includes(pin)) a.push(pin);
  };
  for (const net of nl.nets) for (const node of net.nodes){
    const m = String(node).match(/^(.+?)-([^-]+)$/);
    if (!m) continue;
    add(m[1].toUpperCase(), m[2]);
  }
  for (const a of map.values())
    a.sort((x, y) => (parseInt(x, 10) || 1e6) - (parseInt(y, 10) || 1e6) || String(x).localeCompare(String(y)));
  return map;
}
const nodeRef = node => { const m = String(node).match(/^(.+?)-([^-]+)$/); return m ? m[1].toUpperCase() : String(node).toUpperCase(); };
const nodePin = node => { const m = String(node).match(/^(.+?)-([^-]+)$/); return m ? m[2] : '1'; };

/* ---- imported components → placed parts ---- */
let _pid = 0;
const newId = pre => pre + '_' + (++_pid) + '_' + Math.random().toString(36).slice(2, 6);

function partsFromNetlist(nl){
  const pins = pinsByRef(nl);
  return nl.components.map(c => {
    const kind = kindForComponent({ ...c.props, ref:c.ref, partNumber:c.partNumber, role:c.role });
    const names = pins.get(c.ref) || null;
    const part = {
      id: newId('p'), kind, ref: c.ref, x:0, y:0, rot:0, mir:0,
      partNumber: c.partNumber, value: valueForComponent({ ...c.props, partNumber:c.partNumber }),
      group: c.group, role: c.role, props: c.props, fromNetlist: true,
    };
    // Generated symbols (IC, connector) take their pin list from the netlist;
    // a fixed symbol keeps its own pins, but remembers extras it must expose
    // (an exposed pad, for instance) so no netlist node is left unplaceable.
    if (SYMBOLS[kind].generated){
      part.pinNames = names && names.length ? names
        : (c.props.number_of_contacts ? Array.from({length:+c.props.number_of_contacts||2}, (_,i)=>String(i+1)) : ['1','2']);
    } else if (names){
      const own = new Set(defOf(part).pins.map(p => p.name));
      const extra = names.filter(n => !own.has(n));
      if (extra.length && names.length > own.size){
        // more nodes than the fixed symbol has pins → fall back to a box
        part.kind = 'ic'; part.pinNames = names;
      } else if (extra.length){
        part.pinAlias = {};                       // e.g. "A"/"K" drawn, "1"/"2" in the netlist
        const own2 = defOf(part).pins.map(p => p.name);
        names.forEach((n, i) => { if (own2[i]) part.pinAlias[n] = own2[i]; });
      }
    }
    return part;
  });
}

/* The drawn pin a netlist node refers to ("D2-1" → that part's "A" pin). */
function pinNameFor(part, node){
  const p = nodePin(node);
  if (part.pinAlias && part.pinAlias[p]) return part.pinAlias[p];
  return p;
}

/* ------------------------------------------------------------------
   Auto-arrange: one dashed "room" per functional group, ICs on the
   first rows (they are the tall symbols), passives packed after them.
   Deterministic — the same netlist always lands the same way.
   ------------------------------------------------------------------ */
function arrangeParts(parts, opts){
  const o = opts || {};
  const sheetW = o.sheetW || 3600, pad = 60, gap = 80;
  const groups = new Map();
  for (const p of parts){
    const g = p.group || 'UNGROUPED';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(p);
  }
  const rooms = [];
  let cx = pad, cy = pad, rowH = 0;
  for (const [gname, list] of [...groups.entries()].sort((a, b) => b[1].length - a[1].length)){
    const big = list.filter(p => SYMBOLS[p.kind].generated === 'ic' || p.kind === 'connector' || p.kind === 'relay');
    const small = list.filter(p => !big.includes(p));
    const cellW = 160, cellH = 120;      // room for a net name on both sides
    const cols = Math.max(2, Math.min(6, Math.ceil(Math.sqrt(small.length || 1))));
    // ICs sit in one row, each as wide as its own body needs
    let icW = 0, icH = 0;
    const icSizes = big.map(p => { const b = partBounds({ ...p, x:0, y:0 }); return { p, w:b.w + 40, h:b.h + 40 }; });
    for (const s of icSizes){ icW += s.w; icH = Math.max(icH, s.h); }
    const smallRows = Math.ceil(small.length / cols);
    const innerW = Math.max(icW, cols * cellW, 220);
    const innerH = icH + smallRows * cellH + (icH && smallRows ? 20 : 0);
    if (cx + innerW + 2 * pad > sheetW && cx > pad){ cx = pad; cy += rowH + gap; rowH = 0; }
    const rx = cx, ry = cy;
    // place ICs
    let ix = rx + 20;
    for (const s of icSizes){
      s.p.x = snapTo(ix + s.w / 2); s.p.y = snapTo(ry + 20 + icH / 2);
      ix += s.w;
    }
    // place passives
    small.forEach((p, i) => {
      const r = Math.floor(i / cols), c = i % cols;
      p.x = snapTo(rx + 20 + c * cellW + cellW / 2);
      p.y = snapTo(ry + 20 + icH + (icH ? 20 : 0) + r * cellH + cellH / 2);
      if (/^(cap|cap_pol|res|shunt|ind|ferrite|ntc|fuse)$/.test(p.kind) && isDecoupler(p)) p.rot = 90;
    });
    const w = innerW + 40, h = innerH + 50;
    rooms.push({ group:gname, x:rx, y:ry, w, h, count:list.length });
    cx += w + gap; rowH = Math.max(rowH, h);
  }
  return rooms;
}
const snapTo = v => Math.round(v / GRID) * GRID;
const isDecoupler = p => /BYPASS|DECOUP|FILTER/i.test(p.role || '');

/* ------------------------------------------------------------------
   CONNECTIVITY of what is actually drawn.

   Points on the lattice are the meeting places. A wire contributes its
   vertices as "ends" and the lattice points along its segments as
   "through" points; two wires that merely cross (through × through)
   do NOT connect — exactly like a schematic. A pin under a wire does.
   ------------------------------------------------------------------ */
function connectivity(parts, wires){
  const parent = new Map();
  const find = a => { while (parent.get(a) !== a){ parent.set(a, parent.get(parent.get(a))); a = parent.get(a); } return a; };
  const node = a => { if (!parent.has(a)) parent.set(a, a); return a; };
  const union = (a, b) => { a = find(node(a)); b = find(node(b)); if (a !== b) parent.set(a, b); };

  const key = (x, y) => Math.round(x) + ',' + Math.round(y);
  const at = new Map();                                  // point → [{t:'pin'|'end'|'thru', id}]
  const put = (x, y, rec) => { const k = key(x, y); if (!at.has(k)) at.set(k, []); at.get(k).push(rec); };

  const pinAt = new Map();                               // point → [pinKey]
  for (const part of parts){
    for (const pin of partPins(part)){
      const pk = part.id + '|' + pin.name;
      node(pk); put(pin.x, pin.y, { t:'pin', id:pk });
      const k = key(pin.x, pin.y);
      if (!pinAt.has(k)) pinAt.set(k, []); pinAt.get(k).push(pk);
    }
  }
  for (const w of wires){
    const wk = 'w:' + w.id; node(wk);
    const pts = w.pts || [];
    for (const p of pts) put(p.x, p.y, { t:'end', id:wk });
    for (let i = 0; i < pts.length - 1; i++){
      const a = pts[i], b = pts[i + 1];
      const dx = Math.sign(b.x - a.x), dy = Math.sign(b.y - a.y);
      const steps = Math.round(Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y)) / GRID);
      for (let s = 1; s < steps; s++) put(a.x + dx * s * GRID, a.y + dy * s * GRID, { t:'thru', id:wk });
    }
  }
  const junctions = [];
  for (const [k, recs] of at){
    const ends = recs.filter(r => r.t === 'end');
    const endIds = new Set(ends.map(r => r.id));
    const wireIds = new Set(recs.filter(r => r.t !== 'pin').map(r => r.id));
    const pins = recs.filter(r => r.t === 'pin');
    // A pin joins a wire only where that wire has a VERTEX — a wire merely
    // passing over a pin is not a connection, exactly as in a schematic.
    for (const p of pins) for (const w of endIds) union(p.id, w);
    for (const p of pins) for (const q of pins) union(p.id, q.id);
    // Two wires join when at least one of them ends here (T or corner);
    // two wires crossing through each other do not.
    if (wireIds.size > 1 && endIds.size){
      const list = [...wireIds];
      for (let i = 1; i < list.length; i++) union(list[0], list[i]);
      const [x, y] = k.split(',').map(Number);
      junctions.push({ x, y });
    } else if (pins.length && endIds.size && (pins.length + endIds.size) > 2){
      const [x, y] = k.split(',').map(Number);
      junctions.push({ x, y });
    }
  }
  // net labels and power ports: same text ⇒ same net, anywhere on the sheet
  const byName = new Map();
  for (const part of parts){
    const def = SYMBOLS[part.kind];
    if (!def || !def.port || def.port === 'note' || def.port === 'nc') continue;
    const name = String(part.net || def.net || '').trim().toUpperCase();
    if (!name) continue;
    const pk = part.id + '|' + (def.pins[0] ? def.pins[0].name : '1');
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(pk);
  }
  for (const list of byName.values()) for (let i = 1; i < list.length; i++) union(list[0], list[i]);

  // collect the groups
  const groupOf = new Map(), members = new Map();
  for (const k of parent.keys()){
    if (k.startsWith('w:')) continue;
    const r = find(k);
    groupOf.set(k, r);
    if (!members.has(r)) members.set(r, []);
    members.get(r).push(k);
  }
  const wireGroup = new Map();
  for (const w of wires) wireGroup.set(w.id, find('w:' + w.id));
  const nameOf = new Map();
  for (const [name, list] of byName) if (list.length) nameOf.set(find(list[0]), name);
  return { groupOf, members, wireGroup, junctions, nameOf, find:k => (parent.has(k) ? find(k) : null) };
}

/* ------------------------------------------------------------------
   Rules check: the drawing against the imported netlist.
   ------------------------------------------------------------------ */
function checkDesign(S){
  const issues = [];
  const conn = connectivity(S.parts, S.wires);
  const byRef = new Map();
  for (const p of S.parts) if (p.ref) byRef.set(p.ref.toUpperCase(), p);

  // duplicate references
  const count = new Map();
  for (const p of S.parts) if (p.ref) count.set(p.ref.toUpperCase(), (count.get(p.ref.toUpperCase()) || 0) + 1);
  for (const [ref, n] of count) if (n > 1)
    issues.push({ sev:'err', code:'dup-ref', text:`Reference ${ref} is used by ${n} parts`, ref });

  const nets = (S.netlist && S.netlist.nets) || [];
  const pinNet = new Map();                       // pinKey → imported net name
  const netState = new Map();

  for (const net of nets){
    const wanted = [];
    for (const node of net.nodes){
      const part = byRef.get(nodeRef(node));
      if (!part){
        if (!net._missing) net._missing = [];
        net._missing.push(node);
        continue;
      }
      const pk = part.id + '|' + pinNameFor(part, node);
      wanted.push(pk); pinNet.set(pk, net.name);
    }
    const groups = new Map();
    for (const pk of wanted){
      const g = conn.groupOf.get(pk);
      if (!g) continue;
      groups.set(g, (groups.get(g) || 0) + 1);
    }
    const best = [...groups.entries()].sort((a, b) => b[1] - a[1])[0];
    const wiredIn = best ? best[1] : 0;
    const state = net.nodes.length <= 1 || /^NO_CONNECT$/i.test(net.type) ? 'single'
      : wiredIn >= wanted.length && wanted.length > 1 && groups.size === 1 ? 'done'
      : wiredIn > 1 ? 'partial' : 'open';
    netState.set(net.name, { state, wired:wiredIn, total:wanted.length, group:best ? best[0] : null });
    if (state === 'partial'){
      const inBest = new Set((conn.members.get(best[0]) || []));
      const open = wanted.filter(pk => !inBest.has(pk)).map(pk => {
        const part = S.parts.find(p => p.id === pk.split('|')[0]);
        return (part ? part.ref : '?') + '-' + pk.split('|')[1];
      });
      issues.push({ sev:'warn', code:'net-partial', net:net.name,
        text:`Net ${net.name}: ${wiredIn} of ${wanted.length} pins wired — still open: ${open.slice(0, 6).join(', ')}${open.length > 6 ? '…' : ''}` });
    } else if (state === 'open'){
      issues.push({ sev:'info', code:'net-open', net:net.name,
        text:`Net ${net.name} is not drawn yet (${wanted.length} pins)` });
    }
    if (net._missing && net._missing.length)
      issues.push({ sev:'warn', code:'net-missing-part', net:net.name,
        text:`Net ${net.name} references parts that are not on the sheet: ${net._missing.slice(0, 6).join(', ')}` });
  }
  // shorts: one drawn group carrying pins of two different imported nets
  for (const [g, list] of conn.members){
    const names = new Set(list.map(pk => pinNet.get(pk)).filter(Boolean));
    if (names.size > 1)
      issues.push({ sev:'err', code:'short', text:`Short: ${[...names].join(' — ')} are wired together`, group:g, nets:[...names] });
  }
  // components of the netlist that never made it onto the sheet
  const placed = new Set(S.parts.map(p => (p.ref || '').toUpperCase()));
  const missing = ((S.netlist && S.netlist.components) || []).filter(c => !placed.has(c.ref));
  for (const c of missing.slice(0, 40))
    issues.push({ sev:'warn', code:'unplaced', ref:c.ref, text:`${c.ref} (${c.partNumber}) is in the netlist but not on the sheet` });
  if (missing.length > 40)
    issues.push({ sev:'warn', code:'unplaced', text:`…and ${missing.length - 40} more components of the netlist are not placed` });
  // parts drawn by hand that no imported net mentions
  for (const part of S.parts){
    if (SYMBOLS[part.kind] && SYMBOLS[part.kind].port) continue;
    if (!part.ref || !S.netlist) continue;
    const known = S.netlist.components.some(c => c.ref === part.ref.toUpperCase());
    if (!known)
      issues.push({ sev:'info', code:'extra-part', ref:part.ref, partId:part.id,
        text:`${part.ref} is on the sheet but not in the imported netlist` });
  }
  return { issues, conn, netState, pinNet };
}

/* ---- export: the drawn sheet back out as a circuit_data netlist ---- */
function netlistFromSheet(S){
  const conn = connectivity(S.parts, S.wires);
  const nets = [];
  let anon = 0;
  for (const [g, list] of conn.members){
    const pins = list.filter(pk => {
      const part = S.parts.find(p => p.id === pk.split('|')[0]);
      return part && !(SYMBOLS[part.kind] && SYMBOLS[part.kind].port);
    });
    if (pins.length < 2) continue;                 // a single pin is not a net
    const nodes = pins.map(pk => {
      const [pid, pin] = pk.split('|');
      const part = S.parts.find(p => p.id === pid);
      return (part.ref || pid) + '-' + pin;
    });
    const imported = (S.netlist && S.netlist.nets || []).find(n =>
      n.nodes.some(node => nodes.includes(node)));
    const name = conn.nameOf.get(g) || (imported && imported.name) || ('N$' + (++anon));
    nets.push({ name, type:(imported && imported.type) || 'NA', nodes:nodes.sort() });
  }
  const components = S.parts.filter(p => !(SYMBOLS[p.kind] && SYMBOLS[p.kind].port)).map(p => ({
    partNumber: p.partNumber || SYMBOLS[p.kind].label.toLowerCase(),
    ref: p.ref, ...(p.props || {}), role: p.role || '', group: p.group || 'UNGROUPED',
  }));
  return [{ components, nets }];
}

if (typeof module !== 'undefined') module.exports = {
  parseCircuitData, pinsByRef, partsFromNetlist, arrangeParts, connectivity,
  checkDesign, netlistFromSheet, netClass, isGroundNet, nodeRef, nodePin, pinNameFor, newId,
};
