/* ==================================================================
   symbols.js — the schematic symbol library.

   Every symbol lives in its own local space with the electrical
   centre at (0,0) and EVERY pin on the 10-unit lattice, so a part
   dropped on the grid always has its pins on grid too — wires then
   land on pins without any nudging.

   A def is pure data:
     { id, label, cat, prefix, pins:[{name,x,y,dir}], paths:[d…],
       fills:[d…], extra:'<svg>', box:{x,y,w,h}, leads:bool }
   `leads:true` means the renderer draws the pin leads itself (used by
   the generated IC/connector symbols, whose pin count is only known
   once a netlist is imported).
   ================================================================== */
'use strict';

const GRID = 10;                 // world units per fine grid cell
const PIN_LEAD = 20;             // length of a pin lead on generated symbols

const SYM_CATS = [
  { id:'passive',  label:'Passives' },
  { id:'discrete', label:'Discretes' },
  { id:'active',   label:'Integrated' },
  { id:'electro',  label:'Electromechanical' },
  { id:'port',     label:'Ports & power' },
];

/* ---- helpers used by the fixed defs ---- */
const box = (x, y, w, h) => ({ x, y, w, h });
const P = (name, x, y, dir) => ({ name, x, y, dir });

const SYMBOLS = {
  /* ------------------------------ passives ------------------------------ */
  res: {
    label:'Resistor', cat:'passive', prefix:'R', value:'10k',
    pins:[P('1',-20,0,'l'), P('2',20,0,'r')],
    paths:['M-20 0H-12','M12 0H20','M-12 -6H12V6H-12Z'], box:box(-20,-10,40,20),
  },
  shunt: {
    label:'Shunt', cat:'passive', prefix:'R', value:'10m',
    pins:[P('1',-20,0,'l'), P('2',20,0,'r')],
    paths:['M-20 0H-12','M12 0H20','M-12 -6H12V6H-12Z','M-6 -6V6','M6 -6V6'], box:box(-20,-10,40,20),
  },
  pot: {
    label:'Potentiometer', cat:'passive', prefix:'RV', value:'10k',
    pins:[P('1',-20,0,'l'), P('2',20,0,'r'), P('3',0,-20,'t')],
    paths:['M-20 0H-12','M12 0H20','M-12 -6H12V6H-12Z','M0 -20V-11'],
    fills:['M-3 -11L3 -11L0 -6Z'], box:box(-20,-20,40,30),
  },
  cap: {
    label:'Capacitor', cat:'passive', prefix:'C', value:'100n',
    pins:[P('1',-20,0,'l'), P('2',20,0,'r')],
    paths:['M-20 0H-3','M3 0H20','M-3 -9V9','M3 -9V9'], box:box(-20,-10,40,20),
  },
  cap_pol: {
    label:'Cap. polarized', cat:'passive', prefix:'C', value:'10u',
    pins:[P('1',-20,0,'l'), P('2',20,0,'r')],
    paths:['M-20 0H-4','M6 0H20','M-4 -9V9','M6 -9A11 11 0 0 0 6 9','M-13 -6V-2','M-15 -4H-11'],
    box:box(-20,-10,40,20),
  },
  ind: {
    label:'Inductor', cat:'passive', prefix:'L', value:'10u',
    pins:[P('1',-20,0,'l'), P('2',20,0,'r')],
    paths:['M-20 0H-15','M15 0H20','M-15 0a3.75 3.75 0 0 1 7.5 0a3.75 3.75 0 0 1 7.5 0a3.75 3.75 0 0 1 7.5 0a3.75 3.75 0 0 1 7.5 0'],
    box:box(-20,-8,40,16),
  },
  ferrite: {
    label:'Ferrite bead', cat:'passive', prefix:'FB', value:'600R',
    pins:[P('1',-20,0,'l'), P('2',20,0,'r')],
    paths:['M-20 0H-10','M10 0H20','M-10 -6H10V6H-10Z','M-4 -6V6','M4 -6V6'], box:box(-20,-8,40,16),
  },
  xfmr: {
    label:'Transformer', cat:'passive', prefix:'T', value:'1:1',
    pins:[P('1',-30,-20,'l'), P('2',-30,20,'l'), P('3',30,-20,'r'), P('4',30,20,'r')],
    paths:[
      'M-30 -20H-14','M-30 20H-14',
      'M-14 -20a3.5 3.5 0 0 0 0 7a3.5 3.5 0 0 0 0 7a3.5 3.5 0 0 0 0 7a3.5 3.5 0 0 0 0 6',
      'M30 -20H14','M30 20H14',
      'M14 -20a3.5 3.5 0 0 1 0 7a3.5 3.5 0 0 1 0 7a3.5 3.5 0 0 1 0 7a3.5 3.5 0 0 1 0 6',
      'M-4 -22V22','M4 -22V22',
    ], box:box(-30,-24,60,48),
  },
  xtal: {
    label:'Crystal', cat:'passive', prefix:'Y', value:'32.768k',
    pins:[P('1',-20,0,'l'), P('2',20,0,'r')],
    paths:['M-20 0H-7','M7 0H20','M-7 -9V9','M7 -9V9','M-3 -11H3V11H-3Z'], box:box(-20,-12,40,24),
  },
  ntc: {
    label:'NTC / thermistor', cat:'passive', prefix:'RT', value:'10k',
    pins:[P('1',-20,0,'l'), P('2',20,0,'r')],
    paths:['M-20 0H-12','M12 0H20','M-12 -6H12V6H-12Z','M-12 10L10 -12','M-12 10H-6','M-12 10V4'],
    box:box(-20,-13,40,26),
  },
  fuse: {
    label:'Fuse', cat:'passive', prefix:'F', value:'2A',
    pins:[P('1',-20,0,'l'), P('2',20,0,'r')],
    paths:['M-20 0H-12','M12 0H20','M-12 -6H12V6H-12Z','M-12 0H12'], box:box(-20,-8,40,16),
  },

  /* ----------------------------- discretes ------------------------------ */
  diode: {
    label:'Diode', cat:'discrete', prefix:'D', value:'1N4148',
    pins:[P('A',-20,0,'l'), P('K',20,0,'r')],
    paths:['M-20 0H-8','M8 0H20','M8 -8V8'], fills:['M-8 -8L8 0L-8 8Z'], box:box(-20,-10,40,20),
  },
  zener: {
    label:'Zener', cat:'discrete', prefix:'D', value:'BZX-5V1',
    pins:[P('A',-20,0,'l'), P('K',20,0,'r')],
    paths:['M-20 0H-8','M8 0H20','M8 -8V8','M8 -8H3','M8 8H13'], fills:['M-8 -8L8 0L-8 8Z'], box:box(-20,-10,40,20),
  },
  schottky: {
    label:'Schottky', cat:'discrete', prefix:'D', value:'BAT54',
    pins:[P('A',-20,0,'l'), P('K',20,0,'r')],
    paths:['M-20 0H-8','M8 0H20','M8 -8V8','M8 -8H3V-4','M8 8H13V4'], fills:['M-8 -8L8 0L-8 8Z'], box:box(-20,-10,40,20),
  },
  tvs: {
    label:'TVS', cat:'discrete', prefix:'D', value:'SMAJ',
    pins:[P('1',-20,0,'l'), P('2',20,0,'r')],
    paths:['M-20 0H-10','M10 0H20','M0 -9V9'], fills:['M-10 -8L0 0L-10 8Z','M10 -8L0 0L10 8Z'], box:box(-20,-10,40,20),
  },
  led: {
    label:'LED', cat:'discrete', prefix:'LED', value:'red',
    pins:[P('A',-20,0,'l'), P('K',20,0,'r')],
    paths:['M-20 0H-8','M8 0H20','M8 -8V8','M2 -11L10 -19','M8 -11L16 -19','M13 -19H16V-16','M7 -19H10V-16'],
    fills:['M-8 -8L8 0L-8 8Z'], box:box(-20,-20,40,30),
  },
  npn: {
    label:'NPN', cat:'discrete', prefix:'Q', value:'MMBT3904',
    pins:[P('B',-20,0,'l'), P('C',0,-30,'t'), P('E',0,30,'b')],
    paths:['M-20 0H-8','M-8 -11V11','M-8 -6L0 -14','M0 -14V-30','M-8 6L0 14','M0 14V30'],
    fills:['M-5.5 7.5L1 12.5L-2 5Z'], box:box(-20,-30,30,60),
  },
  pnp: {
    label:'PNP', cat:'discrete', prefix:'Q', value:'MMBT3906',
    pins:[P('B',-20,0,'l'), P('C',0,-30,'t'), P('E',0,30,'b')],
    paths:['M-20 0H-8','M-8 -11V11','M-8 -6L0 -14','M0 -14V-30','M-8 6L0 14','M0 14V30'],
    fills:['M-8.5 4L-2 9L-8 11Z'], box:box(-20,-30,30,60),
  },
  nmos: {
    label:'N-MOSFET', cat:'discrete', prefix:'Q', value:'NMOS',
    pins:[P('G',-20,0,'l'), P('D',0,-30,'t'), P('S',0,30,'b')],
    paths:['M-20 0H-13','M-13 -12V12','M-7 -12V-5','M-7 -2.5V2.5','M-7 5V12',
           'M-7 -9H0V-30','M-7 9H0V30','M-7 0H0'],
    fills:['M-5 -3L-5 3L0 0Z'], box:box(-20,-30,30,60),
  },
  pmos: {
    label:'P-MOSFET', cat:'discrete', prefix:'Q', value:'PMOS',
    pins:[P('G',-20,0,'l'), P('D',0,-30,'t'), P('S',0,30,'b')],
    paths:['M-20 0H-13','M-13 -12V12','M-7 -12V-5','M-7 -2.5V2.5','M-7 5V12',
           'M-7 -9H0V-30','M-7 9H0V30','M-7 0H0'],
    fills:['M-2 -3L-2 3L-7 0Z'], box:box(-20,-30,30,60),
  },
  igbt: {
    label:'IGBT', cat:'discrete', prefix:'Q', value:'IGBT',
    pins:[P('G',-20,0,'l'), P('C',0,-30,'t'), P('E',0,30,'b')],
    paths:['M-20 0H-13','M-13 -12V12','M-7 -12V12','M-7 -9H0V-30','M-7 9H0V30'],
    fills:['M-3 6L3 9L-3 12Z'], box:box(-20,-30,30,60),
  },
  opto: {
    label:'Optocoupler', cat:'discrete', prefix:'U', value:'OPTO',
    pins:[P('1',-30,-10,'l'), P('2',-30,10,'l'), P('3',30,10,'r'), P('4',30,-10,'r')],
    paths:['M-20 -20H20V20H-20Z','M-30 -10H-20','M-30 10H-20','M30 -10H20','M30 10H20',
           'M-14 -14V14','M-14 -3L-8 -8','M-14 3L-8 8','M-9 -9H-6V-6','M-9 9H-6V6',
           'M8 -12V12','M14 -12L8 0L14 12'],
    fills:['M-14 -6L-14 6L-8 0Z'], box:box(-30,-20,60,40),
  },

  /* ----------------------------- integrated ----------------------------- */
  opamp: {
    label:'Op-amp', cat:'active', prefix:'U', value:'TLV9062',
    pins:[P('+',-30,-10,'l'), P('-',-30,10,'l'), P('OUT',30,0,'r'), P('V+',0,-20,'t'), P('V-',0,20,'b')],
    paths:['M-20 -20L20 0L-20 20Z','M-30 -10H-20','M-30 10H-20','M20 0H30','M0 -12V-20','M0 12V20',
           'M-17 -13H-11','M-14 -16V-10','M-17 13H-11'], box:box(-30,-20,60,40),
  },
  comparator: {
    label:'Comparator', cat:'active', prefix:'U', value:'TLV7011',
    pins:[P('+',-30,-10,'l'), P('-',-30,10,'l'), P('OUT',30,0,'r'), P('V+',0,-20,'t'), P('V-',0,20,'b')],
    paths:['M-20 -20L20 0L-20 20Z','M-30 -10H-20','M-30 10H-20','M20 0H30','M0 -12V-20','M0 12V20',
           'M-17 -13H-11','M-14 -16V-10','M-17 13H-11','M-4 -6L2 -6L-4 6L2 6'], box:box(-30,-20,60,40),
  },
  ic: { label:'IC (generic)', cat:'active', prefix:'U', value:'', generated:'ic', pinCount:8 },

  /* ------------------------- electromechanical -------------------------- */
  connector: { label:'Connector', cat:'electro', prefix:'J', value:'', generated:'conn', pinCount:4 },
  switch_spst: {
    label:'Switch SPST', cat:'electro', prefix:'SW', value:'',
    pins:[P('1',-20,0,'l'), P('2',20,0,'r')],
    paths:['M-20 0H-10','M10 0H20','M-10 0L8 -10'], extra:'<circle class="sym" cx="-10" cy="0" r="1.8"/><circle class="sym" cx="10" cy="0" r="1.8"/>',
    box:box(-20,-12,40,24),
  },
  switch_spdt: {
    label:'Switch SPDT', cat:'electro', prefix:'SW', value:'',
    pins:[P('COM',-20,0,'l'), P('NO',20,-10,'r'), P('NC',20,10,'r')],
    paths:['M-20 0H-10','M10 -10H20','M10 10H20','M-10 0L8 -10'],
    extra:'<circle class="sym" cx="-10" cy="0" r="1.8"/><circle class="sym" cx="10" cy="-10" r="1.8"/><circle class="sym" cx="10" cy="10" r="1.8"/>',
    box:box(-20,-14,40,28),
  },
  relay: {
    label:'Relay', cat:'electro', prefix:'K', value:'',
    pins:[P('A1',-40,-10,'l'), P('A2',-40,10,'l'), P('COM',40,0,'r'), P('NO',40,-20,'r'), P('NC',40,20,'r')],
    paths:['M-40 -10H-26','M-40 10H-26','M-26 -14H-14V14H-26Z','M-14 0H6','M40 0H14','M40 -20H14','M40 20H14',
           'M14 0L26 -16'], extra:'<circle class="sym" cx="14" cy="0" r="1.8"/><circle class="sym" cx="14" cy="-20" r="1.8"/><circle class="sym" cx="14" cy="20" r="1.8"/>',
    box:box(-40,-24,80,48),
  },
  battery: {
    label:'Battery', cat:'electro', prefix:'BT', value:'3.7V',
    pins:[P('+',-20,0,'l'), P('-',20,0,'r')],
    paths:['M-20 0H-8','M8 0H20','M-8 -10V10','M-2 -5V5','M2 -10V10','M8 -5V5'], box:box(-20,-12,40,24),
  },
  motor: {
    label:'Motor', cat:'electro', prefix:'M', value:'',
    pins:[P('1',-30,0,'l'), P('2',30,0,'r')],
    paths:['M-30 0H-16','M16 0H30','M-16 -16H16V16H-16Z','M-6 8V-8L6 8V-8'], box:box(-30,-16,60,32),
  },
  testpoint: {
    label:'Test point', cat:'electro', prefix:'TP', value:'',
    pins:[P('1',0,10,'b')], paths:['M0 10V0'], extra:'<circle class="sym" cx="0" cy="-3" r="3.2"/>',
    box:box(-8,-8,16,20),
  },

  /* --------------------------- ports & power ---------------------------- */
  gnd: {
    label:'GND', cat:'port', prefix:'', port:'gnd', net:'GND',
    pins:[P('1',0,-10,'t')], paths:['M0 -10V2','M-9 2H9','M-5.5 6H5.5','M-2.5 10H2.5'], box:box(-10,-10,20,22),
  },
  gnd_hv: {
    label:'GND (isolated)', cat:'port', prefix:'', port:'gnd', net:'GND_HV',
    pins:[P('1',0,-10,'t')], paths:['M0 -10V2','M-9 2H9','M-9 2L-13 8','M-3 2L-7 8','M3 2L-1 8','M9 2L5 8'], box:box(-14,-10,28,20),
  },
  earth: {
    label:'Earth / chassis', cat:'port', prefix:'', port:'gnd', net:'EARTH',
    pins:[P('1',0,-10,'t')], paths:['M0 -10V0','M-9 0V8','M0 0V8','M9 0V8','M-9 0H9'], box:box(-10,-10,20,20),
  },
  vcc: {
    label:'Power rail', cat:'port', prefix:'', port:'power', net:'VCC',
    pins:[P('1',0,10,'b')], paths:['M0 10V-2','M-8 -2H8'], box:box(-10,-8,20,20),
  },
  netlabel: {
    label:'Net label', cat:'port', prefix:'', port:'label', net:'NET',
    pins:[P('1',0,0,'r')], paths:[], box:box(0,-8,60,16),
  },
  noconnect: {
    label:'No connect', cat:'port', prefix:'', port:'nc',
    pins:[P('1',0,0,'r')], paths:['M-5 -5L5 5','M-5 5L5 -5'], box:box(-6,-6,12,12),
  },
  note: {
    label:'Text note', cat:'port', prefix:'', port:'note',
    pins:[], paths:[], box:box(0,-10,120,20),
  },
};

/* ------------------------------------------------------------------
   Generated symbols: an IC (or a connector) only knows its pins once
   a netlist names them, so the body grows with the pin list.
   ------------------------------------------------------------------ */
function makeIcDef(pinNames, label){
  const names = (pinNames && pinNames.length ? pinNames : ['1','2','3','4','5','6','7','8']).map(String);
  const n = names.length;
  const nl = Math.ceil(n/2), nr = n - nl;
  const rows = Math.max(nl, nr);
  const h = Math.max(40, (rows - 1) * GRID + 2 * GRID);
  const longest = names.reduce((m, s) => Math.max(m, s.length), 1);
  const w = Math.max(60, Math.ceil((longest * 9 + 30) / GRID) * GRID);
  const top = -Math.round(h / 2 / GRID) * GRID;
  const pins = [];
  names.slice(0, nl).forEach((nm, i) => pins.push(P(nm, -w/2 - PIN_LEAD, top + GRID + i * GRID, 'l')));
  names.slice(nl).forEach((nm, i) => pins.push(P(nm,  w/2 + PIN_LEAD, top + GRID + i * GRID, 'r')));
  return {
    label: label || 'IC', cat:'active', prefix:'U', generated:'ic', leads:true, names:true,
    pins, body: box(-w/2, top, w, h), box: box(-w/2 - PIN_LEAD, top - GRID, w + 2*PIN_LEAD, h + 2*GRID),
    paths: [], w, h,
  };
}

function makeConnDef(count, label){
  const n = Math.max(1, count|0 || 2);
  const h = Math.max(30, (n - 1) * GRID + 2 * GRID);
  const w = 40, top = -Math.round(h / 2 / GRID) * GRID;
  const pins = [];
  for (let i = 0; i < n; i++) pins.push(P(String(i + 1), w/2 + PIN_LEAD, top + GRID + i * GRID, 'r'));
  return {
    label: label || 'Connector', cat:'electro', prefix:'J', generated:'conn', leads:true, names:true,
    pins, body: box(-w/2, top, w, h), box: box(-w/2, top - GRID, w + PIN_LEAD, h + 2*GRID),
    paths: [], w, h,
  };
}

/* The def a part actually uses: generated symbols carry their pin list on the
   part itself (part.pinNames), fixed ones come straight from the library. */
function defOf(part){
  if (!part) return null;
  const base = SYMBOLS[part.kind];
  if (base && base.generated === 'ic')   return makeIcDef(part.pinNames, part.partNumber || base.label);
  if (base && base.generated === 'conn') return makeConnDef(part.pinNames ? part.pinNames.length : part.pinCount, part.partNumber || 'Connector');
  return base || SYMBOLS.res;
}

/* ---- geometry: local → world, honouring rotation and mirroring ---- */
function rotPoint(x, y, rot, mir){
  if (mir) x = -x;
  switch (((rot % 360) + 360) % 360){
    case 90:  return { x: -y, y: x };
    case 180: return { x: -x, y: -y };
    case 270: return { x: y, y: -x };
    default:  return { x, y };
  }
}
function pinWorld(part, pin){
  const p = rotPoint(pin.x, pin.y, part.rot || 0, part.mir);
  return { x: part.x + p.x, y: part.y + p.y };
}
function partPins(part){
  const def = defOf(part);
  return (def.pins || []).map(pin => ({ ...pin, ...pinWorld(part, pin) , local:pin }));
}
/* Axis-aligned world bounds of a placed part (used by fit-to-view and picking). */
function partBounds(part){
  const def = defOf(part);
  const b = def.box || box(-20, -20, 40, 40);
  const cs = [[b.x,b.y],[b.x+b.w,b.y],[b.x,b.y+b.h],[b.x+b.w,b.y+b.h]]
    .map(([x,y]) => rotPoint(x, y, part.rot || 0, part.mir));
  const xs = cs.map(c => c.x + part.x), ys = cs.map(c => c.y + part.y);
  return { x:Math.min(...xs), y:Math.min(...ys), w:Math.max(...xs)-Math.min(...xs), h:Math.max(...ys)-Math.min(...ys) };
}

/* ---- drawing ---- */
const esc = s => String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

/* The symbol body, in LOCAL coordinates — the caller wraps it in the part's
   translate/rotate so the drawing rotates while ref/value text stays level. */
function symbolBodySVG(def, opts){
  const o = opts || {};
  let s = '';
  if (def.body){                                   // generated: box + leads + pin names
    const b = def.body;
    s += `<rect class="icbody" x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="2"/>`;
    for (const p of def.pins){
      const ex = p.dir === 'l' ? b.x : p.dir === 'r' ? b.x + b.w : p.x;
      const ey = p.dir === 't' ? b.y : p.dir === 'b' ? b.y + b.h : p.y;
      s += `<line class="pinline" x1="${p.x}" y1="${p.y}" x2="${ex}" y2="${ey}"/>`;
      if (def.names){
        const tx = p.dir === 'l' ? b.x + 4 : b.x + b.w - 4;
        s += `<text class="pinname" x="${tx}" y="${p.y + 2.6}" text-anchor="${p.dir === 'l' ? 'start' : 'end'}">${esc(p.name)}</text>`;
      }
    }
    if (o.label) s += `<text class="pinname" x="0" y="${b.y - 3}" text-anchor="middle">${esc(o.label)}</text>`;
  }
  for (const d of def.paths || []) s += `<path class="sym" d="${d}"/>`;
  for (const d of def.fills || []) s += `<path class="symfill" d="${d}"/>`;
  if (def.extra) s += def.extra;
  return s;
}

/* A small standalone preview, used by the Components panel. */
function symbolPreviewSVG(kind){
  const def = SYMBOLS[kind].generated ? (SYMBOLS[kind].generated === 'ic' ? makeIcDef(['1','2','3','4','5','6']) : makeConnDef(3)) : SYMBOLS[kind];
  const b = def.box || box(-20,-20,40,40);
  const pad = 6;
  let inner = symbolBodySVG(def, {});
  if (kind === 'netlabel') inner = '<path class="sym" d="M0 0H8M8 -7H46L52 0L46 7H8Z"/>';
  if (kind === 'note')     inner = '<path class="sym" d="M2 -8H50M2 0H40M2 8H46"/>';
  return `<svg viewBox="${b.x-pad} ${b.y-pad} ${b.w+2*pad} ${b.h+2*pad}" preserveAspectRatio="xMidYMid meet">${inner}</svg>`;
}

/* ------------------------------------------------------------------
   Netlist component → symbol kind. The imported netlists name most
   passives generically ("resistor", "capacitor"), so the reference
   prefix and the type-specific fields decide the symbol.
   ------------------------------------------------------------------ */
function kindForComponent(c){
  const pn = String(c.partNumber || '').toLowerCase();
  const ref = String(c.ref || '').toUpperCase();
  const pre = (ref.match(/^[A-Z]+/) || [''])[0];
  const txt = [pn, c.role, c.type, c.diode_type, c.polarity].filter(Boolean).join(' ').toLowerCase();

  if (pn.includes('shunt')) return 'shunt';
  if (pre === 'R'  || pn === 'resistor')  return /ntc|thermistor/.test(txt) ? 'ntc' : 'res';
  if (pre === 'RT' || pn === 'ntc' || /thermistor/.test(txt)) return 'ntc';
  if (pre === 'C'  || pn === 'capacitor') return /electrolyt|tantal|polymer|polarized/.test(txt) ? 'cap_pol' : 'cap';
  if (pre === 'L'  || pn === 'inductor')  return 'ind';
  if (pre === 'FB' || /ferrite/.test(txt)) return 'ferrite';
  if (pre === 'T'  || pn === 'transformer') return 'xfmr';
  if (pre === 'Y'  || /crystal|oscillator/.test(txt)) return 'xtal';
  if (pre === 'F'  || pn === 'fuse') return 'fuse';
  if (pre === 'LED' || pn === 'led') return 'led';
  if (pre === 'D'  || pn === 'diode'){
    if (/zener/.test(txt)) return 'zener';
    if (/schottky/.test(txt)) return 'schottky';
    if (/tvs|transient/.test(txt)) return 'tvs';
    if (/led/.test(txt)) return 'led';
    return 'diode';
  }
  if (pre === 'Q' || /mosfet|transistor|igbt/.test(txt)){
    if (/igbt/.test(txt)) return 'igbt';
    if (/p-?channel|pmos|\bp\b/.test(String(c.polarity || '').toLowerCase())) return 'pmos';
    if (/pnp/.test(txt)) return 'pnp';
    if (/npn/.test(txt)) return 'npn';
    return 'nmos';
  }
  if (pre === 'J' || pn === 'connector') return 'connector';
  if (pre === 'SW' || pn === 'switch') return /spdt|changeover|form c/.test(txt) ? 'switch_spdt' : 'switch_spst';
  if (pre === 'K' || pn === 'relay') return 'relay';
  if (pre === 'BT' || /battery|cell pack/.test(txt)) return 'battery';
  if (pre === 'TP') return 'testpoint';
  if (/opto|photocoupler/.test(txt)) return 'opto';
  return 'ic';
}

/* The value a placed part shows under its reference. */
function valueForComponent(c){
  return c.resistance || c.capacitance || c.inductance || c.turns_ratio ||
         c.coil_voltage || c.current_rating || c.value ||
         (String(c.partNumber || '').toLowerCase() === c.partNumber ? '' : c.partNumber) || '';
}

if (typeof module !== 'undefined') module.exports = {
  GRID, SYMBOLS, SYM_CATS, makeIcDef, makeConnDef, defOf, pinWorld, partPins, partBounds,
  symbolBodySVG, symbolPreviewSVG, kindForComponent, valueForComponent, rotPoint,
};
