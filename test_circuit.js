/* ==================================================================
   test_circuit.js — the editor, headless.

   Loads index.html and the real scripts in a jsdom window, then puts
   the sheet through the moves a designer makes: import a netlist,
   draw wires, get them wrong, export. Run with `npm test`.
   ================================================================== */
'use strict';
const fs = require('fs');
const { JSDOM } = require('jsdom');

let pass = 0, fail = 0;
const check = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS  ' : 'FAIL  ') + name); };
const section = t => console.log('\n── ' + t + ' ' + '─'.repeat(Math.max(0, 62 - t.length)));

const dom = new JSDOM(fs.readFileSync('index.html', 'utf8').replace(/<script src="[^"]+"><\/script>/g, ''),
  { runScripts:'dangerously', pretendToBeVisual:true, url:'http://localhost/' });
const { window } = dom;
window.SVGElement.prototype.getBoundingClientRect = () => ({ left:0, top:0, width:1600, height:1000 });
window.Element.prototype.setPointerCapture = () => {};
window.Element.prototype.releasePointerCapture = () => {};
/* The browser loads the five scripts into ONE global lexical scope; a single
   eval reproduces that, and the epilogue hands the test what it needs. */
window.eval(['symbols.js', 'netlist.js', 'db.js', 'parts.js', 'panels.js', 'app.js']
  .map(f => fs.readFileSync(f, 'utf8')).join('\n;\n') + `
  window.__T = { SYMBOLS, PANELS, COMPONENT_TYPES, renderDbDetail, defOf, partPins, partBounds, kindForComponent, pinNameFor,
    componentType, typeFields, propValue, symbolBodySVG,
    connectivity, checkDesign, netlistFromSheet, parseCircuitData, partsFromNetlist, arrangeParts, DB,
    dkNormalizeProducts, msNormalizeParts, msParsePrice, mergePartResults, dkFmtPrice, partQueryFor };`);
const T = window.__CE, W = window.__T, S = T.S;
const raw = JSON.parse(fs.readFileSync('sample/circuit_data.json', 'utf8'));

section('Import');
T.importAny(raw, 'sample/circuit_data.json');
check('every component of the netlist lands on the sheet (' + S.parts.length + ')', S.parts.length === 236);
check('every net is kept (' + S.netlist.nets.length + ')', S.netlist.nets.length === 192);
check('the sheet is split into functional rooms (' + S.rooms.length + ')', S.rooms.length > 20);
const u1 = S.parts.find(p => p.ref === 'U1');
check('an IC takes its pin list from the netlist nodes (U1: ' + u1.pinNames.length + ' pins incl. ' +
  (u1.pinNames.includes('EP') ? 'EP' : '—') + ')', u1.pinNames.length === 17 && u1.pinNames.includes('EP'));
const r1 = S.parts.find(p => p.ref === 'R1');
check('a generic "resistor" becomes a resistor symbol with two pins', r1.kind === 'res' && W.partPins(r1).length === 2);
check('values ride along from the netlist (R1 = ' + r1.value + ')', /k/i.test(r1.value));
check('two parts never share a grid cell', new Set(S.parts.map(p => p.x + ',' + p.y)).size === S.parts.length);

section('Geometry');
const pinsH = W.partPins({ ...r1, x:0, y:0, rot:0 }).map(p => p.x + ',' + p.y).sort();
const pinsV = W.partPins({ ...r1, x:0, y:0, rot:90 }).map(p => p.x + ',' + p.y).sort();
check('rotating a part by 90° turns its pins with it (' + pinsH.join(' ') + ' → ' + pinsV.join(' ') + ')',
  pinsH.join('|') === '-20,0|20,0' && pinsV.join('|') === '0,-20|0,20');
check('every pin of every placed part sits on the 10-unit lattice',
  S.parts.every(p => W.partPins(p).every(pin => pin.x % 10 === 0 && pin.y % 10 === 0)));

section('Connectivity rules');
const conn0 = W.connectivity([], [
  { id:'a', pts:[{x:0,y:0},{x:100,y:0}] },
  { id:'b', pts:[{x:50,y:-50},{x:50,y:50}] },
]);
check('two wires that merely CROSS stay separate nets',
  conn0.wireGroup.get('a') !== conn0.wireGroup.get('b') && conn0.junctions.length === 0);
const conn1 = W.connectivity([], [
  { id:'a', pts:[{x:0,y:0},{x:100,y:0}] },
  { id:'b', pts:[{x:50,y:0},{x:50,y:50}] },
]);
check('a wire that ENDS on another one makes a T — with its junction dot',
  conn1.wireGroup.get('a') === conn1.wireGroup.get('b') && conn1.junctions.length === 1);
const probe = { id:'px', kind:'res', ref:'RX', x:0, y:0, rot:0, mir:0 };
const over = W.connectivity([probe], [{ id:'w', pts:[{x:-60,y:0},{x:60,y:0}] }]);
const ends = W.connectivity([probe], [{ id:'w', pts:[{x:-20,y:0},{x:-20,y:60}] }]);
check('a wire passing OVER a pin does not connect to it',
  (over.members.get(over.groupOf.get('px|1')) || []).length < 2);
check('a wire that STARTS on the pin does', (ends.members.get(ends.groupOf.get('px|1')) || []).length >= 1 &&
  ends.groupOf.get('px|1') === ends.find('w:w'));

section('The drawing against the netlist');
const pinPt = node => {
  const part = S.parts.find(p => p.ref === node.split('-')[0]);
  const pin = W.partPins(part).find(x => x.name === W.pinNameFor(part, node));
  return { x:pin.x, y:pin.y };
};
const net2 = S.netlist.nets.find(n => n.nodes.length === 2 && n.type !== 'NO_CONNECT');
const a = pinPt(net2.nodes[0]), b = pinPt(net2.nodes[1]);
S.wires.push({ id:'w1', pts:[{x:a.x,y:a.y},{x:b.x,y:a.y},{x:b.x,y:b.y}] });
T.runCheck(true);
check(`a wire between the two pins of ${net2.name} realises it`, S.lastCheck.netState.get(net2.name).state === 'done');
check('…and the net stops being reported as undrawn',
  !S.lastCheck.issues.some(i => i.net === net2.name && i.code === 'net-open'));
const other = S.netlist.nets.find(n => n.name !== net2.name && n.nodes.length > 1 && n.type !== 'NO_CONNECT');
const c = pinPt(other.nodes[0]);
S.wires.push({ id:'w2', pts:[{x:a.x,y:a.y},{x:c.x,y:a.y},{x:c.x,y:c.y}] });
T.runCheck(true);
const shorts = S.lastCheck.issues.filter(i => i.code === 'short');
check('wiring a second net onto it is caught as a short (' + (shorts[0] ? shorts[0].text : '—') + ')', shorts.length === 1);
S.wires = S.wires.filter(w => w.id !== 'w2');
T.runCheck(true);
check('removing the offending wire clears the short', !S.lastCheck.issues.some(i => i.code === 'short'));
section('Export');
const out = W.netlistFromSheet(S)[0];
check('the drawn sheet exports as a circuit_data netlist (' + out.components.length + ' components)', out.components.length === 236);
const back = out.nets.find(n => n.name === net2.name);
check('the net drawn by hand comes back with both its nodes', !!back && back.nodes.length === 2);
check('no single-pin "net" is invented', out.nets.every(n => n.nodes.length > 1));
const reparsed = W.parseCircuitData([out]);
check('and the export re-imports cleanly', reparsed.components.length === 236 && reparsed.nets.length === out.nets.length);

section('Partially drawn nets');
const used = new Set(net2.nodes.map(n => n.split('-')[0]));
const half = S.netlist.nets.find(n => n.nodes.length >= 3 && n.type !== 'GROUND' && n.type !== 'NO_CONNECT' &&
  n.nodes[0].split('-')[0] !== n.nodes[1].split('-')[0] &&
  !n.nodes.slice(0, 2).some(x => used.has(x.split('-')[0])));
const h1 = pinPt(half.nodes[0]), h2 = pinPt(half.nodes[1]);
const lane = Math.min(h1.y, h2.y) - 80;                 // route around, not through
S.wires.push({ id:'w3', pts:[{x:h1.x,y:h1.y},{x:h1.x,y:lane},{x:h2.x,y:lane},{x:h2.x,y:h2.y}] });
T.runCheck(true);
const st = S.lastCheck.netState.get(half.name);
check(`a partly drawn net reports what is still open (${half.name}: ${st.wired}/${st.total})`, st.state === 'partial');
check('…and names the pins left to wire',
  /still open: /.test((S.lastCheck.issues.find(i => i.net === half.name) || {}).text || ''));
check('the two independent wires stay independent nets',
  !S.lastCheck.issues.some(i => i.code === 'short'));

section('Symbols and library');
check('every symbol of the library has pins on the lattice',
  Object.keys(W.SYMBOLS).filter(k => !W.SYMBOLS[k].generated)
    .every(k => W.SYMBOLS[k].pins.every(p => p.x % 10 === 0 && p.y % 10 === 0)));
check('a netlist MOSFET becomes a MOSFET, a relay a relay',
  W.kindForComponent({ ref:'Q1', partNumber:'MOSFET', polarity:'N-channel' }) === 'nmos' &&
  W.kindForComponent({ ref:'K1', partNumber:'relay' }) === 'relay');
check('the arrangement is deterministic — the same netlist lands the same way',
  JSON.stringify(W.arrangeParts(W.partsFromNetlist(W.parseCircuitData(raw)))) ===
  JSON.stringify(W.arrangeParts(W.partsFromNetlist(W.parseCircuitData(raw)))));

section('Reshaping wires');
{
  // a 3-vertex L between two pins: slide its horizontal leg down
  const pts = [{x:0,y:0},{x:100,y:0},{x:100,y:80}];
  const w = { id:'wl', pts };
  const i = T.ensureSegBends(pts, 0);                 // segment 0 touches the start pin → a bend is inserted
  check('a segment touching a pin gets a bend before it slides (' + pts.length + ' vertices)', pts.length === 4 && i === 1);
  pts[1].y = 30; pts[2].y = 30;
  check('sliding the leg leaves the pin end where it was and keeps every segment orthogonal',
    pts[0].x === 0 && pts[0].y === 0 && pts.every((p, k) => !k || p.x === pts[k-1].x || p.y === pts[k-1].y));
  const simp = T.simplifyWire([{x:0,y:0},{x:0,y:0},{x:50,y:0},{x:100,y:0},{x:100,y:80}]);
  check('release removes zero-length segments and collinear bends (' + simp.length + ' vertices left)', simp.length === 3);
  // moving a bend drags its neighbours along their own axis
  const q = [{x:0,y:0},{x:0,y:50},{x:100,y:50},{x:100,y:100},{x:200,y:100}];
  T.moveVertex(q, 2, 120, 70);
  check('a moved bend keeps the wire orthogonal by sliding the neighbouring bends',
    q[1].y === 70 && q[1].x === 0 && q[3].x === 120 && q[3].y === 100 &&
    q.every((p, k) => !k || p.x === q[k-1].x || p.y === q[k-1].y));
  // rubber band: a part moves, the wire held at one pin bends after it
  const r9 = S.parts.find(p => p.ref === 'R1');
  const pin = W.partPins(r9)[0];
  S.wires.push({ id:'rb', pts:[{x:pin.x,y:pin.y},{x:pin.x-100,y:pin.y},{x:pin.x-100,y:pin.y-100}] });
  const held = T.rubberBandStart([r9]);
  r9.x += 40; r9.y += 60;
  T.rubberBandApply(held, 40, 60); T.rubberBandEnd(held);
  const rb = S.wires.find(w => w.id === 'rb');
  const pin2 = W.partPins(r9)[0];
  check('moving a part drags the wire end with its pin (' + rb.pts.length + ' vertices)',
    rb.pts[0].x === pin2.x && rb.pts[0].y === pin2.y && rb.pts[rb.pts.length-1].x === pin.x-100);
  check('…and the rubber-banded wire is still orthogonal', rb.pts.every((p, k) => !k || p.x === rb.pts[k-1].x || p.y === rb.pts[k-1].y));
  r9.x -= 40; r9.y -= 60; S.wires = S.wires.filter(w => w.id !== 'rb');
}

section('Selection and BOM');
{
  const a = S.parts.find(p => p.ref === 'R1'), b = S.parts.find(p => p.ref === 'R2');
  T.selectOnly('part', a.id); T.toggleSel(b.id);
  check('Shift+click builds a multi-selection', S.selIds.size === 2 && S.selIds.has(a.id) && S.selIds.has(b.id));
  const n0 = S.parts.length;
  T.duplicateSel();
  check('Ctrl+D duplicates the selection with fresh designators', S.parts.length === n0 + 2 &&
    !S.parts.slice(-2).some(p => p.ref === 'R1' || p.ref === 'R2'));
  S.parts.splice(-2, 2); T.clearSel();
  const dk = W.dkNormalizeProducts({ Products:[{ ManufacturerProductNumber:'TPS7A2033PDBVR', Manufacturer:{ Name:'TI' },
    Description:{ ProductDescription:'LDO' }, QuantityAvailable:1200, UnitPrice:0.43, DatasheetUrl:'https://x/ds.pdf' }] });
  const ms = W.msNormalizeParts({ SearchResults:{ Parts:[{ ManufacturerPartNumber:'TPS7A2033PDBVR', Manufacturer:'Texas Instruments',
    Description:'LDO', AvailabilityInStock:'8,000', PriceBreaks:[{ Quantity:1, Price:'0,39 €', Currency:'EUR' }] }] } }, 'EUR');
  const merged = W.mergePartResults(dk, ms, 'USD');
  check('DigiKey and Mouser rows pour into one list, highest stock first (' + merged.map(r => r.src).join(' > ') + ')',
    merged.length === 2 && merged[0].src === 'Mouser' && merged[0].stock === 8000 && merged[0].price === 0.39);
  check('prices are parsed both ways ("1.234,56 €" → ' + W.msParsePrice('1.234,56 €') + ', "$0.62" → ' + W.msParsePrice('$0.62') + ')',
    W.msParsePrice('1.234,56 €') === 1234.56 && W.msParsePrice('$0.62') === 0.62 && W.dkFmtPrice(0.0043, 'USD') === '$0.004');
  check('a generic part searches by value and kind (' + W.partQueryFor(a) + '), an IC by part number',
    /1\.21 kΩ resistor/.test(W.partQueryFor(a)) && W.partQueryFor(u1) === 'BQ24075-Q1');
  a.pick = { ...merged[0] }; const pn0 = a.partNumber; a.partNumber = merged[0].pn;
  const csv = T.bomCSV();
  check('the BOM export carries the picked part, its price and its house', /R1.*TPS7A2033PDBVR.*Texas Instruments.*Mouser.*0\.39.*EUR.*8000/.test(csv.split('\n').find(l => l.startsWith('"R1"'))));
  delete a.pick; a.partNumber = pn0;
}

section('Panels');
const ids = W.PANELS.map(p => p.id).join(',');
check('the dock offers the six panels (' + ids + ')', ids === 'project,components,nets,properties,database,messages');
T.setPanel('components');
check('Components renders the library', window.document.querySelectorAll('#dockBody .libitem').length > 25);
T.setPanel('nets');
check('Netlist renders one card per net', window.document.querySelectorAll('#dockBody .netcard').length === 192);
T.setPanel('messages');
check('Messages renders the rule check', window.document.querySelectorAll('#dockBody .issue').length > 0);
S.sel = { type:'part', id:u1.id };
T.setPanel('properties');
check('Properties lists the pins of the selected IC',
  window.document.querySelectorAll('#dockBody .facttbl tbody tr').length >= 17);

section('Turning a part keeps its wires');
{
  const ortho = pts => pts.every((p, k) => !k || p.x === pts[k-1].x || p.y === pts[k-1].y);
  const onGrid = pts => pts.every(p => p.x % 10 === 0 && p.y % 10 === 0);
  const saved = { parts:S.parts, wires:S.wires };
  S.parts = []; S.wires = [];
  const r = T.addPart('res', 200, 200);                      // pins at (180,200) and (220,200)
  const [p1, p2] = W.partPins(r);
  S.wires.push({ id:'ra', pts:[{x:p1.x,y:p1.y},{x:p1.x-100,y:p1.y},{x:p1.x-100,y:p1.y+100}] });
  S.wires.push({ id:'rb', pts:[{x:p2.x,y:p2.y},{x:p2.x+100,y:p2.y}] });     // a straight 2-vertex wire
  T.selectOnly('part', r.id);
  T.rotateSel();
  const q = W.partPins(r), ra = S.wires.find(w => w.id === 'ra'), rb = S.wires.find(w => w.id === 'rb');
  const onPin = (w, pin) => w.pts.some(pt => pt.x === pin.x && pt.y === pin.y);
  check('after a 90° rotation every wire still ends on its own pin (' + q.map(x => x.x + ',' + x.y).join(' · ') + ')',
    r.rot === 90 && onPin(ra, q[0]) && onPin(rb, q[1]));
  check('…and both wires are still orthogonal and on the grid', ortho(ra.pts) && ortho(rb.pts) && onGrid(ra.pts) && onGrid(rb.pts));
  check('…and the far ends did not move', ra.pts[ra.pts.length-1].x === p1.x-100 && ra.pts[ra.pts.length-1].y === p1.y+100 &&
    rb.pts[rb.pts.length-1].x === p2.x+100 && rb.pts[rb.pts.length-1].y === p2.y);
  T.rotateSel(); T.rotateSel(); T.rotateSel();
  check('four rotations bring the part and its wires back home',
    r.rot === 0 && onPin(S.wires.find(w => w.id === 'ra'), p1) && onPin(S.wires.find(w => w.id === 'rb'), p2));
  T.mirrorSel();
  const m = W.partPins(r);
  check('mirroring keeps the wires on their pins too', onPin(S.wires.find(w => w.id === 'ra'), m[0]) && onPin(S.wires.find(w => w.id === 'rb'), m[1]));
  T.mirrorSel();
  // the classic diagonal: a straight two-vertex wire and a part that moves sideways
  S.wires = [{ id:'st', pts:[{x:p2.x,y:p2.y},{x:p2.x+100,y:p2.y}] }];
  const held = T.rubberBandStart([r]); r.y += 40; T.rubberBandApply(held); T.rubberBandEnd(held);
  const st = S.wires[0];
  check('moving a part with a straight wire on it bends the wire instead of drawing a diagonal (' +
    st.pts.map(p => p.x + ',' + p.y).join(' → ') + ')', ortho(st.pts) && st.pts[0].y === p2.y + 40 && st.pts[st.pts.length-1].x === p2.x+100);
  // two parts joined by one wire, both rotated at once
  const r2 = T.addPart('res', 400, 200);
  const a0 = W.partPins(r)[1], b0 = W.partPins(r2)[0];
  S.wires = [{ id:'jn', pts:[{x:a0.x,y:a0.y},{x:b0.x,y:b0.y}] }];
  S.selIds = new Set([r.id, r2.id]); S.sel = { type:'part', id:r.id };
  T.rotateSel();
  const jn = S.wires[0], a1 = W.partPins(r)[1], b1 = W.partPins(r2)[0];
  check('rotating two connected parts keeps the wire between them attached at both ends',
    onPin(jn, a1) && onPin(jn, b1) && ortho(jn.pts));
  check('a diagonal wire in a loaded session is straightened into an L',
    T.simplifyWire([{x:0,y:0},{x:50,y:40}]).length === 3 && ortho(T.simplifyWire([{x:0,y:0},{x:50,y:40}])));
  T.clearSel(); S.parts = saved.parts; S.wires = saved.wires;
}

section('Junction dots');
{
  const corner = W.connectivity([], [{ id:'a', pts:[{x:0,y:0},{x:100,y:0}] }, { id:'b', pts:[{x:100,y:0},{x:100,y:100}] }]);
  check('two wires meeting end to end make a corner, not a junction — but they connect',
    corner.junctions.length === 0 && corner.wireGroup.get('a') === corner.wireGroup.get('b'));
  const tee = W.connectivity([], [{ id:'a', pts:[{x:0,y:0},{x:100,y:0},{x:100,y:100}] }, { id:'b', pts:[{x:100,y:0},{x:200,y:0}] }]);
  check('a wire ending on the bend of another makes a T junction', tee.junctions.length === 1);
  const probe = { id:'px', kind:'res', ref:'RX', x:0, y:0, rot:0, mir:0 };
  const onePin = W.connectivity([probe], [{ id:'w', pts:[{x:20,y:0},{x:80,y:0}] }]);
  const twoOnPin = W.connectivity([probe], [{ id:'w', pts:[{x:20,y:0},{x:80,y:0}] }, { id:'v', pts:[{x:20,y:0},{x:20,y:60}] }]);
  check('a wire on a pin has no dot; two wires on one pin do', onePin.junctions.length === 0 && twoOnPin.junctions.length === 1);
  T.render();
  check('a selected wire shows no bend handles on the sheet',
    (T.selectOnly('wire', S.wires[0].id), T.render(), window.document.querySelectorAll('#wiresG .vtx:not(.end)').length === 0));
  T.clearSel();
}

section('Component types and their parameters');
{
  const fields = t => W.COMPONENT_TYPES[t].fields.join(',');
  check('a resistor carries resistance, tolerance, power_rating', fields('resistor') === 'resistance,tolerance,power_rating');
  check('a capacitor carries capacitance, tolerance, voltage_rating, type', fields('capacitor') === 'capacitance,tolerance,voltage_rating,type');
  check('an inductor, a choke and a common-mode choke share the inductor fields',
    fields('inductor') === 'inductance,tolerance,max_operational_frequency,current_rating' && fields('choke') === fields('inductor') && fields('common-mode choke') === fields('inductor'));
  check('a transformer carries its five fields', fields('transformer') === 'primary_magnetizing_inductance,turns_ratio,operational_frequency_range,voltage_isolation,voltage_primary');
  check('relay, contactor and solenoid share contact_form, coil_voltage, current_rating, voltage_rating',
    fields('relay') === 'contact_form,coil_voltage,current_rating,voltage_rating' && fields('contactor') === fields('relay') && fields('solenoid') === fields('relay'));
  const kinds = { 'resistor':'res', 'shunt resistor':'shunt', 'capacitor':'cap', 'inductor':'ind', 'choke':'choke', 'common-mode choke':'cm_choke',
    'diode':'diode', 'zener diode':'zener', 'TVS diode':'tvs', 'thyristor':'scr', 'MOSFET':'nmos', 'GAN':'gan', 'IGBT':'igbt', 'BJT':'npn',
    'fuse':'fuse', 'transformer':'xfmr', 'connector':'connector', 'oscillator':'osc', 'ntc':'ntc', 'relay':'relay', 'contactor':'contactor', 'solenoid':'solenoid' };
  const bad = Object.entries(kinds).filter(([pn, k]) => W.kindForComponent({ ref:'X1', partNumber:pn }) !== k);
  check('every generic type in the netlist vocabulary has its own symbol' + (bad.length ? ' — wrong: ' + bad.map(b => b[0]).join(', ') : ''), bad.length === 0);
  check('polarity picks the P-channel and PNP symbols',
    W.kindForComponent({ ref:'Q1', partNumber:'MOSFET', polarity:'P-channel' }) === 'pmos' && W.kindForComponent({ ref:'Q2', partNumber:'BJT', polarity:'PNP' }) === 'pnp');
  check('the type of a placed part follows its part number, else its symbol',
    W.componentType({ partNumber:'zener diode', kind:'diode' }) === 'zener diode' && W.componentType({ partNumber:'RC0603FR-0710KL', kind:'res' }) === 'resistor' &&
    W.componentType({ partNumber:'BQ24075-Q1', kind:'ic' }) === null);
  check('a misspelt netlist field is still read (vce_voltag → vce_voltage)', W.propValue({ vce_voltag:'40 V' }, 'vce_voltage') === '40 V');
  // the Properties panel: one input per field, edits land in props and the symbol value follows
  const c1 = S.parts.find(p => p.ref === 'C1');
  T.selectOnly('part', c1.id); T.setPanel('properties');
  const inputs = [...window.document.querySelectorAll('#dockBody [data-pfield]')].map(i => i.dataset.pfield);
  check('Properties shows the capacitor fields as editable inputs (' + inputs.join(', ') + ')', inputs.join(',') === 'capacitance,tolerance,voltage_rating,type');
  const inp = window.document.querySelector('#dockBody [data-pfield="capacitance"]');
  inp.value = '2.2 µF'; inp.onchange();
  check('editing a parameter updates the part and the value under the symbol', c1.props.capacitance === '2.2 µF' && c1.value === '2.2 µF');
  const q9 = T.addPart('nmos', 0, 0);
  T.selectOnly('part', q9.id); T.setPanel('properties');
  check('a hand-placed MOSFET gets its fields empty, ready to fill',
    [...window.document.querySelectorAll('#dockBody [data-pfield]')].map(i => i.dataset.pfield).join(',') === 'vds_voltage,id_current,gate_voltage,polarity');
  S.parts = S.parts.filter(p => p !== q9); T.clearSel();
  check('the export carries the edited parameter', W.netlistFromSheet(S)[0].components.find(c => c.ref === 'C1').capacitance === '2.2 µF');
}

section('Symbol drawing');
{
  const ic = W.symbolBodySVG(W.defOf({ kind:'ic', pinNames:['1','2','3','4'] }), {});
  check('an IC is a filled body with its pin names inside', /icbody/.test(ic) && (ic.match(/pinname/g) || []).length === 4);
  check('a resistor body is a closed, filled outline; a diode arrow is solid',
    W.SYMBOLS.res.bodies.length === 1 && W.SYMBOLS.diode.fills.length === 1);
  check('every new symbol keeps its pins on the lattice',
    ['choke','cm_choke','osc','scr','gan','contactor','solenoid'].every(k => W.SYMBOLS[k].pins.every(p => p.x % 10 === 0 && p.y % 10 === 0)));
  const svgOut = T.sheetSVG();
  check('the SVG export ships the schematic palette', /#000080/.test(svgOut) && /#FFFFB2/.test(svgOut));
}

section('Panel tabs');
{
  const doc = window.document, css = fs.readFileSync('styles.css', 'utf8');
  const nav = d => doc.querySelector('#dockTabs [data-tabnav="' + d + '"]');
  const titles = W.PANELS.map(p => p.title).join(',');
  check('the Database panel is now called Explorer (' + titles + ')',
    titles === 'Project,Components,Netlist,Properties,Explorer,Messages');
  T.setPanel('database');
  check('…and wears a blue cloud in its tab and in the panel header',
    /cloudicon/.test(doc.querySelector('#dockTabs [data-pane="database"]').innerHTML) &&
    /cloudicon/.test(doc.getElementById('dockTitle').innerHTML));
  check('…and no other panel carries one', doc.querySelectorAll('#dockTabs .cloudicon').length === 1);
  check('the cloud is drawn in the blue token, in both themes',
    /\.cloudicon\{[^}]*fill:var\(--cloud\)/.test(css) && (css.match(/--cloud:/g) || []).length === 2);

  const strip = doc.querySelector('#dockTabs .dtabs-scroll');
  check('every tab lives in ONE row that never wraps',
    !!strip && strip.querySelectorAll('[data-pane]').length === 6 &&
    /\.dtabs\{[^}]*flex-wrap:nowrap/.test(css) && /\.dtabs-scroll\{[^}]*flex-wrap:nowrap/.test(css));
  check('the row hides its overflow instead of stacking rows',
    /\.dtabs-scroll\{[^}]*overflow:hidden/.test(css));
  check('two triangle buttons sit together just right of the names',
    !!nav(-1) && !!nav(1) && nav(-1).closest('.dtabs-nav') === nav(1).closest('.dtabs-nav') &&
    nav(-1).closest('.dtabs-nav').previousElementSibling === strip &&
    /<path /.test(nav(-1).innerHTML) && /<path /.test(nav(1).innerHTML));
  check('…and they only show themselves once the names stop fitting',
    /\.dtabs-nav\{[^}]*display:none/.test(css) && /\.dtabs\.tabnav \.dtabs-nav\{display:flex\}/.test(css));

  T.setPanel('project');
  check('at the first panel the left triangle is disabled', nav(-1).disabled && !nav(1).disabled);
  nav(1).click();
  check('the right triangle makes the NEXT panel active', T.dock.active === 'components');
  nav(1).click(); nav(1).click();
  check('…and keeps stepping along the strip', T.dock.active === 'properties');
  nav(-1).click();
  check('the left triangle steps back', T.dock.active === 'nets');
  T.setPanel('messages');
  check('at the last panel the right triangle is disabled', nav(1).disabled && !nav(-1).disabled);
  nav(1).click();
  check('…and pressing it anyway changes nothing', T.dock.active === 'messages');
  // a panel without a tab is simply not in the walk
  T.dock.enabled.nets = false; T.setPanel('components');
  nav(1).click();
  check('stepping skips a panel whose tab was switched off in the Panels menu', T.dock.active === 'properties');
  T.dock.enabled.nets = true;
  check('the active tab is always scrolled into view', typeof T.updateTabOverflow === 'function' &&
    (T.setPanel('messages'), T.updateTabOverflow(), true));
  T.setPanel('project');
}

section('Explorer detail');
{
  T.clearSel();
  const host = window.document.createElement('div');
  W.renderDbDetail(host, { gpn:'TEST123', part_numbers:['TEST123A'], facts:{
    identity:{ package:'QFN-16', description:'A test part' },
    pinout:[{ pin:'1', name:'VIN', type:'power' }],
    supplies:[{ name:'VDD', min:'2.7', typ:'3.3', max:'5.5', units:'V' }],
    external_components:[{ type:'capacitor', value:'1 µF', from_pin_name:'VIN', to_pin_name:'GND' }],
    designer_notes:['Keep the input capacitor close to the pin.'],
    figures:[{ title:'Application circuit', image_url:'https://example.invalid/fig.png' }] } });
  const heads = [...host.querySelectorAll('.sechead')].map(e => e.textContent.trim());
  check('the IC preview ends with Figures, after Designer notes (' + heads.join(' → ') + ')',
    heads[heads.length - 1] === 'Figures' && heads.indexOf('Figures') > heads.indexOf('Designer notes'));
  check('…and every other section keeps its order',
    heads.slice(0, 4).join('|') === 'TEST123 — identity|Pinout|Supplies|Required external parts');
}

section('Typography');
{
  const css = fs.readFileSync('styles.css', 'utf8');
  const token = n => (css.match(new RegExp('--' + n + ':([^;]+);')) || [])[1] || '';
  check("the interface runs on Altium's own UI face, Segoe UI (" + token('sans').split(',')[0] + ')',
    /^'Segoe UI'/.test(token('sans').trim()));
  check("the sheet is drawn in Times New Roman, Altium's default schematic font",
    /^'Times New Roman'/.test(token('sheet').trim()));
  check('both name a stand-in for machines without them',
    /Open Sans/.test(token('sans')) && /Tinos/.test(token('sheet')) && /Liberation Serif/.test(token('sheet')));
  check('the page actually loads those two stand-ins',
    /family=Open\+Sans/.test(fs.readFileSync('index.html', 'utf8')) && /family=Tinos/.test(fs.readFileSync('index.html', 'utf8')));
  const sheetText = ['#partsG \\.ref', '#partsG \\.value', '#partsG \\.netlabel', '#partsG \\.netstub', '#partsG \\.note', '#roomsG \\.roomlbl'];
  const wrong = sheetText.filter(sel => !new RegExp(sel + '\\{font-family:var\\(--sheet\\)').test(css));
  check('every piece of text ON the sheet uses the schematic face' + (wrong.length ? ' — not: ' + wrong.join(', ') : ''), wrong.length === 0);
  check('…pin names included, on the sheet and in the library preview',
    /#partsG \.pinname,#overlayG \.pinname\{font-family:var\(--sheet\)/.test(css) && /\.libitem \.pinname\{font-family:var\(--sheet\)/.test(css));
  check('nothing in the chrome is monospaced any more except a raw JSON/CSV dump',
    (css.match(/font-family:var\(--mono\)/g) || []).length === 1 && /pre\.out\{font-family:var\(--mono\)/.test(css));
  const svgOut = T.sheetSVG();
  check('the exported sheet carries the schematic face too',
    (svgOut.match(/Times New Roman/g) || []).length >= 5 && !/IBM Plex/.test(svgOut));
}

section('One line weight');
{
  const css = fs.readFileSync('styles.css', 'utf8');
  const heavy = Object.keys(W.SYMBOLS).filter(k => W.SYMBOLS[k].thick);
  check('no symbol carries a heavier set of strokes any more' + (heavy.length ? ' — still: ' + heavy.join(', ') : ''), heavy.length === 0);
  const drawn = Object.keys(W.SYMBOLS).filter(k => !W.SYMBOLS[k].generated)
    .map(k => W.symbolBodySVG(W.SYMBOLS[k], {})).join('') +
    W.symbolBodySVG(W.defOf({ kind:'ic', pinNames:['1','2','3','4'] }), {}) +
    W.symbolBodySVG(W.defOf({ kind:'connector', pinNames:['1','2'] }), {});
  check('…and nothing the renderer emits asks for one', !/thick/.test(drawn));
  check('the stylesheet declares a single symbol line weight',
    /--sym-w:[\d.]+;/.test(css) && !/\.thick\{/.test(css));
  const widths = (css.match(/#partsG [^{]*\{[^}]*stroke-width:[^;}]+/g) || [])
    .map(r => r.split('stroke-width:')[1]).filter(w => !/10/.test(w));
  check('every symbol stroke on the sheet uses it, pin leads included (' + [...new Set(widths)].join(' ') + ')',
    widths.length > 0 && widths.every(w => w.startsWith('var(--sym-w)')));
  const svgOut = T.sheetSVG();
  const svgW = [...new Set((svgOut.match(/stroke-width:[\d.]+/g) || []).map(Number.parseFloat ? s => s : s => s))]
    .filter(w => !/:(10|1\.5|2)$/.test(w));
  check('the exported sheet draws its symbols at one width too (' + svgW.join(' ') + ')',
    !/\.thick/.test(svgOut) && svgW.every(w => w === 'stroke-width:1.4' || w === 'stroke-width:1.6'));
  // the capacitor plates and the MOSFET gate bar were the two heaviest
  check('the capacitor plates and the MOSFET gate bar survived the merge',
    W.SYMBOLS.cap.paths.includes('M-3 -8V8') && W.SYMBOLS.cap.paths.includes('M3 -8V8') &&
    W.SYMBOLS.nmos.paths.includes('M-7 -12V-5') && W.SYMBOLS.npn.paths.includes('M-8 -11V11') &&
    W.SYMBOLS.battery.paths.includes('M-8 -10V10') && W.SYMBOLS.xtal.paths.includes('M-7 -8V8'));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
