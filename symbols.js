/* ==================================================================
   symbols.js — the schematic symbol library.

   Every symbol lives in its own local space with the electrical
   centre at (0,0) and EVERY pin on the 10-unit lattice, so a part
   dropped on the grid always has its pins on grid too — wires then
   land on pins without any nudging.

   A def is pure data:
     { id, label, cat, prefix, pins:[{name,x,y,dir}],
       bodies:[d…]   closed outlines, drawn FILLED (the pale body fill)
       paths:[d…]    open strokes: leads, plates, windings
       fills:[d…]    solid shapes in the line colour (diode triangles, arrows)
       extra:'<svg>', box:{x,y,w,h}, leads:bool, names:bool }
   `leads:true` means the renderer draws the pin leads itself (used by
   the generated IC/connector symbols, whose pin count is only known
   once a netlist is imported); `names:true` writes the pin names
   inside the body.

   The drawing convention is the one schematic CAD tools share
   (Altium's default look): dark-blue outlines at ONE line weight —
   no symbol mixes thicknesses — filled bodies, filled arrows, pin names
   inside the body, designator above and value below. The colours and
   that single weight live in styles.css.
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
const circlePath = (cx, cy, r) => `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`;
/* n half-circle bumps of radius r along the x axis from x0, above (side=1) or below the axis */
const winding = (x0, y, n, r, side) => `M${x0} ${y}` + Array.from({ length:n }, () => `a${r} ${r} 0 0 ${side ? 1 : 0} ${2 * r} 0`).join('');
/* the same, vertical, from y0 downwards; side=1 bulges to the left */
const windingV = (x, y0, n, r, side) => `M${x} ${y0}` + Array.from({ length:n }, () => `a${r} ${r} 0 0 ${side ? 0 : 1} 0 ${2 * r}`).join('');

const SYMBOLS = {
  /* ------------------------------ passives ------------------------------ */
  res: {
    label:'Resistor', cat:'passive', prefix:'R', value:'10k',
    pins:[P('1',-20,0,'l'), P('2',20,0,'r')],
    paths:['M-20 0H-12','M12 0H20'], bodies:['M-12 -5H12V5H-12Z'], box:box(-20,-10,40,20),
  },
  shunt: {
    label:'Shunt resistor', cat:'passive', prefix:'R', value:'10m',
    pins:[P('1',-20,0,'l'), P('2',20,0,'r')],
    paths:['M-20 0H-12','M12 0H20','M-6 -5V5','M6 -5V5'], bodies:['M-12 -5H12V5H-12Z'], box:box(-20,-10,40,20),
  },
  pot: {
    label:'Potentiometer', cat:'passive', prefix:'RV', value:'10k',
    pins:[P('1',-20,0,'l'), P('2',20,0,'r'), P('3',0,-20,'t')],
    paths:['M-20 0H-12','M12 0H20','M0 -20V-10'], bodies:['M-12 -5H12V5H-12Z'],
    fills:['M-3 -11L3 -11L0 -5Z'], box:box(-20,-20,40,30),
  },
  cap: {
    label:'Capacitor', cat:'passive', prefix:'C', value:'100n',
    pins:[P('1',-20,0,'l'), P('2',20,0,'r')],
    paths:['M-20 0H-3','M3 0H20','M-3 -8V8','M3 -8V8'], box:box(-20,-10,40,20),
  },
  cap_pol: {
    label:'Cap. polarized', cat:'passive', prefix:'C', value:'10u',
    pins:[P('1',-20,0,'l'), P('2',20,0,'r')],
    paths:['M-20 0H-3','M5 0H20','M-13 -7V-3','M-15 -5H-11','M-3 -8V8','M6 -8A12 12 0 0 0 6 8'],
    box:box(-20,-10,40,20),
  },
  ind: {
    label:'Inductor', cat:'passive', prefix:'L', value:'10u',
    pins:[P('1',-20,0,'l'), P('2',20,0,'r')],
    paths:['M-20 0H-15','M15 0H20', winding(-15, 0, 4, 3.75, 1)],
    box:box(-20,-8,40,16),
  },
  choke: {
    label:'Choke', cat:'passive', prefix:'L', value:'100u',
    pins:[P('1',-20,0,'l'), P('2',20,0,'r')],
    paths:['M-20 0H-15','M15 0H20', winding(-15, 0, 4, 3.75, 1), 'M-15 -7H15','M-15 -10H15'],
    box:box(-20,-12,40,20),
  },
  cm_choke: {
    label:'Common-mode choke', cat:'passive', prefix:'L', value:'1m',
    pins:[P('1',-30,-10,'l'), P('2',30,-10,'r'), P('3',-30,10,'l'), P('4',30,10,'r')],
    paths:['M-30 -10H-15','M15 -10H30','M-30 10H-15','M15 10H30',
           winding(-15, -10, 4, 3.75, 1), winding(-15, 10, 4, 3.75, 0), 'M-15 -3H15','M-15 3H15'],
    box:box(-30,-20,60,40),
  },
  ferrite: {
    label:'Ferrite bead', cat:'passive', prefix:'FB', value:'600R',
    pins:[P('1',-20,0,'l'), P('2',20,0,'r')],
    paths:['M-20 0H-10','M10 0H20','M-10 5L10 -5'], bodies:['M-10 -5H10V5H-10Z'], box:box(-20,-8,40,16),
  },
  xfmr: {
    label:'Transformer', cat:'passive', prefix:'T', value:'1:1',
    pins:[P('1',-30,-20,'l'), P('2',-30,20,'l'), P('3',30,-20,'r'), P('4',30,20,'r')],
    paths:['M-30 -20H-14','M-30 20H-14', windingV(-14, -20, 4, 5, 1),
           'M30 -20H14','M30 20H14', windingV(14, -20, 4, 5, 0),
           'M-3 -22V22','M3 -22V22'],
    box:box(-30,-24,60,48),
  },
  xtal: {
    label:'Crystal', cat:'passive', prefix:'Y', value:'32.768k',
    pins:[P('1',-20,0,'l'), P('2',20,0,'r')],
    paths:['M-20 0H-7','M7 0H20','M-7 -8V8','M7 -8V8'], bodies:['M-3 -11H3V11H-3Z'], box:box(-20,-12,40,24),
  },
  osc: {
    label:'Oscillator', cat:'passive', prefix:'Y', value:'25MHz',
    pins:[P('EN',-40,-10,'l'), P('GND',-40,10,'l'), P('OUT',40,10,'r'), P('VDD',40,-10,'r')],
    body:box(-30,-20,60,40), leads:true, names:true,
    paths:['M-8 3H-5V-3H-1V3H3V-3H7V3H10'], box:box(-40,-24,80,48),
  },
  ntc: {
    label:'NTC / thermistor', cat:'passive', prefix:'RT', value:'10k',
    pins:[P('1',-20,0,'l'), P('2',20,0,'r')],
    paths:['M-20 0H-12','M12 0H20','M-14 10L-9 10L8 -10L13 -10'], bodies:['M-12 -5H12V5H-12Z'],
    box:box(-20,-13,40,26),
  },
  fuse: {
    label:'Fuse', cat:'passive', prefix:'F', value:'2A',
    pins:[P('1',-20,0,'l'), P('2',20,0,'r')],
    paths:['M-20 0H-12','M12 0H20','M-12 0H12'], bodies:['M-12 -5H12V5H-12Z'], box:box(-20,-8,40,16),
  },

  /* ----------------------------- discretes ------------------------------ */
  diode: {
    label:'Diode', cat:'discrete', prefix:'D', value:'1N4148',
    pins:[P('A',-20,0,'l'), P('K',20,0,'r')],
    paths:['M-20 0H-8','M8 0H20','M8 -8V8'], fills:['M-8 -8L8 0L-8 8Z'], box:box(-20,-10,40,20),
  },
  zener: {
    label:'Zener diode', cat:'discrete', prefix:'D', value:'BZX-5V1',
    pins:[P('A',-20,0,'l'), P('K',20,0,'r')],
    paths:['M-20 0H-8','M8 0H20','M8 -8V8','M8 -8H4','M8 8H12'], fills:['M-8 -8L8 0L-8 8Z'], box:box(-20,-10,40,20),
  },
  schottky: {
    label:'Schottky diode', cat:'discrete', prefix:'D', value:'BAT54',
    pins:[P('A',-20,0,'l'), P('K',20,0,'r')],
    paths:['M-20 0H-8','M8 0H20','M8 -8V8','M8 -8H4V-5','M8 8H12V5'], fills:['M-8 -8L8 0L-8 8Z'], box:box(-20,-10,40,20),
  },
  tvs: {
    label:'TVS diode', cat:'discrete', prefix:'D', value:'SMAJ',
    pins:[P('1',-20,0,'l'), P('2',20,0,'r')],
    paths:['M-20 0H-10','M10 0H20','M0 -9V9','M0 -9H-4','M0 9H4'],
    fills:['M-10 -8L0 0L-10 8Z','M10 -8L0 0L10 8Z'], box:box(-20,-10,40,20),
  },
  led: {
    label:'LED', cat:'discrete', prefix:'LED', value:'red',
    pins:[P('A',-20,0,'l'), P('K',20,0,'r')],
    paths:['M-20 0H-8','M8 0H20','M8 -8V8','M2 -11L9 -18','M8 -11L15 -18'],
    fills:['M-8 -8L8 0L-8 8Z','M9 -18L5 -17L8 -14Z','M15 -18L11 -17L14 -14Z'], box:box(-20,-20,40,30),
  },
  npn: {
    label:'NPN transistor', cat:'discrete', prefix:'Q', value:'MMBT3904',
    pins:[P('B',-20,0,'l'), P('C',0,-30,'t'), P('E',0,30,'b')],
    bodies:[circlePath(-3, 0, 15)],
    paths:['M-20 0H-8','M-8 -6L0 -14','M0 -14V-30','M-8 6L0 14','M0 14V30','M-8 -11V11'],
    fills:['M-0.5 13.5L-6.5 11.1L-2.9 7.5Z'], box:box(-20,-30,30,60),
  },
  pnp: {
    label:'PNP transistor', cat:'discrete', prefix:'Q', value:'MMBT3906',
    pins:[P('B',-20,0,'l'), P('C',0,-30,'t'), P('E',0,30,'b')],
    bodies:[circlePath(-3, 0, 15)],
    paths:['M-20 0H-8','M-8 -6L0 -14','M0 -14V-30','M-8 6L0 14','M0 14V30','M-8 -11V11'],
    fills:['M-7.5 6.5L-5.1 12.5L-1.5 8.9Z'], box:box(-20,-30,30,60),
  },
  nmos: {
    label:'N-MOSFET', cat:'discrete', prefix:'Q', value:'NMOS',
    pins:[P('G',-20,0,'l'), P('D',0,-30,'t'), P('S',0,30,'b')],
    paths:['M-20 0H-13','M-13 -11V11','M-7 -9H0V-30','M-7 9H0V30','M-7 0H0','M0 9V0','M-7 -12V-5','M-7 -3.5V3.5','M-7 5V12'],
    fills:['M-7 0L-2 -3L-2 3Z'], box:box(-20,-30,30,60),
  },
  pmos: {
    label:'P-MOSFET', cat:'discrete', prefix:'Q', value:'PMOS',
    pins:[P('G',-20,0,'l'), P('D',0,-30,'t'), P('S',0,30,'b')],
    paths:['M-20 0H-13','M-13 -11V11','M-7 -9H0V-30','M-7 9H0V30','M-7 0H0','M0 9V0','M-7 -12V-5','M-7 -3.5V3.5','M-7 5V12'],
    fills:['M-1 0L-6 -3L-6 3Z'], box:box(-20,-30,30,60),
  },
  gan: {
    label:'GaN HEMT', cat:'discrete', prefix:'Q', value:'GaN',
    pins:[P('G',-20,0,'l'), P('D',0,-30,'t'), P('S',0,30,'b')],
    paths:['M-20 0H-13','M-13 -11V11','M-7 -9H0V-30','M-7 9H0V30','M-7 0H0','M0 9V0','M-7 -12V12'],
    fills:['M-7 0L-2 -3L-2 3Z'], box:box(-20,-30,30,60),
  },
  igbt: {
    label:'IGBT', cat:'discrete', prefix:'Q', value:'IGBT',
    pins:[P('G',-20,0,'l'), P('C',0,-30,'t'), P('E',0,30,'b')],
    paths:['M-20 0H-13','M-13 -11V11','M-7 -8L0 -14V-30','M-7 8L0 14V30','M-7 -12V12'],
    fills:['M-0.5 13.6L-6.7 11.6L-3.5 7.8Z'], box:box(-20,-30,30,60),
  },
  scr: {
    label:'Thyristor (SCR)', cat:'discrete', prefix:'Q', value:'SCR',
    pins:[P('A',-20,0,'l'), P('K',20,0,'r'), P('G',10,20,'b')],
    paths:['M-20 0H-8','M8 0H20','M8 -8V8','M10 20V10L8 6'], fills:['M-8 -8L8 0L-8 8Z'], box:box(-20,-10,40,32),
  },
  opto: {
    label:'Optocoupler', cat:'discrete', prefix:'U', value:'OPTO',
    pins:[P('1',-30,-10,'l'), P('2',-30,10,'l'), P('3',30,10,'r'), P('4',30,-10,'r')],
    bodies:['M-20 -20H20V20H-20Z'],
    paths:['M-30 -10H-14V-5','M-14 3V10H-30','M-18 3H-10',            // LED
           'M-9 -4H-5','M-9 2H-5',                                    // light
           'M8 -4L14 -10H30','M8 4L14 10H30','M8 -8V8'],                        // phototransistor
    fills:['M-18 -5L-10 -5L-14 3Z','M-4 -4L-7 -6L-7 -2Z','M-4 2L-7 0L-7 4Z','M13.5 9.5L8.6 7.4L11.4 4.6Z'],
    box:box(-30,-20,60,40),
  },

  /* ----------------------------- integrated ----------------------------- */
  opamp: {
    label:'Op-amp', cat:'active', prefix:'U', value:'TLV9062',
    pins:[P('+',-30,-10,'l'), P('-',-30,10,'l'), P('OUT',30,0,'r'), P('V+',0,-20,'t'), P('V-',0,20,'b')],
    bodies:['M-20 -20L20 0L-20 20Z'],
    paths:['M-30 -10H-20','M-30 10H-20','M20 0H30','M0 -10V-20','M0 10V20',
           'M-17 -13H-11','M-14 -16V-10','M-17 13H-11'], box:box(-30,-20,60,40),
  },
  comparator: {
    label:'Comparator', cat:'active', prefix:'U', value:'TLV7011',
    pins:[P('+',-30,-10,'l'), P('-',-30,10,'l'), P('OUT',30,0,'r'), P('V+',0,-20,'t'), P('V-',0,20,'b')],
    bodies:['M-20 -20L20 0L-20 20Z'],
    paths:['M-30 -10H-20','M-30 10H-20','M20 0H30','M0 -10V-20','M0 10V20',
           'M-17 -13H-11','M-14 -16V-10','M-17 13H-11','M-4 -6L2 -6L-4 6L2 6'], box:box(-30,-20,60,40),
  },
  ic: { label:'IC (generic)', cat:'active', prefix:'U', value:'', generated:'ic', pinCount:8 },

  /* ------------------------- electromechanical -------------------------- */
  connector: { label:'Connector', cat:'electro', prefix:'J', value:'', generated:'conn', pinCount:4 },
  switch_spst: {
    label:'Switch SPST', cat:'electro', prefix:'SW', value:'',
    pins:[P('1',-20,0,'l'), P('2',20,0,'r')],
    paths:['M-20 0H-10','M10 0H20','M-10 0L8 -10'], extra:'<circle class="sym" cx="-10" cy="0" r="1.6"/><circle class="sym" cx="10" cy="0" r="1.6"/>',
    box:box(-20,-12,40,24),
  },
  switch_spdt: {
    label:'Switch SPDT', cat:'electro', prefix:'SW', value:'',
    pins:[P('COM',-20,0,'l'), P('NO',20,-10,'r'), P('NC',20,10,'r')],
    paths:['M-20 0H-10','M10 -10H20','M10 10H20','M-10 0L8 -10'],
    extra:'<circle class="sym" cx="-10" cy="0" r="1.6"/><circle class="sym" cx="10" cy="-10" r="1.6"/><circle class="sym" cx="10" cy="10" r="1.6"/>',
    box:box(-20,-14,40,28),
  },
  relay: {
    label:'Relay', cat:'electro', prefix:'K', value:'',
    pins:[P('A1',-40,-10,'l'), P('A2',-40,10,'l'), P('COM',40,0,'r'), P('NO',40,-20,'r'), P('NC',40,20,'r')],
    bodies:['M-26 -14H-14V14H-26Z'],
    paths:['M-40 -10H-26','M-40 10H-26','M-26 14L-14 -14','M-14 0H6','M40 0H14','M40 -20H14','M40 20H14',
           'M14 0L26 -16'], extra:'<circle class="sym" cx="14" cy="0" r="1.6"/><circle class="sym" cx="14" cy="-20" r="1.6"/><circle class="sym" cx="14" cy="20" r="1.6"/>',
    box:box(-40,-24,80,48),
  },
  contactor: {
    label:'Contactor', cat:'electro', prefix:'K', value:'',
    pins:[P('A1',-40,-10,'l'), P('A2',-40,10,'l'), P('L1',40,-20,'r'), P('T1',40,20,'r')],
    bodies:['M-26 -14H-14V14H-26Z'],
    paths:['M-40 -10H-26','M-40 10H-26','M-26 14L-14 -14','M-14 0H6','M40 -20H20V-10','M40 20H20V10','M20 10L28 -8'],
    extra:'<circle class="sym" cx="20" cy="-10" r="1.6"/><circle class="sym" cx="20" cy="10" r="1.6"/>',
    box:box(-40,-24,80,48),
  },
  solenoid: {
    label:'Solenoid', cat:'electro', prefix:'L', value:'',
    pins:[P('1',-20,0,'l'), P('2',20,0,'r')],
    paths:['M-20 0H-15','M15 0H20', winding(-15, 0, 4, 3.75, 1), 'M-15 -8H15','M0 -8V-14'],
    fills:['M-3 -14L3 -14L0 -18Z'], box:box(-20,-18,40,26),
  },
  battery: {
    label:'Battery', cat:'electro', prefix:'BT', value:'3.7V',
    pins:[P('+',-20,0,'l'), P('-',20,0,'r')],
    paths:['M-20 0H-8','M8 0H20','M-2 -5V5','M8 -5V5','M-17 -7V-3','M-19 -5H-15','M-8 -10V10','M2 -10V10'], box:box(-20,-12,40,24),
  },
  motor: {
    label:'Motor', cat:'electro', prefix:'M', value:'',
    pins:[P('1',-30,0,'l'), P('2',30,0,'r')],
    bodies:[circlePath(0, 0, 14)],
    paths:['M-30 0H-14','M14 0H30','M-6 7V-7L0 1L6 -7V7'], box:box(-30,-16,60,32),
  },
  testpoint: {
    label:'Test point', cat:'electro', prefix:'TP', value:'',
    pins:[P('1',0,10,'b')], paths:['M0 10V0'], extra:'<circle class="sym" cx="0" cy="-3" r="3.2"/>',
    box:box(-8,-8,16,20),
  },

  /* --------------------------- ports & power ---------------------------- */
  gnd: {
    label:'GND', cat:'port', prefix:'', port:'gnd', net:'GND',
    pins:[P('1',0,-10,'t')], paths:['M0 -10V0','M-10 0H10','M-6 4H6','M-2 8H2'], box:box(-10,-10,20,20),
  },
  gnd_hv: {
    label:'GND (isolated)', cat:'port', prefix:'', port:'gnd', net:'GND_HV',
    pins:[P('1',0,-10,'t')], paths:['M0 -10V0','M-10 0H10','M-10 0L-14 6','M-4 0L-8 6','M2 0L-2 6','M8 0L4 6'], box:box(-14,-10,28,18),
  },
  earth: {
    label:'Earth / chassis', cat:'port', prefix:'', port:'gnd', net:'EARTH',
    pins:[P('1',0,-10,'t')], paths:['M0 -10V0','M-10 0V8','M0 0V8','M10 0V8','M-10 0H10'], box:box(-10,-10,20,20),
  },
  vcc: {
    label:'Power rail', cat:'port', prefix:'', port:'power', net:'VCC',
    pins:[P('1',0,10,'b')], paths:['M0 10V-2','M-8 -2H8'], box:box(-10,-8,20,20),
  },
  netlabel: {
    label:'Net label', cat:'port', prefix:'', port:'label', net:'NET',
    pins:[P('1',0,0,'r')], paths:[], box:box(0,-10,60,12),
  },
  noconnect: {
    label:'No connect', cat:'port', prefix:'', port:'nc',
    pins:[P('1',0,0,'r')], paths:['M-4 -4L4 4','M-4 4L4 -4'], box:box(-6,-6,12,12),
  },
  note: {
    label:'Text note', cat:'port', prefix:'', port:'note',
    pins:[], paths:[], box:box(0,-10,120,20),
  },
};

/* ------------------------------------------------------------------
   Component TYPES — the generic names a netlist uses for its passives
   and discretes, the parameter fields each one carries, and which
   symbols draw it. `value` is the field shown under the designator.
   ------------------------------------------------------------------ */
const F_L = ['inductance','tolerance','max_operational_frequency','current_rating'];
const F_K = ['contact_form','coil_voltage','current_rating','voltage_rating'];
const COMPONENT_TYPES = {
  'resistor':          { fields:['resistance','tolerance','power_rating'], kinds:['res','pot'], value:'resistance' },
  'shunt resistor':    { fields:['resistance','tolerance','power_rating'], kinds:['shunt'], value:'resistance' },
  'capacitor':         { fields:['capacitance','tolerance','voltage_rating','type'], kinds:['cap','cap_pol'], value:'capacitance' },
  'inductor':          { fields:F_L, kinds:['ind','ferrite'], value:'inductance' },
  'choke':             { fields:F_L, kinds:['choke'], value:'inductance' },
  'common-mode choke': { fields:F_L, kinds:['cm_choke'], value:'inductance' },
  'diode':             { fields:['diode_type','reverse_voltage','current_rating'], kinds:['diode','schottky','led'], value:'' },
  'zener diode':       { fields:['zener_voltage','power_rating'], kinds:['zener'], value:'zener_voltage' },
  'TVS diode':         { fields:['clamping_voltage_max','peak_pulse_power','polarity'], kinds:['tvs'], value:'clamping_voltage_max' },
  'thyristor':         { fields:['thyristor_type','blocking_voltage','current_rating'], kinds:['scr'], value:'' },
  'MOSFET':            { fields:['vds_voltage','id_current','gate_voltage','polarity'], kinds:['nmos','pmos'], value:'' },
  'GAN':               { fields:['vds_voltage','id_current','gate_voltage','polarity'], kinds:['gan'], value:'' },
  'IGBT':              { fields:['vce_voltage','ic_current','vge_voltage','polarity'], kinds:['igbt'], value:'' },
  'BJT':               { fields:['vce_voltage','ic_current','vbe_voltage','polarity'], kinds:['npn','pnp'], value:'' },
  'fuse':              { fields:['current_rating','voltage_rating'], kinds:['fuse'], value:'current_rating' },
  'transformer':       { fields:['primary_magnetizing_inductance','turns_ratio','operational_frequency_range','voltage_isolation','voltage_primary'], kinds:['xfmr'], value:'turns_ratio' },
  'connector':         { fields:['number_of_contacts','mounting_type','current_rating','voltage_rating'], kinds:['connector'], value:'' },
  'oscillator':        { fields:['frequency','oscillator_type','voltage_rating'], kinds:['osc'], value:'frequency' },
  'crystal':           { fields:['frequency','tolerance','load_capacitance'], kinds:['xtal'], value:'frequency' },
  'ntc':               { fields:['thermistor_type','operating_temperature_range','power_rating'], kinds:['ntc'], value:'' },
  'relay':             { fields:F_K, kinds:['relay'], value:'coil_voltage' },
  'contactor':         { fields:F_K, kinds:['contactor'], value:'coil_voltage' },
  'solenoid':          { fields:F_K, kinds:['solenoid'], value:'coil_voltage' },
};
/* Spellings a netlist may use for a field (older generators wrote `vce_voltag`). */
const FIELD_ALIASES = { vce_voltage:['vce_voltag'] };

/* The generic type a part is: from its part number when that is one of the
   generic names above, otherwise from the symbol that draws it. An IC with a
   real part number has no generic type (and no parameter fields). */
const TYPE_BY_NAME = new Map(Object.keys(COMPONENT_TYPES).map(k => [k.toLowerCase(), k]));
const TYPE_ALIASES = { 'gan':'GAN', 'gan hemt':'GAN', 'gan fet':'GAN', 'mosfet':'MOSFET', 'igbt':'IGBT', 'bjt':'BJT',
  'transistor':'BJT', 'npn':'BJT', 'pnp':'BJT', 'tvs':'TVS diode', 'zener':'zener diode', 'scr':'thyristor', 'triac':'thyristor',
  'thermistor':'ntc', 'ptc':'ntc', 'shunt':'shunt resistor', 'common mode choke':'common-mode choke', 'cm choke':'common-mode choke',
  'led':'diode', 'schottky':'diode', 'schottky diode':'diode', 'xtal':'crystal', 'header':'connector', 'ferrite':'inductor', 'ferrite bead':'inductor' };
function componentType(part){
  if (!part) return null;
  const pn = String(part.partNumber || '').trim().toLowerCase();
  if (pn && TYPE_BY_NAME.has(pn)) return TYPE_BY_NAME.get(pn);
  if (pn && TYPE_ALIASES[pn]) return TYPE_ALIASES[pn];
  for (const [name, t] of Object.entries(COMPONENT_TYPES)) if (t.kinds.includes(part.kind)) return name;
  return null;
}
/* The fields a part exposes in Properties: those of its type, in order. */
function typeFields(part){
  const t = componentType(part);
  return t ? COMPONENT_TYPES[t].fields : [];
}
/* Read a parameter, honouring the alias spellings. */
function propValue(props, field){
  if (!props) return '';
  if (props[field] != null && props[field] !== '') return props[field];
  for (const a of FIELD_ALIASES[field] || []) if (props[a] != null && props[a] !== '') return props[a];
  return '';
}

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
    label: label || 'Connector', cat:'electro', prefix:'J', generated:'conn', leads:true, names:true, pinMarks:true,
    pins, body: box(-w/2, top, w, h), box: box(-w/2, top - GRID, w + PIN_LEAD, h + 2*GRID),
    paths: [], w, h,
  };
}

/* A def that came from outside — an Altium symbol parsed by altium.js and
   stored on the part, or one restored from a saved session. It is data like
   any other def; this only fills in what a hand-written def states inline. */
function makeLibDef(sym){
  const def = { label:'Symbol', cat:'active', prefix:'U', leads:true, names:true,
                paths:[], bodies:[], fills:[], ...sym };
  def.pins = (def.pins || []).map(p => P(p.name, p.x, p.y, p.dir));
  if (!def.box){
    const xs = def.pins.map(p => p.x), ys = def.pins.map(p => p.y);
    const b = def.body || box(-20, -20, 40, 40);
    const x0 = Math.min(b.x, ...xs) - GRID, y0 = Math.min(b.y, ...ys) - GRID;
    def.box = box(x0, y0, Math.max(b.x + b.w, ...xs) - x0 + GRID, Math.max(b.y + b.h, ...ys) - y0 + GRID);
  }
  return def;
}

/* The def a part actually uses: a symbol carried by the part itself (the
   library's Altium symbol) wins, then the generated symbols, which carry
   their pin list on the part (part.pinNames), then the fixed library. */
function defOf(part){
  if (!part) return null;
  if (part.libSymbol && part.libSymbol.pins && part.libSymbol.pins.length) return makeLibDef(part.libSymbol);
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
/* Which way a pin points once the part is turned. */
function rotDir(dir, rot, mir){
  const order = ['r','b','l','t'];
  let i = order.indexOf(dir);
  if (i < 0) return dir;
  if (mir && (dir === 'l' || dir === 'r')) i = order.indexOf(dir === 'l' ? 'r' : 'l');
  return order[(i + Math.round(((rot % 360) + 360) % 360 / 90)) % 4];
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

/* Where a pin name sits: the point just inside the body where the lead
   enters, and the side of the body it hangs from. */
function pinNameAnchor(def, p){
  const b = def.body, inset = def.pinMarks ? 11 : 4;
  return { x: p.dir === 'l' ? b.x + inset : p.dir === 'r' ? b.x + b.w - inset : p.x,
           y: p.dir === 't' ? b.y + inset : p.dir === 'b' ? b.y + b.h - inset : p.y };
}
/* A pin name as level text, whichever way the part is turned. `rot`/`mir`
   are the part's, so the text can be laid out in the part's unrotated frame:
   names on a left/right edge read horizontally, names on a top/bottom edge
   run vertically, the way every schematic tool does it. */
function pinNameText(def, p, rot, mir){
  const a = pinNameAnchor(def, p);
  const q = rotPoint(a.x, a.y, rot || 0, mir);
  const d = rotDir(p.dir, rot || 0, mir);
  if (d === 'l') return `<text class="pinname" x="${q.x}" y="${q.y + 2.6}" text-anchor="start">${esc(p.name)}</text>`;
  if (d === 'r') return `<text class="pinname" x="${q.x}" y="${q.y + 2.6}" text-anchor="end">${esc(p.name)}</text>`;
  const anchor = d === 't' ? 'end' : 'start';
  return `<text class="pinname" x="${q.x + 2.6}" y="${q.y}" text-anchor="${anchor}" transform="rotate(-90 ${q.x + 2.6} ${q.y})">${esc(p.name)}</text>`;
}

/* The symbol body, in LOCAL coordinates — the caller wraps it in the part's
   translate/rotate so the drawing rotates while ref/value text stays level.
   opts.names:false leaves the pin names out (the sheet draws them level). */
function symbolBodySVG(def, opts){
  const o = opts || {};
  let s = '';
  if (def.body){                                   // box body + leads (+ pin names)
    const b = def.body;
    s += `<rect class="icbody" x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}"/>`;
    for (const p of def.pins){
      const ex = p.dir === 'l' ? b.x : p.dir === 'r' ? b.x + b.w : p.x;
      const ey = p.dir === 't' ? b.y : p.dir === 'b' ? b.y + b.h : p.y;
      s += `<line class="pinline" x1="${p.x}" y1="${p.y}" x2="${ex}" y2="${ey}"/>`;
      if (def.pinMarks) s += `<rect class="pinmark" x="${(p.dir === 'l' ? b.x + 2 : b.x + b.w - 8)}" y="${p.y - 2.5}" width="6" height="5"/>`;
      if (def.names && o.names !== false) s += pinNameText(def, p, 0, 0);
    }
    if (o.label) s += `<text class="pinname" x="0" y="${b.y - 3}" text-anchor="middle">${esc(o.label)}</text>`;
  }
  for (const d of def.bodies || []) s += `<path class="symbody" d="${d}"/>`;
  for (const d of def.paths || []) s += `<path class="sym" d="${d}"/>`;
  for (const d of def.fills || []) s += `<path class="symfill" d="${d}"/>`;
  if (def.extra) s += def.extra;
  return s;
}

/* A small standalone preview of any def — the Components panel draws the
   fixed library with it, the Library panel the symbol a component resolves to. */
function defPreviewSVG(def, opts){
  const b = (def && def.box) || box(-20,-20,40,40);
  const pad = 6;
  return `<svg viewBox="${b.x-pad} ${b.y-pad} ${b.w+2*pad} ${b.h+2*pad}" preserveAspectRatio="xMidYMid meet">${symbolBodySVG(def, opts || {})}</svg>`;
}

/* A small standalone preview, used by the Components panel. */
function symbolPreviewSVG(kind){
  const def = SYMBOLS[kind].generated ? (SYMBOLS[kind].generated === 'ic' ? makeIcDef(['1','2','3','4','5','6']) : makeConnDef(3)) : SYMBOLS[kind];
  const b = def.box || box(-20,-20,40,40);
  const pad = 6;
  let inner = symbolBodySVG(def, {});
  if (kind === 'netlabel') inner = '<path class="sym" d="M0 0H8"/><text class="pinname" x="10" y="-2" style="font-size:9px">NET</text>';
  if (kind === 'note')     inner = '<path class="sym" d="M2 -8H50M2 0H40M2 8H46"/>';
  return `<svg viewBox="${b.x-pad} ${b.y-pad} ${b.w+2*pad} ${b.h+2*pad}" preserveAspectRatio="xMidYMid meet">${inner}</svg>`;
}

/* ------------------------------------------------------------------
   Netlist component → symbol kind. The generic type of the part number
   ("resistor", "TVS diode", "common-mode choke"…) decides first; when
   the part number is a real one, the reference prefix and the
   type-specific fields do.
   ------------------------------------------------------------------ */
function kindForComponent(c){
  const pn = String(c.partNumber || '').trim().toLowerCase();
  const ref = String(c.ref || '').toUpperCase();
  const pre = (ref.match(/^[A-Z]+/) || [''])[0];
  const txt = [pn, c.role, c.type, c.diode_type, c.thyristor_type, c.polarity].filter(Boolean).join(' ').toLowerCase();
  const pol = String(c.polarity || '').toLowerCase();
  const pChannel = /p-?channel|pmos|pnp|^p$/.test(pol);
  const polar = /electrolyt|tantal|polymer|polarized|aluminium|aluminum/.test(txt);

  const type = TYPE_BY_NAME.get(pn) || TYPE_ALIASES[pn] || null;
  switch (type){
    case 'resistor':          return /ntc|thermistor/.test(txt) ? 'ntc' : 'res';
    case 'shunt resistor':    return 'shunt';
    case 'capacitor':         return polar ? 'cap_pol' : 'cap';
    case 'inductor':          return /ferrite|bead/.test(txt) ? 'ferrite' : 'ind';
    case 'choke':             return /common/.test(txt) ? 'cm_choke' : 'choke';
    case 'common-mode choke': return 'cm_choke';
    case 'diode':             return /zener/.test(txt) ? 'zener' : /schottky/.test(txt) ? 'schottky' : /tvs|transient/.test(txt) ? 'tvs' : /led|light/.test(txt) ? 'led' : 'diode';
    case 'zener diode':       return 'zener';
    case 'TVS diode':         return 'tvs';
    case 'thyristor':         return 'scr';
    case 'MOSFET':            return pChannel ? 'pmos' : 'nmos';
    case 'GAN':               return 'gan';
    case 'IGBT':              return 'igbt';
    case 'BJT':               return pChannel ? 'pnp' : 'npn';
    case 'fuse':              return 'fuse';
    case 'transformer':       return 'xfmr';
    case 'connector':         return 'connector';
    case 'oscillator':        return 'osc';
    case 'crystal':           return 'xtal';
    case 'ntc':               return 'ntc';
    case 'relay':             return 'relay';
    case 'contactor':         return 'contactor';
    case 'solenoid':          return 'solenoid';
  }
  if (pn.includes('shunt')) return 'shunt';
  if (pre === 'R')  return /ntc|thermistor/.test(txt) ? 'ntc' : 'res';
  if (pre === 'RT' || /thermistor/.test(txt)) return 'ntc';
  if (pre === 'C')  return polar ? 'cap_pol' : 'cap';
  if (pre === 'L')  return /common/.test(txt) ? 'cm_choke' : /choke/.test(txt) ? 'choke' : 'ind';
  if (pre === 'FB' || /ferrite/.test(txt)) return 'ferrite';
  if (pre === 'T')  return 'xfmr';
  if (pre === 'Y')  return /oscillator/.test(txt) ? 'osc' : 'xtal';
  if (pre === 'F')  return 'fuse';
  if (pre === 'LED') return 'led';
  if (pre === 'D'){
    if (/zener/.test(txt)) return 'zener';
    if (/schottky/.test(txt)) return 'schottky';
    if (/tvs|transient/.test(txt)) return 'tvs';
    if (/led/.test(txt)) return 'led';
    return 'diode';
  }
  if (pre === 'Q' || /mosfet|transistor|igbt|thyristor|hemt/.test(txt)){
    if (/igbt/.test(txt)) return 'igbt';
    if (/gan|hemt/.test(txt)) return 'gan';
    if (/thyristor|scr|triac/.test(txt)) return 'scr';
    if (/pnp/.test(txt)) return 'pnp';
    if (/npn/.test(txt)) return 'npn';
    if (/bjt|bipolar/.test(txt)) return pChannel ? 'pnp' : 'npn';
    return pChannel ? 'pmos' : 'nmos';
  }
  if (pre === 'J') return 'connector';
  if (pre === 'SW' || pn === 'switch') return /spdt|changeover|form c/.test(txt) ? 'switch_spdt' : 'switch_spst';
  if (pre === 'K') return /contactor/.test(txt) ? 'contactor' : 'relay';
  if (pre === 'BT' || /battery|cell pack/.test(txt)) return 'battery';
  if (pre === 'TP') return 'testpoint';
  if (/opto|photocoupler/.test(txt)) return 'opto';
  return 'ic';
}

/* The value a placed part shows under its reference: the type's own value
   field first, then the usual suspects. */
function valueForComponent(c){
  const type = componentType({ partNumber:c.partNumber, kind:c.kind || kindForComponent(c) });
  const prime = type && COMPONENT_TYPES[type].value;
  const v = prime && propValue(c, prime);
  if (v) return String(v);
  return c.resistance || c.capacitance || c.inductance || c.turns_ratio || c.zener_voltage || c.frequency ||
         c.coil_voltage || c.current_rating || c.value ||
         (String(c.partNumber || '').toLowerCase() === c.partNumber ? '' : c.partNumber) || '';
}

if (typeof module !== 'undefined') module.exports = {
  GRID, PIN_LEAD, SYMBOLS, SYM_CATS, COMPONENT_TYPES, FIELD_ALIASES, makeIcDef, makeConnDef, makeLibDef, defOf, pinWorld, partPins, partBounds,
  symbolBodySVG, symbolPreviewSVG, defPreviewSVG, pinNameText, kindForComponent, valueForComponent, componentType, typeFields, propValue,
  rotPoint, rotDir,
};
