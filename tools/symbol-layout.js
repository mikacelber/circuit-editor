/* ==================================================================
   tools/symbol-layout.js — a datasheet pinout, turned into a symbol.

   This is the DETERMINISTIC half of the generator: given a pinout and
   a side for every pin, it always produces the same geometry. The half
   that is JUDGEMENT — which side a pin belongs on, how pins group —
   comes either from the rules below or from the agent in
   tools/gen-symbol.js. The geometry is never a model's decision, so
   the same component is drawn the same way twice.

   Out comes the IR documented in docs/component-library.md: mils, +y
   up (Altium's axes), every pin anchored at its ELECTRICAL end, and
   `orientation` pointing the way the lead runs into the body.
   ================================================================== */
'use strict';

const PITCH = 100;          // mil — Altium's lattice; one step is one of our grid cells
const LEAD = 300;           // mil — the pin lead
const MIN_W = 600, MIN_H = 400;
const SIDES = ['left', 'right', 'top', 'bottom'];
/* The side a pin hangs off → Altium's orientation (see the IR). */
const SIDE_ORIENTATION = { left:0, bottom:90, right:180, top:270 };

/* Names that outrank the datasheet's own `type`: a ground is very often
   declared "power", and the thermal pad is usually declared as nothing. */
const RE_GROUND = /^(GND|VSS|AGND|DGND|PGND|SGND|VEE|EP|EPAD|PAD|THERMAL|EXPOSED|NEG)\b|^(GND|VSS)/i;
const RE_POWER  = /^(VDD|VCC|VIN|VBAT|VBUS|VS|VP|AVDD|DVDD|VDDA|VDDIO|VCCIO|PVDD|VREF|VREG|VAA|VDDS)/i;
const RE_OUTPUT = /^(OUT|VOUT|SW|LX|DRV|GATE|SOURCE|TX|SDO|MISO|DOUT|CHG|PG|PGOOD|FAULT|FLT|ALERT|DRDY|INT|STAT|Q\d*)\b|^(OUT|VOUT)/i;

/* ---- the pinout, wherever it comes from -------------------------
   A record from the datasheet pipeline (db/approved/<GPN>__….json)
   carries facts.pinout = [{pin, name, type}]. A bare list of names —
   what a library record holds — is accepted just the same. */
function pinoutFromRecord(rec){
  const facts = (rec && rec.facts) || rec || {};
  const list = facts.pinout || rec.pinout || [];
  return list.map((p, i) => ({
    pin: String(p.pin != null ? p.pin : i + 1),
    name: String(p.name || p.pin || i + 1),
    type: normType(p.type),
    description: String(p.description || p.function || ''),
  })).filter(p => p.name);
}

/* Pin tables abbreviate the type every which way — "O", "PWR", "I/O",
   "GND" — and the side of the symbol follows from it, so it is normalised
   here before anything reads it. */
const TYPE_CODES = {
  i:'input', in:'input', input:'input', inp:'input',
  o:'output', out:'output', output:'output', op:'output',
  io:'io', 'i/o':'io', bidir:'io', bidirectional:'io', inout:'io',
  pwr:'power', power:'power', supply:'power', p:'power', vcc:'power', vdd:'power',
  gnd:'ground', ground:'ground', gnd_ret:'ground', vss:'ground', rtn:'ground', return:'ground',
  nc:'nc', dnc:'nc', 'n/c':'nc', reserved:'nc',
  a:'analog', analog:'analog', ai:'input', ao:'output',
  pas:'passive', passive:'passive', pin:'passive',
};
function normType(t){
  const k = String(t == null ? '' : t).trim().toLowerCase();
  if (!k) return '';
  return TYPE_CODES[k] || k;
}
function pinoutFromNames(names){
  return (names || []).map((n, i) => ({ pin:String(i + 1), name:String(n), type:'', description:'' }));
}

/* ---- the rules: which side each pin goes on ---------------------
   The schematic convention: supplies at the top, grounds at the bottom,
   inputs on the left, outputs on the right. The datasheet's `type`
   decides, except where the name plainly says otherwise. */
function groupOf(p){
  const name = p.name || '', type = normType(p.type);
  if (type === 'nc' || /^(NC|DNC|RESERVED)$/i.test(name)) return 'nc';
  if (RE_GROUND.test(name) || type === 'ground') return 'ground';
  if (RE_POWER.test(name) || type === 'power') return 'power';
  if (type === 'output' || (RE_OUTPUT.test(name) && type !== 'input' && type !== 'io')) return 'output';
  return 'input';
}
const GROUP_SIDE = { power:'top', ground:'bottom', output:'right', input:'left', nc:'left' };

/* The default assignment. A plan is one entry per pin: its side, its
   group and where it sits along that side. */
function planLayout(pins){
  const plan = pins.map(p => {
    const group = groupOf(p);
    return { pin:p.pin, name:p.name, type:p.type, group, side:GROUP_SIDE[group] || 'left' };
  });
  return orderPlan(plan);
}

/* Order within a side: by group, and inside a group by pin number —
   the pins with no number (EP, PAD) go last. */
function orderPlan(plan){
  const groupRank = { power:0, input:1, output:2, nc:3, ground:4 };
  const bySide = new Map();
  for (const e of plan){
    if (!SIDES.includes(e.side)) e.side = GROUP_SIDE[e.group] || 'left';
    if (!bySide.has(e.side)) bySide.set(e.side, []);
    bySide.get(e.side).push(e);
  }
  for (const list of bySide.values()){
    list.sort((a, b) => {
      if (a.order != null && b.order != null && a.order !== b.order) return a.order - b.order;
      const g = (groupRank[a.group] ?? 9) - (groupRank[b.group] ?? 9);
      if (g) return g;
      const na = Number(a.pin), nb = Number(b.pin);
      if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
      if (Number.isFinite(na)) return -1;
      if (Number.isFinite(nb)) return 1;
      return String(a.pin).localeCompare(String(b.pin));
    });
    list.forEach((e, i) => { e.order = i; });
  }
  return plan;
}

/* ---- the assignment the agent proposes --------------------------
   Taken only when it covers exactly the same pins, each one once, on
   valid sides. Anything else is thrown away whole: the symbol from the
   rules beats one that is missing a pin. */
function applyAgentPlan(pins, proposed){
  const want = new Map(pins.map(p => [String(p.pin), p]));
  const seen = new Set();
  const plan = [];
  for (const e of (proposed || [])){
    const key = String(e.pin);
    const p = want.get(key);
    if (!p || seen.has(key)) return { ok:false, reason:'the agent returned an unknown or repeated pin: ' + key };
    if (!SIDES.includes(e.side)) return { ok:false, reason:'not a valid side for pin ' + key + ': ' + e.side };
    seen.add(key);
    plan.push({ pin:p.pin, name:p.name, type:p.type, group:String(e.group || groupOf(p)),
                side:e.side, order:Number.isFinite(+e.order) ? +e.order : undefined });
  }
  if (seen.size !== want.size)
    return { ok:false, reason:'the agent left ' + (want.size - seen.size) + ' pin(s) unplaced' };
  return { ok:true, plan:orderPlan(plan) };
}

/* ---- geometry: the plan becomes the IR -------------------------- */
function irFromPlan(plan, meta){
  const m = meta || {};
  const side = s => plan.filter(e => e.side === s).sort((a, b) => a.order - b.order);
  const L = side('left'), R = side('right'), T = side('top'), B = side('bottom');

  const rows = Math.max(L.length, R.length, 1);
  const cols = Math.max(T.length, B.length, 0);
  const longest = plan.reduce((n, e) => Math.max(n, String(e.name).length), 1);
  const w = Math.max(MIN_W, (cols + 1) * PITCH, Math.ceil((longest * 60 + 240) / PITCH) * PITCH);
  const h = Math.max(MIN_H, (rows + 1) * PITCH);
  const hw = w / 2, hh = h / 2;

  const pins = [];
  const put = (e, x, y) => pins.push({
    name: e.name, designator: String(e.pin), x, y, length: LEAD,
    orientation: SIDE_ORIENTATION[e.side], electrical: electricalOf(e), hidden: false,
  });
  L.forEach((e, i) => put(e, -(hw + LEAD),  hh - PITCH * (i + 1)));
  R.forEach((e, i) => put(e,  (hw + LEAD),  hh - PITCH * (i + 1)));
  T.forEach((e, i) => put(e, -hw + PITCH * (i + 1),  (hh + LEAD)));
  B.forEach((e, i) => put(e, -hw + PITCH * (i + 1), -(hh + LEAD)));

  return {
    ok: true, implemented: true, reason: '', warnings: [], units: 'mil',
    symbols: [{
      name: m.name || 'SYMBOL',
      description: m.description || '',
      designator: m.designator || 'U',
      pins,
      primitives: [{ type:'rect', x1:-hw, y1:-hh, x2:hw, y2:hh, filled:true }],
    }],
  };
}
const electricalOf = e => e.group === 'power' || e.group === 'ground' ? 'power'
  : e.group === 'output' ? 'output' : e.group === 'nc' ? 'passive' : 'input';

/* What <PN>.sym.json holds: the IR plus where it came from — which
   datasheet, who generated it, and whether anyone has reviewed it. */
function symbolFile(ir, provenance){
  return {
    format: 'circuit-editor/symbol-ir/1',
    status: (provenance && provenance.status) || 'generated',
    generated: new Date().toISOString(),
    provenance: provenance || {},
    ir,
  };
}

module.exports = {
  PITCH, LEAD, SIDES, SIDE_ORIENTATION, GROUP_SIDE,
  pinoutFromRecord, pinoutFromNames, normType, groupOf, planLayout, orderPlan, applyAgentPlan,
  irFromPlan, symbolFile,
};
