/* ==================================================================
   app.js — sheet, view, tools and the glue between them.

   The document is small on purpose:
     S.parts  placed symbols (components, power ports, labels, notes)
     S.wires  orthogonal polylines
     S.netlist the imported circuit_data.json — the golden connectivity
   Everything else (nets, junctions, checks) is DERIVED, never stored,
   so the drawing can never disagree with itself.
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
  sel: null, tool:'select', place:null, traceNet:null, lastCheck:null,
  pinNets: new Map(), showRooms:true, showStubs:true,
  ui: { libQuery:'', netQuery:'', netFilter:'all', dbQuery:'', dbSel:null },
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
  S.sel = null; rebuildPinNets(); render();
}
function undo(){ if (!HIST.undo.length) return; HIST.redo.push(snapshot()); restore(HIST.undo.pop()); updateHistButtons(); }
function redo(){ if (!HIST.redo.length) return; HIST.undo.push(snapshot()); restore(HIST.redo.pop()); updateHistButtons(); }
function updateHistButtons(){ $('btnUndo').disabled = !HIST.undo.length; $('btnRedo').disabled = !HIST.redo.length; }

let autosaveT = null;
function scheduleAutosave(){
  clearTimeout(autosaveT);
  autosaveT = setTimeout(() => {
    try { localStorage.setItem('circuit_session', sessionJSON()); } catch(e){}
  }, 800);
}

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
function sheetBounds(){
  const bs = S.parts.map(partBounds);
  for (const w of S.wires) for (const p of w.pts) bs.push({ x:p.x, y:p.y, w:0, h:0 });
  if (!bs.length) return null;
  const minX = Math.min(...bs.map(b => b.x)), maxX = Math.max(...bs.map(b => b.x + b.w));
  const minY = Math.min(...bs.map(b => b.y)), maxY = Math.max(...bs.map(b => b.y + b.h));
  return { x:minX, y:minY, w:Math.max(1, maxX - minX), h:Math.max(1, maxY - minY) };
}
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
  { id:'select', key:'S', title:'Select / move (S)', icon:'<path d="M5 3l14 7-6 1.6L10 18z"/>' },
  { id:'wire',   key:'W', title:'Place wire (W)',    icon:'<path d="M3 17h6V7h6v10h6"/><circle cx="3" cy="17" r="1.8"/><circle cx="21" cy="17" r="1.8"/>' },
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
     <button data-act="rot" title="Rotate selection (R)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8 8 0 1 1-2.3-5.6M20 4v5h-5"/></svg></button>
     <button data-act="mir" title="Mirror selection (M)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v18M7 7l-4 5 4 5zM17 7l4 5-4 5z"/></svg></button>
     <button data-act="del" title="Delete selection (Del)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg></button>`;
  $('toolbar').querySelectorAll('[data-tool]').forEach(b => b.onclick = () => setTool(b.dataset.tool));
  $('toolbar').querySelectorAll('[data-act]').forEach(b => b.onclick = () => {
    const a = b.dataset.act;
    if (a === 'rot') rotateSel(); else if (a === 'mir') mirrorSel(); else deleteSel();
  });
}
function setTool(t){
  S.tool = t; S.place = null; wireDraft = null;
  if (t === 'label') startPlace('netlabel');
  else if (t === 'gnd') startPlace('gnd');
  else if (t === 'power') startPlace('vcc');
  else if (t === 'text') startPlace('note');
  svg.classList.toggle('drawing', t === 'wire');
  svg.classList.toggle('placing', t === 'place');
  renderToolbar(); render();
}
function startPlace(kind){
  S.place = { kind, rot:0, mir:0, x:0, y:0 };
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
function deletePart(id){
  S.parts = S.parts.filter(p => p.id !== id);
  if (S.sel && S.sel.id === id) S.sel = null;
  rebuildPinNets(); render();
}
function deleteSel(){
  if (!S.sel) return;
  commit();
  if (S.sel.type === 'wire') S.wires = S.wires.filter(w => w.id !== S.sel.id);
  else S.parts = S.parts.filter(p => p.id !== S.sel.id);
  S.sel = null; rebuildPinNets(); render(); renderDock();
}
function rotateSel(){
  if (S.place){ S.place.rot = ((S.place.rot || 0) + 90) % 360; renderOverlay(); return; }
  if (!S.sel || S.sel.type !== 'part') return;
  commit();
  const p = S.parts.find(x => x.id === S.sel.id);
  p.rot = ((p.rot || 0) + 90) % 360; render(); renderDock();
}
function mirrorSel(){
  if (S.place){ S.place.mir = S.place.mir ? 0 : 1; renderOverlay(); return; }
  if (!S.sel || S.sel.type !== 'part') return;
  commit();
  const p = S.parts.find(x => x.id === S.sel.id);
  p.mir = p.mir ? 0 : 1; render(); renderDock();
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
  S.parts.push(p); S.sel = { type:'part', id:p.id };
  rebuildPinNets(); render(); renderDock();
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

/* ---------------- render ---------------- */
function render(){
  applyView();
  renderRooms(); renderWires(); renderParts(); renderOverlay();
  renderStatus(); renderEmpty();
  if (!$('dockBody').contains(document.activeElement)) renderDock();
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
    const on = S.sel && S.sel.type === 'wire' && S.sel.id === w.id ? ' on' : '';
    return `<g class="wireg${dim}" data-wid="${w.id}"><path class="wire hit" d="${d}"/><path class="wire${on}" d="${d}"/></g>`;
  }).join('') + (conn ? conn.junctions.map(j => `<circle class="junction" cx="${j.x}" cy="${j.y}" r="2.6"/>`).join('') : '');
  wiresG.querySelectorAll('[data-wid]').forEach(g => g.addEventListener('pointerdown', ev => {
    if (S.tool !== 'select') return;
    ev.stopPropagation();
    S.sel = { type:'wire', id:g.dataset.wid }; render(); renderDock();
  }));
}
function renderParts(){
  const tr = traceState();
  const conn = S.lastCheck && S.lastCheck.conn;
  partsG.innerHTML = S.parts.map(part => partSVG(part, tr, conn)).join('');
  partsG.querySelectorAll('[data-pid]').forEach(g => {
    g.addEventListener('pointerdown', ev => onPartPointerDown(ev, g.dataset.pid));
    g.addEventListener('dblclick', ev => { ev.stopPropagation(); S.sel = { type:'part', id:g.dataset.pid }; setPanel('properties'); });
  });
}
function partSVG(part, tr, conn){
  const def = defOf(part);
  const sdef = SYMBOLS[part.kind];
  const sel = S.sel && S.sel.type === 'part' && S.sel.id === part.id;
  const dim = tr && !tr.parts.has(part.id) ? ' dim' : '';
  const rot = part.rot || 0, mir = part.mir ? -1 : 1;
  let inner = `<g transform="rotate(${rot}) scale(${mir},1)">${symbolBodySVG(def, {})}</g>`;

  // pins, ref/value and the imported net stub live OUTSIDE the rotation so
  // the text always reads level, whichever way the symbol is turned
  let deco = '';
  for (const pin of (def.pins || [])){
    const p = rotPoint(pin.x, pin.y, rot, part.mir);
    const pk = part.id + '|' + pin.name;
    const g = conn && conn.groupOf.get(pk);
    const free = !g || (conn.members.get(g) || []).length < 2;
    deco += `<circle class="pindot${conn && free ? ' free' : ''}" cx="${p.x}" cy="${p.y}" r="2"/>`;
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
    const w = Math.max(30, String(part.net || 'NET').length * 6 + 14);
    inner = `<path class="sym" d="M0 0H8M8 -7H${w}L${w + 6} 0L${w} 7H8Z"/>` +
            `<text class="ref" x="13" y="3">${esc(part.net || 'NET')}</text>`;
  } else if (sdef.port){
    deco += `<text class="value" x="${b.x + b.w / 2}" y="${b.y + b.h + 10}" text-anchor="middle">${esc(part.net || '')}</text>`;
  } else {
    // Where the designators go: over/under the body for an IC, and beside a
    // two-pin part standing on end — under it is exactly where its own net
    // stub already sits, and the two would print on top of each other.
    const above = !!def.body;
    const upright = !above && b.h > b.w;
    const tx = upright ? b.x + b.w + 6 : b.x + b.w / 2;
    const anchor = upright ? 'start' : 'middle';
    const y1 = above ? b.y - 6 : upright ? -2 : b.y + b.h + 11;
    const y2 = above ? b.y + b.h + 12 : upright ? 8 : b.y + b.h + 21;
    deco += `<text class="ref" x="${tx}" y="${y1}" text-anchor="${anchor}">${esc(part.ref || '')}</text>`;
    if (part.value || part.partNumber)
      deco += `<text class="value" x="${tx}" y="${y2}" text-anchor="${anchor}">${esc(part.value || part.partNumber)}</text>`;
  }
  const hit = `<rect class="hit" x="${b.x}" y="${b.y}" width="${Math.max(b.w, 10)}" height="${Math.max(b.h, 10)}"/>`;
  return `<g class="part${sel ? ' selon' : ''}${dim}" data-pid="${part.id}" transform="translate(${part.x},${part.y})">${hit}${inner}${deco}</g>`;
}
const short = (t, n) => { t = String(t || ''); return t.length > (n || 13) ? t.slice(0, (n || 13) - 1) + '…' : t; };
function localBounds(def, rot, mir){
  const b = def.box || { x:-20, y:-20, w:40, h:40 };
  const cs = [[b.x,b.y],[b.x+b.w,b.y],[b.x,b.y+b.h],[b.x+b.w,b.y+b.h]].map(([x, y]) => rotPoint(x, y, rot, mir));
  const xs = cs.map(c => c.x), ys = cs.map(c => c.y);
  return { x:Math.min(...xs), y:Math.min(...ys), w:Math.max(...xs) - Math.min(...xs), h:Math.max(...ys) - Math.min(...ys) };
}
function rotDir(dir, rot, mir){
  const order = ['r','b','l','t'];
  let i = order.indexOf(dir);
  if (i < 0) return dir;
  if (mir && (dir === 'l' || dir === 'r')) i = order.indexOf(dir === 'l' ? 'r' : 'l');
  return order[(i + Math.round(((rot % 360) + 360) % 360 / 90)) % 4];
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
  overlayG.innerHTML = s;
}
function renderEmpty(){ $('emptyState').hidden = S.parts.length > 0 || S.wires.length > 0; }
function renderSheetChip(){
  $('sheetChip').innerHTML = `<b>${esc(S.project.title || 'Untitled circuit')}</b>
    <span class="crumb-sep">/</span> ${esc(S.project.revision ? 'rev ' + S.project.revision : 'rev —')}
    <span class="crumb-sep">/</span> ${Math.round(S.view.k * 100)}%
    <span class="crumb-sep">/</span> ${esc(S.place ? 'placing ' + SYMBOLS[S.place.kind].label : S.tool)}`;
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
function focusPart(id){
  const p = S.parts.find(x => x.id === id);
  if (!p) return;
  S.sel = { type:'part', id }; centerOn(p.x, p.y, Math.max(S.view.k, 1)); render(); renderDock();
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
let drag = null, wireDraft = null, snapHint = null;

function onPartPointerDown(ev, pid){
  if (S.tool === 'wire'){ return; }          // the wire tool owns the click
  if (S.tool !== 'select') return;
  ev.stopPropagation();
  const part = S.parts.find(p => p.id === pid);
  if (!part) return;
  S.sel = { type:'part', id:pid };
  const w = toWorld(ev.clientX, ev.clientY);
  // wire vertices sitting on this part's pins travel with it
  const pinPts = partPins(part).map(p => p.x + ',' + p.y);
  const stuck = [];
  for (const wire of S.wires) wire.pts.forEach((pt, i) => {
    if (pinPts.includes(pt.x + ',' + pt.y)) stuck.push({ wire, i, x:pt.x, y:pt.y });
  });
  drag = { mode:'part', id:pid, dx:w.x - part.x, dy:w.y - part.y, x0:part.x, y0:part.y, stuck, moved:false };
  svg.setPointerCapture(ev.pointerId);
  render(); renderDock();
}

svg.addEventListener('pointerdown', ev => {
  if (ev.button === 1 || ev.button === 2 || ev.shiftKey || S.tool === 'select'){
    // background press with the select tool = pan, like the architecture editor
    if (!drag){
      drag = { mode:'pan', sx:ev.clientX, sy:ev.clientY, tx:S.view.tx, ty:S.view.ty, moved:false };
      svg.classList.add('panning'); svg.setPointerCapture(ev.pointerId);
      if (S.tool === 'select' && ev.target.id === 'bg'){ S.sel = null; renderDock(); }
    }
    return;
  }
  const w = toWorld(ev.clientX, ev.clientY);
  if (S.tool === 'place' && S.place){
    commit();
    const kind = S.place.kind;
    const part = addPart(kind, w.x, w.y);
    part.rot = S.place.rot; part.mir = S.place.mir;
    const pin = nearestPin({ x:part.x, y:part.y }, 0);
    S.sel = { type:'part', id:part.id };
    if (!ev.shiftKey && SYMBOLS[kind].port !== 'label') { /* keep placing */ }
    rebuildPinNets(); render(); renderDock();
    return;
  }
  if (S.tool === 'wire'){
    const snap = nearestPin(w, GRID);
    const pt = snap ? { x:snap.x, y:snap.y } : { x:snapView(w.x), y:snapView(w.y) };
    if (!wireDraft) wireDraft = { pts:[pt], preview:[] };
    else {
      const pts = [...wireDraft.pts, ...elbow(wireDraft.pts[wireDraft.pts.length - 1], pt)];
      wireDraft.pts = dedupe(pts);
      if (snap) finishWire();
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
  if (drag && drag.mode === 'part'){
    const part = S.parts.find(p => p.id === drag.id);
    if (!part) return;
    const nx = snapView(w.x - drag.dx), ny = snapView(w.y - drag.dy);
    if (nx !== part.x || ny !== part.y){
      if (!drag.moved){ drag.moved = true; commit(); }
      const ddx = nx - part.x, ddy = ny - part.y;
      part.x = nx; part.y = ny;
      for (const s of drag.stuck){ s.wire.pts[s.i].x += ddx; s.wire.pts[s.i].y += ddy; }
      renderWires(); renderParts();
    }
    return;
  }
  if (S.tool === 'place' && S.place){
    S.place.x = snapView(w.x); S.place.y = snapView(w.y);
    renderOverlay();
    return;
  }
  if (S.tool === 'wire' && wireDraft){
    const snap = nearestPin(w, GRID);
    snapHint = snap ? { x:snap.x, y:snap.y } : null;
    const pt = snap ? { x:snap.x, y:snap.y } : { x:snapView(w.x), y:snapView(w.y) };
    wireDraft.preview = elbow(wireDraft.pts[wireDraft.pts.length - 1], pt);
    renderOverlay();
    return;
  }
  if (S.tool === 'wire'){
    const snap = nearestPin(w, GRID);
    const next = snap ? { x:snap.x, y:snap.y } : null;
    if (JSON.stringify(next) !== JSON.stringify(snapHint)){ snapHint = next; renderOverlay(); }
  }
});
svg.addEventListener('pointerup', ev => {
  if (drag && drag.mode === 'pan'){ svg.classList.remove('panning'); }
  if (drag && drag.mode === 'part' && drag.moved){ rebuildPinNets(); render(); }
  drag = null;
});
svg.addEventListener('dblclick', () => { if (wireDraft) finishWire(); });
svg.addEventListener('contextmenu', ev => { ev.preventDefault(); if (wireDraft) finishWire(); else cancelTool(); });
svg.addEventListener('wheel', ev => {
  ev.preventDefault();
  const r = svg.getBoundingClientRect();
  zoomAbout(ev.deltaY < 0 ? 1.12 : 0.89, ev.clientX - r.left, ev.clientY - r.top);
}, { passive:false });

/* an orthogonal elbow from a to b — the leg along the bigger delta first */
function elbow(a, b){
  if (a.x === b.x || a.y === b.y) return [{ x:b.x, y:b.y }];
  return Math.abs(b.x - a.x) >= Math.abs(b.y - a.y)
    ? [{ x:b.x, y:a.y }, { x:b.x, y:b.y }]
    : [{ x:a.x, y:b.y }, { x:b.x, y:b.y }];
}
const dedupe = pts => pts.filter((p, i) => i === 0 || p.x !== pts[i-1].x || p.y !== pts[i-1].y);
function finishWire(){
  if (wireDraft && wireDraft.pts.length > 1){
    commit();
    S.wires.push({ id:newId('w'), pts:dedupe(wireDraft.pts) });
  }
  wireDraft = null; snapHint = null;
  if (S.lastCheck) runCheck(true);
  render();
}
function cancelTool(){
  wireDraft = null; snapHint = null; S.place = null;
  if (S.tool !== 'select') setTool('select'); else render();
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
  S.sel = { type:'part', id:part.id };
  rebuildPinNets(); render(); renderDock();
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
  S.sel = null; S.traceNet = null; S.lastCheck = null;
  rebuildPinNets();
  fitView();
  runCheck(true);
  render();
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
  S.parts = d.parts || []; S.wires = d.wires || []; S.rooms = d.rooms || [];
  S.netlist = d.netlist || null;
  if (d.view) S.view = d.view;
  if (d.showRooms != null) S.showRooms = d.showRooms;
  if (d.showStubs != null) S.showStubs = d.showStubs;
  S.sel = null; S.lastCheck = null;
  $('projTitle').textContent = S.project.title || 'Untitled circuit';
  rebuildPinNets(); render();
}
function download(name, text, type){
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type:type || 'application/json' }));
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
function openExport(){
  const session = sessionJSON();
  const netlist = JSON.stringify(netlistFromSheet(S), null, 2);
  openModal('Export', `
    <div class="tabs"><button class="on" data-etab="session">Session</button><button data-etab="netlist">Drawn netlist</button><button data-etab="svg">Sheet SVG</button></div>
    <div data-epane="session"><p class="hint">Everything: project fields, placed symbols, wires and the imported netlist.</p>
      <pre class="out">${esc(session.slice(0, 4000))}${session.length > 4000 ? '\n…' : ''}</pre>
      <div class="btnrow"><button id="dlSession" class="primary">Download session.json</button></div></div>
    <div data-epane="netlist" hidden><p class="hint">What the drawing itself says, in circuit_data.json shape — diff it against the imported netlist.</p>
      <pre class="out">${esc(netlist.slice(0, 4000))}${netlist.length > 4000 ? '\n…' : ''}</pre>
      <div class="btnrow"><button id="dlNetlist" class="primary">Download circuit_data.json</button></div></div>
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
  $('dlSvg').onclick = () => download('sheet.svg', sheetSVG(), 'image/svg+xml');
  $('expClose').onclick = closeModal;
}
function sheetSVG(){
  const b = sheetBounds() || { x:0, y:0, w:100, h:100 };
  const pad = 40;
  const css = `<style>
    .sym{fill:none;stroke:#1B2A41;stroke-width:1.8}.symfill{fill:#1B2A41}.icbody{fill:#fff;stroke:#1B2A41;stroke-width:1.8}
    .pinline{stroke:#4A5A72;stroke-width:1.6}.pindot{fill:none;stroke:#4A5A72;stroke-width:1.2}
    .wire{fill:none;stroke:#1B2A41;stroke-width:2}.wire.hit{display:none}.junction{fill:#1B2A41}
    .ref{font:600 10px monospace;fill:#1B2A41}.value,.netstub,.pinname{font:9px monospace;fill:#4A5A72}
    .room{fill:none;stroke:#DEDACC;stroke-width:1.5;stroke-dasharray:6 5}.roomlbl{font:11px monospace;fill:#4A5A72}
    .note{font:11px sans-serif;fill:#1B2A41}</style>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${b.x - pad} ${b.y - pad} ${b.w + 2*pad} ${b.h + 2*pad}" width="${Math.round(b.w + 2*pad)}" height="${Math.round(b.h + 2*pad)}">
    ${css}<rect x="${b.x - pad}" y="${b.y - pad}" width="${b.w + 2*pad}" height="${b.h + 2*pad}" fill="#F7F5F0"/>
    ${roomsG.innerHTML}${wiresG.innerHTML}${partsG.innerHTML}</svg>`;
}

/* ---------------- keyboard ---------------- */
document.addEventListener('keydown', ev => {
  const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
  if ((ev.ctrlKey || ev.metaKey) && !typing){
    const k = ev.key.toLowerCase();
    if (k === 'z' && !ev.shiftKey){ ev.preventDefault(); undo(); return; }
    if (k === 'y' || (k === 'z' && ev.shiftKey)){ ev.preventDefault(); redo(); return; }
    if (k === 's'){ ev.preventDefault(); download('session.json', sessionJSON()); return; }
  }
  if (typing) return;
  if (ev.key === 'Escape'){ cancelTool(); return; }
  if (ev.key === 'Delete' || ev.key === 'Backspace'){ ev.preventDefault(); deleteSel(); return; }
  const k = ev.key.toLowerCase();
  if (k === 'r'){ rotateSel(); return; }
  if (k === 'm'){ mirrorSel(); return; }
  if (k === 'f'){ fitView(); return; }
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
  setPanel, dock, renderDock, DB, finishWire, sheetBounds,
  get wireDraft(){ return wireDraft; }, set wireDraft(v){ wireDraft = v; },
};
