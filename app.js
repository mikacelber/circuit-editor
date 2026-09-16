/* ==================================================================
   app.js — sheet, view, tools and the glue between them.

   The document is small on purpose:
     S.parts   placed symbols (components, power ports, labels, notes)
     S.wires   orthogonal polylines
     S.netlist the imported circuit_data.json — the golden connectivity
   Everything else (nets, junctions, checks) is DERIVED, never stored,
   so the drawing can never disagree with itself. The rules check runs
   on every render, so pin dots, net states and the status bar are
   always a reading of the sheet as it is right now.
   ================================================================== */
'use strict';

const $ = id => document.getElementById(id);
const svg = $('board'), viewport = $('viewport'), gridG = $('gridG');
const roomsG = $('roomsG'), wiresG = $('wiresG'), partsG = $('partsG'), overlayG = $('overlayG');

const S = {
  project: { title:'Untitled circuit', code:'', revision:'A', author:'', customer:'', variant:'', status:'draft',
             vin:'', vout:'', imax:'', isolation:'', standards:'', notes:'', checklist:[] },
  parts: [], wires: [], rooms: [], netlist: null,
  view: { tx:0, ty:0, k:1 },
  sel: null,                    // primary selection: {type:'part'|'wire', id}
  selIds: new Set(),            // every selected part (multi-select)
  tool:'select', place:null, traceNet:null, lastCheck:null,
  pinNets: new Map(), showRooms:true, showStubs:true,
  ui: { libQuery:'', netQuery:'', netFilter:'all', dbQuery:'', dbSel:null, pick:{} },
};

/* ---------------- history ---------------- */
const HIST = { undo:[], redo:[], max:60 };
const snapshot = () => JSON.stringify({ project:S.project, parts:S.parts, wires:S.wires, rooms:S.rooms, netlist:S.netlist });
function commit(){
  HIST.undo.push(snapshot());
  if (HIST.undo.length > HIST.max) HIST.undo.shift();
  HIST.redo.length = 0;
  scheduleAutosave();
  updateHistButtons();
}
function restore(str){
  const d = JSON.parse(str);
  S.project = d.project; S.parts = d.parts; S.wires = d.wires; S.rooms = d.rooms || []; S.netlist = d.netlist;
  clearSel(); rebuildPinNets(); render();
}
function undo(){ if (!HIST.undo.length) return; HIST.redo.push(snapshot()); restore(HIST.undo.pop()); updateHistButtons(); }
function redo(){ if (!HIST.redo.length) return; HIST.undo.push(snapshot()); restore(HIST.redo.pop()); updateHistButtons(); }
function updateHistButtons(){ $('btnUndo').disabled = !HIST.undo.length; $('btnRedo').disabled = !HIST.redo.length; }

let autosaveT = null;
function scheduleAutosave(){
  clearTimeout(autosaveT);
  autosaveT = setTimeout(() => { try { localStorage.setItem('circuit_session', sessionJSON()); } catch(e){} }, 800);
}

/* ---------------- selection ---------------- */
function clearSel(){ S.sel = null; S.selIds = new Set(); }
function selectOnly(type, id){ S.sel = { type, id }; S.selIds = new Set(type === 'part' ? [id] : []); }
function toggleSel(id){
  if (S.selIds.has(id)){ S.selIds.delete(id); if (S.sel && S.sel.id === id) S.sel = S.selIds.size ? { type:'part', id:[...S.selIds][0] } : null; }
  else { S.selIds.add(id); S.sel = { type:'part', id }; }
}
const selectedParts = () => S.parts.filter(p => S.selIds.has(p.id));

/* ---------------- grid, exactly like the architecture editor ----------------
   Drawn in SCREEN space over the whole board, with the pattern origin tied to
   the view translation, so its lines sit on the very lattice parts snap to. */
const GRID_LEVELS = [GRID, GRID * 2, GRID * 4, GRID * 8, GRID * 16, GRID * 32];   // 10 … 320
const GRID_CELL_MIN_PX = 14;
const SNAP_MAX = GRID * 2;      // a sheet seen from far away still snaps at 20
function gridPitch(){
  for (const p of GRID_LEVELS) if (p * S.view.k >= GRID_CELL_MIN_PX) return p;
  return GRID_LEVELS[GRID_LEVELS.length - 1];
}
/* Placement follows the VISIBLE grid, but never gets coarser than SNAP_MAX —
   pins live on the 10-unit lattice and must stay reachable at any zoom. */
const snapView = v => { const p = Math.min(gridPitch(), SNAP_MAX); return Math.round(v / p) * p; };
const snapFine = v => Math.round(v / GRID) * GRID;
let gridShownPitch = null;
function updateGridLOD(){
  const p = gridPitch();
  if (p !== gridShownPitch || !gridG.firstElementChild){
    gridShownPitch = p;
    gridG.innerHTML = `<defs><pattern id="gridPat" patternUnits="userSpaceOnUse">
      <path fill="none" stroke="var(--grid)" stroke-width="1"/></pattern></defs>
      <rect x="0" y="0" width="100%" height="100%" fill="url(#gridPat)" style="pointer-events:none"/>`;
  }
  const cell = p * S.view.k;
  const pat = gridG.querySelector('#gridPat');
  pat.setAttribute('width', cell); pat.setAttribute('height', cell);
  pat.setAttribute('patternTransform', `translate(${S.view.tx},${S.view.ty})`);
  pat.querySelector('path').setAttribute('d', `M ${cell} 0 L 0 0 0 ${cell}`);
}
function applyView(){
  viewport.setAttribute('transform', `translate(${S.view.tx},${S.view.ty}) scale(${S.view.k})`);
  updateGridLOD(); updateViewTools(); renderSheetChip();
}

const ZOOM_MIN = .12, ZOOM_MAX = 4, ZOOM_STEP = 1.2;
function zoomAbout(factor, sx, sy){
  const k0 = S.view.k, k1 = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, k0 * factor));
  if (k1 === k0) return;
  S.view.tx = sx - (sx - S.view.tx) * (k1 / k0);
  S.view.ty = sy - (sy - S.view.ty) * (k1 / k0);
  S.view.k = k1;
  applyView();
}
function zoomStep(dir){ const r = svg.getBoundingClientRect(); zoomAbout(dir > 0 ? ZOOM_STEP : 1 / ZOOM_STEP, r.width / 2, r.height / 2); }
function updateViewTools(){
  $('btnZoomIn').disabled = S.view.k >= ZOOM_MAX - 1e-6;
  $('btnZoomOut').disabled = S.view.k <= ZOOM_MIN + 1e-6;
}
function boundsOf(parts, wires){
  const bs = parts.map(partBounds);
  for (const w of wires) for (const p of w.pts) bs.push({ x:p.x, y:p.y, w:0, h:0 });
  if (!bs.length) return null;
  const minX = Math.min(...bs.map(b => b.x)), maxX = Math.max(...bs.map(b => b.x + b.w));
  const minY = Math.min(...bs.map(b => b.y)), maxY = Math.max(...bs.map(b => b.y + b.h));
  return { x:minX, y:minY, w:Math.max(1, maxX - minX), h:Math.max(1, maxY - minY) };
}
const sheetBounds = () => boundsOf(S.parts, S.wires);
function fitView(bounds){
  const b = bounds || sheetBounds();
  if (!b) return;
  const r = svg.getBoundingClientRect(), pad = 60;
  const k = Math.min(ZOOM_MAX, Math.min((r.width - 2 * pad) / b.w, (r.height - 2 * pad) / b.h));
  S.view.k = Math.max(ZOOM_MIN, k);
  S.view.tx = (r.width - b.w * S.view.k) / 2 - b.x * S.view.k;
  S.view.ty = (r.height - b.h * S.view.k) / 2 - b.y * S.view.k;
  render();
}
/* Shift+F: frame the selection instead of the whole sheet. */
function fitSelection(){
  const parts = selectedParts();
  const wires = S.sel && S.sel.type === 'wire' ? S.wires.filter(w => w.id === S.sel.id) : [];
  const b = boundsOf(parts, wires);
  if (!b) return fitView();
  fitView({ x:b.x - 80, y:b.y - 80, w:b.w + 160, h:b.h + 160 });
}
function centerOn(x, y, k){
  const r = svg.getBoundingClientRect();
  if (k) S.view.k = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, k));
  S.view.tx = r.width / 2 - x * S.view.k;
  S.view.ty = r.height / 2 - y * S.view.k;
  applyView();
}
const toWorld = (cx, cy) => { const r = svg.getBoundingClientRect(); return { x:(cx - r.left - S.view.tx) / S.view.k, y:(cy - r.top - S.view.ty) / S.view.k }; };

/* ---------------- tools ---------------- */
const TOOLS = [
  { id:'select', key:'S', title:'Select / move (S) — Shift+drag for a marquee', icon:'<path d="M5 3l14 7-6 1.6L10 18z"/>' },
  { id:'wire',   key:'W', title:'Place wire (W) — Space flips the bend, Esc or right-click ends it', icon:'<path d="M3 17h6V7h6v10h6"/><circle cx="3" cy="17" r="1.8"/><circle cx="21" cy="17" r="1.8"/>' },
  { id:'label',  key:'L', title:'Net label (L)',     icon:'<path d="M3 12h4M7 6h11l3 6-3 6H7z"/>' },
  { id:'gnd',    key:'G', title:'Ground (G)',        icon:'<path d="M12 4v9M6 13h12M8.5 17h7M10.5 20h3"/>' },
  { id:'power',  key:'P', title:'Power rail (P)',    icon:'<path d="M12 20V7M6 7h12M12 7l0-3"/>' },
  { id:'text',   key:'T', title:'Text note (T)',     icon:'<path d="M5 6h14M12 6v13M9 19h6"/>' },
];
function renderToolbar(){
  $('toolbar').innerHTML = TOOLS.map(t =>
    `<button data-tool="${t.id}" class="${S.tool === t.id ? 'on' : ''}" title="${t.title}">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${t.icon}</svg></button>`).join('') +
    `<span class="tsep"></span>
     <button data-act="rot" title="Rotate (R)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8 8 0 1 1-2.3-5.6M20 4v5h-5"/></svg></button>
     <button data-act="mir" title="Mirror (M)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v18M7 7l-4 5 4 5zM17 7l4 5-4 5z"/></svg></button>
     <button data-act="dup" title="Duplicate (Ctrl+D)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="8" width="12" height="12" rx="1.5"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/></svg></button>
     <button data-act="del" title="Delete (Del)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg></button>`;
  $('toolbar').querySelectorAll('[data-tool]').forEach(b => b.onclick = () => setTool(b.dataset.tool));
  $('toolbar').querySelectorAll('[data-act]').forEach(b => b.onclick = () => {
    const a = b.dataset.act;
    if (a === 'rot') rotateSel(); else if (a === 'mir') mirrorSel(); else if (a === 'dup') duplicateSel(); else deleteSel();
  });
}
function setTool(t){
  S.tool = t; S.place = null; wireDraft = null; snapHint = null;
  if (t === 'label') startPlace('netlabel');
  else if (t === 'gnd') startPlace('gnd');
  else if (t === 'power') startPlace('vcc');
  else if (t === 'text') startPlace('note');
  svg.classList.toggle('drawing', t === 'wire');
  svg.classList.toggle('placing', t === 'place');
  renderToolbar(); render();
}
function startPlace(kind){
  S.place = { kind, rot:0, mir:0, x:null, y:null };
  S.tool = 'place';
  svg.classList.add('placing'); svg.classList.remove('drawing');
  renderToolbar(); renderDock();
}

/* ---------------- parts ---------------- */
function nextRef(prefix){
  if (!prefix) return '';
  let n = 1;
  const used = new Set(S.parts.map(p => (p.ref || '').toUpperCase()));
  while (used.has(prefix + n)) n++;
  return prefix + n;
}
function addPart(kind, x, y, extra){
  const def = SYMBOLS[kind];
  const part = {
    id: newId('p'), kind, x:snapView(x), y:snapView(y), rot:0, mir:0,
    ref: def.prefix ? nextRef(def.prefix) : '', value: def.value || '',
    partNumber:'', group:'', role:'', props:{}, ...(extra || {}),
  };
  if (def.port === 'label' || def.port === 'gnd' || def.port === 'power') part.net = def.net;
  if (def.port === 'note') part.text = 'Note';
  if (def.generated) part.pinNames = def.generated === 'ic' ? ['1','2','3','4','5','6','7','8'] : ['1','2','3','4'];
  S.parts.push(part);
  return part;
}
/* A label or a power port dropped on a pin (or a wire end) takes the name of
   the imported net that pin belongs to — the netlist already knows it. */
function prefillPortNet(part){
  const def = SYMBOLS[part.kind];
  if (!def.port || def.port === 'note' || def.port === 'nc') return;
  const own = partPins(part)[0];
  if (!own) return;
  for (const other of S.parts){
    if (other === part) continue;
    for (const pin of partPins(other)){
      if (pin.x !== own.x || pin.y !== own.y) continue;
      const net = S.pinNets.get(other.id + '|' + pin.name);
      if (net) { part.net = net; return; }
    }
  }
}
function deletePart(id){
  S.parts = S.parts.filter(p => p.id !== id);
  S.selIds.delete(id);
  if (S.sel && S.sel.id === id) S.sel = null;
  rebuildPinNets(); render();
}
function deleteSel(){
  if (!S.sel && !S.selIds.size) return;
  commit();
  if (S.sel && S.sel.type === 'wire') S.wires = S.wires.filter(w => w.id !== S.sel.id);
  S.parts = S.parts.filter(p => !S.selIds.has(p.id));
  clearSel(); rebuildPinNets(); render(); renderDock();
}
/* Rotate / mirror the selection. The wires held by the pins of those parts
   follow the pins to wherever they land, bending as needed (the same rubber
   band a move uses), so turning a part never breaks its connections. */
function rotateSel(){
  if (S.place){ S.place.rot = ((S.place.rot || 0) + 90) % 360; renderOverlay(); return; }
  const parts = selectedParts();
  if (!parts.length) return;
  commit();
  const held = rubberBandStart(parts);
  for (const p of parts) p.rot = ((p.rot || 0) + 90) % 360;
  rubberBandApply(held); rubberBandEnd(held);
  render(); renderDock();
}
function mirrorSel(){
  if (S.place){ S.place.mir = S.place.mir ? 0 : 1; renderOverlay(); return; }
  const parts = selectedParts();
  if (!parts.length) return;
  commit();
  const held = rubberBandStart(parts);
  for (const p of parts) p.mir = p.mir ? 0 : 1;
  rubberBandApply(held); rubberBandEnd(held);
  render(); renderDock();
}
/* Ctrl+D: a copy of the selection one cell down-right, with fresh designators. */
function duplicateSel(){
  const parts = selectedParts();
  if (!parts.length) return;
  commit();
  const copies = parts.map(p => {
    const c = JSON.parse(JSON.stringify(p));
    c.id = newId('p'); c.x += 40; c.y += 40;
    c.fromNetlist = false;
    const def = SYMBOLS[c.kind];
    if (def.prefix) c.ref = nextRef(def.prefix);
    S.parts.push(c);
    return c;
  });
  S.selIds = new Set(copies.map(c => c.id)); S.sel = { type:'part', id:copies[0].id };
  rebuildPinNets(); render(); renderDock();
}
/* Arrow keys: nudge the selection by one snap step (Shift = 4). */
function nudgeSel(dx, dy){
  const parts = selectedParts();
  if (!parts.length) return;
  commit();
  const rb = rubberBandStart(parts);
  for (const p of parts){ p.x += dx; p.y += dy; }
  rubberBandApply(rb);
  rubberBandEnd(rb);
  render();
}
/* Place one component of the imported netlist that is not on the sheet yet. */
function placeNetlistComponent(ref){
  const c = S.netlist && S.netlist.components.find(x => x.ref === ref);
  if (!c) return;
  commit();
  const [p] = partsFromNetlist({ components:[c], nets:S.netlist.nets });
  const r = svg.getBoundingClientRect();
  const c0 = toWorld(r.left + r.width / 2, r.top + r.height / 2);
  p.x = snapView(c0.x); p.y = snapView(c0.y);
  S.parts.push(p); selectOnly('part', p.id);
  rebuildPinNets(); render(); setPanel('properties');
  toast(ref + ' placed');
}

/* Imported net of every drawn pin — feeds the pin stubs and the properties. */
function rebuildPinNets(){
  S.pinNets = new Map();
  if (!S.netlist) return;
  const byRef = new Map();
  for (const p of S.parts) if (p.ref) byRef.set(p.ref.toUpperCase(), p);
  for (const net of S.netlist.nets) for (const node of net.nodes){
    const part = byRef.get(nodeRef(node));
    if (part) S.pinNets.set(part.id + '|' + pinNameFor(part, node), net.name);
  }
}

/* ------------------------------------------------------------------
   WIRE GEOMETRY — reshaping without ever losing orthogonality.

   A vertex that moves drags its neighbours along the axis of THEIR
   next segment, so every segment stays horizontal or vertical; an
   endpoint sitting on a pin never moves on its own — a bend is
   inserted next to it instead, exactly what a schematic editor does
   when you drag a wire away from a part.
   ------------------------------------------------------------------ */
const axisOf = (a, b) => (a.y === b.y ? 'h' : 'v');
/* Make sure vertex i has an INTERIOR neighbour on each side it has one at
   all (a duplicate endpoint becomes the new bend). Returns the new index. */
function ensureBends(pts, i){
  if (i > 0 && i - 1 === 0){ pts.splice(1, 0, { ...pts[0] }); i += 1; }
  if (i < pts.length - 1 && i + 1 === pts.length - 1) pts.push({ ...pts[pts.length - 1] });
  return i;
}
/* Neighbour N of the moved vertex V slides along its own next segment N→M,
   so V→N keeps its orientation. When N→M has no length yet (N is a bend
   that was just inserted on top of an endpoint) the orientation V→N had
   BEFORE the move decides which way N slides — the segment never turns
   diagonal. */
function followNeighbour(pts, i, dir, old){
  const n = i + dir, m = i + 2 * dir;
  if (n < 0 || n >= pts.length || m < 0 || m >= pts.length) return;
  const V = pts[i], N = pts[n], M = pts[m];
  let axis;                                      // axis of N→M, the one N slides along
  if (N.x !== M.x || N.y !== M.y) axis = axisOf(N, M);
  else if (old && old.y === N.y && old.x !== N.x) axis = 'v';      // V→N was horizontal: keep it so
  else if (old && old.x === N.x && old.y !== N.y) axis = 'h';      // V→N was vertical: keep it so
  else axis = Math.abs(V.x - N.x) >= Math.abs(V.y - N.y) ? 'v' : 'h';
  if (axis === 'h') N.x = V.x; else N.y = V.y;
}
/* Same for a SEGMENT (vertices i and i+1 both move): an endpoint at either
   end stays behind as a fresh bend. Returns the new index of the segment. */
function ensureSegBends(pts, i){
  if (i === 0){ pts.unshift({ ...pts[0] }); i = 1; }
  if (i + 1 === pts.length - 1) pts.push({ ...pts[pts.length - 1] });
  return i;
}
function moveVertex(pts, i, x, y){
  const old = { x:pts[i].x, y:pts[i].y };
  pts[i].x = x; pts[i].y = y;
  followNeighbour(pts, i, -1, old); followNeighbour(pts, i, +1, old);
}
/* A wire is only ever horizontal and vertical. Whatever produced a diagonal
   segment (an old session, a hand-edited file), it becomes an L here — the
   horizontal leg first. */
function orthogonalize(pts){
  const out = [];
  for (const p of pts){
    const a = out[out.length - 1];
    if (a && a.x !== p.x && a.y !== p.y) out.push({ x:p.x, y:a.y });
    out.push({ x:p.x, y:p.y });
  }
  return out;
}
/* Drop-time cleanup: only orthogonal segments, no zero-length ones, no
   collinear bends. */
function simplifyWire(pts){
  const o = orthogonalize(pts);
  let out = o.filter((p, i) => i === 0 || p.x !== o[i-1].x || p.y !== o[i-1].y);
  let changed = true;
  while (changed && out.length > 2){
    changed = false;
    for (let i = 1; i < out.length - 1; i++){
      const a = out[i-1], b = out[i], c = out[i+1];
      if ((a.x === b.x && b.x === c.x) || (a.y === b.y && b.y === c.y)){ out.splice(i, 1); changed = true; break; }
    }
  }
  return out;
}
/* ------------------------------------------------------------------
   RUBBER BAND. Wires whose vertices sit on the pins of the parts about
   to move, rotate or mirror: each such vertex remembers WHICH pin it is
   on, and once the parts have changed, rubberBandApply() puts every
   held vertex back on its pin. A wire whose held vertices all moved by
   the same amount simply translates; otherwise each held vertex is
   moved on its own and the wire bends next to it, staying orthogonal.
   ------------------------------------------------------------------ */
function rubberBandStart(parts){
  const pinAt = new Map();
  for (const part of parts) for (const pin of partPins(part)) pinAt.set(pin.x + ',' + pin.y, { part, pin:pin.local });
  const held = [];
  for (const wire of S.wires){
    const hits = [];
    wire.pts.forEach((pt, i) => { const a = pinAt.get(pt.x + ',' + pt.y); if (a) hits.push({ i, part:a.part, pin:a.pin, bent:false }); });
    if (hits.length) held.push({ wire, hits });
  }
  return held;
}
function rubberBandApply(held){
  for (const h of held){
    const pts = h.wire.pts;
    const targets = h.hits.map(t => ({ t, ...pinWorld(t.part, t.pin) }));
    const d = targets.map(({ t, x, y }) => ({ dx:x - pts[t.i].x, dy:y - pts[t.i].y }));
    if (targets.length >= 2 && d.every(v => v.dx === d[0].dx && v.dy === d[0].dy)){
      if (d[0].dx || d[0].dy) for (const p of pts){ p.x += d[0].dx; p.y += d[0].dy; }
      continue;
    }
    for (const { t, x, y } of targets){
      if (!t.bent){
        // a bend appears next to the held vertex so the rest of the wire can
        // stay where it is; the copies ensureBends() adds shift the other hits
        const before = pts.length;
        const ni = ensureBends(pts, t.i);
        const spliced = ni !== t.i, pushed = pts.length - before > (spliced ? 1 : 0);
        for (const u of h.hits){
          if (u === t) continue;
          if (spliced && u.i >= 1) u.i += 1;
          if (pushed && u.i === before + (spliced ? 1 : 0) - 1) u.i += 1;
        }
        t.i = ni; t.bent = true;
      }
      moveVertex(pts, t.i, x, y);
    }
  }
}
function rubberBandEnd(held){
  for (const h of held) h.wire.pts = simplifyWire(h.wire.pts);
  S.wires = S.wires.filter(w => w.pts.length > 1);
}

/* ---------------- render ---------------- */
function render(){
  applyView();
  S.lastCheck = checkDesign(S);            // live: every frame is a fresh reading
  renderRooms(); renderWires(); renderParts(); renderOverlay();
  renderStatus(); renderEmpty();
  if (!$('dockBody').contains(document.activeElement)) renderDock();
  else renderDockTabs();
  dockOnRender();
  updateHistButtons();
}
function renderRooms(){
  if (!S.showRooms || !S.rooms.length){ roomsG.innerHTML = ''; return; }
  roomsG.innerHTML = S.rooms.map(r => `
    <rect class="room" x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" rx="6"/>
    <text class="roomlbl" x="${r.x + 8}" y="${r.y + 16}">${esc(r.group)} · ${r.count}</text>`).join('');
}
function traceState(){
  if (!S.traceNet || !S.netlist) return null;
  const net = S.netlist.nets.find(n => n.name === S.traceNet);
  if (!net) return null;
  const pins = new Set(), parts = new Set();
  const byRef = new Map();
  for (const p of S.parts) if (p.ref) byRef.set(p.ref.toUpperCase(), p);
  for (const node of net.nodes){
    const part = byRef.get(nodeRef(node));
    if (!part) continue;
    parts.add(part.id); pins.add(part.id + '|' + pinNameFor(part, node));
  }
  const wires = new Set();
  const conn = S.lastCheck && S.lastCheck.conn;
  if (conn){
    const groups = new Set([...pins].map(pk => conn.groupOf.get(pk)).filter(Boolean));
    for (const [wid, g] of conn.wireGroup) if (groups.has(g)) wires.add(wid);
  }
  return { pins, parts, wires };
}
function renderWires(){
  const tr = traceState();
  const conn = S.lastCheck && S.lastCheck.conn;
  wiresG.innerHTML = S.wires.map(w => {
    const d = w.pts.map((p, i) => (i ? 'L' : 'M') + p.x + ' ' + p.y).join(' ');
    const dim = tr && !tr.wires.has(w.id) ? ' dim' : '';
    const on = S.sel && S.sel.type === 'wire' && S.sel.id === w.id;
    // one hit path per segment (its cursor says which way it slides), so the
    // wire can be reshaped straight on the sheet; the two ENDS of the
    // selected wire are grab targets too (unmarked — the cursor says so)
    const segs = w.pts.slice(1).map((p, i) => {
      const a = w.pts[i];
      return `<path class="wire hit ${axisOf(a, p) === 'h' ? 'segh' : 'segv'}" data-seg="${i}" d="M${a.x} ${a.y}L${p.x} ${p.y}"/>`;
    }).join('');
    const ends = on ? [0, w.pts.length - 1].map(i => `<circle class="vtx end" data-vtx="${i}" cx="${w.pts[i].x}" cy="${w.pts[i].y}" r="5"/>`).join('') : '';
    // the visible stroke first, the per-segment hit strips OVER it, the end
    // targets last — whatever is on top is what a press lands on
    return `<g class="wireg${dim}${on ? ' on' : ''}" data-wid="${w.id}"><path class="wire${on ? ' on' : ''}" d="${d}"/>${segs}${ends}</g>`;
  }).join('') + (conn ? conn.junctions.map(j => `<circle class="junction" cx="${j.x}" cy="${j.y}" r="2.4"/>`).join('') : '');
  wiresG.querySelectorAll('[data-wid]').forEach(g => g.addEventListener('pointerdown', ev => onWirePointerDown(ev, g.dataset.wid)));
}
function renderParts(){
  const tr = traceState();
  const conn = S.lastCheck && S.lastCheck.conn;
  partsG.innerHTML = S.parts.map(part => partSVG(part, tr, conn)).join('');
  partsG.querySelectorAll('[data-pid]').forEach(g => g.addEventListener('pointerdown', ev => onPartPointerDown(ev, g.dataset.pid)));
}
const short = (t, n) => { t = String(t || ''); return t.length > (n || 13) ? t.slice(0, (n || 13) - 1) + '…' : t; };
function partSVG(part, tr, conn){
  const def = defOf(part);
  const sdef = SYMBOLS[part.kind];
  const sel = S.selIds.has(part.id);
  const dim = tr && !tr.parts.has(part.id) ? ' dim' : '';
  const rot = part.rot || 0, mir = part.mir ? -1 : 1;
  let inner = `<g transform="rotate(${rot}) scale(${mir},1)">${symbolBodySVG(def, { names:false })}</g>`;

  // pin names, pin markers, ref/value and the imported net stub live OUTSIDE
  // the rotation so the text always reads level, whichever way the symbol is
  // turned (names on a top/bottom edge run vertically, as in any CAD tool)
  let deco = '';
  if (def.body && def.names) for (const pin of def.pins) deco += pinNameText(def, pin, rot, part.mir);
  for (const pin of (def.pins || [])){
    const p = rotPoint(pin.x, pin.y, rot, part.mir);
    const pk = part.id + '|' + pin.name;
    const g = conn && conn.groupOf.get(pk);
    const free = !g || (conn.members.get(g) || []).length < 2;
    // a connected pin end is bare; an open one carries a small hollow ring
    deco += `<circle class="pinend${conn && free ? ' free' : ''}" cx="${p.x}" cy="${p.y}" r="${conn && free ? 2 : 3}"><title>${esc(part.ref || '')}-${esc(pin.name)}${S.pinNets.has(pk) ? ' · ' + esc(S.pinNets.get(pk)) : ''}</title></circle>`;
    if (S.showStubs && S.pinNets.has(pk)){
      const dir = rotDir(pin.dir, rot, part.mir);
      const off = 5, ax = dir === 'l' ? 'end' : dir === 'r' ? 'start' : 'middle';
      const tx = p.x + (dir === 'l' ? -off : dir === 'r' ? off : 0);
      const ty = p.y + (dir === 't' ? -off : dir === 'b' ? off + 7 : -3.5);
      deco += `<text class="netstub" x="${tx}" y="${ty}" text-anchor="${ax}">${esc(short(S.pinNets.get(pk)))}</text>`;
    }
  }
  const b = localBounds(def, rot, part.mir);
  if (sdef.port === 'note'){
    inner = `<text class="note" x="0" y="0">${esc(part.text || '')}</text>`;
    deco = '';
  } else if (sdef.port === 'label'){
    // a net label is its text, sitting on the wire with its lower-left corner
    // at the anchor — the way schematic tools draw one
    inner = `<path class="sym" d="M0 0H6"/><text class="netlabel" x="2" y="-2">${esc(part.net || 'NET')}</text>`;
  } else if (sdef.port){
    deco += `<text class="value" x="${b.x + b.w / 2}" y="${b.y + b.h + 10}" text-anchor="middle">${esc(part.net || '')}</text>`;
  } else {
    // Designators go over/under the body for an IC and BESIDE a two-pin part
    // standing on end — under it is where its own net stub already sits.
    const above = !!def.body;
    const upright = !above && b.h > b.w;
    const tx = upright ? b.x + b.w + 6 : b.x + b.w / 2;
    const anchor = upright ? 'start' : 'middle';
    const y1 = above ? b.y - 6 : upright ? -2 : b.y + b.h + 11;
    const y2 = above ? b.y + b.h + 12 : upright ? 8 : b.y + b.h + 21;
    deco += `<text class="ref" x="${tx}" y="${y1}" text-anchor="${anchor}">${esc(part.ref || '')}</text>`;
    if (part.value || part.partNumber)
      deco += `<text class="value" x="${tx}" y="${y2}" text-anchor="${anchor}">${esc(part.value || part.partNumber)}</text>`;
    if (part.pick) deco += `<circle class="picked" cx="${b.x + b.w - 2}" cy="${b.y + 2}" r="2.4"><title>${esc(part.pick.pn)} · ${esc(part.pick.src || '')}</title></circle>`;
  }
  const hit = `<rect class="hit" x="${b.x}" y="${b.y}" width="${Math.max(b.w, 10)}" height="${Math.max(b.h, 10)}"/>`;
  return `<g class="part${sel ? ' selon' : ''}${dim}" data-pid="${part.id}" transform="translate(${part.x},${part.y})">${hit}${inner}${deco}</g>`;
}
function localBounds(def, rot, mir){
  const b = def.box || { x:-20, y:-20, w:40, h:40 };
  const cs = [[b.x,b.y],[b.x+b.w,b.y],[b.x,b.y+b.h],[b.x+b.w,b.y+b.h]].map(([x, y]) => rotPoint(x, y, rot, mir));
  const xs = cs.map(c => c.x), ys = cs.map(c => c.y);
  return { x:Math.min(...xs), y:Math.min(...ys), w:Math.max(...xs) - Math.min(...xs), h:Math.max(...ys) - Math.min(...ys) };
}
function renderOverlay(){
  let s = '';
  if (wireDraft && wireDraft.pts.length){
    const pts = [...wireDraft.pts, ...(wireDraft.preview || [])];
    s += `<path class="preview" d="${pts.map((p, i) => (i ? 'L' : 'M') + p.x + ' ' + p.y).join(' ')}"/>`;
  }
  if (S.place && S.place.x != null){
    const def = defOf({ kind:S.place.kind, pinNames:['1','2','3','4','5','6','7','8'] });
    s += `<g class="ghost" transform="translate(${S.place.x},${S.place.y})">
      <g transform="rotate(${S.place.rot}) scale(${S.place.mir ? -1 : 1},1)">${symbolBodySVG(def, {})}</g></g>`;
  }
  if (snapHint) s += `<circle class="snap" cx="${snapHint.x}" cy="${snapHint.y}" r="5"/>`;
  if (marquee) s += `<rect class="marquee" x="${Math.min(marquee.x0, marquee.x1)}" y="${Math.min(marquee.y0, marquee.y1)}"
      width="${Math.abs(marquee.x1 - marquee.x0)}" height="${Math.abs(marquee.y1 - marquee.y0)}"/>`;
  overlayG.innerHTML = s;
}
function renderEmpty(){ $('emptyState').hidden = S.parts.length > 0 || S.wires.length > 0; }
function renderSheetChip(){
  const n = S.selIds.size;
  $('sheetChip').innerHTML = `<b>${esc(S.project.title || 'Untitled circuit')}</b>
    <span class="crumb-sep">/</span> ${esc(S.project.revision ? 'rev ' + S.project.revision : 'rev —')}
    <span class="crumb-sep">/</span> ${Math.round(S.view.k * 100)}%
    <span class="crumb-sep">/</span> ${esc(S.place ? 'placing ' + SYMBOLS[S.place.kind].label : S.tool)}` +
    (n > 1 ? `<span class="crumb-sep">/</span> ${n} selected` : '');
}
function renderStatus(){
  const st = projectStats();
  const errs = S.lastCheck ? S.lastCheck.issues.filter(i => i.sev === 'err').length : 0;
  const warns = S.lastCheck ? S.lastCheck.issues.filter(i => i.sev === 'warn').length : 0;
  $('statusChips').innerHTML = [
    `<span class="chip">${st.placed} parts</span>`,
    `<span class="chip">${st.wires} wires</span>`,
    S.netlist ? `<span class="chip">${st.nets} nets imported</span>` : '',
    S.netlist ? `<span class="chip ${st.donePct === 100 ? 'ok' : ''}">${st.donePct}% wired</span>` : '',
    st.picked ? `<span class="chip">${st.picked} parts picked · ${dkFmtPrice(st.bom, st.cur)}</span>` : '',
    S.lastCheck ? `<button class="chip ${errs ? 'err' : warns ? 'warn' : 'ok'}" id="chipIssues"><span class="dot"></span>${errs} errors · ${warns} warnings</button>` : '',
    S.traceNet ? `<button class="chip warn" id="chipTrace">tracing ${esc(S.traceNet)} ✕</button>` : '',
  ].filter(Boolean).join('');
  if ($('chipIssues')) $('chipIssues').onclick = () => setPanel('messages');
  if ($('chipTrace')) $('chipTrace').onclick = () => { S.traceNet = null; render(); };
  renderSheetChip();
}
function toast(msg){
  const t = $('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 1800);
}

/* ---------------- picking helpers ---------------- */
function nearestPin(world, maxDist){
  let best = null;
  for (const part of S.parts) for (const pin of partPins(part)){
    const d = Math.hypot(pin.x - world.x, pin.y - world.y);
    if (d <= (maxDist || GRID) && (!best || d < best.d)) best = { d, x:pin.x, y:pin.y, part, pin };
  }
  return best;
}
/* A lattice point lying on some wire — where a new wire may end in a T. */
function pointOnWire(pt){
  for (const w of S.wires) for (let i = 0; i < w.pts.length - 1; i++){
    const a = w.pts[i], b = w.pts[i + 1];
    if (a.x === b.x && pt.x === a.x && pt.y >= Math.min(a.y, b.y) && pt.y <= Math.max(a.y, b.y)) return w;
    if (a.y === b.y && pt.y === a.y && pt.x >= Math.min(a.x, b.x) && pt.x <= Math.max(a.x, b.x)) return w;
  }
  return null;
}
function focusPart(id){
  const p = S.parts.find(x => x.id === id);
  if (!p) return;
  selectOnly('part', id); centerOn(p.x, p.y, Math.max(S.view.k, 1)); render(); renderDock();
}
function focusNet(name){
  const net = S.netlist && S.netlist.nets.find(n => n.name === name);
  if (!net) return;
  const byRef = new Map();
  for (const p of S.parts) if (p.ref) byRef.set(p.ref.toUpperCase(), p);
  const pts = [];
  for (const node of net.nodes){
    const part = byRef.get(nodeRef(node));
    if (part) pts.push(partBounds(part));
  }
  if (!pts.length) return;
  const minX = Math.min(...pts.map(b => b.x)), maxX = Math.max(...pts.map(b => b.x + b.w));
  const minY = Math.min(...pts.map(b => b.y)), maxY = Math.max(...pts.map(b => b.y + b.h));
  fitView({ x:minX - 40, y:minY - 40, w:Math.max(80, maxX - minX + 80), h:Math.max(80, maxY - minY + 80) });
}

/* ---------------- pointer interaction ---------------- */
let drag = null, wireDraft = null, snapHint = null, marquee = null;

function onPartPointerDown(ev, pid){
  if (S.tool === 'wire') return;             // the wire tool owns the click
  if (S.tool !== 'select') return;
  ev.stopPropagation();
  const part = S.parts.find(p => p.id === pid);
  if (!part) return;
  if (ev.shiftKey) toggleSel(pid);
  else if (!S.selIds.has(pid)) selectOnly('part', pid);
  else S.sel = { type:'part', id:pid };
  const w = toWorld(ev.clientX, ev.clientY);
  const parts = selectedParts();
  drag = { mode:'part', ids:parts.map(p => p.id), start:new Map(parts.map(p => [p.id, { x:p.x, y:p.y }])),
           ox:w.x, oy:w.y, held:null, moved:false };
  svg.setPointerCapture(ev.pointerId);
  render(); setPanel('properties');
}
function onWirePointerDown(ev, wid){
  if (S.tool !== 'select') return;
  ev.stopPropagation();
  const wire = S.wires.find(w => w.id === wid);
  if (!wire) return;
  selectOnly('wire', wid);
  const t = ev.target;
  const w = toWorld(ev.clientX, ev.clientY);
  if (t.dataset.vtx != null){
    drag = { mode:'vtx', wire, i:+t.dataset.vtx, moved:false, ox:w.x, oy:w.y };
  } else if (t.dataset.seg != null){
    const i = +t.dataset.seg;
    drag = { mode:'seg', wire, i, axis:axisOf(wire.pts[i], wire.pts[i + 1]), moved:false, ox:w.x, oy:w.y,
             y0:wire.pts[i].y, x0:wire.pts[i].x };
  }
  svg.setPointerCapture(ev.pointerId);
  render(); setPanel('properties');
}

svg.addEventListener('pointerdown', ev => {
  const w = toWorld(ev.clientX, ev.clientY);
  if (S.tool === 'select' && ev.shiftKey && ev.button === 0 && ev.target.id === 'bg'){
    marquee = { x0:w.x, y0:w.y, x1:w.x, y1:w.y };
    drag = { mode:'marquee' };
    svg.setPointerCapture(ev.pointerId);
    return;
  }
  if (ev.button === 1 || ev.button === 2 || S.tool === 'select'){
    // background press = pan, like the architecture editor
    if (!drag){
      drag = { mode:'pan', sx:ev.clientX, sy:ev.clientY, tx:S.view.tx, ty:S.view.ty, moved:false };
      svg.classList.add('panning'); svg.setPointerCapture(ev.pointerId);
      if (S.tool === 'select' && ev.target.id === 'bg' && !ev.shiftKey){ clearSel(); renderWires(); renderParts(); renderDock(); }
    }
    return;
  }
  if (ev.button !== 0) return;
  if (S.tool === 'place' && S.place){
    commit();
    const part = addPart(S.place.kind, w.x, w.y);
    part.rot = S.place.rot; part.mir = S.place.mir;
    rebuildPinNets(); prefillPortNet(part);
    selectOnly('part', part.id);
    render(); setPanel('properties');
    return;
  }
  if (S.tool === 'wire'){
    const snap = nearestPin(w, GRID);
    const pt = snap ? { x:snap.x, y:snap.y } : { x:snapView(w.x), y:snapView(w.y) };
    if (!wireDraft) wireDraft = { pts:[pt], preview:[], flip:false };
    else {
      wireDraft.pts = dedupe([...wireDraft.pts, ...elbow(wireDraft.pts[wireDraft.pts.length - 1], pt, wireDraft.flip)]);
      if (snap || pointOnWire(pt)) finishWire();
    }
    render();
  }
});
svg.addEventListener('pointermove', ev => {
  const w = toWorld(ev.clientX, ev.clientY);
  if (drag && drag.mode === 'pan'){
    const dx = ev.clientX - drag.sx, dy = ev.clientY - drag.sy;
    if (Math.abs(dx) + Math.abs(dy) > 2) drag.moved = true;
    S.view.tx = drag.tx + dx; S.view.ty = drag.ty + dy;
    applyView();
    return;
  }
  if (drag && drag.mode === 'marquee'){
    marquee.x1 = w.x; marquee.y1 = w.y; renderOverlay(); return;
  }
  if (drag && drag.mode === 'part'){
    const first = S.parts.find(p => p.id === drag.ids[0]);
    if (!first) return;
    const s0 = drag.start.get(first.id);
    const nx = snapView(s0.x + (w.x - drag.ox)), ny = snapView(s0.y + (w.y - drag.oy));
    const ddx = nx - first.x, ddy = ny - first.y;
    if (!ddx && !ddy) return;
    if (!drag.moved){ drag.moved = true; commit(); drag.held = rubberBandStart(selectedParts()); }
    for (const id of drag.ids){ const p = S.parts.find(x => x.id === id); if (p){ p.x += ddx; p.y += ddy; } }
    rubberBandApply(drag.held);
    renderWires(); renderParts();
    return;
  }
  if (drag && (drag.mode === 'vtx' || drag.mode === 'seg')){
    const pts = drag.wire.pts;
    if (!drag.moved){
      const moved = Math.abs(w.x - drag.ox) + Math.abs(w.y - drag.oy) > GRID / 2;
      if (!moved) return;
      drag.moved = true; commit();
      // bends appear where an endpoint would otherwise leave its pin
      drag.i = drag.mode === 'vtx' ? ensureBends(pts, drag.i) : ensureSegBends(pts, drag.i);
    }
    if (drag.mode === 'vtx'){
      const snap = drag.i === 0 || drag.i === pts.length - 1 ? nearestPin(w, GRID) : null;
      const nx = snap ? snap.x : snapView(w.x), ny = snap ? snap.y : snapView(w.y);
      moveVertex(pts, drag.i, nx, ny);
    } else {
      const a = pts[drag.i], b = pts[drag.i + 1];
      if (drag.axis === 'h'){ const ny = snapView(w.y); a.y = ny; b.y = ny; }
      else { const nx = snapView(w.x); a.x = nx; b.x = nx; }
    }
    renderWires();
    return;
  }
  if (S.tool === 'place' && S.place){
    S.place.x = snapView(w.x); S.place.y = snapView(w.y);
    renderOverlay();
    return;
  }
  if (S.tool === 'wire'){
    const snap = nearestPin(w, GRID);
    const pt = snap ? { x:snap.x, y:snap.y } : { x:snapView(w.x), y:snapView(w.y) };
    snapHint = snap || pointOnWire(pt) ? pt : null;
    if (wireDraft) wireDraft.preview = elbow(wireDraft.pts[wireDraft.pts.length - 1], pt, wireDraft.flip);
    renderOverlay();
  }
});
svg.addEventListener('pointerup', ev => {
  if (!drag) return;
  if (drag.mode === 'pan') svg.classList.remove('panning');
  else if (drag.mode === 'marquee'){
    const x0 = Math.min(marquee.x0, marquee.x1), x1 = Math.max(marquee.x0, marquee.x1);
    const y0 = Math.min(marquee.y0, marquee.y1), y1 = Math.max(marquee.y0, marquee.y1);
    const hit = S.parts.filter(p => { const b = partBounds(p); return b.x >= x0 && b.x + b.w <= x1 && b.y >= y0 && b.y + b.h <= y1; });
    S.selIds = new Set(hit.map(p => p.id)); S.sel = hit.length ? { type:'part', id:hit[0].id } : null;
    marquee = null; render(); renderDock();
  }
  else if (drag.mode === 'part' && drag.moved){ rubberBandEnd(drag.held); rebuildPinNets(); render(); }
  else if ((drag.mode === 'vtx' || drag.mode === 'seg') && drag.moved){
    drag.wire.pts = simplifyWire(drag.wire.pts);
    S.wires = S.wires.filter(x => x.pts.length > 1);
    render(); renderDock();
  }
  drag = null;
});
svg.addEventListener('dblclick', () => { if (wireDraft) finishWire(); });
svg.addEventListener('contextmenu', ev => { ev.preventDefault(); if (wireDraft) finishWire(); else cancelTool(); });
svg.addEventListener('wheel', ev => {
  ev.preventDefault();
  const r = svg.getBoundingClientRect();
  zoomAbout(ev.deltaY < 0 ? 1.12 : 0.89, ev.clientX - r.left, ev.clientY - r.top);
}, { passive:false });

/* An orthogonal elbow from a to b — the leg along the bigger delta first,
   or the other way round when the wire tool has been flipped with Space. */
function elbow(a, b, flip){
  if (a.x === b.x || a.y === b.y) return [{ x:b.x, y:b.y }];
  const hFirst = (Math.abs(b.x - a.x) >= Math.abs(b.y - a.y)) !== !!flip;
  return hFirst ? [{ x:b.x, y:a.y }, { x:b.x, y:b.y }] : [{ x:a.x, y:b.y }, { x:b.x, y:b.y }];
}
const dedupe = pts => pts.filter((p, i) => i === 0 || p.x !== pts[i-1].x || p.y !== pts[i-1].y);
function finishWire(){
  if (wireDraft && wireDraft.pts.length > 1){
    commit();
    S.wires.push({ id:newId('w'), pts:simplifyWire(wireDraft.pts) });
  }
  wireDraft = null; snapHint = null;
  render();
}
function cancelTool(){
  if (wireDraft && wireDraft.pts.length > 1){ finishWire(); return; }   // Esc keeps what is drawn
  wireDraft = null; snapHint = null; S.place = null; marquee = null;
  if (S.tool !== 'select') setTool('select');
  else { clearSel(); render(); renderDock(); }
}

/* drag & drop from the Components panel */
svg.addEventListener('dragover', ev => { ev.preventDefault(); ev.dataTransfer.dropEffect = 'copy'; });
svg.addEventListener('drop', ev => {
  const kind = ev.dataTransfer.getData('text/symbol');
  if (!kind || !SYMBOLS[kind]) return;
  ev.preventDefault();
  const w = toWorld(ev.clientX, ev.clientY);
  commit();
  const part = addPart(kind, w.x, w.y);
  rebuildPinNets(); prefillPortNet(part);
  selectOnly('part', part.id);
  render(); setPanel('properties');
});

/* ---------------- rules check ---------------- */
function runCheck(quiet){
  S.lastCheck = checkDesign(S);
  if (!quiet){
    const e = S.lastCheck.issues.filter(i => i.sev === 'err').length;
    const w = S.lastCheck.issues.filter(i => i.sev === 'warn').length;
    toast(e || w ? `${e} errors, ${w} warnings` : 'No errors');
    setPanel('messages');
  }
  render();
}

/* ---------------- import / export ---------------- */
function openModal(title, bodyHTML, footHTML){
  $('modalTitle').textContent = title;
  $('modalBody').innerHTML = bodyHTML;
  $('modalFoot').innerHTML = footHTML || '';
  $('modalOverlay').classList.add('open');
}
function closeModal(){ $('modalOverlay').classList.remove('open'); }
$('modalClose').onclick = closeModal;
$('modalOverlay').onclick = ev => { if (ev.target.id === 'modalOverlay') closeModal(); };

function openImport(){
  openModal('Import', `
    <div class="tabs"><button class="on" data-itab="file">File</button><button data-itab="paste">Paste JSON</button><button data-itab="sample">Sample</button></div>
    <div data-ipane="file">
      <p class="hint">A <b>circuit_data.json</b> netlist (components + nets), or a session saved from this editor.</p>
      <input type="file" id="impFile" accept="application/json">
    </div>
    <div data-ipane="paste" hidden>
      <p class="hint">Paste the netlist JSON.</p>
      <textarea id="impText" placeholder='[{"components":[…],"nets":[…]}]'></textarea>
    </div>
    <div data-ipane="sample" hidden>
      <p class="hint">The bundled example netlist: 236 components, 192 nets, HV supply with isolated feedback.</p>
      <button id="impSample">Load sample/circuit_data.json</button>
    </div>`,
    `<button id="impPasteGo">Import pasted JSON</button><button class="primary" id="impClose">Close</button>`);
  const show = t => {
    document.querySelectorAll('[data-itab]').forEach(b => b.classList.toggle('on', b.dataset.itab === t));
    document.querySelectorAll('[data-ipane]').forEach(p => p.hidden = p.dataset.ipane !== t);
  };
  document.querySelectorAll('[data-itab]').forEach(b => b.onclick = () => show(b.dataset.itab));
  $('impFile').onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    try { importAny(JSON.parse(await f.text()), f.name); closeModal(); }
    catch (err){ toast('Import failed: ' + err.message); }
  };
  $('impPasteGo').onclick = () => {
    try { importAny(JSON.parse($('impText').value), 'pasted'); closeModal(); }
    catch (err){ toast('Import failed: ' + err.message); }
  };
  $('impSample').onclick = async () => {
    try {
      const res = await fetch('sample/circuit_data.json');
      importAny(await res.json(), 'sample/circuit_data.json'); closeModal();
    } catch (err){ toast('Could not load the sample: ' + err.message); }
  };
  $('impClose').onclick = closeModal;
}
function importAny(data, name){
  if (data && data.parts && data.wires){ loadSession(data); toast('Session restored'); return; }
  const nl = parseCircuitData(data);
  commit();
  nl.source = name;
  S.netlist = nl;
  S.parts = partsFromNetlist(nl);
  S.wires = [];
  S.rooms = arrangeParts(S.parts);
  if (nl.title && !S.project.code) S.project.title = nl.title;
  $('projTitle').textContent = S.project.title;
  clearSel(); S.traceNet = null;
  rebuildPinNets();
  fitView();
  toast(`${nl.components.length} components · ${nl.nets.length} nets`);
}
function sessionJSON(){
  return JSON.stringify({
    format:'circuit-editor/1', project:S.project, parts:S.parts, wires:S.wires,
    rooms:S.rooms, netlist:S.netlist, view:S.view, showRooms:S.showRooms, showStubs:S.showStubs,
  });
}
function loadSession(d){
  S.project = { ...S.project, ...(d.project || {}) };
  S.parts = d.parts || []; S.rooms = d.rooms || [];
  // whatever the file says, a wire on this sheet is orthogonal
  S.wires = (d.wires || []).map(w => ({ ...w, pts:simplifyWire(w.pts || []) })).filter(w => w.pts.length > 1);
  S.netlist = d.netlist || null;
  if (d.view) S.view = d.view;
  if (d.showRooms != null) S.showRooms = d.showRooms;
  if (d.showStubs != null) S.showStubs = d.showStubs;
  clearSel();
  $('projTitle').textContent = S.project.title || 'Untitled circuit';
  rebuildPinNets(); render();
}
function download(name, text, type){
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type:type || 'application/json' }));
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
/* The bill of materials as the sheet stands: one line per component, with
   whatever the distributor search has pinned to it. */
function bomCSV(){
  const q = s => '"' + String(s == null ? '' : s).replace(/"/g, '""') + '"';
  const head = ['Ref','Symbol','Value','Part number','Manufacturer','Distributor','Unit price','Currency','Stock','Datasheet','Group','Role'];
  const rows = S.parts.filter(p => !(SYMBOLS[p.kind] && SYMBOLS[p.kind].port))
    .sort((a, b) => String(a.ref).localeCompare(String(b.ref), undefined, { numeric:true }))
    .map(p => [p.ref, SYMBOLS[p.kind].label, p.value, p.partNumber, p.pick ? p.pick.man : '', p.pick ? p.pick.src : '',
      p.pick && p.pick.price != null ? p.pick.price : '', p.pick ? p.pick.currency : '', p.pick ? p.pick.stock : '',
      p.pick ? p.pick.datasheet : '', p.group, p.role].map(q).join(','));
  return [head.map(q).join(','), ...rows].join('\n');
}
function openExport(){
  const session = sessionJSON();
  const netlist = JSON.stringify(netlistFromSheet(S), null, 2);
  const bom = bomCSV();
  openModal('Export', `
    <div class="tabs"><button class="on" data-etab="session">Session</button><button data-etab="netlist">Drawn netlist</button><button data-etab="bom">BOM</button><button data-etab="svg">Sheet SVG</button></div>
    <div data-epane="session"><p class="hint">Everything: project fields, placed symbols, wires and the imported netlist.</p>
      <pre class="out">${esc(session.slice(0, 4000))}${session.length > 4000 ? '\n…' : ''}</pre>
      <div class="btnrow"><button id="dlSession" class="primary">Download session.json</button></div></div>
    <div data-epane="netlist" hidden><p class="hint">What the drawing itself says, in circuit_data.json shape — diff it against the imported netlist.</p>
      <pre class="out">${esc(netlist.slice(0, 4000))}${netlist.length > 4000 ? '\n…' : ''}</pre>
      <div class="btnrow"><button id="dlNetlist" class="primary">Download circuit_data.json</button></div></div>
    <div data-epane="bom" hidden><p class="hint">One line per component with the part picked on DigiKey / Mouser, its price and stock.</p>
      <pre class="out">${esc(bom.slice(0, 4000))}${bom.length > 4000 ? '\n…' : ''}</pre>
      <div class="btnrow"><button id="dlBom" class="primary">Download bom.csv</button></div></div>
    <div data-epane="svg" hidden><p class="hint">The sheet as vector art, for reports and reviews.</p>
      <div class="btnrow"><button id="dlSvg" class="primary">Download sheet.svg</button></div></div>`,
    `<button class="primary" id="expClose">Close</button>`);
  const show = t => {
    document.querySelectorAll('[data-etab]').forEach(b => b.classList.toggle('on', b.dataset.etab === t));
    document.querySelectorAll('[data-epane]').forEach(p => p.hidden = p.dataset.epane !== t);
  };
  document.querySelectorAll('[data-etab]').forEach(b => b.onclick = () => show(b.dataset.etab));
  $('dlSession').onclick = () => download('session.json', session);
  $('dlNetlist').onclick = () => download('circuit_data.json', netlist);
  $('dlBom').onclick = () => download('bom.csv', bom, 'text/csv');
  $('dlSvg').onclick = () => download('sheet.svg', sheetSVG(), 'image/svg+xml');
  $('expClose').onclick = closeModal;
}
function sheetSVG(){
  const b = sheetBounds() || { x:0, y:0, w:100, h:100 };
  const pad = 40;
  // the printed sheet: the light schematic palette, whatever theme is on screen
  const css = `<style>
    .sym{fill:none;stroke:#000080;stroke-width:1.4;stroke-linecap:round;stroke-linejoin:round}
    .symbody{fill:#FFFFB2;stroke:#000080;stroke-width:1.4;stroke-linejoin:round}.symfill{fill:#000080;stroke:none}
    .icbody{fill:#FFFFB2;stroke:#000080;stroke-width:1.4}.pinmark{fill:#000080;stroke:none}
    .pinline{stroke:#000080;stroke-width:1.4}.pinend{fill:none;stroke:none}.pinend.free{stroke:#C43E1C;stroke-width:1.4}.picked{fill:#3D7A46}
    .wire{fill:none;stroke:#000080;stroke-width:1.6;stroke-linecap:square;stroke-linejoin:miter}.wire.hit,.vtx,.hit{display:none}.junction{fill:#800000}
    .ref{font:bold 11px 'Times New Roman',Tinos,serif;fill:#000080}.value{font:10px 'Times New Roman',Tinos,serif;fill:#000080}
    .netlabel{font:bold 10.5px 'Times New Roman',Tinos,serif;fill:#000080}
    .netstub{font:8px 'Times New Roman',Tinos,serif;fill:#4A5A72}.pinname{font:8px 'Times New Roman',Tinos,serif;fill:#000080}
    .room{fill:none;stroke:#DEDACC;stroke-width:1.5;stroke-dasharray:6 5}.roomlbl{font:11.5px 'Times New Roman',Tinos,serif;fill:#4A5A72}
    .note{font:12px 'Times New Roman',Tinos,serif;fill:#1B2A41}</style>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${b.x - pad} ${b.y - pad} ${b.w + 2*pad} ${b.h + 2*pad}" width="${Math.round(b.w + 2*pad)}" height="${Math.round(b.h + 2*pad)}">
    ${css}<rect x="${b.x - pad}" y="${b.y - pad}" width="${b.w + 2*pad}" height="${b.h + 2*pad}" fill="#FFFFFF"/>
    ${roomsG.innerHTML}${partsG.innerHTML}${wiresG.innerHTML}</svg>`;
}

/* ---------------- keyboard ---------------- */
document.addEventListener('keydown', ev => {
  const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
  if ((ev.ctrlKey || ev.metaKey) && !typing){
    const k = ev.key.toLowerCase();
    if (k === 'z' && !ev.shiftKey){ ev.preventDefault(); undo(); return; }
    if (k === 'y' || (k === 'z' && ev.shiftKey)){ ev.preventDefault(); redo(); return; }
    if (k === 's'){ ev.preventDefault(); download('session.json', sessionJSON()); return; }
    if (k === 'd'){ ev.preventDefault(); duplicateSel(); return; }
    if (k === 'a'){ ev.preventDefault(); S.selIds = new Set(S.parts.map(p => p.id)); S.sel = S.parts[0] ? { type:'part', id:S.parts[0].id } : null; render(); return; }
  }
  if (typing) return;
  if (ev.key === 'Escape'){ cancelTool(); return; }
  if (ev.key === 'Delete' || ev.key === 'Backspace'){ ev.preventDefault(); deleteSel(); return; }
  if (ev.key === ' ' && wireDraft){ ev.preventDefault(); wireDraft.flip = !wireDraft.flip; return; }
  if (ev.key.startsWith('Arrow')){
    ev.preventDefault();
    const step = Math.min(gridPitch(), SNAP_MAX) * (ev.shiftKey ? 4 : 1);
    nudgeSel(ev.key === 'ArrowLeft' ? -step : ev.key === 'ArrowRight' ? step : 0,
             ev.key === 'ArrowUp' ? -step : ev.key === 'ArrowDown' ? step : 0);
    return;
  }
  const k = ev.key.toLowerCase();
  if (k === 'r'){ rotateSel(); return; }
  if (k === 'm'){ mirrorSel(); return; }
  if (k === 'f'){ if (ev.shiftKey) fitSelection(); else fitView(); return; }
  const tool = TOOLS.find(t => t.key.toLowerCase() === k);
  if (tool) setTool(tool.id);
});

/* ---------------- boot ---------------- */
$('btnUndo').onclick = undo;
$('btnRedo').onclick = redo;
$('btnImport').onclick = openImport;
$('btnExport').onclick = openExport;
$('btnCheck').onclick = () => runCheck();
$('btnArrange').onclick = () => {
  if (!S.parts.length) return;
  commit(); S.rooms = arrangeParts(S.parts); fitView(); toast('Re-arranged by functional group');
};
$('btnZoomIn').onclick = () => zoomStep(+1);
$('btnZoomOut').onclick = () => zoomStep(-1);
$('btnZoomFit').onclick = () => fitView();
$('emptyImport').onclick = openImport;
$('emptyBlank').onclick = () => { commit(); S.parts = []; S.wires = []; S.rooms = []; setTool('select'); render(); toast('Blank sheet — drag parts in from Components'); };

initDock();
renderToolbar();
DB.loadIndex().then(n => { if (n) renderDock(); });
try {
  const saved = localStorage.getItem('circuit_session');
  if (saved) loadSession(JSON.parse(saved));
} catch(e){}
render();
if (!S.parts.length) fitView({ x:-400, y:-300, w:800, h:600 });

if (typeof window !== 'undefined') window.__CE = {
  S, render, importAny, runCheck, setTool, startPlace, addPart, fitView, toWorld, snapView,
  connectivity, checkDesign, netlistFromSheet, partsFromNetlist, arrangeParts, parseCircuitData,
  setPanel, dock, renderDock, renderDockTabs, stepPanel, tabNeighbour, updateTabOverflow,
  DB, finishWire, sheetBounds, selectOnly, toggleSel, clearSel,
  moveVertex, ensureBends, ensureSegBends, simplifyWire, orthogonalize, rubberBandStart, rubberBandApply, rubberBandEnd,
  rotateSel, mirrorSel, duplicateSel, nudgeSel, bomCSV, loadSession, sheetSVG,
  get wireDraft(){ return wireDraft; }, set wireDraft(v){ wireDraft = v; },
};
