/* ==================================================================
   altium-project.js — the editor's sheet as an Altium project, and back.

   Export:
       the editor (S.parts, S.wires, S.project)
           │  sheetFromEditor()        world units, y down  →  Altium units, y up
           ▼
       the neutral sheet model (altium.js)  ──sheetRecords()──▶ records ──▶ .SchDoc
           + every symbol used          ──────writeSchLib()──────────────▶ .SchLib
           + the document list          ──────writePrjPcb()──────────────▶ .PrjPcb
           ▼
       <Project>/<Project>.PrjPcb, <Sheet>.SchDoc…, <Project>.SchLib  (one .zip)

   Import is the same road backwards — readPrjPcb / readSchDoc →
   sheetModel() → editorFromSheet() — and every step of it is already
   here and tested, so wiring an "Import Altium project" button is a
   matter of handing the files to readProject().

   One editor world unit IS one Altium unit (10 mil): the editor's 10-unit
   grid is Altium's 100-mil grid, so the only change of coordinates is the
   y flip and a shift that puts the drawing inside the sheet border.

   Symbols:
     * a part placed from the component library whose .SchLib can be read
       is written with THAT symbol — its records copied, moved and turned
       onto the sheet — after checking that its pins land where the editor
       drew them (they always do: the editor's symbol was made from it);
     * every other part (the built-in resistors, FETs, generated ICs…) is
       converted from the editor's own drawing: bodies become filled
       polygons, strokes polylines, pins Altium pins at the same hot spots.
   Every symbol used also goes into <Project>.SchLib, which the sheet's
   components name as their source library, so the project is
   self-contained: "Update from libraries" in Altium finds them all.
   ================================================================== */
'use strict';

const AltiumProject = (() => {
  const A = Altium;
  const PORT_STYLE = { gnd:A.POWER_STYLE.power_ground, gnd_hv:A.POWER_STYLE.signal_ground,
                       earth:A.POWER_STYLE.earth, vcc:A.POWER_STYLE.bar };
  const DIR_OUT = { r:0, t:1, l:2, b:3 };                 // editor pin side → Altium pin direction
  const VEC = [[1, 0], [0, 1], [-1, 0], [0, -1]];         // Altium direction → unit vector (y up)
  const r3 = v => Math.round(v * 1000) / 1000;

  /* A file or storage name Altium (and every OS) will take. */
  const safeName = (s, fallback) => (String(s || '').trim().replace(/[\\\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ').slice(0, 80) || fallback);

  /* The editor's rotation (clockwise on screen, y down) as Altium's
     counter-clockwise quarter turns, y up. */
  const orientationOf = rot => ((4 - Math.round((((rot || 0) % 360) + 360) % 360 / 90)) % 4);
  const rotOf = orientation => ((4 - (orientation % 4)) % 4) * 90;
  /* A direction in the part's own frame (editor axes), once the part is placed, as 0-3. */
  function dirOf(vx, vy, part){
    const p = rotPoint(vx, vy, part.rot || 0, part.mir);
    const ax = Math.sign(Math.round(p.x)), ay = -Math.sign(Math.round(p.y));
    return ax > 0 ? 0 : ay > 0 ? 1 : ax < 0 ? 2 : 3;
  }

  /* ------------------------------------------------------------------
     SVG path → polylines. The editor's symbols are SVG paths (M L H V Z,
     arcs for windings and circles); Altium wants points. Arcs and curves
     are flattened finely enough that nobody will see the facets.
     ------------------------------------------------------------------ */
  function svgSubpaths(d){
    const toks = String(d || '').match(/[MmLlHhVvZzAaCcSsQqTt]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) || [];
    const out = [];
    let i = 0, cmd = '', x = 0, y = 0, sx = 0, sy = 0, cur = null, lcx = null, lcy = null, lqx = null, lqy = null;
    const num = () => Number(toks[i++]);
    const isNum = () => i < toks.length && !/^[A-Za-z]$/.test(toks[i]);
    const lineTo = (nx, ny) => { if (!cur){ cur = { pts:[[x, y]], closed:false }; out.push(cur); } cur.pts.push([nx, ny]); x = nx; y = ny; };
    while (i < toks.length){
      if (/^[A-Za-z]$/.test(toks[i])) cmd = toks[i++];
      else if (!cmd) { i++; continue; }
      const rel = cmd === cmd.toLowerCase(), C = cmd.toUpperCase();
      const ox = rel ? x : 0, oy = rel ? y : 0;
      if (C === 'Z'){ if (cur){ cur.closed = true; x = sx; y = sy; } cur = null; lcx = lqx = null; continue; }
      if (!isNum()) continue;
      if (C === 'M'){
        x = num() + ox; y = num() + oy; sx = x; sy = y;
        cur = { pts:[[x, y]], closed:false }; out.push(cur);
        cmd = rel ? 'l' : 'L';                                   // implicit lineto after a moveto
      } else if (C === 'L'){ lineTo(num() + ox, num() + oy); }
      else if (C === 'H'){ lineTo(num() + (rel ? x : 0), y); }
      else if (C === 'V'){ lineTo(x, num() + (rel ? y : 0)); }
      else if (C === 'A'){
        const rx = Math.abs(num()), ry = Math.abs(num()), phi = num() * Math.PI / 180, large = !!num(), sweep = !!num();
        const ex = num() + ox, ey = num() + oy;
        for (const [px, py] of arcPoints(x, y, rx, ry, phi, large, sweep, ex, ey)) lineTo(px, py);
      } else if (C === 'C' || C === 'S'){
        let c1x, c1y;
        if (C === 'C'){ c1x = num() + ox; c1y = num() + oy; }
        else { c1x = lcx != null ? 2 * x - lcx : x; c1y = lcy != null ? 2 * y - lcy : y; }
        const c2x = num() + ox, c2y = num() + oy, ex = num() + ox, ey = num() + oy, x0 = x, y0 = y;
        for (let k = 1; k <= 12; k++){
          const t = k / 12, u = 1 - t;
          lineTo(u*u*u*x0 + 3*u*u*t*c1x + 3*u*t*t*c2x + t*t*t*ex, u*u*u*y0 + 3*u*u*t*c1y + 3*u*t*t*c2y + t*t*t*ey);
        }
        lcx = c2x; lcy = c2y; continue;
      } else if (C === 'Q' || C === 'T'){
        let qx, qy;
        if (C === 'Q'){ qx = num() + ox; qy = num() + oy; }
        else { qx = lqx != null ? 2 * x - lqx : x; qy = lqy != null ? 2 * y - lqy : y; }
        const ex = num() + ox, ey = num() + oy, x0 = x, y0 = y;
        for (let k = 1; k <= 10; k++){ const t = k / 10, u = 1 - t; lineTo(u*u*x0 + 2*u*t*qx + t*t*ex, u*u*y0 + 2*u*t*qy + t*t*ey); }
        lqx = qx; lqy = qy; continue;
      } else { i++; continue; }
      lcx = lcy = lqx = lqy = null;
    }
    return out.filter(s => s.pts.length > 1);
  }
  /* SVG's endpoint arc → points (the SVG spec's centre parameterisation). */
  function arcPoints(x1, y1, rx, ry, phi, large, sweep, x2, y2){
    if (!rx || !ry || (x1 === x2 && y1 === y2)) return [[x2, y2]];
    const cp = Math.cos(phi), sp = Math.sin(phi);
    const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
    const x1p = cp * dx + sp * dy, y1p = -sp * dx + cp * dy;
    const lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
    if (lam > 1){ rx *= Math.sqrt(lam); ry *= Math.sqrt(lam); }
    const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
    const co = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, num / (rx * rx * y1p * y1p + ry * ry * x1p * x1p)));
    const cxp = co * rx * y1p / ry, cyp = -co * ry * x1p / rx;
    const cx = cp * cxp - sp * cyp + (x1 + x2) / 2, cy = sp * cxp + cp * cyp + (y1 + y2) / 2;
    const ang = (ux, uy, vx, vy) => { const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy); return a; };
    const t1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
    let dt = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
    if (!sweep && dt > 0) dt -= 2 * Math.PI;
    if (sweep && dt < 0) dt += 2 * Math.PI;
    const n = Math.max(4, Math.ceil(Math.abs(dt) / (Math.PI / 16)));
    const pts = [];
    for (let k = 1; k <= n; k++){
      const t = t1 + dt * k / n;
      pts.push([cx + rx * Math.cos(t) * cp - ry * Math.sin(t) * sp, cy + rx * Math.cos(t) * sp + ry * Math.sin(t) * cp]);
    }
    pts[pts.length - 1] = [x2, y2];
    return pts;
  }

  /* ------------------------------------------------------------------
     An editor symbol (a symbols.js def) → an Altium library symbol, in
     the symbol's own frame: editor (x, y) becomes Altium (x, -y).
     ------------------------------------------------------------------ */
  function symbolFromDef(def, opts){
    const o = opts || {};
    const recs = [];
    const P = (x, y) => [r3(x), r3(-y)];
    const line = String(A.COLOR.line), fill = String(A.COLOR.bodyFill);
    const poly = (pts, kind, solidColor) => {
      const r = { RECORD: kind === 'polygon' ? '7' : '6', OWNERPARTID: '1', ISNOTACCESIBLE: 'T', LINEWIDTH: '1',
                  COLOR: line, LOCATIONCOUNT: String(pts.length) };
      if (kind === 'polygon'){ r.AREACOLOR = solidColor; r.ISSOLID = 'T'; }
      pts.forEach(([x, y], i) => { const [ax, ay] = P(x, y); A.setCoord(r, 'X' + (i + 1), ax); A.setCoord(r, 'Y' + (i + 1), ay); });
      recs.push(r);
    };
    const rect = (x, y, w, h, solidColor) => {
      const r = { RECORD: '14', OWNERPARTID: '1', ISNOTACCESIBLE: 'T', LINEWIDTH: '1', COLOR: line,
                  AREACOLOR: solidColor, ISSOLID: 'T' };
      A.setCoord(r, 'LOCATION.X', r3(x)); A.setCoord(r, 'LOCATION.Y', r3(-(y + h)));
      A.setCoord(r, 'CORNER.X', r3(x + w)); A.setCoord(r, 'CORNER.Y', r3(-y));
      recs.push(r);
    };
    const b = def.body;
    if (b) rect(b.x, b.y, b.w, b.h, fill);
    for (const d of def.bodies || []) for (const sp of svgSubpaths(d)) poly(sp.pts, 'polygon', fill);
    for (const d of def.paths || []) for (const sp of svgSubpaths(d))
      poly(sp.closed ? [...sp.pts, sp.pts[0]] : sp.pts, 'polyline');
    for (const d of def.fills || []) for (const sp of svgSubpaths(d)) poly(sp.pts, 'polygon', line);
    // the circles a few symbols add as raw SVG (terminals, a test point)
    for (const m of String(def.extra || '').matchAll(/<circle\b[^>]*>/g)){
      const at = k => { const mm = new RegExp('\\b' + k + '="([-+\\d.eE]+)"').exec(m[0]); return mm ? Number(mm[1]) : 0; };
      const r = { RECORD: '8', OWNERPARTID: '1', ISNOTACCESIBLE: 'T', LINEWIDTH: '1', COLOR: line, AREACOLOR: line, ISSOLID: 'F' };
      const [cx, cy] = P(at('cx'), at('cy'));
      A.setCoord(r, 'LOCATION.X', cx); A.setCoord(r, 'LOCATION.Y', cy);
      A.setCoord(r, 'RADIUS', r3(at('r'))); A.setCoord(r, 'SECONDARYRADIUS', r3(at('r')));
      recs.push(r);
    }
    if (b && def.pinMarks) for (const p of def.pins)
      rect(p.dir === 'l' ? b.x + 2 : b.x + b.w - 8, p.y - 2.5, 6, 5, line);

    // the pins: same hot spot, the lead running back to the body when there is one
    for (const p of def.pins || []){
      const dir = DIR_OUT[p.dir] != null ? DIR_OUT[p.dir] : 2;
      let len = 0;
      if (b && def.leads !== false){
        len = p.dir === 'l' ? b.x - p.x : p.dir === 'r' ? p.x - (b.x + b.w) : p.dir === 't' ? b.y - p.y : p.y - (b.y + b.h);
        len = Math.max(0, r3(len));
      }
      const [hx, hy] = P(p.x, p.y), [vx, vy] = VEC[dir];
      const name = String(p.name), des = String(p.designator || p.name);
      // names inside a body, as the sheet draws them; numbers only when they differ from the name
      const showName = !!(b && def.names), showDes = showName && des !== name;
      const r = {
        RECORD: '2', OWNERPARTID: '1', FORMALTYPE: '1',
        ELECTRICAL: String(A.ELECTRICAL_CODE[String(p.electrical || 'passive').toLowerCase()] != null
          ? A.ELECTRICAL_CODE[String(p.electrical || 'passive').toLowerCase()] : 4),
        PINCONGLOMERATE: String(0x20 | dir | (showName ? 0x08 : 0) | (showDes ? 0x10 : 0)),
        PINLENGTH: String(Math.round(len)), NAME: name, DESIGNATOR: des,
      };
      A.setCoord(r, 'LOCATION.X', r3(hx - vx * Math.round(len))); A.setCoord(r, 'LOCATION.Y', r3(hy - vy * Math.round(len)));
      recs.push(r);
    }

    // the designator above the drawing, the comment under it
    const box = def.box || { x:-20, y:-20, w:40, h:40 };
    const prefix = def.prefix || o.prefix || 'U';
    const des = { RECORD: '34', OWNERPARTID: '-1', COLOR: '8388608', FONTID: '1', TEXT: prefix + '?', NAME: 'Designator', READONLYSTATE: '1' };
    A.setCoord(des, 'LOCATION.X', r3(box.x)); A.setCoord(des, 'LOCATION.Y', r3(-box.y + 2));
    const com = { RECORD: '41', OWNERPARTID: '-1', COLOR: '8388608', FONTID: '1', TEXT: '*', NAME: 'Comment' };
    A.setCoord(com, 'LOCATION.X', r3(box.x)); A.setCoord(com, 'LOCATION.Y', r3(-(box.y + box.h) - 10));
    recs.push(des, com);
    return { name: o.name || def.label || 'SYMBOL', description: o.description || def.label || '',
             designator: prefix, partCount: 1, records: recs };
  }

  /* Where a symbol's pins connect, in the symbol's own frame (Altium axes). */
  function hotSpots(sym){
    const out = new Map();
    for (const r of sym.records){
      if (Number(r.RECORD) !== 2 || !(Number(r.OWNERPARTID || 1) <= 1) || (Number(r.PINCONGLOMERATE || 0) & 4)) continue;
      const d = Number(r.PINCONGLOMERATE || 0) & 3, len = A.coord(r, 'PINLENGTH');
      out.set(String(r.NAME || r.DESIGNATOR), [r3(A.coord(r, 'LOCATION.X') + VEC[d][0] * len), r3(A.coord(r, 'LOCATION.Y') + VEC[d][1] * len)]);
    }
    return out;
  }
  /* True when every pin the editor draws sits on a pin of the Altium symbol. */
  function pinsAgree(sym, def){
    const spots = hotSpots(sym);
    return (def.pins || []).every(p => {
      const s = spots.get(String(p.name)) || (p.designator && spots.get(String(p.designator)));
      return s && Math.abs(s[0] - p.x) < 0.01 && Math.abs(s[1] + p.y) < 0.01;
    });
  }

  /* ------------------------------------------------------------------
     The editor's sheet → the neutral model.
     ctx: { library (LIB, optional), symbols (a SymbolBook), warnings[] }
     ------------------------------------------------------------------ */
  function SymbolBook(){
    const byKey = new Map(), byName = new Map(), list = [];
    return {
      list,
      add(sym){
        const key = JSON.stringify([sym.records, sym.partCount]);
        if (byKey.has(key)) return byKey.get(key);
        let name = String(sym.name || 'SYMBOL').trim() || 'SYMBOL', n = 2;
        while (byName.has(name.toUpperCase())) name = String(sym.name) + '_' + (n++);
        const s = { ...sym, name };
        byKey.set(key, s); byName.set(name.toUpperCase(), s); list.push(s);
        return s;
      },
    };
  }

  /* The Altium symbol of a part placed from the component library, when its
     .SchLib is reachable and agrees with what the editor drew. */
  async function librarySymbol(part, def, ctx){
    const lib = ctx.library;
    if (!part.lib || !lib || !lib.byId) return null;
    const c = lib.byId.get(part.lib.id) || (lib.match && part.partNumber ? lib.match(part.partNumber) : null);
    if (!c || !c.models || !c.models.symbol) return null;
    ctx.cache = ctx.cache || new Map();
    if (!ctx.cache.has(c.id)){
      ctx.cache.set(c.id, (async () => {
        try {
          const data = await lib.modelData(c, 'symbol');
          return A.readSchLib(data).symbols;
        } catch (e){ ctx.warnings.push(part.ref + ': could not read ' + (c.models.symbol.name || 'its .SchLib') + ' (' + e.message + ') — its drawing was converted instead'); return []; }
      })());
    }
    const syms = await ctx.cache.get(c.id);
    if (!syms.length) return null;
    const norm = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const sym = syms.find(s => norm(s.name) === norm(c.part_number)) || syms.find(s => pinsAgree(s, def)) || syms[0];
    if (!pinsAgree(sym, def)){
      ctx.warnings.push(part.ref + ': the pins of ' + sym.name + ' in its .SchLib are not where the sheet draws them — its drawing was converted instead');
      return null;
    }
    return sym;
  }

  /* Text placement copied from the sheet's own renderer: the designator over
     an IC body or beside a part on end, the value under it — all level. */
  function textSpots(part, def){
    const b = localBounds(def, part.rot || 0, part.mir);
    const above = !!def.body, upright = !above && b.h > b.w;
    const tx = upright ? b.x + b.w + 6 : b.x + b.w / 2;
    const y1 = above ? b.y - 6 : upright ? -2 : b.y + b.h + 11;
    const y2 = above ? b.y + b.h + 12 : upright ? 8 : b.y + b.h + 21;
    const just = upright ? 0 : 1;                 // bottom-left / bottom-centre
    return { des:{ x:part.x + tx, y:part.y + y1, justification:just }, com:{ x:part.x + tx, y:part.y + y2, justification:just } };
  }
  function localBounds(def, rot, mir){
    const bx = def.box || { x:-20, y:-20, w:40, h:40 };
    const cs = [[bx.x, bx.y], [bx.x + bx.w, bx.y], [bx.x, bx.y + bx.h], [bx.x + bx.w, bx.y + bx.h]].map(([x, y]) => rotPoint(x, y, rot, mir));
    const xs = cs.map(c => c.x), ys = cs.map(c => c.y);
    return { x:Math.min(...xs), y:Math.min(...ys), w:Math.max(...xs) - Math.min(...xs), h:Math.max(...ys) - Math.min(...ys) };
  }

  function partParameters(part){
    const out = [], seen = new Set();
    const put = (name, value) => {
      if (value == null || value === '' || seen.has(name.toUpperCase())) return;
      seen.add(name.toUpperCase()); out.push({ name, value:String(value) });
    };
    put('Value', part.value);
    put('Part Number', part.partNumber);
    if (part.pick){
      put('Manufacturer', part.pick.man);
      put('Manufacturer Part Number', part.pick.pn);
      put('Supplier', part.pick.src);
      put('Datasheet', part.pick.datasheet);
    }
    for (const [k, v] of Object.entries(part.props || {})) put(k, v);
    put('Group', part.group);
    put('Role', part.role);
    return out;
  }

  /* sheet = { name, parts, wires }   → { model, offset } */
  async function sheetFromEditor(sheet, ctx){
    const parts = sheet.parts || [], wires = (sheet.wires || []).filter(w => (w.pts || []).length > 1);
    // where the drawing sits, so it can be moved inside the sheet border
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const grow = (x, y) => { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); };
    for (const p of parts){ const b = partBounds(p); grow(b.x, b.y); grow(b.x + b.w, b.y + b.h + 25); }
    for (const w of wires) for (const pt of w.pts) grow(pt.x, pt.y);
    if (!isFinite(minX)){ minX = minY = 0; maxX = maxY = 100; }
    const margin = 100, bottom = 150;              // 1" all round, 1.5" under the drawing for the title block
    const ox = Math.ceil((margin - minX) / 100) * 100, oy = Math.ceil((maxY + bottom) / 100) * 100;
    const X = x => x + ox, Y = y => oy - y;
    const model = {
      name: sheet.name, size:{ w:Math.ceil((maxX + ox + margin) / 100) * 100, h:Math.ceil((oy - minY + margin) / 100) * 100 },
      parameters: sheet.parameters || {},
      components:[], wires:[], junctions:[], netLabels:[], powerPorts:[], noErcs:[], texts:[],
    };
    const stats = { library:0, converted:0 };

    for (const part of parts){
      const sdef = SYMBOLS[part.kind] || {};
      const def = defOf(part);
      const port = sdef.port;
      if (port === 'gnd' || port === 'power'){
        const pin = partPins(part)[0];
        const local = def.pins[0] || { x:0, y:0 };
        model.powerPorts.push({ x:X(pin.x), y:Y(pin.y), orientation:dirOf(-local.x, -local.y, part),
                                style:PORT_STYLE[part.kind] != null ? PORT_STYLE[part.kind] : (port === 'gnd' ? A.POWER_STYLE.power_ground : A.POWER_STYLE.bar),
                                text:part.net || sdef.net || '' });
        continue;
      }
      if (port === 'label'){
        const pin = partPins(part)[0];
        model.netLabels.push({ x:X(pin.x), y:Y(pin.y), orientation:dirOf(1, 0, part), text:part.net || sdef.net || '' });
        continue;
      }
      if (port === 'nc'){ const pin = partPins(part)[0]; model.noErcs.push([X(pin.x), Y(pin.y)]); continue; }
      if (port === 'note'){
        String(part.text || '').split(/\r?\n/).forEach((line, i) => {
          if (line.trim()) model.texts.push({ x:X(part.x), y:Y(part.y + i * 12), orientation:dirOf(1, 0, part), text:line });
        });
        continue;
      }

      // a component
      let sym = await librarySymbol(part, def, ctx), fromLib = !!sym;
      if (!sym){
        const label = sdef.generated ? (part.partNumber || (sdef.generated === 'conn' ? 'CONNECTOR' : 'IC')) : (def.label || part.kind);
        sym = symbolFromDef(def, { name:safeName(label, 'SYMBOL').replace(/\s+/g, '_').toUpperCase(), description:def.label || '' });
      }
      fromLib ? stats.library++ : stats.converted++;
      sym = ctx.symbols.add(sym);
      const spots = textSpots(part, def);
      model.components.push({
        symbol:sym, x:X(part.x), y:Y(part.y), orientation:orientationOf(part.rot), mirrored:!!part.mir,
        designator:part.ref || '', comment:part.value || part.partNumber || '',
        description: sym.description || '', sourceLibrary:ctx.libraryName || '*',
        designItemId: part.partNumber || sym.name,
        parameters: partParameters(part),
        // a converted symbol keeps the editor's level text; a library symbol keeps its own
        ...(fromLib ? {} : { designatorAt:{ x:X(spots.des.x), y:Y(spots.des.y), justification:spots.des.justification },
                             commentAt:{ x:X(spots.com.x), y:Y(spots.com.y), justification:spots.com.justification } }),
      });
    }

    for (const w of wires) model.wires.push(w.pts.map(p => [X(p.x), Y(p.y)]));
    const conn = connectivity(parts, wires);
    for (const j of conn.junctions) model.junctions.push([X(j.x), Y(j.y)]);

    // Altium joins a wire to every pin end it passes over; the editor only to
    // the ones a wire has a vertex on. Say so where the two would disagree.
    for (const part of parts){
      for (const pin of partPins(part)){
        for (const w of wires){
          const pts = w.pts;
          if (pts.some(q => q.x === pin.x && q.y === pin.y)) continue;
          for (let i = 0; i < pts.length - 1; i++){
            const a = pts[i], b = pts[i + 1];
            const on = (a.x === b.x && a.x === pin.x && pin.y > Math.min(a.y, b.y) && pin.y < Math.max(a.y, b.y)) ||
                       (a.y === b.y && a.y === pin.y && pin.x > Math.min(a.x, b.x) && pin.x < Math.max(a.x, b.x));
            if (on){ ctx.warnings.push((part.ref || part.net || part.kind) + '-' + pin.name + ': a wire runs over this pin without ending on it — Altium will connect them'); break; }
          }
        }
      }
    }
    return { model, offset:{ x:ox, y:oy }, stats };
  }

  /* ------------------------------------------------------------------
     The whole project: { files: {path → bytes|string}, zip, report }.
       state: { project, sheets:[{ name, parts, wires }] }  (or S itself)
       opts:  { name, format:'binary'|'ascii', library:LIB }
     ------------------------------------------------------------------ */
  async function build(state, opts){
    const o = opts || {};
    const proj = state.project || {};
    const name = safeName(o.name || proj.title, 'Project');
    const sheets = (state.sheets && state.sheets.length) ? state.sheets
      : [{ name:proj.sheetName || 'Sheet1', parts:state.parts || [], wires:state.wires || [] }];
    const libraryName = name + '.SchLib';
    const ctx = { library:o.library || null, symbols:SymbolBook(), warnings:[], libraryName };
    const files = {}, report = { sheets:[], symbols:0, warnings:ctx.warnings, format:o.format || 'binary' };
    const used = new Set(), docs = [];
    const params = {
      Title: proj.title, DocumentNumber: proj.code, Revision: proj.revision, Author: proj.author, DrawnBy: proj.author,
      CompanyName: proj.customer, ProjectName: name,
    };
    for (let i = 0; i < sheets.length; i++){
      const sh = sheets[i];
      let base = safeName(sh.name, 'Sheet' + (i + 1)), n = 2;
      while (used.has(base.toUpperCase())) base = safeName(sh.name, 'Sheet') + '_' + (n++);
      used.add(base.toUpperCase());
      const file = base + '.SchDoc';
      const { model, stats } = await sheetFromEditor({ ...sh, name:base,
        parameters:{ ...params, SheetNumber:String(i + 1), SheetTotal:String(sheets.length), DocumentName:file } }, ctx);
      const records = A.sheetRecords(model, { seed:name + '/' + base });
      files[name + '/' + file] = A.writeSchDoc(records, { format:o.format || 'binary' });
      docs.push(file);
      report.sheets.push({ name:base, file, components:model.components.length, wires:model.wires.length,
                           netLabels:model.netLabels.length, powerPorts:model.powerPorts.length,
                           junctions:model.junctions.length, records:records.length, ...stats });
    }
    if (ctx.symbols.list.length){
      files[name + '/' + libraryName] = A.writeSchLib(ctx.symbols.list);
      docs.push(libraryName);
    }
    report.symbols = ctx.symbols.list.length;
    const prjParams = { Customer:proj.customer, Variant:proj.variant, Status:proj.status, InputVoltage:proj.vin,
                        Rails:proj.vout, MaxCurrent:proj.imax, Isolation:proj.isolation, Standards:proj.standards };
    files[name + '/' + name + '.PrjPcb'] = A.writePrjPcb({ documents:docs, parameters:prjParams });
    return { name, files, report, zip:() => ZIP.write(files) };
  }

  /* ------------------------------------------------------------------
     The way back: an Altium sheet model → editor parts and wires. The
     placement maths is the exact inverse of sheetFromEditor(), so a sheet
     exported from here comes back where it was (offset aside).
     ------------------------------------------------------------------ */
  function editorFromSheet(model, opts){
    const o = opts || {};
    const oy = o.offset ? o.offset.y : (model.size ? model.size.h : 0), ox = o.offset ? o.offset.x : 0;
    const x = X => Math.round(X - ox), y = Y => Math.round(oy - Y);
    const parts = [], wires = [];
    let n = 0;
    const id = p => p + '_alt_' + (++n);
    const turned = (kind, net, hx, hy, orientation, baseVec) => {
      // the rotation whose direction matches the port's, then its pin onto the hot spot
      for (const rot of [0, 90, 180, 270]){
        const part = { id:id('p'), kind, rot, mir:0, x:0, y:0, ref:'', value:'', partNumber:'', group:'', role:'', props:{}, net };
        if (dirOf(baseVec[0], baseVec[1], part) !== orientation) continue;
        const pin = SYMBOLS[kind].pins[0], q = rotPoint(pin.x, pin.y, rot, 0);
        part.x = x(hx) - q.x; part.y = y(hy) - q.y;
        return part;
      }
      return null;
    };
    for (const c of model.components || []){
      const ir = A.irFromLibSymbol(c.symbol);
      const def = A.symbolDefFromAltium(ir, { label:c.symbol.name });
      if (!def) continue;
      const props = {};
      for (const p of c.parameters || []) if (!/^(Value|Part Number)$/i.test(p.name)) props[p.name] = p.value;
      const pv = (k) => ((c.parameters || []).find(p => p.name.toUpperCase() === k.toUpperCase()) || {}).value;
      parts.push({ id:id('p'), kind:'ic', x:x(c.x), y:y(c.y), rot:rotOf(c.orientation || 0), mir:c.mirrored ? 1 : 0,
                   ref:c.designator || '', value:pv('Value') || c.comment || '', partNumber:pv('Part Number') || c.designItemId || '',
                   group:pv('Group') || '', role:pv('Role') || '', props, libSymbol:def,
                   altium:{ libRef:c.symbol.name, library:c.sourceLibrary || '' } });
    }
    const kindOfStyle = { [A.POWER_STYLE.power_ground]:'gnd', [A.POWER_STYLE.signal_ground]:'gnd_hv', [A.POWER_STYLE.earth]:'earth' };
    for (const p of model.powerPorts || []){
      const kind = kindOfStyle[p.style] || 'vcc';
      const local = SYMBOLS[kind].pins[0];
      const part = turned(kind, p.text, p.x, p.y, p.orientation || 0, [-local.x, -local.y]);
      if (part) parts.push(part);
    }
    for (const l of model.netLabels || []){
      const part = turned('netlabel', l.text, l.x, l.y, l.orientation || 0, [1, 0]);
      if (part) parts.push(part);
    }
    for (const [hx, hy] of model.noErcs || []){
      const part = turned('noconnect', '', hx, hy, 0, [1, 0]);
      if (part) parts.push(part);
    }
    for (const t of model.texts || []) parts.push({ id:id('p'), kind:'note', x:x(t.x), y:y(t.y), rot:rotOf(t.orientation || 0), mir:0,
                                                     ref:'', value:'', partNumber:'', group:'', role:'', props:{}, text:t.text });
    for (const w of model.wires || []) wires.push({ id:id('w'), pts:w.map(([X, Y]) => ({ x:x(X), y:y(Y) })) });
    return { parts, wires };
  }

  /* Read a project back from its files: { 'X.PrjPcb': text, 'Sheet1.SchDoc': bytes, … }
     → { name, sheets:[{ name, model }], libraries:{ name → symbols } }. */
  function readProject(files){
    const names = Object.keys(files);
    const prjName = names.find(f => /\.PrjPcb$/i.test(f));
    const base = f => f.split('/').pop();
    const byBase = new Map(names.map(f => [base(f).toUpperCase(), f]));
    const text = d => typeof d === 'string' ? d : String.fromCharCode.apply(null, CFB.u8(d));
    const prj = prjName ? A.readPrjPcb(text(files[prjName])) : { documents:[] };
    const docs = prj.documents.length ? prj.documents.map(d => base(d.path)) : names.map(base);
    const sheets = [], libraries = {}, warnings = [];
    for (const d of docs){
      const f = byBase.get(d.toUpperCase());
      if (!f){ warnings.push(d + ' is listed in the project but was not given'); continue; }
      if (/\.SchDoc$/i.test(d)){
        const doc = A.readSchDoc(files[f]);
        sheets.push({ name:d.replace(/\.SchDoc$/i, ''), format:doc.format, model:A.sheetModel(doc.records, { name:d }) });
      } else if (/\.SchLib$/i.test(d)){
        libraries[d] = A.readSchLib(files[f]).symbols;
      }
    }
    return { name:prjName ? base(prjName).replace(/\.PrjPcb$/i, '') : '', parameters:prj.parameters || {}, sheets, libraries, warnings };
  }

  return { build, sheetFromEditor, symbolFromDef, svgSubpaths, hotSpots, pinsAgree, editorFromSheet, readProject,
           orientationOf, rotOf, safeName };
})();

if (typeof module !== 'undefined') module.exports = { AltiumProject };
