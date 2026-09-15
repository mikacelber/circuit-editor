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
window.eval(['symbols.js', 'netlist.js', 'db.js', 'panels.js', 'app.js']
  .map(f => fs.readFileSync(f, 'utf8')).join('\n;\n') + `
  window.__T = { SYMBOLS, PANELS, defOf, partPins, partBounds, kindForComponent, pinNameFor,
    connectivity, checkDesign, netlistFromSheet, parseCircuitData, partsFromNetlist, arrangeParts, DB };`);
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

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
