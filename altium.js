/* ==================================================================
   altium.js — the Altium file formats, read AND written.

   Everything Altium-specific lives here, in layers that each go both
   ways, so the export (editor → Altium) and a future import
   (Altium → editor) are the same code run in opposite directions:

     bytes ⇄ container     cfb.js: the OLE2 compound file (binary docs)
                           or plain text lines (ASCII .SchDoc)
     container ⇄ records   decodeRecords / encodeRecords: a run of
                           length-prefixed records, each `|KEY=VALUE|…`
                           text — or, for a pin in a .SchLib, a packed
                           binary record (decodePin / encodePin)
     records ⇄ documents   readSchLib / writeSchLib    the symbol library
                           readSchDoc / writeSchDoc    a schematic sheet
                           readPrjPcb / writePrjPcb    the project file
     documents ⇄ model     sheetModel() / sheetRecords(): a neutral sheet
                           — components (a library symbol + placement),
                           wires, junctions, net labels, power ports — in
                           Altium units with Altium axes. altium-project.js
                           maps the editor's sheet onto it and back.
     library ⇄ IR          parseSchLib() → the IR the editor draws, via
                           symbolDefFromAltium()

   A record is a plain object with UPPER-CASE keys and string values,
   exactly the `|KEY=VALUE|` pairs of the file (Altium is case-blind
   about keys; SchLib files say `Location.X`, SchDoc files `LOCATION.X`).
   Pins are carried in that same shape everywhere — the binary form only
   exists inside a .SchLib Data stream — so one transform, one writer and
   one reader handle a pin like any other primitive.

   ---- units and axes --------------------------------------------------
   A schematic coordinate is a count of 10 mil (DXP "units": the default
   snap grid of 10 = 100 mil), plus an optional `_FRAC` key holding
   1/100000 of a unit — `LOCATION.X=12|LOCATION.X_FRAC=50000` is 125 mil.
   +x runs right and +y runs UP. One editor world unit is one Altium
   unit (the editor's 10-unit grid is Altium's 100 mil), so the export
   only flips y and shifts the sheet onto Altium's positive quadrant.

   A pin's LOCATION is the end that touches the body; the end a wire
   connects to (the "hot spot") is LOCATION + PINLENGTH in the pin's
   direction. That direction is bits 0–1 of PINCONGLOMERATE: 0 right,
   1 up, 2 left, 3 down — so a pin on the left edge of a body is 2.

   A placed component (SchDoc RECORD=1) has LOCATION, ORIENTATION (the
   number of 90° counter-clockwise turns) and ISMIRRORED; its children —
   pins, lines, the designator — are stored at their final sheet
   coordinates. Mirroring is about the component's own vertical axis and
   happens before the rotation.
   ================================================================== */
'use strict';

/* Altium's schematic lattice is 100 mil; ours is GRID (10 units) — so one
   Altium grid step is one of our grid cells and a 600-mil IC body is 60 units
   wide, the size the generated bodies already use. */
const MIL_TO_UNIT = 0.1;
const MIL_PER_DXP = 10;                 // one Altium schematic unit, in mils

/* The IR's pin orientation is the way the lead runs FROM the electrical end
   INTO the body, so the pin hangs off the OPPOSITE edge. The IR's +y is up,
   ours is down — 90 (up) therefore puts the pin on the bottom edge. */
const ALTIUM_PIN_DIR = { 0:'l', 90:'b', 180:'r', 270:'t' };

/* ---- the record types this module knows by name ---- */
const REC = {
  COMPONENT:1, PIN:2, IEEE:3, LABEL:4, BEZIER:5, POLYLINE:6, POLYGON:7, ELLIPSE:8, PIE:9,
  ROUNDRECT:10, ELLIPTICAL_ARC:11, ARC:12, LINE:13, RECTANGLE:14, SHEET_SYMBOL:15, SHEET_ENTRY:16,
  POWER_PORT:17, PORT:18, NO_ERC:22, NET_LABEL:25, BUS:26, WIRE:27, TEXT_FRAME:28, JUNCTION:29,
  IMAGE:30, SHEET:31, SHEET_NAME:32, FILE_NAME:33, DESIGNATOR:34, BUS_ENTRY:37, TEMPLATE:39,
  PARAMETER:41, IMPL_LIST:44, IMPLEMENTATION:45, MAP_DEF_LIST:46, MAP_DEF:47, IMPL_PARAMS:48,
};
/* The records that sit somewhere on the sheet (the rest — the implementation
   records, the component header — carry no coordinates to move). */
const PLACED = new Set([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 28, 30, 34, 41]);
const TEXTS = new Set([REC.LABEL, REC.DESIGNATOR, REC.PARAMETER]);
const ELECTRICAL = ['input', 'io', 'output', 'open_collector', 'passive', 'hiz', 'open_emitter', 'power'];
const ELECTRICAL_CODE = { input:0, io:1, output:2, open_collector:3, oc:3, passive:4, hiz:5, emitter:6,
                          open_emitter:6, power:7, ground:7, analog:4, nc:4 };
/* Power port STYLE codes. */
const POWER_STYLE = { circle:0, arrow:1, bar:2, wave:3, power_ground:4, signal_ground:5, earth:6 };

/* Colours are Windows COLORREFs: 0x00BBGGRR. */
const COLOR = {
  line: 0x800000,          // #000080 navy — symbol outlines, wires, text
  bodyFill: 0xB0FFFF,      // #FFFFB0 pale yellow — component bodies
  junction: 0x000080,      // #800000 dark red
  netLabel: 0x000080,
  sheetArea: 0xF8FCFF,     // the sheet paper
  noErc: 0x0000FF,
};

const HEADERS = {
  schDocBinary: 'Protel for Windows - Schematic Capture Binary File Version 5.0',
  schDocAscii:  'Protel for Windows - Schematic Capture Ascii File Version 5.0',
  schLib:       'Protel for Windows - Schematic Library Editor Binary File Version 5.0',
  icons:        'Icon storage',
};

/* ==================================================================
   1. TEXT — Altium writes Windows-1252; anything outside it rides in a
      parallel `%UTF8%KEY=` pair holding the UTF-8 bytes.
   ================================================================== */
const latin1Bytes = s => Uint8Array.from(String(s), c => { const v = c.charCodeAt(0); return v < 256 ? v : 0x3F; });
const latin1String = b => { let s = ''; for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode.apply(null, b.subarray(i, i + 8192)); return s; };
const utf8Bytes = s => typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(String(s)) : latin1Bytes(unescape(encodeURIComponent(String(s))));
const utf8String = b => typeof TextDecoder !== 'undefined' ? new TextDecoder().decode(b) : decodeURIComponent(escape(latin1String(b)));
const needsUtf8 = s => /[^\x00-\xFF]/.test(s);

/* `|A=1|B=2` → { A:'1', B:'2' }. %UTF8% twins win over their 1252 fallback. */
function parseProps(text){
  const props = {}, utf = {};
  for (const part of String(text).replace(/\0+$/, '').split('|')){
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const key = part.slice(0, eq).toUpperCase(), val = part.slice(eq + 1);
    if (key.startsWith('%UTF8%')){
      try { utf[key.slice(6)] = utf8String(latin1Bytes(val)); } catch(e){}
    } else props[key] = val;
  }
  for (const [k, v] of Object.entries(utf)) props[k] = v;
  return props;
}
/* The inverse: a string of 1252 code points (one char per byte). */
function formatProps(props){
  let s = '';
  for (const [k, raw] of Object.entries(props)){
    if (raw == null || k.startsWith('__')) continue;
    const v = String(raw);
    if (needsUtf8(v)) s += '|%UTF8%' + k + '=' + latin1String(utf8Bytes(v)).replace(/\|/g, '¦');
    s += '|' + k + '=' + v.replace(/[^\x00-\xFF]/g, '?').replace(/\|/g, '¦');
  }
  return s;
}

/* ==================================================================
   2. RECORDS — a stream is a run of records, each a little-endian
      uint32 whose low 24 bits are the length and high byte the type
      (0 = `|KEY=VALUE|` text ending in NUL, 1 = binary).
   ================================================================== */
function decodeRecords(bytes){
  const b = CFB.u8(bytes), out = [];
  let o = 0;
  while (o + 4 <= b.length){
    const len = b[o] | (b[o + 1] << 8) | (b[o + 2] << 16), type = b[o + 3];
    o += 4;
    if (len === 0) continue;
    const body = b.subarray(o, o + len);
    o += len;
    if (type === 0) out.push(parseProps(latin1String(body)));
    else if (type === 1 && body[0] === REC.PIN) out.push(decodePin(body));
    else out.push({ __binary:body.slice(), __type:type });
  }
  return out;
}
function encodeRecord(rec, binaryPins){
  let body, type = 0;
  if (rec.__binary){ body = rec.__binary; type = rec.__type || 1; }
  else if (binaryPins && String(rec.RECORD) === '2'){ body = encodePin(rec); type = 1; }
  else body = latin1Bytes(formatProps(rec) + '\0');
  if (body.length > 0xFFFFFF) throw new Error('record too long');
  const head = new Uint8Array([body.length & 0xFF, (body.length >> 8) & 0xFF, (body.length >> 16) & 0xFF, type]);
  return CFB.concat([head, body]);
}
const encodeRecords = (records, binaryPins) => CFB.concat(records.map(r => encodeRecord(r, binaryPins)));

/* ---- the binary pin of a .SchLib ------------------------------------
     int32  RECORD (= 2)        u8  (reserved)       int16 OWNERPARTID
     u8     OWNERPARTDISPLAYMODE                     u8 ×4 SYMBOL_INNEREDGE,
            SYMBOL_OUTEREDGE, SYMBOL_INSIDE, SYMBOL_OUTSIDE
     pascal DESCRIPTION         u8  FORMALTYPE       u8 ELECTRICAL
     u8     PINCONGLOMERATE     int16 PINLENGTH, LOCATION.X, LOCATION.Y
     uint32 COLOR               pascal NAME, DESIGNATOR, SWAPIDGROUP,
                                PARTANDSEQUENCE ("|&|"), DEFAULTVALUE
   (pascal = one length byte, then that many 1252 bytes) */
const PIN_FIELDS = ['SYMBOL_INNEREDGE', 'SYMBOL_OUTEREDGE', 'SYMBOL_INSIDE', 'SYMBOL_OUTSIDE'];
function decodePin(b){
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let o = 0;
  const u8 = () => b[o++], i16 = () => { const v = dv.getInt16(o, true); o += 2; return v; };
  const u32 = () => { const v = dv.getUint32(o, true); o += 4; return v; };
  const str = () => { const n = b[o++] || 0; const s = latin1String(b.subarray(o, o + n)); o += n; return s; };
  const rec = { RECORD:String(u32()) };
  o++;                                                    // reserved byte
  rec.OWNERPARTID = String(i16());
  rec.OWNERPARTDISPLAYMODE = String(u8());
  for (const f of PIN_FIELDS) rec[f] = String(u8());
  rec.DESCRIPTION = str();
  rec.FORMALTYPE = String(u8());
  rec.ELECTRICAL = String(u8());
  rec.PINCONGLOMERATE = String(u8());
  rec.PINLENGTH = String(i16());
  rec['LOCATION.X'] = String(i16());
  rec['LOCATION.Y'] = String(i16());
  rec.COLOR = String(u32());
  rec.NAME = str();
  rec.DESIGNATOR = str();
  if (o < b.length) rec.SWAPIDGROUP = str();
  if (o < b.length) rec.PARTANDSEQUENCE = str();
  if (o < b.length) rec.DEFAULTVALUE = str();
  for (const k of Object.keys(rec)) if (rec[k] === '') delete rec[k];
  return rec;
}
function encodePin(rec){
  const g = (k, d) => (rec[k] != null && rec[k] !== '' ? rec[k] : d);
  const pas = s => { const b = latin1Bytes(String(s || '')).subarray(0, 255); return CFB.concat([new Uint8Array([b.length]), b]); };
  const head = new Uint8Array(12), hv = new DataView(head.buffer);
  hv.setUint32(0, 2, true);
  hv.setInt16(5, Number(g('OWNERPARTID', 1)), true);
  head[7] = Number(g('OWNERPARTDISPLAYMODE', 0));
  PIN_FIELDS.forEach((f, i) => { head[8 + i] = Number(g(f, 0)); });
  const mid = new Uint8Array(13), mv = new DataView(mid.buffer);
  mid[0] = Number(g('FORMALTYPE', 1)); mid[1] = Number(g('ELECTRICAL', 4)); mid[2] = Number(g('PINCONGLOMERATE', 0));
  // binary pins hold whole units only: a fractional pin is rounded here
  mv.setInt16(3, Math.round(coord(rec, 'PINLENGTH')), true);
  mv.setInt16(5, Math.round(coord(rec, 'LOCATION.X')), true);
  mv.setInt16(7, Math.round(coord(rec, 'LOCATION.Y')), true);
  mv.setUint32(9, Number(g('COLOR', 0)) >>> 0, true);
  return CFB.concat([head, pas(g('DESCRIPTION', '')), mid,
    pas(g('NAME', '')), pas(g('DESIGNATOR', '')), pas(g('SWAPIDGROUP', '')), pas(g('PARTANDSEQUENCE', '|&|')), pas(g('DEFAULTVALUE', ''))]);
}

/* ---- ASCII .SchDoc: one record per line, sections opened by HEADER ---- */
function decodeAscii(text){
  const sections = [];
  let cur = null;
  for (const line of String(text).split(/\r?\n/)){
    if (!line.trim()) continue;
    const props = parseProps(line);
    if (props.HEADER != null){ cur = { header:props, records:[] }; sections.push(cur); continue; }
    if (!cur){ cur = { header:{}, records:[] }; sections.push(cur); }
    cur.records.push(props);
  }
  return sections;
}

/* ==================================================================
   3. COORDINATES — integer units plus 1/100000 fractions, both ways.
   ================================================================== */
function coord(rec, key){
  const v = Number(rec[key] || 0), f = Number(rec[key + '_FRAC'] || 0);
  return v + f / 100000;
}
function setCoord(rec, key, value){
  const v = Math.round(Number(value) * 100000) / 100000;
  const whole = Math.trunc(v), frac = Math.round((v - whole) * 100000);
  rec[key] = String(whole);
  if (frac) rec[key + '_FRAC'] = String(frac); else delete rec[key + '_FRAC'];
}
const recType = rec => Number(rec.RECORD);

/* Every point a record holds, as [xKey, yKey] pairs. */
function pointKeys(rec){
  const keys = [], t = recType(rec);
  if (rec.LOCATIONCOUNT != null){
    const n = Number(rec.LOCATIONCOUNT) || 0;
    for (let i = 1; i <= n; i++) keys.push(['X' + i, 'Y' + i]);
  }
  if (t !== REC.WIRE && t !== REC.POLYLINE && t !== REC.POLYGON && t !== REC.BEZIER && t !== REC.BUS)
    keys.push(['LOCATION.X', 'LOCATION.Y']);
  if ([REC.LINE, REC.RECTANGLE, REC.ROUNDRECT, REC.TEXT_FRAME, REC.IMAGE, REC.BUS_ENTRY].includes(t))
    keys.push(['CORNER.X', 'CORNER.Y']);
  return keys;
}

/* ---- placement: a component's local frame → the sheet, and back ----
   T = { x, y, orientation (0-3 CCW quarter turns), mirrored }. */
const rot90 = (x, y, k) => {
  switch (((k % 4) + 4) % 4){
    case 1: return [-y, x];
    case 2: return [-x, -y];
    case 3: return [y, -x];
    default: return [x, y];
  }
};
function placePoint(x, y, T){
  if (T.mirrored) x = -x;
  const [rx, ry] = rot90(x, y, T.orientation || 0);
  return [rx + (T.x || 0), ry + (T.y || 0)];
}
function unplacePoint(x, y, T){
  let [rx, ry] = rot90(x - (T.x || 0), y - (T.y || 0), -(T.orientation || 0));
  if (T.mirrored) rx = -rx;
  return [rx, ry];
}
/* A direction 0-3 (right, up, left, down) through the same placement. */
function placeDir(d, T, inverse){
  const k = T.orientation || 0;
  if (!inverse){ if (T.mirrored && d % 2 === 0) d = (d + 2) % 4; return (d + k) % 4; }
  d = ((d - k) % 4 + 4) % 4;
  if (T.mirrored && d % 2 === 0) d = (d + 2) % 4;
  return d;
}
function placeAngle(a, T, inverse){
  const k = (T.orientation || 0) * 90;
  if (!inverse){ if (T.mirrored) a = 180 - a; return ((a + k) % 360 + 360) % 360; }
  a = ((a - k) % 360 + 360) % 360;
  if (T.mirrored) a = ((180 - a) % 360 + 360) % 360;
  return a;
}
/* A copy of `rec` moved through T (or back through it, `inverse`). Points,
   rectangle corners, pin and text orientations, arc angles and ellipse radii
   all follow; everything else is copied untouched. */
function transformRecord(rec, T, inverse){
  const r = { ...rec }, t = recType(r);
  if (!PLACED.has(t)) return r;
  const move = inverse ? unplacePoint : placePoint;
  for (const [kx, ky] of pointKeys(r)){
    const [x, y] = move(coord(r, kx), coord(r, ky), T);
    setCoord(r, kx, x); setCoord(r, ky, y);
  }
  if ([REC.RECTANGLE, REC.ROUNDRECT, REC.TEXT_FRAME, REC.IMAGE].includes(t)){
    const x1 = coord(r, 'LOCATION.X'), y1 = coord(r, 'LOCATION.Y'), x2 = coord(r, 'CORNER.X'), y2 = coord(r, 'CORNER.Y');
    setCoord(r, 'LOCATION.X', Math.min(x1, x2)); setCoord(r, 'LOCATION.Y', Math.min(y1, y2));
    setCoord(r, 'CORNER.X', Math.max(x1, x2)); setCoord(r, 'CORNER.Y', Math.max(y1, y2));
  }
  if (t === REC.PIN){
    const c = Number(r.PINCONGLOMERATE || 0);
    r.PINCONGLOMERATE = String((c & ~3) | placeDir(c & 3, T, inverse));
  }
  if (t === REC.ARC || t === REC.ELLIPTICAL_ARC || t === REC.PIE){
    let s = placeAngle(coord(r, 'STARTANGLE'), T, inverse);
    let e = placeAngle(r.ENDANGLE != null ? coord(r, 'ENDANGLE') : 360, T, inverse);
    if (T.mirrored) [s, e] = [e, s];                  // a mirror reverses the sweep
    setCoord(r, 'STARTANGLE', s); setCoord(r, 'ENDANGLE', e);
  }
  if ((t === REC.ELLIPSE || t === REC.ELLIPTICAL_ARC) && (T.orientation || 0) % 2){
    const a = coord(r, 'RADIUS'), b = r.SECONDARYRADIUS != null ? coord(r, 'SECONDARYRADIUS') : a;
    setCoord(r, 'RADIUS', b); setCoord(r, 'SECONDARYRADIUS', a);
  }
  if (TEXTS.has(t)){
    const o = Number(r.ORIENTATION || 0), k = T.orientation || 0;
    const n = (((inverse ? o - k : o + k) % 4) + 4) % 4;
    if (n) r.ORIENTATION = String(n); else delete r.ORIENTATION;
  }
  return r;
}

/* Deterministic Altium-style unique ids: eight capital letters. */
function uniqueIdMaker(seed){
  let h = 2166136261 >>> 0;
  for (const c of String(seed || 'altium')) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  const used = new Set();
  return () => {
    for (;;){
      let s = '';
      for (let i = 0; i < 8; i++){ h = (Math.imul(h, 1103515245) + 12345) >>> 0; s += String.fromCharCode(65 + (h >>> 8) % 26); }
      if (!used.has(s)){ used.add(s); return s; }
    }
  };
}

/* ==================================================================
   4. .SchLib — the symbol library.
      OLE2 streams:  FileHeader            library properties + the list
                                           of components (LIBREF0…)
                     Storage               icon storage
                     SectionKeys           (only when a name does not fit
                                           a 31-character storage name)
                     <section>/Data        one component: RECORD=1, then
                                           its primitives; pins binary
   ================================================================== */

/* A library symbol, the unit everything here passes around:
     { name, description, designator:'U', partCount, header:{RECORD=1 props},
       records:[ every child record, pins included, in LOCAL coordinates ] } */
function readSchLib(data){
  const cfb = CFB.read(data);
  const fhRaw = cfb.get('FileHeader');
  if (!fhRaw) throw new Error('no FileHeader stream — not a schematic library');
  const fh = decodeRecords(fhRaw)[0] || {};
  const keys = new Map();
  const sk = cfb.get('SectionKeys');
  if (sk){
    const p = decodeRecords(sk)[0] || {};
    for (let i = 0; i < Number(p.KEYCOUNT || 0); i++) if (p['LIBREF' + i]) keys.set(p['LIBREF' + i], p['SECTIONKEY' + i]);
  }
  const listed = [];
  for (let i = 0; i < Number(fh.COMPCOUNT || 0); i++) if (fh['LIBREF' + i] != null) listed.push(fh['LIBREF' + i]);
  const dataStreams = cfb.list().filter(p => /\/Data$/.test(p));
  const order = listed.length ? listed : dataStreams.map(p => p.slice(0, -5));
  const symbols = [], warnings = [];
  for (const libRef of order){
    const section = keys.get(libRef) || sectionKeyFor(libRef);
    const stream = cfb.get(section + '/Data') ||
      cfb.get(dataStreams.find(p => p.slice(0, -5).toUpperCase() === section.toUpperCase()) || '');
    if (!stream){ warnings.push('component "' + libRef + '" has no Data stream'); continue; }
    const recs = decodeRecords(stream);
    const header = recs.find(r => recType(r) === REC.COMPONENT) || {};
    const records = recs.filter(r => r !== header && !r.__binary);
    const des = records.find(r => recType(r) === REC.DESIGNATOR);
    symbols.push({
      name: header.LIBREFERENCE || libRef,
      description: header.COMPONENTDESCRIPTION || '',
      designator: des ? String(des.TEXT || '').replace(/\?+$/, '') : '',
      partCount: Math.max(1, Number(header.PARTCOUNT || 2) - 1),
      header, records,
    });
  }
  return { header:fh, symbols, warnings };
}

/* Altium names a component's storage after it, cut to 31 characters with the
   characters a storage name cannot hold replaced. */
const sectionKeyFor = name => String(name).replace(/[\/\\:!]/g, '_').slice(0, 31);

function writeSchLib(symbols){
  const uid = uniqueIdMaker('schlib:' + symbols.map(s => s.name).join('|'));
  const fh = {
    HEADER: HEADERS.schLib, WEIGHT: String(symbols.length), MINORVERSION: '9', UNIQUEID: uid(),
    FONTIDCOUNT: '1', SIZE1: '10', FONTNAME1: 'Times New Roman', USEMBCS: 'T', ISBOC: 'T',
    SHEETSTYLE: '9', SYSTEMFONT: '1', BORDERON: 'T', SHEETNUMBERSPACESIZE: '12', AREACOLOR: String(COLOR.sheetArea),
    SNAPGRIDON: 'T', SNAPGRIDSIZE: '10', VISIBLEGRIDON: 'T', VISIBLEGRIDSIZE: '10',
    CUSTOMX: '18000', CUSTOMY: '18000', USECUSTOMSHEET: 'T', REFERENCEZONESON: 'T', DISPLAY_UNIT: '0',
    COMPCOUNT: String(symbols.length),
  };
  const files = {}, sectionKeys = [], usedSections = new Set();
  symbols.forEach((s, i) => {
    fh['LIBREF' + i] = s.name;
    fh['COMPDESCR' + i] = s.description || '';
    fh['PARTCOUNT' + i] = String((s.partCount || 1) + 1);
    let section = sectionKeyFor(s.name), n = 1;
    while (usedSections.has(section.toUpperCase())) section = sectionKeyFor(s.name).slice(0, 27) + '~' + (n++);
    usedSections.add(section.toUpperCase());
    if (section !== s.name) sectionKeys.push([s.name, section]);
    const pins = s.records.filter(r => recType(r) === REC.PIN);
    const header = {
      RECORD: '1', LIBREFERENCE: s.name, COMPONENTDESCRIPTION: s.description || undefined,
      PARTCOUNT: String((s.partCount || 1) + 1), DISPLAYMODECOUNT: '1', INDEXINSHEET: '-1', OWNERPARTID: '-1',
      CURRENTPARTID: '1', LIBRARYPATH: '*', SOURCELIBRARYNAME: '*', SHEETPARTFILENAME: '*', TARGETFILENAME: '*',
      UNIQUEID: uid(), AREACOLOR: String(COLOR.bodyFill), COLOR: '128', PARTIDLOCKED: 'T',
      DESIGNITEMID: s.name, ALLPINCOUNT: String(pins.length),
    };
    const children = s.records.map(r => { const c = { ...r }; delete c.OWNERINDEX; return c; });
    files[section + '/Data'] = encodeRecords([header, ...children], true);
  });
  files.FileHeader = encodeRecords([fh]);
  files.Storage = encodeRecords([{ HEADER: HEADERS.icons, WEIGHT: '0' }]);
  if (sectionKeys.length){
    const p = { KEYCOUNT: String(sectionKeys.length) };
    sectionKeys.forEach(([lib, sec], i) => { p['LIBREF' + i] = lib; p['SECTIONKEY' + i] = sec; });
    files.SectionKeys = encodeRecords([p]);
  }
  return CFB.write(files);
}

/* The records of the part that is drawn: part 1 (or the shared ones, part
   0/-1) in the normal display mode. */
const inFirstPart = r => Number(r.OWNERPARTID == null ? 1 : r.OWNERPARTID) <= 1 && Number(r.OWNERPARTDISPLAYMODE || 0) === 0;

/* ---- a library symbol → the IR the editor draws (mils, +y up) ---- */
function irFromLibSymbol(sym){
  const M = v => v * MIL_PER_DXP;
  const pins = [], primitives = [];
  for (const r of sym.records.filter(inFirstPart)){
    const t = recType(r);
    if (t === REC.PIN){
      const c = Number(r.PINCONGLOMERATE || 0), dir = c & 3, len = coord(r, 'PINLENGTH');
      const [dx, dy] = [[1, 0], [0, 1], [-1, 0], [0, -1]][dir];
      const x = coord(r, 'LOCATION.X') + dx * len, y = coord(r, 'LOCATION.Y') + dy * len;
      pins.push({
        name: r.NAME || r.DESIGNATOR || '', designator: r.DESIGNATOR || r.NAME || '',
        x: M(x), y: M(y), length: M(len), orientation: (dir * 90 + 180) % 360,
        electrical: ELECTRICAL[Number(r.ELECTRICAL || 4)] || 'passive', hidden: !!(c & 4),
      });
    } else if (t === REC.RECTANGLE || t === REC.ROUNDRECT){
      primitives.push({ type:'rect', x1:M(coord(r, 'LOCATION.X')), y1:M(coord(r, 'LOCATION.Y')),
                        x2:M(coord(r, 'CORNER.X')), y2:M(coord(r, 'CORNER.Y')), filled:r.ISSOLID === 'T' });
    } else if (t === REC.LINE){
      primitives.push({ type:'line', x1:M(coord(r, 'LOCATION.X')), y1:M(coord(r, 'LOCATION.Y')),
                        x2:M(coord(r, 'CORNER.X')), y2:M(coord(r, 'CORNER.Y')) });
    } else if (t === REC.POLYLINE || t === REC.POLYGON || t === REC.BEZIER){
      const points = pointKeys(r).map(([kx, ky]) => [M(coord(r, kx)), M(coord(r, ky))]);
      primitives.push(t === REC.POLYGON ? { type:'polygon', points, filled:r.ISSOLID === 'T' } : { type:'polyline', points });
    } else if (t === REC.ARC || t === REC.ELLIPTICAL_ARC || t === REC.PIE){
      primitives.push({ type:'arc', cx:M(coord(r, 'LOCATION.X')), cy:M(coord(r, 'LOCATION.Y')), r:M(coord(r, 'RADIUS')),
                        start:coord(r, 'STARTANGLE'), end:r.ENDANGLE != null ? coord(r, 'ENDANGLE') : 360 });
    } else if (t === REC.ELLIPSE){
      const rx = coord(r, 'RADIUS');
      primitives.push({ type:'ellipse', cx:M(coord(r, 'LOCATION.X')), cy:M(coord(r, 'LOCATION.Y')),
                        rx:M(rx), ry:M(r.SECONDARYRADIUS != null ? coord(r, 'SECONDARYRADIUS') : rx), filled:r.ISSOLID === 'T' });
    } else if (t === REC.LABEL){
      primitives.push({ type:'label', x:M(coord(r, 'LOCATION.X')), y:M(coord(r, 'LOCATION.Y')), text:r.TEXT || '' });
    }
  }
  return { name:sym.name, description:sym.description, designator:sym.designator || 'U', pins, primitives, altium:sym };
}

/* ==================================================================
   5. .SchDoc — a schematic sheet.
      Binary: OLE2 with a FileHeader stream (a header record, the sheet
      record, then every object) and a Storage stream (embedded images).
      ASCII: the same records, one per line, between `|HEADER=` lines.
      Either way a record's OWNERINDEX is the position of its owner in
      that list (0 = the sheet record), and a component's primitives
      follow it.
   ================================================================== */
function readSchDoc(data){
  let records, format;
  if (CFB.isCFB(data)){
    const cfb = CFB.read(data);
    const fh = cfb.get('FileHeader');
    if (!fh) throw new Error('no FileHeader stream — not a schematic document');
    const all = decodeRecords(fh);
    records = all[0] && all[0].HEADER != null ? all.slice(1) : all;
    format = 'binary';
  } else {
    const text = typeof data === 'string' ? data : latin1String(CFB.u8(data));
    if (!/\|HEADER=Protel for Windows - Schematic Capture/.test(text.slice(0, 400))) throw new Error('not a schematic document');
    records = (decodeAscii(text)[0] || { records:[] }).records;
    format = 'ascii';
  }
  return { format, records };
}
function writeSchDoc(records, opts){
  const format = (opts && opts.format) || 'binary';
  if (format === 'ascii'){
    const lines = ['|HEADER=' + HEADERS.schDocAscii + '|WEIGHT=' + records.length + '|MINORVERSION=13'];
    for (const r of records) lines.push(formatProps(r));
    lines.push('|HEADER=' + HEADERS.icons, '|HEADER=' + HEADERS.schDocAscii);
    return latin1Bytes(lines.join('\r\n') + '\r\n');
  }
  return CFB.write({
    FileHeader: encodeRecords([{ HEADER: HEADERS.schDocBinary, WEIGHT: String(records.length), MINORVERSION: '13' }, ...records]),
    Storage: encodeRecords([{ HEADER: HEADERS.icons, WEIGHT: '0' }]),
  });
}

/* The sheet parameters every new Altium sheet carries; a value given in
   `params` is filled in, the rest stay `*` (Altium's "not set"). */
const SHEET_PARAMETERS = ['CurrentTime', 'CurrentDate', 'Time', 'Date', 'DocumentFullPathAndName', 'DocumentName',
  'ModifiedDate', 'ApprovedBy', 'CheckedBy', 'Author', 'CompanyName', 'DrawnBy', 'Engineer', 'Organization',
  'Address1', 'Address2', 'Address3', 'Address4', 'Title', 'DocumentNumber', 'Revision', 'SheetNumber', 'SheetTotal',
  'Rule', 'ImagePath', 'ProjectName', 'Application_BuildNumber'];

/* ---- the neutral sheet model → records ------------------------------
   model = {
     name, size:{ w, h },                   (units)
     parameters: { Title, Revision, … },
     components: [{ symbol, x, y, orientation, mirrored, designator, comment,
                    sourceLibrary, description, parameters:[{name, value}],
                    designatorAt?, commentAt?: { x, y, orientation }   (sheet coords) }],
     wires: [[[x, y]…]…], junctions: [[x, y]…], noErcs: [[x, y]…],
     netLabels: [{ x, y, orientation, text }],
     powerPorts: [{ x, y, orientation, style, text }],
     texts: [{ x, y, orientation, text }],
   } */
function sheetRecords(model, opts){
  const uid = uniqueIdMaker((opts && opts.seed) || model.name || 'sheet');
  const out = [];
  let index = 0;
  const add = rec => { out.push(rec); return out.length - 1; };
  const top = rec => add({ RECORD: String(rec.RECORD), INDEXINSHEET: String(++index), OWNERPARTID: '-1', ...rec, UNIQUEID: uid() });
  const w = Math.max(100, Math.ceil(((model.size && model.size.w) || 1500) / 10) * 10);
  const h = Math.max(100, Math.ceil(((model.size && model.size.h) || 950) / 10) * 10);

  add({
    RECORD: '31', FONTIDCOUNT: '1', SIZE1: '10', FONTNAME1: 'Times New Roman', USEMBCS: 'T', ISBOC: 'T',
    HOTSPOTGRIDON: 'T', HOTSPOTGRIDSIZE: '4', SYSTEMFONT: '1', BORDERON: 'T', TITLEBLOCKON: 'T',
    SHEETNUMBERSPACESIZE: '12', AREACOLOR: String(COLOR.sheetArea), SNAPGRIDON: 'T', SNAPGRIDSIZE: '10',
    VISIBLEGRIDON: 'T', VISIBLEGRIDSIZE: '10', USECUSTOMSHEET: 'T', CUSTOMX: String(w), CUSTOMY: String(h),
    CUSTOMXZONES: String(Math.max(2, Math.round(w / 250))), CUSTOMYZONES: String(Math.max(2, Math.round(h / 250))),
    CUSTOMMARGINWIDTH: '20', DISPLAY_UNIT: '0',
  });
  const params = model.parameters || {};
  SHEET_PARAMETERS.forEach((name, i) => {
    const v = params[name];
    add({ RECORD: '41', ...(i ? { INDEXINSHEET: String(i) } : {}), OWNERPARTID: '-1', COLOR: '8388608', FONTID: '1',
          ISHIDDEN: 'T', TEXT: v != null && v !== '' ? String(v) : '*', NAME: name, READONLYSTATE: '1' });
  });
  index = SHEET_PARAMETERS.length;

  for (const c of model.components || []){
    const sym = c.symbol;
    const T = { x:c.x, y:c.y, orientation:c.orientation || 0, mirrored:!!c.mirrored };
    const children = sym.records.filter(inFirstPart);
    const pins = children.filter(r => recType(r) === REC.PIN);
    const head = {
      RECORD: '1', LIBREFERENCE: sym.name, COMPONENTDESCRIPTION: c.description || sym.description || undefined,
      PARTCOUNT: String((sym.partCount || 1) + 1), DISPLAYMODECOUNT: '1', INDEXINSHEET: String(++index),
      OWNERPARTID: '-1', 'LOCATION.X': '0', 'LOCATION.Y': '0',
      ...(T.orientation ? { ORIENTATION: String(T.orientation) } : {}), ...(T.mirrored ? { ISMIRRORED: 'T' } : {}),
      CURRENTPARTID: '1', LIBRARYPATH: '*', SOURCELIBRARYNAME: c.sourceLibrary || '*', SHEETPARTFILENAME: '*',
      TARGETFILENAME: '*', UNIQUEID: uid(), AREACOLOR: String(COLOR.bodyFill), COLOR: '128', PARTIDLOCKED: 'T',
      DESIGNITEMID: c.designItemId || sym.name, ALLPINCOUNT: String(pins.length),
    };
    setCoord(head, 'LOCATION.X', c.x); setCoord(head, 'LOCATION.Y', c.y);
    const owner = add(head);

    // the drawing, the pins and the texts, moved onto the sheet
    let hasDes = false, hasCom = false, implList = -1, impl = -1, mapList = -1;
    const given = new Map((c.parameters || []).filter(p => p && p.name).map(p => [String(p.name).toUpperCase(), p]));
    for (const raw of children){
      const t = recType(raw);
      if (t === REC.COMPONENT) continue;
      const r = transformRecord(raw, T);
      delete r.UNIQUEID; delete r.OWNERINDEX; delete r.INDEXINSHEET;
      if (t === REC.DESIGNATOR){
        hasDes = true;
        r.TEXT = c.designator || r.TEXT || '';
        if (c.designatorAt) placeText(r, c.designatorAt);
      } else if (t === REC.PARAMETER && String(r.NAME || '').toUpperCase() === 'COMMENT'){
        hasCom = true;
        if (c.comment != null) r.TEXT = c.comment;
        if (c.commentAt) placeText(r, c.commentAt);
      } else if (t === REC.PARAMETER && given.has(String(r.NAME || '').toUpperCase())){
        r.TEXT = String(given.get(String(r.NAME).toUpperCase()).value);
        given.delete(String(r.NAME).toUpperCase());
      }
      // the implementation (footprint, simulation) records nest: 44 → 45 → 46/48 → 47
      let ownerIdx = owner;
      if (t === REC.IMPLEMENTATION) ownerIdx = implList >= 0 ? implList : owner;
      else if (t === REC.MAP_DEF_LIST || t === REC.IMPL_PARAMS) ownerIdx = impl >= 0 ? impl : owner;
      else if (t === REC.MAP_DEF) ownerIdx = mapList >= 0 ? mapList : owner;
      const rec = { RECORD: r.RECORD, OWNERINDEX: String(ownerIdx), ...r };
      if (t === REC.PIN) rec.UNIQUEID = uid();
      const at = add(rec);
      if (t === REC.IMPL_LIST) implList = at;
      else if (t === REC.IMPLEMENTATION) impl = at;
      else if (t === REC.MAP_DEF_LIST) mapList = at;
    }
    if (!hasDes){
      const r = { RECORD: '34', OWNERINDEX: String(owner), INDEXINSHEET: '-1', OWNERPARTID: '-1', COLOR: '8388608',
                  FONTID: '1', TEXT: c.designator || '', NAME: 'Designator', READONLYSTATE: '1' };
      placeText(r, c.designatorAt || { x:c.x, y:c.y + 10 });
      add(r);
    }
    if (!hasCom && (c.comment || c.commentAt)){
      const r = { RECORD: '41', OWNERINDEX: String(owner), INDEXINSHEET: '-1', OWNERPARTID: '-1', COLOR: '8388608',
                  FONTID: '1', TEXT: c.comment || '', NAME: 'Comment' };
      placeText(r, c.commentAt || { x:c.x, y:c.y - 20 });
      add(r);
    }
    for (const p of given.values()){
      const r = { RECORD: '41', OWNERINDEX: String(owner), INDEXINSHEET: '-1', OWNERPARTID: '-1', COLOR: '8388608',
                  FONTID: '1', ISHIDDEN: 'T', TEXT: String(p.value == null ? '' : p.value), NAME: String(p.name) };
      setCoord(r, 'LOCATION.X', c.x); setCoord(r, 'LOCATION.Y', c.y);
      add(r);
    }
  }

  for (const pts of model.wires || []){
    const r = { RECORD: '27', LINEWIDTH: '1', COLOR: String(COLOR.line), LOCATIONCOUNT: String(pts.length) };
    pts.forEach(([x, y], i) => { setCoord(r, 'X' + (i + 1), x); setCoord(r, 'Y' + (i + 1), y); });
    top(r);
  }
  for (const [x, y] of model.junctions || []){
    const r = { RECORD: '29', COLOR: String(COLOR.junction) };
    setCoord(r, 'LOCATION.X', x); setCoord(r, 'LOCATION.Y', y);
    top(r);
  }
  for (const l of model.netLabels || []){
    const r = { RECORD: '25' };
    setCoord(r, 'LOCATION.X', l.x); setCoord(r, 'LOCATION.Y', l.y);
    if (l.orientation) r.ORIENTATION = String(l.orientation);
    Object.assign(r, { COLOR: String(COLOR.netLabel), FONTID: '1', TEXT: String(l.text || '') });
    top(r);
  }
  for (const p of model.powerPorts || []){
    const r = { RECORD: '17', STYLE: String(p.style == null ? POWER_STYLE.bar : p.style), SHOWNETNAME: 'T' };
    setCoord(r, 'LOCATION.X', p.x); setCoord(r, 'LOCATION.Y', p.y);
    if (p.orientation) r.ORIENTATION = String(p.orientation);
    Object.assign(r, { COLOR: '128', FONTID: '1', TEXT: String(p.text || '') });
    top(r);
  }
  for (const [x, y] of model.noErcs || []){
    const r = { RECORD: '22', COLOR: String(COLOR.noErc), ISACTIVE: 'T', SUPPRESSALL: 'T' };
    setCoord(r, 'LOCATION.X', x); setCoord(r, 'LOCATION.Y', y);
    top(r);
  }
  for (const t of model.texts || []){
    const r = { RECORD: '4' };
    setCoord(r, 'LOCATION.X', t.x); setCoord(r, 'LOCATION.Y', t.y);
    if (t.orientation) r.ORIENTATION = String(t.orientation);
    Object.assign(r, { COLOR: String(COLOR.line), FONTID: '1', TEXT: String(t.text || '') });
    top(r);
  }
  return out;
}
function placeText(r, at){
  setCoord(r, 'LOCATION.X', at.x); setCoord(r, 'LOCATION.Y', at.y);
  if (at.orientation) r.ORIENTATION = String(at.orientation); else delete r.ORIENTATION;
  if (at.justification != null){ if (at.justification) r.JUSTIFICATION = String(at.justification); else delete r.JUSTIFICATION; }
}

/* ---- records → the neutral sheet model: the reading half ------------
   The inverse of sheetRecords(): components come back with their symbol
   in LOCAL coordinates (the placement undone), so a sheet read from
   Altium hands the editor the same thing an export started from. */
function sheetModel(records, opts){
  const name = (opts && opts.name) || '';
  const sheet = records.find(r => recType(r) === REC.SHEET) || {};
  const model = {
    name, size:{ w:Number(sheet.CUSTOMX || 1500), h:Number(sheet.CUSTOMY || 950) }, parameters:{},
    components:[], wires:[], junctions:[], netLabels:[], powerPorts:[], noErcs:[], texts:[], warnings:[],
  };
  const kids = new Map();
  records.forEach((r, i) => {
    if (r.OWNERINDEX == null) return;
    const k = Number(r.OWNERINDEX);
    if (!kids.has(k)) kids.set(k, []);
    kids.get(k).push(i);
  });
  const xy = r => [coord(r, 'LOCATION.X'), coord(r, 'LOCATION.Y')];
  // everything a component owns, its descendants included (implementation records nest)
  const subtree = i => (kids.get(i) || []).flatMap(j => [records[j], ...subtree(j)]);
  const unknown = new Set();
  records.forEach((r, i) => {
    const t = recType(r);
    const owned = r.OWNERINDEX != null && Number(r.OWNERINDEX) > 0;
    if (t === REC.PARAMETER && !owned && r.NAME){ if (r.TEXT && r.TEXT !== '*') model.parameters[r.NAME] = r.TEXT; return; }
    if (owned) return;
    if (t === REC.COMPONENT){
      const T = { x:coord(r, 'LOCATION.X'), y:coord(r, 'LOCATION.Y'), orientation:Number(r.ORIENTATION || 0) % 4,
                  mirrored:r.ISMIRRORED === 'T' };
      const local = subtree(i).filter(c => !(recType(c) === REC.PARAMETER && /^PINUNIQUEID$/i.test(c.NAME || '')))
        .map(c => { const l = transformRecord(c, T, true); delete l.OWNERINDEX; delete l.UNIQUEID; return l; });
      const des = local.find(c => recType(c) === REC.DESIGNATOR);
      const com = local.find(c => recType(c) === REC.PARAMETER && String(c.NAME).toUpperCase() === 'COMMENT');
      model.components.push({
        x:T.x, y:T.y, orientation:T.orientation, mirrored:T.mirrored,
        designator: des ? des.TEXT || '' : '', comment: com ? com.TEXT || '' : '',
        sourceLibrary: r.SOURCELIBRARYNAME || '', designItemId: r.DESIGNITEMID || '',
        description: r.COMPONENTDESCRIPTION || '',
        parameters: local.filter(c => recType(c) === REC.PARAMETER && !/^COMMENT$/i.test(c.NAME || ''))
          .map(c => ({ name:c.NAME, value:c.TEXT || '' })),
        symbol: { name:r.LIBREFERENCE || r.DESIGNITEMID || '', description:r.COMPONENTDESCRIPTION || '',
                  designator: des ? String(des.TEXT || '').replace(/[\d?]+$/, '') : '',
                  partCount: Math.max(1, Number(r.PARTCOUNT || 2) - 1), header:{ ...r }, records:local },
      });
    } else if (t === REC.WIRE){
      model.wires.push(pointKeys(r).map(([kx, ky]) => [coord(r, kx), coord(r, ky)]));
    } else if (t === REC.JUNCTION) model.junctions.push(xy(r));
    else if (t === REC.NO_ERC) model.noErcs.push(xy(r));
    else if (t === REC.NET_LABEL) model.netLabels.push({ x:xy(r)[0], y:xy(r)[1], orientation:Number(r.ORIENTATION || 0), text:r.TEXT || '' });
    else if (t === REC.POWER_PORT) model.powerPorts.push({ x:xy(r)[0], y:xy(r)[1], orientation:Number(r.ORIENTATION || 0),
                                                           style:Number(r.STYLE || 0), text:r.TEXT || '' });
    else if (t === REC.LABEL) model.texts.push({ x:xy(r)[0], y:xy(r)[1], orientation:Number(r.ORIENTATION || 0), text:r.TEXT || '' });
    else if (![REC.SHEET, REC.PARAMETER, REC.TEMPLATE].includes(t) && r.HEADER == null) unknown.add(t);
  });
  for (const t of unknown) model.warnings.push('records of type ' + t + ' are not read yet');
  return model;
}

/* ==================================================================
   6. .PrjPcb — an INI file listing the project's documents.
   ================================================================== */
const PRJPCB_DESIGN = [
  '[Design]', 'Version=1.0', 'HierarchyMode=3', 'AutoCrossReferences=1', 'CrossRefSheetStyle=2',
  'CrossRefLocationStyle=1', 'CrossRefPorts=3', 'CrossRefCrossSheets=1', 'CrossRefSheetEntries=1',
  'AllowPortNetNames=1', 'CrossRefFollowFromMainSettings=0', '',
  '[Electrical Rules Check]', 'Type59=1', 'Type11=1',
];
function writePrjPcb(project){
  const lines = PRJPCB_DESIGN.slice();
  (project.documents || []).forEach((d, i) => {
    lines.push('', '[Document' + (i + 1) + ']', 'DocumentPath=' + (typeof d === 'string' ? d : d.path),
               'AnnotationEnabled=1', 'AnnotateStartValue=1', 'DesignatorDisplayMode=0', 'DoLibraryUpdate=1',
               'DoDatabaseUpdate=1', 'ClassGenCCAutoEnabled=1', 'ClassGenCCAutoRoomEnabled=0', 'GenerateClassCluster=0');
  });
  const params = Object.entries(project.parameters || {}).filter(([, v]) => v != null && v !== '');
  if (params.length){
    lines.push('', '[Parameters]', 'ParameterCount=' + params.length);
    params.forEach(([k, v], i) => lines.push('ParameterName' + i + '=' + k, 'ParameterValue' + i + '=' + String(v).replace(/\r?\n/g, ' ')));
  }
  return lines.join('\r\n') + '\r\n';
}
function readPrjPcb(text){
  const sections = new Map();
  let cur = null;
  for (const line of String(text).split(/\r?\n/)){
    const m = /^\s*\[(.+)\]\s*$/.exec(line);
    if (m){ cur = new Map(); sections.set(m[1], cur); continue; }
    const eq = line.indexOf('=');
    if (cur && eq > 0) cur.set(line.slice(0, eq).trim(), line.slice(eq + 1));
  }
  const documents = [];
  for (const [name, s] of sections) if (/^Document\d+$/.test(name) && s.get('DocumentPath'))
    documents.push({ path:s.get('DocumentPath').replace(/\\/g, '/'), index:Number(name.slice(8)) });
  documents.sort((a, b) => a.index - b.index);
  const parameters = {};
  const p = sections.get('Parameters');
  if (p) for (let i = 0; i < Number(p.get('ParameterCount') || 0); i++) parameters[p.get('ParameterName' + i)] = p.get('ParameterValue' + i);
  return { documents, parameters, sections };
}

/* ==================================================================
   The public face.
   ================================================================== */
const Altium = {
  MIL_TO_UNIT, MIL_PER_DXP, ALTIUM_PIN_DIR, REC, ELECTRICAL, ELECTRICAL_CODE, POWER_STYLE, COLOR, HEADERS,
  parseProps, formatProps, decodeRecords, encodeRecords, decodePin, encodePin, decodeAscii,
  coord, setCoord, pointKeys, transformRecord, placePoint, unplacePoint, placeDir, uniqueIdMaker,
  readSchLib, writeSchLib, irFromLibSymbol, sectionKeyFor,
  readSchDoc, writeSchDoc, sheetRecords, sheetModel,
  readPrjPcb, writePrjPcb,

  /* What the UI says about each model. */
  status(kind){
    if (kind === 'spice') return { implemented:true, note:'subcircuits and pins are read' };
    if (kind === 'symbol') return { implemented:true, note:'the Altium symbol is read' };
    return { implemented:false, note:'parser not implemented yet — the symbol falls back to a generated body' };
  },

  /* ---- the Altium schematic symbol ----------------------------------
     `data` is an ArrayBuffer/Uint8Array of the .SchLib. Returns the IR
     described in docs/component-library.md; each IR symbol also carries
     `altium` — the library symbol itself, records and all — which is what
     the Altium export copies onto the sheet untouched. */
  parseSchLib(data, opts){
    const o = opts || {};
    const base = { units:'mil', symbols:[], bytes:byteLength(data), want:o.name || null, warnings:[], implemented:true };
    if (!data || !CFB.isCFB(data))
      return { ...base, ok:false, reason:'not an OLE2 file — a .SchLib is a compound document' };
    try {
      const lib = readSchLib(data);
      const symbols = lib.symbols.map(irFromLibSymbol);
      const usable = symbols.filter(s => s.pins.length);
      return { ...base, ok:usable.length > 0, symbols, warnings:lib.warnings,
               reason: usable.length ? '' : (symbols.length ? 'the .SchLib symbols have no pins' : 'the .SchLib holds no component') };
    } catch (e){
      return { ...base, ok:false, reason:'could not read the .SchLib: ' + e.message };
    }
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
     Mils become world units, the y axis is flipped (Altium counts up,
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
    const FX = mx => round2(mx * S2), FY = my => round2(-my * S2);   // the drawing itself is not snapped

    const pins = sym.pins.filter(p => !p.hidden).map(p => {
      const dir = ALTIUM_PIN_DIR[((Number(p.orientation) || 0) % 360 + 360) % 360] || 'l';
      return { name:String(p.name || p.designator || '?'), designator:String(p.designator || ''),
               x:X(p.x), y:Y(p.y), dir, electrical:p.electrical || 'passive' };
    });
    if (!pins.length) return null;

    // The body: the biggest rectangle the symbol draws, or the pin extent.
    const rects = (sym.primitives || []).filter(r => r.type === 'rect');
    let body = null, bodyRect = null;
    for (const r of rects){
      const b = { x:Math.min(X(r.x1), X(r.x2)), y:Math.min(Y(r.y1), Y(r.y2)),
                  w:Math.abs(X(r.x2) - X(r.x1)), h:Math.abs(Y(r.y2) - Y(r.y1)) };
      if (!body || b.w * b.h > body.w * body.h){ body = b; bodyRect = r; }
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
      if (pr === bodyRect) continue;                                   // already the body
      if (pr.type === 'rect'){
        bodies.push(`M${FX(pr.x1)} ${FY(pr.y1)}H${FX(pr.x2)}V${FY(pr.y2)}H${FX(pr.x1)}Z`);
      } else if (pr.type === 'line'){
        paths.push(`M${FX(pr.x1)} ${FY(pr.y1)}L${FX(pr.x2)} ${FY(pr.y2)}`);
      } else if (pr.type === 'polyline' || pr.type === 'polygon'){
        const pts = (pr.points || []).map(([px, py]) => `${FX(px)} ${FY(py)}`);
        if (pts.length < 2) continue;
        const d = 'M' + pts.join('L') + (pr.type === 'polygon' ? 'Z' : '');
        (pr.type === 'polygon' ? (pr.filled ? fills : bodies) : paths).push(d);
      } else if (pr.type === 'arc'){
        paths.push(arcPath(FX(pr.cx), FY(pr.cy), Math.abs(pr.r * S2), pr.start, pr.end));
      } else if (pr.type === 'ellipse'){
        const rx = Math.abs(pr.rx * S2), ry = Math.abs(pr.ry * S2);
        (pr.filled ? fills : paths).push(`M${round2(FX(pr.cx) - rx)} ${FY(pr.cy)}a${round2(rx)} ${round2(ry)} 0 1 0 ${round2(2 * rx)} 0a${round2(rx)} ${round2(ry)} 0 1 0 ${round2(-2 * rx)} 0`);
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
  const s = Number(startDeg) || 0, e = endDeg == null ? 360 : Number(endDeg);
  const sweep = ((e - s) % 360 + 360) % 360;
  if (sweep === 0)                                    // a full circle: two half arcs
    return `M${round2(cx - r)} ${round2(cy)}a${round2(r)} ${round2(r)} 0 1 0 ${round2(2 * r)} 0a${round2(r)} ${round2(r)} 0 1 0 ${round2(-2 * r)} 0`;
  const a0 = s * Math.PI / 180, a1 = e * Math.PI / 180;
  const x0 = cx + r * Math.cos(a0), y0 = cy - r * Math.sin(a0);
  const x1 = cx + r * Math.cos(a1), y1 = cy - r * Math.sin(a1);
  return `M${round2(x0)} ${round2(y0)}A${round2(r)} ${round2(r)} 0 ${sweep > 180 ? 1 : 0} 0 ${round2(x1)} ${round2(y1)}`;
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
