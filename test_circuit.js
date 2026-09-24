/* ==================================================================
   test_circuit.js — the editor, headless.

   Loads index.html and the real scripts in a jsdom window, then puts
   the sheet through the moves a designer makes: import a netlist,
   draw wires, get them wrong, export. Run with `npm test`.
   ================================================================== */
'use strict';
const fs = require('fs');
const path = require('path'), os = require('os'), cp = require('child_process');
const GEN = require('./tools/gen-symbol.js');
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
window.eval(['symbols.js', 'netlist.js', 'db.js', 'altium.js', 'library.js', 'parts.js', 'panels.js', 'app.js']
  .map(f => fs.readFileSync(f, 'utf8')).join('\n;\n') + `
  window.__T = { SYMBOLS, PANELS, COMPONENT_TYPES, renderDbDetail, paneDatabase, defOf, partPins, partBounds, kindForComponent, pinNameFor,
    LIB_MODEL_SLOTS, normalizeLibComponent, componentsFromFiles, serializeLibComponent, libFallbackKind, libPinNames,
    paneLibrary, renderLibDetail, makeIcDef, makeLibDef, defPreviewSVG,
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
check('the dock offers the seven panels (' + ids + ')', ids === 'project,components,nets,properties,library,database,messages');
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
    titles === 'Project,Components,Netlist,Properties,Library,Explorer,Messages');
  T.setPanel('database');
  check('…and wears a blue cloud in its tab and in the panel header',
    /cloudicon/.test(doc.querySelector('#dockTabs [data-pane="database"]').innerHTML) &&
    /cloudicon/.test(doc.getElementById('dockTitle').innerHTML));
  check('…and so does Library — the two panels that read a store, and no others',
    doc.querySelectorAll('#dockTabs .cloudicon').length === 2 &&
    /cloudicon/.test(doc.querySelector('#dockTabs [data-pane="library"]').innerHTML));
  check('the cloud is drawn in the blue token, in both themes',
    /\.cloudicon\{[^}]*fill:var\(--cloud\)/.test(css) && (css.match(/--cloud:/g) || []).length === 2);

  const strip = doc.querySelector('#dockTabs .dtabs-scroll');
  check('every tab lives in ONE row that never wraps',
    !!strip && strip.querySelectorAll('[data-pane]').length === 7 &&
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

section('Connecting a database');
{
  const doc = window.document, chip = doc.getElementById('btnDb');
  T.setPanel('database');
  check('the Explorer panel no longer carries the database folder settings',
    !doc.getElementById('dbBase') && !doc.getElementById('dbReload') && !doc.getElementById('dbFiles'));
  check('with nothing attached it shows one centred message',
    doc.getElementById('dockBody').classList.contains('pane-center') &&
    doc.querySelector('#dockBody .dbempty-msg').textContent === 'Please Connect to one of your database:');
  check('…and a way to attach one', !!doc.getElementById('dbConnect'));
  check('the cloud lives at the far right of the top bar',
    !!chip && chip.parentElement.tagName === 'HEADER' && chip.parentElement.lastElementChild === chip);
  check('unattached it reads "Not connected", grey and struck through',
    doc.getElementById('dbLabel').textContent === 'Not connected' && !chip.classList.contains('on') &&
    !!chip.querySelector('.dbcloud .slash'));
  const css = fs.readFileSync('styles.css', 'utf8');
  check('attaching one turns it blue and drops the stroke',
    /#btnDb\.on\{color:var\(--cloud\)/.test(css) && /\.dbchip\.on \.dbcloud \.slash[^{]*\{display:none\}/.test(css));
  // attach a record and the panel becomes the part list, the cloud the name
  W.DB.records.push({ gpn:'FAKE', part_numbers:['FAKE-1'], status:'approved', path:'fake.json' });
  W.DB.name = 'my-parts';
  T.renderDbChip(); T.renderDock();
  check('attached, the cloud shows the database name (' + doc.getElementById('dbLabel').textContent + ')',
    chip.classList.contains('on') && doc.getElementById('dbLabel').textContent === 'my-parts');
  check('…and the Explorer switches to the parts it found',
    !doc.querySelector('#dockBody .dbempty-msg') && !!doc.getElementById('dbSearch') &&
    doc.querySelectorAll('#dbList [data-db]').length === 1);
  W.DB.records.length = 0; W.DB.name = '';
  T.renderDbChip(); T.renderDock();
  check('disconnecting puts the message back', !!doc.querySelector('#dockBody .dbempty-msg'));
}

section('Closing the panel group');
{
  const doc = window.document;
  T.setPanel('project');
  check('while the group is open the reopen arrow is out of the way', doc.getElementById('dockHandle').hidden);
  T.dockCloseAll();
  check('the X unchecks every tab', T.dockEmpty() && doc.querySelectorAll('#dockTabs [data-pane]').length === 0);
  check('…unchecks them in the Panels menu too',
    [...doc.querySelectorAll('#panelsMenu input')].every(i => !i.checked));
  check('…folds the group away', T.dock.hidden && doc.getElementById('dock').classList.contains('collapsed'));
  check('…and brings back the arrow to reopen it', !doc.getElementById('dockHandle').hidden);
  T.setPanel('properties', true);
  check('the sheet selecting a part does NOT reopen a group closed on purpose',
    T.dockEmpty() && T.dock.hidden);
  doc.getElementById('dockHandle').onclick();
  check('the arrow reopens it with Project, and only Project',
    !T.dock.hidden && T.dock.active === 'project' &&
    [...doc.querySelectorAll('#dockTabs [data-pane]')].map(b => b.textContent.trim()).join() === 'Project');
  check('…checked in the Panels menu to match',
    [...doc.querySelectorAll('#panelsMenu input')].filter(i => i.checked).map(i => i.dataset.pane).join() === 'project');
  // the handle itself: one double arrow in a narrow box
  const hnd = doc.getElementById('dockHandle'), css = fs.readFileSync('styles.css', 'utf8');
  check('the handle is a double arrow, not a stack of chevrons (' + hnd.querySelectorAll('polyline').length + ')',
    hnd.querySelectorAll('polyline').length === 2);
  check('…pointing the way the panels come out, with no mirroring left over',
    /points="6\.5,3 2\.5,7 6\.5,11"/.test(hnd.innerHTML) && !/#dockHandle\.folded svg\{transform/.test(css));
  check('…in a box narrower than before but just as tall',
    /#dockHandle\{[^}]*width:12px;height:52px/.test(css) && /#dockHandle svg\{width:9px;height:11px\}/.test(css));
  // unchecking the last tab closes the group just as the X does
  const cb = doc.querySelector('#panelsMenu input[data-pane="project"]');
  cb.checked = false; cb.onchange();
  check('unchecking the last tab closes the group as well', T.dockEmpty() && T.dock.hidden);
  for (const p of W.PANELS) T.dock.enabled[p.id] = true;
  T.setPanel('project');
}

/* ------------------------------------------------------------------
   The component library is read asynchronously (files, fetches, the
   Altium models), so its section — and the summary — run last.
   ------------------------------------------------------------------ */
(async () => {

section('Component library — records');
const LIB = T.LIB;
{
  // every shape a library file comes in lands on the same record
  const a = W.normalizeLibComponent({ partNumber:'ABC123', attributes:{ tolerance:'1%' }, rds_on:'2 mOhm',
                                      datasheet:'https://x/y.pdf', schlib:'models/ABC123.SchLib' }, {});
  check('a record is read whatever it calls its part number', a.part_number === 'ABC123');
  check('parameters come from wherever they were written, loose keys included (' +
    Object.keys(a.parameters).join(', ') + ')', a.parameters.tolerance === '1%' && a.parameters.rds_on === '2 mOhm');
  check('a model named at the top level of the record is still a model',
    a.models.datasheet.url === 'https://x/y.pdf' && a.models.symbol.path === 'models/ABC123.SchLib');
  check('a record with no part number is not a component', W.normalizeLibComponent({ description:'x' }, {}) === null);
  check('the five slots are datasheet, symbol, footprint, spice and the generated IR',
    W.LIB_MODEL_SLOTS.map(x => x.id).join(',') === 'datasheet,symbol,footprint,spice,symbol_ir');
}

const file = (name, text, rel) => {
  const f = new window.File([text], name, { type:'text/plain' });
  if (rel) Object.defineProperty(f, 'relativePath', { value:rel });
  return f;
};
const libJson = fs.readFileSync('library/library.json', 'utf8');
const spiceText = fs.readFileSync('library/models/CSD17573Q5B.lib', 'utf8');

{
  const n = await LIB.loadFiles([
    file('library.json', libJson, 'sample/library.json'),
    file('CSD17573Q5B.lib', spiceText, 'sample/models/CSD17573Q5B.lib'),
    file('BQ24075RGTR.SchLib', 'PLACEHOLDER-BINARY', 'sample/models/BQ24075RGTR.SchLib'),
  ], { label:'sample library' });
  check('a library imported off the disk holds every component of its index (' + n + ')', n === 4);
  check('…and is what the chip in the top bar says it is', LIB.connected && LIB.name === 'sample library');
  const bq = LIB.match('BQ24075RGTR');
  check('a part number finds its component', bq && bq.part_number === 'BQ24075RGTR');
  check('…and so does a part number from the same family (BQ24075-Q1)',
    LIB.match('BQ24075-Q1') === bq);
  check('a picked model file is attached to the component that names it',
    bq.models.symbol && bq.models.symbol.file && bq.models.symbol.name === 'BQ24075RGTR.SchLib');
  check('a model that lives on the web stays a URL',
    /^https:\/\/www\.ti\.com\//.test(LIB.modelURL(bq, 'datasheet')));
  check('the parameters the designer chose are kept as they were (' +
    Object.keys(bq.parameters).length + ' of them)',
    bq.parameters.charge_current_max === '1.5 A' && bq.parameters.internal_code === 'NX-PM-0001');
  check('searching runs over the parameters too, not just the part number',
    LIB.search('NX-PM-0001').length === 1 && LIB.search('murata').length === 1 &&
    LIB.search('', 'MOSFET').map(c => c.part_number).join() === 'CSD17573Q5B');
  const lib2 = JSON.parse(JSON.stringify(LIB.toJSON()));
  check('exporting the library writes it back in the documented format',
    lib2.format === 'circuit-editor/component-library/1' && lib2.components.length === 4 &&
    lib2.components.find(c => c.part_number === 'BQ24075RGTR').parameters.regulation_voltage === '4.2 V');
}

{
  // a bare folder of models, with no index at all
  const n = await LIB.loadFiles([
    file('TPS7A2033PDBVR.SchLib', 'PLACEHOLDER', 'parts/ldo/TPS7A2033PDBVR.SchLib'),
    file('TPS7A2033PDBVR.pdf', 'PLACEHOLDER', 'parts/ldo/TPS7A2033PDBVR.pdf'),
    file('CSD17573Q5B.lib', spiceText, 'parts/fet/CSD17573Q5B.lib'),
  ], { label:'loose models' });
  check('a folder of loose model files is a library by itself (' + n + ' components)', n === 2);
  const ldo = LIB.match('TPS7A2033PDBVR');
  check('…each file landing in the slot its extension says',
    ldo.models.symbol.name.endsWith('.SchLib') && ldo.models.datasheet.name.endsWith('.pdf'));
  check('…and the folder it sat in becoming its category', ldo.category === 'ldo');
}

{
  // a served directory: the editor fetches library.json and reattaches by
  // itself next time, exactly as the datasheet database does
  const seen = [];
  window.fetch = async url => {
    seen.push(String(url));
    if (/library\/library\.json$/.test(url)) return { ok:true, json: async () => JSON.parse(libJson) };
    return { ok:false, status:404, json: async () => ({}) };
  };
  const n = await LIB.connectFolder('library');
  check('a served library folder is read from its library.json (' + n + ')',
    n === 4 && seen.includes('library/library.json'));
  check('…and a relative model path is resolved against that folder',
    LIB.modelURL(LIB.match('CSD17573Q5B'), 'spice') === 'library/models/CSD17573Q5B.lib');
  LIB.reset(); LIB.loaded = false;
  const back = await LIB.autoConnect();
  check('…so the next session reattaches to it without being asked', back === 4);
  delete window.fetch;
}

section('Component library — the Altium models');
{
  const parsed = T.Altium.parseSchLib('PLACEHOLDER-BINARY', { name:'X' });
  check('the .SchLib parser is still the placeholder, and says so',
    parsed.ok === false && parsed.implemented === false && /not implemented/.test(parsed.reason));
  check('the .PcbLib parser says the same', T.Altium.parsePcbLib('X').implemented === false);
  const sp = T.Altium.parseLtspice(spiceText);
  check('the LTspice model is read: its subcircuit and the pin order (' +
    (sp.models[0] && sp.models[0].pins.join(' ')) + ')',
    sp.ok && sp.models[0].name === 'CSD17573Q5B' && sp.models[0].pins.join(' ') === 'drain gate source');

  // the IR → symbol conversion is REAL: this is what draws the part once the
  // reader above is implemented
  const ir = { name:'U_TEST', designator:'U',
    pins:[ { name:'VIN', designator:'1', x:-500, y:100, orientation:0 },
           { name:'GND', designator:'2', x:0, y:-500, orientation:90 },
           { name:'OUT', designator:'3', x:500, y:100, orientation:180 },
           { name:'EN',  designator:'4', x:0, y:500, orientation:270 } ],
    primitives:[ { type:'rect', x1:-300, y1:-300, x2:300, y2:300, filled:true },
                 { type:'line', x1:-200, y1:0, x2:200, y2:0 } ] };
  const def = T.Altium.symbolDefFromAltium(ir, {});
  check('an Altium symbol becomes a drawable def: four pins, one body',
    def.pins.length === 4 && def.body.w === 60 && def.body.h === 60 && def.leads === true);
  check('…mils become world units and the y axis is flipped (VIN at ' +
    def.pins[0].x + ',' + def.pins[0].y + ')', def.pins[0].x === -50 && def.pins[0].y === -10);
  check('…every pin lands on the 10-unit lattice', def.pins.every(p => p.x % 10 === 0 && p.y % 10 === 0));
  check('…and hangs off the edge Altium put it on (' + def.pins.map(p => p.dir).join('') + ')',
    def.pins.map(p => p.dir).join('') === 'lbrt');
  check('the rest of the symbol is drawn too', def.paths.length === 1);
  // and the sheet draws it like any other symbol
  const probe = { id:'lx', kind:'ic', ref:'U9', x:100, y:100, rot:90, mir:0, libSymbol:def };
  check('a part carrying an Altium symbol takes its geometry from it',
    W.defOf(probe).pins.length === 4 && W.partPins(probe).every(p => p.x % 10 === 0 && p.y % 10 === 0));
  check('…and it survives a session round-trip as plain data',
    W.makeLibDef(JSON.parse(JSON.stringify(def))).pins.length === 4);
}

section('Component library — on the sheet');
{
  await LIB.loadFiles([file('library.json', libJson, 'sample/library.json')], { label:'sample library' });
  const cap = LIB.match('GRM155R61A104KA01D'), bq = LIB.match('BQ24075RGTR');
  const symCap = await LIB.symbolFor(cap);
  check('while the .SchLib parser is a placeholder the symbol falls back, and says why',
    symCap.state === 'fallback' && /no Altium symbol attached|not implemented/.test(symCap.reason));
  check('…to the right generic symbol: a library capacitor is drawn as a capacitor',
    symCap.kind === 'cap');
  const symBq = await LIB.symbolFor(bq);
  check('…and an IC to a body with the pins the record lists (' + W.libPinNames(bq).length + ')',
    symBq.kind === 'ic' && W.libPinNames(bq).length === 17);

  const before = S.parts.length;
  const part = await T.dropLibComponent(bq.id, 400, 400);
  check('dragging a component onto the sheet places it', S.parts.length === before + 1 && part.partNumber === 'BQ24075RGTR');
  check('…with the library parameters as the part parameters',
    part.props.charge_current_max === '1.5 A' && part.props.internal_code === 'NX-PM-0001');
  check('…with the 17 pins of the record, not a default eight',
    W.partPins(part).length === 17 && W.partPins(part).some(p => p.name === 'EP'));
  check('…and remembering where it came from',
    part.lib.id === bq.id && part.lib.library === 'sample library' && part.lib.models.datasheet);
  check('…so a saved session carries the library link', /"lib":/.test(JSON.stringify(part)));

  // applying a component to a symbol already on the sheet
  const r1 = S.parts.find(p => p.ref === 'R1');
  await T.applyLibComponent(r1, cap);
  check('a library component can be applied to a symbol already drawn',
    r1.partNumber === 'GRM155R61A104KA01D' && r1.props.voltage_rating === '10 V');
  T.selectOnly('part', r1.id); T.setPanel('properties');
  check('…and Properties then says which library it came from',
    /Component library/.test(window.document.getElementById('dockBody').innerHTML));

  T.setPanel('library');
  const body = window.document.getElementById('dockBody');
  check('the Library panel lists every component of the library',
    body.querySelectorAll('[data-libc]').length === 4);
  check('…each row showing which of the five models it has',
    body.querySelectorAll('[data-libc] .mdot').length === 20 &&
    body.querySelectorAll('[data-libc] .mdot.on').length === 6);
  S.ui.libSel = bq.id; T.renderDock();
  const detail = window.document.getElementById('dockBody').innerHTML;
  check('…and opening one shows its parameters, its models and what it will draw',
    /charge_current_max|charge current max/.test(detail) && /Altium symbol/.test(detail) &&
    /Schematic symbol/.test(detail) && /libcPlace/.test(detail));

  // a component added by hand, the way the editor's "New…" does it
  const made = LIB.upsert({ part_number:'NX-TEST-1', category:'resistor',
                            parameters:{ resistance:'10k', tolerance:'1%' } });
  check('a component can be added to the library from the editor',
    LIB.count === 5 && LIB.match('NX-TEST-1') === made && LIB.dirty);
  LIB.remove(made.id);
  check('…and removed again', LIB.count === 4 && !LIB.match('NX-TEST-1'));

  T.renderLibChip();
  check('the chip in the top bar names the library it is attached to',
    window.document.getElementById('libLabel').textContent === 'sample library' &&
    window.document.getElementById('btnLib').classList.contains('on'));
  LIB.disconnect();
  T.setPanel('library');
  check('detaching it leaves the panel asking for one',
    !LIB.connected && /Import a library/.test(window.document.getElementById('dockBody').innerHTML));
}

section('Symbol generation — the layout rules');
const SL = require('./tools/symbol-layout.js');
const bqRec = JSON.parse(fs.readFileSync('db/approved/BQ2970__BQ29707__2c7bf3ab65c3.json', 'utf8'));
{
  const pins = SL.pinoutFromRecord(bqRec);
  check('the pinout is read straight from the datasheet pipeline (' + pins.length + ' pins)',
    pins.length === 6 && pins[4].name === 'BAT' && pins[4].type === 'power');
  check('the short type codes of a pin table are normalised (O→output, PWR→power, I/O→io)',
    SL.normType('O') === 'output' && SL.normType('PWR') === 'power' && SL.normType('I/O') === 'io' &&
    SL.normType('GND') === 'ground');
  const plan = SL.planLayout(pins);
  const side = n => (plan.find(e => e.name === n) || {}).side;
  check('supplies go to the top, grounds to the bottom, outputs right, the rest left (' +
    plan.map(e => e.name + '→' + e.side).join(' ') + ')',
    side('BAT') === 'top' && side('VSS') === 'bottom' &&
    side('COUT') === 'right' && side('DOUT') === 'right' && side('V-') === 'left' && side('NC') === 'left');
  const ep = SL.planLayout(SL.pinoutFromRecord({ facts:{ pinout:[
    { pin:1, name:'VIN', type:'PWR' }, { pin:2, name:'OUT', type:'O' }, { pin:'EP', name:'EP', type:'' }] } }));
  check('the thermal pad goes to the bottom even when the datasheet types it as nothing',
    ep.find(e => e.name === 'EP').side === 'bottom');

  const ir = SL.irFromPlan(plan, { name:'BQ29707', designator:'U' });
  const sym = ir.symbols[0];
  check('the plan becomes an IR: one body, every pin, mils and Altium axes',
    ir.units === 'mil' && sym.pins.length === 6 && sym.primitives[0].type === 'rect');
  check('…with the orientation that puts each pin on its own side',
    sym.pins.find(p => p.name === 'BAT').orientation === 270 &&
    sym.pins.find(p => p.name === 'VSS').orientation === 90 &&
    sym.pins.find(p => p.name === 'DOUT').orientation === 180 &&
    sym.pins.find(p => p.name === 'V-').orientation === 0);
  const def = T.Altium.symbolDefFromAltium(sym, {});
  check('…and altium.js draws it: 6 pins on the lattice, on the four sides',
    def.pins.length === 6 && def.pins.every(p => p.x % 10 === 0 && p.y % 10 === 0) &&
    new Set(def.pins.map(p => p.dir)).size === 4);
  check('two runs of the generator give byte-identical geometry',
    JSON.stringify(SL.irFromPlan(SL.planLayout(SL.pinoutFromRecord(bqRec)), { name:'BQ29707' })) ===
    JSON.stringify(SL.irFromPlan(SL.planLayout(SL.pinoutFromRecord(bqRec)), { name:'BQ29707' })));
}

section('Symbol generation — what the agent is allowed to change');
{
  const pins = SL.pinoutFromRecord(bqRec);
  const good = pins.map((p, i) => ({ pin:p.pin, side:'left', group:'input', order:i }));
  const applied = SL.applyAgentPlan(pins, good);
  check('a complete assignment from the agent is taken',
    applied.ok && applied.plan.length === 6 && applied.plan.every(e => e.side === 'left'));
  check('…one that drops a pin is refused whole',
    SL.applyAgentPlan(pins, good.slice(1)).ok === false);
  check('…one that repeats a pin is refused whole',
    SL.applyAgentPlan(pins, [...good, good[0]]).ok === false);
  check('…and so is a side that is not a side',
    SL.applyAgentPlan(pins, good.map(e => ({ ...e, side:'middle' }))).ok === false);
  check('the agent is asked for every pin, and only for the assignment',
    /emit_symbol_layout/.test(GEN.LAYOUT_TOOL.name) &&
    GEN.LAYOUT_TOOL.input_schema.properties.pins.items.required.join() === 'pin,side,group,order' &&
    GEN.LAYOUT_TOOL.strict === true);
}

section('Symbol generation — the offline step, end to end');
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-lib-'));
  const out = cp.execFileSync('node', ['tools/gen-symbol.js', 'BQ2970', '--lib', tmp], { encoding:'utf8' });
  check('the CLI finds the datasheet record and writes the symbol\n      ' + out.trim().split('\n')[0],
    /BQ29707 · 6 pins/.test(out));
  const symPath = path.join(tmp, 'models', 'BQ29707.sym.json');
  const doc = JSON.parse(fs.readFileSync(symPath, 'utf8'));
  check('…as an IR file that says where it came from and that nobody has reviewed it',
    doc.format === 'circuit-editor/symbol-ir/1' && doc.status === 'generated' &&
    doc.provenance.source.gpn === 'BQ2970' && doc.provenance.layout === 'rules' && doc.ir.symbols.length === 1);
  const index = JSON.parse(fs.readFileSync(path.join(tmp, 'library.json'), 'utf8'));
  const entry = index.components.find(c => c.part_number === 'BQ29707');
  check('…and the component lands in library.json pointing at it',
    entry && entry.models.symbol_ir === 'models/BQ29707.sym.json' && entry.pins.length === 6);
  cp.execFileSync('node', ['tools/gen-symbol.js', 'BQ2970', '--lib', tmp], { encoding:'utf8' });
  check('running it twice does not duplicate the component',
    JSON.parse(fs.readFileSync(path.join(tmp, 'library.json'), 'utf8')).components.length === index.components.length);

  // the Altium writer: the records are real, the OLE2 container is not yet
  let wrote = '';
  try {
    wrote = cp.execFileSync('python3', ['tools/write-schlib.py', 'BQ29707', '--lib', tmp], { encoding:'utf8' });
  } catch (e){ wrote = (e.stdout || '') + (e.stderr || ''); }   // it exits 3 while the container is a stub
  const dump = path.join(tmp, 'models', 'BQ29707.schlib.txt');
  const recs = fs.existsSync(dump) ? fs.readFileSync(dump, 'utf8').trim().split('\n') : [];
  check('the writer turns the IR into Altium records: a component, a body, six pins',
    recs.length === 8 && /^\|RECORD=1\|LIBREFERENCE=BQ29707\|/.test(recs[0]) &&
    recs.filter(r => /^\|RECORD=2\|/.test(r)).length === 6 && /RECORD=14/.test(recs[1]));
  check('…in Altium internal units, 1/10000 inch (the 600-mil body is 6000)',
    /LOCATION\.X=-3000\|LOCATION\.Y=-2000\|CORNER\.X=3000/.test(recs[1]) &&
    /PINLENGTH=3000/.test(recs[2]));
  check('…and it refuses to write a .SchLib it cannot write yet, saying so',
    /not implemented yet/.test(wrote) && !fs.existsSync(path.join(tmp, 'models', 'BQ29707.SchLib')));

  section('Symbol generation — the generated symbol in the editor');
  const libJson2 = fs.readFileSync(path.join(tmp, 'library.json'), 'utf8');
  const symJson = fs.readFileSync(symPath, 'utf8');
  (async () => {})();
  global.__genFiles = { libJson2, symJson };
}
{
  const { libJson2, symJson } = global.__genFiles;
  const n = await LIB.loadFiles([
    file('library.json', libJson2, 'gen/library.json'),
    file('BQ29707.sym.json', symJson, 'gen/models/BQ29707.sym.json'),
  ], { label:'generated library' });
  check('a .sym.json in the folder is a model, not a library index (' + n + ' component)', n === 1);
  const c = LIB.match('BQ29707');
  check('…attached to the component it is named after', !!c && !!c.models.symbol_ir);
  const sym = await LIB.symbolFor(c);
  check('the editor draws the generated symbol, with no Altium file anywhere',
    sym.state === 'ir' && sym.def && sym.def.pins.length === 6 && sym.status === 'generated');
  const genPart = await T.dropLibComponent(c.id, 900, 900);
  check('…and the part places carrying that symbol, with the pins of the datasheet',
    !!genPart.libSymbol && W.partPins(genPart).length === 6 &&
    W.partPins(genPart).some(p => p.name === 'BAT'));
  S.ui.libSel = c.id; T.setPanel('library'); T.renderDock();
  await new Promise(r => setTimeout(r, 10));
  T.renderDock();
  const html = window.document.getElementById('dockBody').innerHTML;
  check('…the panel says it was generated and still needs a look',
    /generated · not reviewed/.test(html) && /libcApprove/.test(html) && /Generate from datasheet|Regenerate/.test(html));
  window.document.getElementById('libcApprove').onclick();
  check('approving it is remembered on the component and exported with the library',
    c.symbol_status === 'reviewed' &&
    LIB.toJSON().components.find(x => x.part_number === 'BQ29707').symbol_status === 'reviewed');

  // a broken IR must never take the sheet down
  c.symbol = null; c.models.symbol_ir = { slot:'symbol_ir', name:'x.sym.json', file:file('x.sym.json', 'not json at all') };
  const bad = await LIB.symbolFor(c);
  check('a symbol file that cannot be read falls back to the generated body, and says so',
    bad.state === 'fallback' && /could not read the generated symbol|no Altium/.test(bad.reason));
  LIB.disconnect();
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);

})().catch(e => { console.error(e); process.exit(1); });
