/* ==================================================================
   altium.js — the Altium model readers.

   A library component carries up to four attached models (datasheet,
   Altium symbol, Altium footprint, LTspice model). Two of them are
   Altium binaries, and THIS is where they are turned into something
   the editor can draw:

       .SchLib  →  parseSchLib()  →  an IR symbol  →  symbolDefFromAltium()
                                                      → a symbols.js def
       .PcbLib  →  parsePcbLib()  →  footprint metadata (pads, courtyard)
       .lib/.mod/.sub  →  parseLtspice()  →  subcircuits and their pins

   parseSchLib() and parsePcbLib() are PLACEHOLDERS: they report
   `implemented:false` and hand back an empty IR, so the rest of the
   app already runs the whole path (place → fall back to a generated
   body) and only the binary reading is missing. Everything downstream
   of the IR — the conversion into a schematic symbol, the grid snap,
   the pin sides, the body — is real and tested, so implementing the
   reader is a matter of filling the IR in.

   ---- the IR (what a reader must produce) ----------------------------
   {
     ok, implemented, reason, warnings:[…],
     units:'mil',                       // IR coordinates are always mils
     symbols: [{
       name, description, designator:'U',   // designator = the ref prefix
       pins: [{
         name:'VIN', designator:'1',
         x, y,            // the ELECTRICAL end of the pin, in mils,
                          // Altium axes: +x right, +y UP
         length,          // lead length in mils
         orientation,     // 0|90|180|270 — the way the lead runs FROM the
                          // electrical end INTO the body (Altium's own
                          // convention), so 0 puts the pin on the left edge
         electrical,      // 'input'|'output'|'io'|'power'|'passive'…
         hidden
       }],
       primitives: [      // everything else drawn in the symbol, in mils
         { type:'rect',     x1, y1, x2, y2, filled },
         { type:'line',     x1, y1, x2, y2 },
         { type:'polyline', points:[[x,y]…] },
         { type:'polygon',  points:[[x,y]…], filled },
         { type:'arc',      cx, cy, r, start, end },     // degrees, CCW
         { type:'ellipse',  cx, cy, rx, ry, filled },
         { type:'label',    x, y, text }
       ]
     }]
   }

   ---- implementing parseSchLib() later --------------------------------
   A .SchLib is an OLE2 compound document. Inside it every component
   lives in its own storage, whose "Data" stream is a run of records:
   a 4-byte little-endian length, then that many bytes of ASCII made of
   `|KEY=VALUE` pairs. `RECORD=1` opens a component, `RECORD=2` is a pin,
   `RECORD=14` a rectangle, `RECORD=13` a line, `RECORD=6` a polyline,
   `RECORD=7` a polygon, `RECORD=12` an arc, `RECORD=4` a label.
   Coordinates come as `LOCATION.X` / `LOCATION.Y` in Altium internal
   units (1/10000 inch = 0.1 mil), so divide by 10 to get the mils this
   IR wants. Feed the result through symbolDefFromAltium() untouched.
   ================================================================== */
'use strict';

/* Altium's schematic lattice is 100 mil; ours is GRID (10 units) — so one
   Altium grid step is one of our grid cells and a 600-mil IC body is 60 units
   wide, the size the generated bodies already use. */
const MIL_TO_UNIT = 0.1;

/* The lead runs from the connection point INTO the body, so the pin hangs
   off the OPPOSITE edge. Altium's +y is up, ours is down — 90 (up) therefore
   puts the pin on the bottom edge. */
const ALTIUM_PIN_DIR = { 0:'l', 90:'b', 180:'r', 270:'t' };

const Altium = {
  MIL_TO_UNIT, ALTIUM_PIN_DIR,

  /* What the UI says about a model it cannot read yet. */
  status(kind){
    if (kind === 'spice') return { implemented:true, note:'subcircuits and pins are read' };
    return { implemented:false, note:'parser not implemented yet — the symbol falls back to a generated body' };
  },

  /* ---- PLACEHOLDER: the Altium schematic symbol ---------------------
     `data` is an ArrayBuffer/Uint8Array of the .SchLib (or a string, for
     the ASCII exports). Returns the IR described at the top of the file.
     Fill this in and the editor draws the real Altium symbol — nothing
     else has to change. */
  parseSchLib(data, opts){
    const o = opts || {};
    return {
      ok: false, implemented: false,
      reason: 'SchLib parser not implemented yet',
      units: 'mil', symbols: [],
      bytes: byteLength(data),
      want: o.name || null,
      warnings: [],
    };
  },

  /* ---- PLACEHOLDER: the Altium footprint ---------------------------- */
  parsePcbLib(data, opts){
    return {
      ok: false, implemented: false,
      reason: 'PcbLib parser not implemented yet',
      units: 'mil', footprints: [],
      bytes: byteLength(data),
      want: (opts && opts.name) || null,
      warnings: [],
    };
  },

  /* ---- the LTspice model: plain text, so this one is real ----------
     Reads `.subckt` headers (name + pin order) and `.model` lines, which
     is what the editor needs to tie a simulation model to a symbol. */
  parseLtspice(text){
    const src = String(text == null ? '' : text);
    const models = [], warnings = [];
    for (let line of src.split(/\r?\n/)){
      line = line.trim();
      if (!line || line[0] === '*' || line[0] === ';') continue;
      let m = /^\.subckt\s+(\S+)\s*(.*)$/i.exec(line);
      if (m){
        const pins = m[2].split(/\s+/).filter(t => t && !t.includes('='));
        models.push({ kind:'subckt', name:m[1], pins });
        continue;
      }
      m = /^\.model\s+(\S+)\s+([A-Za-z_]+)/i.exec(line);
      if (m) models.push({ kind:'model', name:m[1], type:m[2].toUpperCase(), pins:[] });
    }
    if (!models.length && src.trim()) warnings.push('no .subckt or .model line found');
    return { ok:models.length > 0, implemented:true, models, warnings,
             reason: models.length ? '' : 'no SPICE model found in the file' };
  },

  /* ---- IR symbol → a symbols.js def --------------------------------
     Real code: this is what draws the component once a reader fills the
     IR. Mils become world units, the y axis is flipped (Altium counts up,
     the sheet counts down), every pin is snapped onto the lattice so wires
     land on it, and the body is the symbol's outline — the renderer then
     draws the leads and the pin names itself, exactly as it does for a
     generated IC. */
  symbolDefFromAltium(sym, opts){
    const o = opts || {};
    if (!sym || !Array.isArray(sym.pins) || !sym.pins.length) return null;
    const S2 = (o.scale || MIL_TO_UNIT);
    const snap = v => Math.round(v / GRID) * GRID;
    const X = mx => snap(mx * S2), Y = my => snap(-my * S2);   // +y up → +y down

    const pins = sym.pins.filter(p => !p.hidden).map(p => {
      const dir = ALTIUM_PIN_DIR[((Number(p.orientation) || 0) % 360 + 360) % 360] || 'l';
      return { name:String(p.name || p.designator || '?'), designator:String(p.designator || ''),
               x:X(p.x), y:Y(p.y), dir, electrical:p.electrical || 'passive' };
    });
    if (!pins.length) return null;

    // The body: the biggest rectangle the symbol draws, or the pin extent.
    const rects = (sym.primitives || []).filter(r => r.type === 'rect');
    let body = null;
    for (const r of rects){
      const b = { x:Math.min(X(r.x1), X(r.x2)), y:Math.min(Y(r.y1), Y(r.y2)),
                  w:Math.abs(X(r.x2) - X(r.x1)), h:Math.abs(Y(r.y2) - Y(r.y1)) };
      if (!body || b.w * b.h > body.w * body.h) body = b;
    }
    if (!body){
      const xs = pins.map(p => p.x), ys = pins.map(p => p.y);
      const pad = PIN_LEAD;
      body = { x:Math.min(...xs) + pad, y:Math.min(...ys) + pad,
               w:Math.max(GRID, Math.max(...xs) - Math.min(...xs) - 2 * pad),
               h:Math.max(GRID, Math.max(...ys) - Math.min(...ys) - 2 * pad) };
    }

    const paths = [], bodies = [], fills = [];
    for (const pr of sym.primitives || []){
      if (pr === rects[0] && body && rects.length) continue;          // already the body
      if (pr.type === 'rect'){
        bodies.push(`M${X(pr.x1)} ${Y(pr.y1)}H${X(pr.x2)}V${Y(pr.y2)}H${X(pr.x1)}Z`);
      } else if (pr.type === 'line'){
        paths.push(`M${X(pr.x1)} ${Y(pr.y1)}L${X(pr.x2)} ${Y(pr.y2)}`);
      } else if (pr.type === 'polyline' || pr.type === 'polygon'){
        const pts = (pr.points || []).map(([px, py]) => `${X(px)} ${Y(py)}`);
        if (pts.length < 2) continue;
        const d = 'M' + pts.join('L') + (pr.type === 'polygon' ? 'Z' : '');
        (pr.type === 'polygon' ? (pr.filled ? fills : bodies) : paths).push(d);
      } else if (pr.type === 'arc'){
        paths.push(arcPath(X(pr.cx), Y(pr.cy), Math.abs(pr.r * S2), pr.start, pr.end));
      } else if (pr.type === 'ellipse'){
        const rx = Math.abs(pr.rx * S2), ry = Math.abs(pr.ry * S2);
        bodies.push(`M${X(pr.cx) - rx} ${Y(pr.cy)}a${rx} ${ry} 0 1 0 ${2 * rx} 0a${rx} ${ry} 0 1 0 ${-2 * rx} 0`);
      }
    }

    const b = body;
    const ext = {
      x:Math.min(b.x, ...pins.map(p => p.x)), y:Math.min(b.y, ...pins.map(p => p.y)),
    };
    const maxX = Math.max(b.x + b.w, ...pins.map(p => p.x));
    const maxY = Math.max(b.y + b.h, ...pins.map(p => p.y));
    return {
      label: sym.name || o.label || 'Symbol', cat:'active',
      prefix: String(sym.designator || o.prefix || 'U').replace(/[^A-Za-z]/g, '') || 'U',
      source:'altium', pins, body: b, leads:true, names:true,
      paths, bodies, fills,
      box: { x:ext.x - GRID, y:ext.y - GRID, w:(maxX - ext.x) + 2 * GRID, h:(maxY - ext.y) + 2 * GRID },
    };
  },
};

/* An SVG arc between two angles on a circle (degrees, counter-clockwise in
   Altium's frame, which is clockwise once y is flipped). */
function arcPath(cx, cy, r, startDeg, endDeg){
  const a0 = (Number(startDeg) || 0) * Math.PI / 180, a1 = (Number(endDeg) || 360) * Math.PI / 180;
  const x0 = cx + r * Math.cos(a0), y0 = cy - r * Math.sin(a0);
  const x1 = cx + r * Math.cos(a1), y1 = cy - r * Math.sin(a1);
  let sweep = ((Number(endDeg) || 0) - (Number(startDeg) || 0) + 360) % 360;
  const large = sweep > 180 ? 1 : 0;
  return `M${round2(x0)} ${round2(y0)}A${round2(r)} ${round2(r)} 0 ${large} 0 ${round2(x1)} ${round2(y1)}`;
}
const round2 = v => Math.round(v * 100) / 100;
function byteLength(data){
  if (!data) return 0;
  if (typeof data === 'string') return data.length;
  if (data.byteLength != null) return data.byteLength;
  if (data.length != null) return data.length;
  return 0;
}

if (typeof module !== 'undefined') module.exports = { Altium, MIL_TO_UNIT, ALTIUM_PIN_DIR };
