/* ==================================================================
   panels.js — the docked panel group.

   One panel fills the dock at a time; the strip at the bottom of the
   dock switches between the ENABLED ones, and the "Panels" button in
   the bottom-right corner of the window decides which panels have a
   tab at all. Altium's model, minus the floating windows.
   ================================================================== */
'use strict';

const PANELS = [
  { id:'project',    title:'Project',    eyebrow:'Design record',        render: paneProject },
  { id:'components', title:'Components', eyebrow:'Symbol library',       render: paneComponents },
  { id:'nets',       title:'Netlist',    eyebrow:'Imported connectivity',render: paneNets },
  { id:'properties', title:'Properties', eyebrow:'Selection',            render: paneProperties },
  { id:'database',   title:'Database',   eyebrow:'GPN datasheets',       render: paneDatabase },
  { id:'messages',   title:'Messages',   eyebrow:'Rule check',           render: paneMessages },
];
const PANEL_DEFAULT = { project:true, components:true, nets:true, properties:true, database:true, messages:true };

const dock = {
  active:'project', enabled:{ ...PANEL_DEFAULT },
  pinned:true, hidden:false, w:340, hideT:null,
  load(){
    try {
      const raw = JSON.parse(localStorage.getItem('dock_state') || '{}');
      if (raw.enabled) this.enabled = { ...PANEL_DEFAULT, ...raw.enabled };
      if (raw.active) this.active = raw.active;
      if (raw.w) this.w = raw.w;
    } catch(e){}
    if (!this.enabled[this.active]) this.active = PANELS.find(p => this.enabled[p.id]) ? PANELS.find(p => this.enabled[p.id]).id : 'project';
  },
  save(){
    try { localStorage.setItem('dock_state', JSON.stringify({ enabled:this.enabled, active:this.active, w:this.w })); } catch(e){}
  },
};

const el = id => document.getElementById(id);
const h = (strings, ...vals) => strings.reduce((a, s, i) => a + s + (vals[i] == null ? '' : vals[i]), '');

/* ---------- dock shell ---------- */
function renderDock(){
  const pane = PANELS.find(p => p.id === dock.active) || PANELS[0];
  el('dockEyebrow').textContent = pane.eyebrow;
  el('dockTitle').textContent = pane.title;
  const body = el('dockBody');
  const keepScroll = body.dataset.pane === pane.id ? body.scrollTop : 0;
  body.dataset.pane = pane.id;
  body.innerHTML = '';
  pane.render(body);
  body.scrollTop = keepScroll;
  renderDockTabs();
}
function renderDockTabs(){
  const tabs = el('dockTabs');
  const badges = { messages: (S.lastCheck && S.lastCheck.issues.filter(i => i.sev !== 'info').length) || 0 };
  tabs.innerHTML = PANELS.filter(p => dock.enabled[p.id]).map(p =>
    `<button data-pane="${p.id}" class="${p.id === dock.active ? 'on' : ''}">${p.title}` +
    (badges[p.id] ? `<span class="badge">${badges[p.id]}</span>` : '') + `</button>`).join('');
  tabs.querySelectorAll('button').forEach(b => b.onclick = () => setPanel(b.dataset.pane));
}
function setPanel(id){
  if (!dock.enabled[id]) dock.enabled[id] = true;
  dock.active = id; dock.save();
  dockShow();
  renderDock();
}
function renderPanelsMenu(){
  const m = el('panelsMenu');
  m.innerHTML = '<div class="pm-title">Panels</div>' + PANELS.map(p =>
    `<label><input type="checkbox" data-pane="${p.id}" ${dock.enabled[p.id] ? 'checked' : ''}> ${p.title}</label>`).join('');
  m.querySelectorAll('input').forEach(cb => cb.onchange = () => {
    const id = cb.dataset.pane;
    dock.enabled[id] = cb.checked;
    if (!Object.values(dock.enabled).some(Boolean)){ dock.enabled[id] = true; cb.checked = true; return; }
    if (!dock.enabled[dock.active]) dock.active = PANELS.find(p => dock.enabled[p.id]).id;
    if (cb.checked) setPanel(id); else { dock.save(); renderDock(); }
  });
}

/* ================================================================
   PROJECT — the fields a reviewer checks before the circuit ships
   ================================================================ */
function paneProject(body){
  const pr = S.project;
  const stats = projectStats();
  const field = (k, label, type) => h`
    <div class="kv"><label>${label}</label>
      ${type === 'area' ? `<textarea data-pf="${k}">${esc(pr[k] || '')}</textarea>`
                        : `<input type="text" data-pf="${k}" value="${esc(pr[k] || '')}">`}</div>`;
  body.innerHTML = h`
    <div class="sechead">Identification</div>
    ${field('title','Title')}
    <div class="row">${field('code','Project code')}${field('revision','Revision')}</div>
    <div class="row">${field('author','Author')}${field('customer','Customer / program')}</div>
    <div class="row">${field('variant','Variant')}${field('status','Status')}</div>
    <div class="sechead">Electrical envelope</div>
    <div class="row">${field('vin','Input voltage')}${field('vout','Output / rails')}</div>
    <div class="row">${field('imax','Max current')}${field('isolation','Isolation')}</div>
    ${field('standards','Standards / compliance')}
    ${field('notes','Notes','area')}
    <div class="sechead">Sheet</div>
    <div class="kv"><label>Netlist</label><div class="val">${esc(S.netlist ? (S.netlist.source || 'imported') : 'none imported')}</div></div>
    <div class="kv"><label>Counts</label><div class="val">
      ${stats.placed} parts placed · ${stats.components} in netlist · ${stats.nets} nets · ${stats.wires} wires</div></div>
    <div class="kv"><label>Netlist realised</label><div class="val">${stats.donePct}% of nets fully wired (${stats.done}/${stats.nets})</div></div>
    <div class="sechead">Verification checklist</div>
    <div id="pjChecks"></div>
    <div class="row" style="margin-top:6px"><input type="text" id="pjNewCheck" placeholder="Add a check…"><button id="pjAddCheck" style="flex:0 0 auto">Add</button></div>
    <div class="sechead">Appearance</div>
    <label class="switch"><input type="checkbox" id="pjTheme" ${document.documentElement.dataset.theme === 'light' ? '' : 'checked'}><span class="knob"></span><span class="swlabel">Dark theme</span></label>
    <label class="switch" style="margin-top:8px"><input type="checkbox" id="pjRooms" ${S.showRooms ? 'checked' : ''}><span class="knob"></span><span class="swlabel">Show functional group outlines</span></label>
    <label class="switch" style="margin-top:8px"><input type="checkbox" id="pjStubs" ${S.showStubs ? 'checked' : ''}><span class="knob"></span><span class="swlabel">Show imported net names on pins</span></label>`;

  body.querySelectorAll('[data-pf]').forEach(inp => {
    inp.onchange = () => { commit(); S.project[inp.dataset.pf] = inp.value; if (inp.dataset.pf === 'title') el('projTitle').textContent = inp.value || 'Untitled circuit'; render(); };
  });
  const checks = el('pjChecks');
  checks.innerHTML = (pr.checklist || []).map((c, i) => h`
    <label class="switch" style="display:flex;margin-bottom:6px">
      <input type="checkbox" data-chk="${i}" ${c.done ? 'checked' : ''}><span class="knob"></span>
      <span class="swlabel" style="flex:1">${esc(c.text)}</span>
      <button data-delchk="${i}" style="flex:0 0 auto;padding:2px 6px;font-size:10px">✕</button></label>`).join('') ||
    '<p style="font-size:11.5px">No checks yet — add the ones this design must pass.</p>';
  checks.querySelectorAll('[data-chk]').forEach(cb => cb.onchange = () => { commit(); S.project.checklist[+cb.dataset.chk].done = cb.checked; renderDock(); });
  checks.querySelectorAll('[data-delchk]').forEach(b => b.onclick = () => { commit(); S.project.checklist.splice(+b.dataset.delchk, 1); renderDock(); });
  el('pjAddCheck').onclick = () => {
    const v = el('pjNewCheck').value.trim(); if (!v) return;
    commit(); (S.project.checklist = S.project.checklist || []).push({ text:v, done:false }); renderDock();
  };
  el('pjTheme').onchange = e => {
    document.documentElement.dataset.theme = e.target.checked ? 'dark' : 'light';
    try { localStorage.setItem('ui_theme', document.documentElement.dataset.theme); } catch(err){}
  };
  el('pjRooms').onchange = e => { S.showRooms = e.target.checked; render(); };
  el('pjStubs').onchange = e => { S.showStubs = e.target.checked; render(); };
}
function projectStats(){
  const nets = (S.netlist && S.netlist.nets) || [];
  const done = S.lastCheck ? [...S.lastCheck.netState.values()].filter(v => v.state === 'done').length : 0;
  return {
    placed: S.parts.filter(p => !(SYMBOLS[p.kind] && SYMBOLS[p.kind].port)).length,
    components: (S.netlist && S.netlist.components.length) || 0,
    nets: nets.length, wires: S.wires.length, done,
    donePct: nets.length ? Math.round(100 * done / nets.length) : 0,
  };
}

/* ================================================================
   COMPONENTS — the symbol library, drag or click to place
   ================================================================ */
function paneComponents(body){
  const q = (S.ui.libQuery || '').toLowerCase();
  const unplaced = unplacedComponents();
  body.innerHTML = h`
    <input type="search" id="libSearch" placeholder="Search symbols…" value="${esc(S.ui.libQuery || '')}">
    <p class="hint">Click a symbol then click the sheet, or drag it straight in. <b>R</b> rotates while placing.</p>
    <div id="libCats"></div>
    <div class="sechead">From the netlist — not placed (${unplaced.length})</div>
    <div id="libUnplaced"></div>`;

  el('libCats').innerHTML = SYM_CATS.map(cat => {
    const kinds = Object.keys(SYMBOLS).filter(k => SYMBOLS[k].cat === cat.id &&
      (!q || k.includes(q) || SYMBOLS[k].label.toLowerCase().includes(q)));
    if (!kinds.length) return '';
    return h`<div class="sechead">${cat.label}</div><div class="libgrid">` + kinds.map(k => h`
      <div class="libitem ${S.place && S.place.kind === k ? 'on' : ''}" draggable="true" data-kind="${k}" title="${esc(SYMBOLS[k].label)}">
        ${symbolPreviewSVG(k)}<span>${esc(SYMBOLS[k].label)}</span></div>`).join('') + '</div>';
  }).join('');
  el('libCats').querySelectorAll('.libitem').forEach(it => {
    it.onclick = () => startPlace(it.dataset.kind);
    it.ondragstart = ev => { ev.dataTransfer.setData('text/symbol', it.dataset.kind); ev.dataTransfer.effectAllowed = 'copy'; };
  });

  el('libUnplaced').innerHTML = unplaced.length ? unplaced.slice(0, 200).map(c => h`
    <button class="lrow" data-place="${esc(c.ref)}">
      <span class="lmain"><span class="lref">${esc(c.ref)}</span>
        <span class="lsub">${esc(c.partNumber)} · ${esc(c.group)}</span></span>
      <span class="ltag">place</span></button>`).join('')
    : '<p style="font-size:11.5px">Every component of the netlist is on the sheet.</p>';
  el('libUnplaced').querySelectorAll('[data-place]').forEach(b => b.onclick = () => placeNetlistComponent(b.dataset.place));
  el('libSearch').oninput = e => { S.ui.libQuery = e.target.value; renderDock(); el('libSearch').focus(); };
}
function unplacedComponents(){
  if (!S.netlist) return [];
  const placed = new Set(S.parts.map(p => (p.ref || '').toUpperCase()));
  return S.netlist.components.filter(c => !placed.has(c.ref));
}

/* ================================================================
   NETLIST — the imported nets, click one to light it up
   ================================================================ */
function paneNets(body){
  const nets = (S.netlist && S.netlist.nets) || [];
  const q = (S.ui.netQuery || '').toLowerCase();
  const filt = S.ui.netFilter || 'all';
  const shown = nets.filter(n => (filt === 'all' || netClass(n.type) === filt) &&
    (!q || n.name.toLowerCase().includes(q) || n.nodes.some(nd => nd.toLowerCase().includes(q))));
  const classes = [...new Set(nets.map(n => netClass(n.type)))].sort();
  body.innerHTML = h`
    <input type="search" id="netSearch" placeholder="Search nets or nodes…" value="${esc(S.ui.netQuery || '')}">
    <div class="row" style="margin-top:8px">
      <select id="netFilter">
        <option value="all">All classes (${nets.length})</option>
        ${classes.map(c => `<option value="${c}" ${filt === c ? 'selected' : ''}>${c} (${nets.filter(n => netClass(n.type) === c).length})</option>`).join('')}
      </select>
    </div>
    <p class="hint">${shown.length} shown · click a net to trace it on the sheet.</p>
    <div id="netList"></div>`;
  el('netList').innerHTML = shown.slice(0, 400).map(n => {
    const st = S.lastCheck && S.lastCheck.netState.get(n.name);
    const badge = !st ? '' : st.state === 'done' ? '<span class="netstate done">wired</span>'
      : st.state === 'partial' ? `<span class="netstate part">${st.wired}/${st.total}</span>` : '';
    return h`<div class="netcard cat-${netClass(n.type)} ${S.traceNet === n.name ? 'on' : ''}" data-net="${esc(n.name)}">
      <div class="nettop"><span class="netname">${esc(n.name)}</span>${badge}<span class="nettype">${esc(n.type)}</span></div>
      <div class="netnodes">${esc(n.nodes.join('  '))}</div></div>`;
  }).join('') || '<p style="font-size:11.5px">Nothing matches.</p>';
  el('netList').querySelectorAll('[data-net]').forEach(c => c.onclick = () => {
    S.traceNet = S.traceNet === c.dataset.net ? null : c.dataset.net;
    if (S.traceNet) focusNet(S.traceNet);
    render(); renderDock();
  });
  el('netSearch').oninput = e => { S.ui.netQuery = e.target.value; renderDock(); el('netSearch').focus(); };
  el('netFilter').onchange = e => { S.ui.netFilter = e.target.value; renderDock(); };
}

/* ================================================================
   PROPERTIES — whatever is selected, editable
   ================================================================ */
function paneProperties(body){
  const sel = S.sel;
  if (!sel){ body.innerHTML = '<p>Nothing selected. Click a part, a wire or a net label on the sheet.</p>'; return; }
  if (sel.type === 'wire'){
    const w = S.wires.find(x => x.id === sel.id);
    if (!w){ body.innerHTML = '<p>That wire is gone.</p>'; return; }
    const len = w.pts.reduce((a, p, i) => i ? a + Math.abs(p.x - w.pts[i-1].x) + Math.abs(p.y - w.pts[i-1].y) : 0, 0);
    body.innerHTML = h`<div class="kv"><label>Object</label><div class="val">Wire</div></div>
      <div class="kv"><label>Vertices</label><div class="val">${w.pts.length}</div></div>
      <div class="kv"><label>Length</label><div class="val">${Math.round(len)} units</div></div>
      <div class="btnrow"><button class="danger" id="wDel">Delete wire</button></div>`;
    el('wDel').onclick = () => { commit(); S.wires = S.wires.filter(x => x.id !== w.id); S.sel = null; render(); renderDock(); };
    return;
  }
  const part = S.parts.find(p => p.id === sel.id);
  if (!part){ body.innerHTML = '<p>That object is gone.</p>'; return; }
  const def = SYMBOLS[part.kind];
  const isPort = !!def.port;
  const rec = part.partNumber ? DB.match(part.partNumber) : null;
  const pinRows = partPins(part).map(pin => {
    const net = S.lastCheck ? S.lastCheck.pinNet.get(part.id + '|' + pin.name) : null;
    const g = S.lastCheck ? S.lastCheck.conn.groupOf.get(part.id + '|' + pin.name) : null;
    const wired = g && (S.lastCheck.conn.members.get(g) || []).length > 1;
    return `<tr><td class="mono">${esc(pin.name)}</td><td class="mono">${esc(net || '—')}</td>
      <td class="mono" style="color:var(--${wired ? 'ok' : 'warn'})">${wired ? 'wired' : 'open'}</td></tr>`;
  }).join('');

  body.innerHTML = h`
    <div class="kv"><label>Symbol</label><div class="val">${esc(def.label)}${part.fromNetlist ? ' · from netlist' : ''}</div></div>
    ${isPort ? h`<div class="kv"><label>${def.port === 'label' ? 'Net label' : def.port === 'note' ? 'Text' : 'Net name'}</label>
        <input type="text" data-pp="${def.port === 'note' ? 'text' : 'net'}" value="${esc(def.port === 'note' ? (part.text || '') : (part.net || def.net || ''))}"></div>`
      : h`<div class="row"><div class="kv"><label>Reference</label><input type="text" data-pp="ref" value="${esc(part.ref || '')}"></div>
          <div class="kv"><label>Value</label><input type="text" data-pp="value" value="${esc(part.value || '')}"></div></div>
        <div class="kv"><label>Part number</label><input type="text" data-pp="partNumber" value="${esc(part.partNumber || '')}"></div>
        <div class="row"><div class="kv"><label>Group</label><input type="text" data-pp="group" value="${esc(part.group || '')}"></div>
          <div class="kv"><label>Role</label><input type="text" data-pp="role" value="${esc(part.role || '')}"></div></div>`}
    <div class="btnrow">
      <button id="ppRot">Rotate 90°</button><button id="ppMir">Mirror</button>
      <button class="danger" id="ppDel">Delete</button>
    </div>
    ${isPort ? '' : h`
      <div class="sechead">Pins (${partPins(part).length})</div>
      <table class="facttbl"><thead><tr><th>Pin</th><th>Imported net</th><th>State</th></tr></thead><tbody>${pinRows}</tbody></table>`}
    ${Object.keys(part.props || {}).length ? h`
      <div class="sechead">Netlist attributes</div>
      <table class="facttbl"><tbody>${Object.entries(part.props).map(([k, v]) =>
        `<tr><td class="mono">${esc(k)}</td><td>${esc(typeof v === 'object' ? JSON.stringify(v) : v)}</td></tr>`).join('')}</tbody></table>` : ''}
    ${rec ? h`<div class="sechead">Datasheet</div>
      <p style="font-size:11.5px">Matched <b>${esc(rec.gpn || '')}</b> in the database.</p>
      <div class="btnrow"><button id="ppDb">Open in Database panel</button></div>` : ''}`;

  body.querySelectorAll('[data-pp]').forEach(inp => inp.onchange = () => {
    commit(); part[inp.dataset.pp] = inp.value;
    if (inp.dataset.pp === 'ref') part.ref = inp.value.toUpperCase();
    render(); renderDock();
  });
  el('ppRot').onclick = () => { commit(); part.rot = ((part.rot || 0) + 90) % 360; render(); renderDock(); };
  el('ppMir').onclick = () => { commit(); part.mir = part.mir ? 0 : 1; render(); renderDock(); };
  el('ppDel').onclick = () => { commit(); deletePart(part.id); renderDock(); };
  if (rec) el('ppDb').onclick = () => { S.ui.dbSel = rec.path || rec.gpn; setPanel('database'); };
}

/* ================================================================
   DATABASE — GPN datasheet extracts, and what they demand
   ================================================================ */
function paneDatabase(body){
  const q = (S.ui.dbQuery || '').toLowerCase();
  const recs = DB.records.filter(r => !q ||
    String(r.gpn || '').toLowerCase().includes(q) ||
    (r.part_numbers || []).some(p => String(p).toLowerCase().includes(q)));
  const sel = DB.records.find(r => (r.path || r.gpn) === S.ui.dbSel);
  body.innerHTML = h`
    <div class="kv"><label>Database folder</label>
      <div class="row"><input type="text" id="dbBase" value="${esc(DB.base)}"><button id="dbReload" style="flex:0 0 auto">Load</button></div></div>
    <p class="hint">Reads <b>${esc(DB.base)}index.json</b>. No server? Pick the JSON files by hand:</p>
    <input type="file" id="dbFiles" multiple accept="application/json" style="font-size:11px">
    ${DB.error ? `<p class="hint" style="color:var(--warn)">index.json: ${esc(DB.error)}</p>` : ''}
    <div class="sechead">Parts (${DB.records.length})</div>
    <input type="search" id="dbSearch" placeholder="Search GPN or part number…" value="${esc(S.ui.dbQuery || '')}">
    <div id="dbList" style="margin-top:8px"></div>
    <div id="dbDetail"></div>`;
  el('dbList').innerHTML = recs.slice(0, 80).map(r => h`
    <button class="lrow ${sel === r ? 'on' : ''}" data-db="${esc(r.path || r.gpn)}">
      <span class="lmain"><span class="lref">${esc(r.gpn || '?')}</span>
        <span class="lsub">${esc((r.part_numbers || []).join(', '))}</span></span>
      <span class="ltag ${r.status === 'approved' ? 'ok' : ''}">${esc(r.status || '')}</span></button>`).join('')
    || '<p style="font-size:11.5px">No records loaded yet.</p>';
  el('dbList').querySelectorAll('[data-db]').forEach(b => b.onclick = async () => {
    S.ui.dbSel = b.dataset.db;
    const rec = DB.records.find(r => (r.path || r.gpn) === S.ui.dbSel);
    try { await DB.fetchRecord(rec); } catch(e){ toast('Could not read ' + rec.path); }
    renderDock();
  });
  el('dbSearch').oninput = e => { S.ui.dbQuery = e.target.value; renderDock(); el('dbSearch').focus(); };
  el('dbBase').onchange = e => DB.setBase(e.target.value);
  el('dbReload').onclick = async () => { await DB.loadIndex(); toast(DB.records.length + ' database records'); renderDock(); };
  el('dbFiles').onchange = async e => { const n = await DB.loadFiles(e.target.files); toast(n + ' records loaded'); renderDock(); };
  if (sel && sel.facts) renderDbDetail(el('dbDetail'), sel);
}

function renderDbDetail(host, rec){
  const f = rec.facts || {};
  const id = f.identity || {};
  const selPart = S.sel && S.sel.type === 'part' ? S.parts.find(p => p.id === S.sel.id) : null;
  const report = selPart ? requiredExternalsReport(rec, selPart, S) : [];
  const figs = (f.figures || []).filter(x => DB.figureURL(rec, x));
  host.innerHTML = h`
    <div class="sechead">${esc(rec.gpn || '')} — identity</div>
    <table class="facttbl"><tbody>
      <tr><td>Part numbers</td><td class="mono">${esc((id.part_numbers || rec.part_numbers || []).join(', '))}</td></tr>
      <tr><td>Package</td><td class="mono">${esc(id.package || '—')}</td></tr>
      <tr><td>Pins</td><td class="mono">${esc(id.pin_count || (f.pinout || []).length || '—')}</td></tr>
      <tr><td>Datasheet</td><td>${rec.source_url ? `<a href="${esc(rec.source_url)}" target="_blank" rel="noreferrer">${esc(rec.manufacturer || 'source')}</a>` : '—'}</td></tr>
    </tbody></table>
    ${id.description ? `<p style="font-size:11.5px;margin-top:8px">${esc(id.description)}</p>` : ''}
    ${(f.pinout || []).length ? h`<div class="sechead">Pinout</div>
      <table class="facttbl"><thead><tr><th>#</th><th>Name</th><th>Type</th></tr></thead><tbody>
      ${f.pinout.map(p => `<tr><td class="mono">${esc(p.pin)}</td><td class="mono">${esc(p.name)}</td><td>${esc(p.type || '')}</td></tr>`).join('')}
      </tbody></table>` : ''}
    ${(f.supplies || []).length ? h`<div class="sechead">Supplies</div>
      <table class="facttbl"><thead><tr><th>Rail</th><th>Min</th><th>Typ</th><th>Max</th></tr></thead><tbody>
      ${f.supplies.map(s => `<tr><td class="mono">${esc(s.name)}</td><td class="mono">${esc(s.min)}</td><td class="mono">${esc(s.typ ?? '—')}</td><td class="mono">${esc(s.max)} ${esc(s.units || '')}</td></tr>`).join('')}
      </tbody></table>` : ''}
    ${(f.external_components || []).length ? h`<div class="sechead">Required external parts${selPart ? ' — checked against ' + esc(selPart.ref) : ''}</div>
      ${selPart ? '' : '<p class="hint">Select the IC on the sheet to check these against the netlist.</p>'}
      <table class="facttbl"><thead><tr><th>Part</th><th>From → to</th><th>${selPart ? 'Found' : 'Value'}</th></tr></thead><tbody>
      ${f.external_components.map((c, i) => {
        const r = report[i];
        const stateCol = !selPart ? esc(c.value || '')
          : r.state === 'present' ? `<span style="color:var(--ok)">${esc(r.found.ref)}</span>`
          : r.state === 'probable' ? `<span style="color:var(--warn)">${esc(r.found.ref)}?</span>`
          : r.state === 'missing' ? '<span style="color:var(--hv)">missing</span>'
          : '<span style="color:var(--ink-soft)">optional</span>';
        return `<tr><td class="mono">${esc(c.type)} ${esc(c.value || '')}</td>
          <td class="mono">${esc(c.from_pin_name)} → ${esc(c.to_pin_name)}</td><td>${stateCol}</td></tr>`;
      }).join('')}</tbody></table>` : ''}
    ${figs.length ? h`<div class="sechead">Figures</div><div class="figgrid">
      ${figs.slice(0, 6).map(x => `<a href="${esc(DB.figureURL(rec, x))}" target="_blank" rel="noreferrer" title="${esc(x.title || '')}"><img loading="lazy" src="${esc(DB.figureURL(rec, x))}" alt="${esc(x.title || '')}"></a>`).join('')}
      </div>` : ''}
    ${(f.designer_notes || []).length ? h`<div class="sechead">Designer notes</div>
      ${f.designer_notes.slice(0, 8).map(n => `<p style="font-size:11.5px">${esc(n)}</p>`).join('')}` : ''}
    ${selPart ? h`<div class="btnrow"><button id="dbAssign">Assign ${esc(rec.gpn)} to ${esc(selPart.ref)}</button></div>` : ''}`;
  if (selPart) el('dbAssign').onclick = () => {
    commit();
    selPart.partNumber = (rec.part_numbers && rec.part_numbers[0]) || rec.gpn;
    toast(selPart.ref + ' → ' + selPart.partNumber); render(); renderDock();
  };
}

/* ================================================================
   MESSAGES — the rule check, every line jumps to the culprit
   ================================================================ */
function paneMessages(body){
  const res = S.lastCheck;
  body.innerHTML = h`
    <div class="btnrow" style="margin-top:0"><button id="msgRun" class="primary">Run check</button>
      <button id="msgClear">Clear</button></div>
    <div id="msgList" style="margin-top:12px"></div>`;
  el('msgRun').onclick = () => { runCheck(); renderDock(); };
  el('msgClear').onclick = () => { S.lastCheck = null; render(); renderDock(); };
  if (!res){ el('msgList').innerHTML = '<p style="font-size:11.5px">No check run yet. The check compares every wire you drew against the imported netlist.</p>'; return; }
  const order = { err:0, warn:1, info:2 };
  const issues = [...res.issues].sort((a, b) => order[a.sev] - order[b.sev]);
  const counts = { err:0, warn:0, info:0 };
  for (const i of issues) counts[i.sev]++;
  el('msgList').innerHTML = h`
    <p style="font-size:11.5px">${counts.err} errors · ${counts.warn} warnings · ${counts.info} notes</p>` +
    (issues.slice(0, 300).map((i, n) => h`
      <button class="issue ${i.sev === 'err' ? 'err' : i.sev === 'info' ? 'info' : ''}" data-issue="${n}">
        ${esc(i.text)}<span class="isrc">${esc(i.code)}</span></button>`).join('') ||
      '<p style="font-size:11.5px;color:var(--ok)">Everything checks out.</p>');
  el('msgList').querySelectorAll('[data-issue]').forEach(b => b.onclick = () => {
    const i = issues[+b.dataset.issue];
    if (i.net){ S.traceNet = i.net; focusNet(i.net); }
    else if (i.partId) focusPart(i.partId);
    else if (i.ref){ const p = S.parts.find(x => (x.ref || '').toUpperCase() === i.ref); if (p) focusPart(p.id); }
    render();
  });
}

/* ---------- dock chrome behaviour (pin / fold / resize) ---------- */
const DOCK_HIDE_MS = 3000, DOCK_MIN_W = 260, DOCK_COLLAPSE_W = 120, DOCK_TINY_W = 40;
function dockSetWidth(w, tiny){
  dock.w = Math.max(tiny ? DOCK_TINY_W : DOCK_MIN_W, Math.min(Math.round(w), Math.round(window.innerWidth * 0.7)));
  const d = el('dock');
  d.style.width = dock.w + 'px';
  d.style.setProperty('--dockw', dock.w + 'px');
}
function dockApply(){
  const d = el('dock'), hnd = el('dockHandle');
  const was = d.classList.contains('collapsed');
  d.classList.toggle('collapsed', dock.hidden);
  hnd.classList.toggle('folded', dock.hidden);
  hnd.title = dock.hidden ? 'Show the panel dock' : 'Hide the panel dock';
  if (was !== dock.hidden) setTimeout(render, 240);
}
function dockShow(){ dock.hidden = false; dockApply(); }
function dockHide(){
  if (dock.pinned) return;
  if (S.sel) return;
  const d = el('dock');
  if (d.matches(':hover') || d.contains(document.activeElement)){ dockScheduleHide(); return; }
  dock.hidden = true; dockApply();
}
function dockScheduleHide(){
  clearTimeout(dock.hideT);
  if (!dock.pinned) dock.hideT = setTimeout(dockHide, DOCK_HIDE_MS);
}
function dockOnRender(){
  if (dock.pinned) return;
  const k = S.sel ? S.sel.type + ':' + S.sel.id : null;
  if (k){ clearTimeout(dock.hideT); dock.hideT = null; if (k !== dock.selKey) dockShow(); }
  else dockScheduleHide();
  dock.selKey = k;
}
function initDock(){
  dock.load();
  dockSetWidth(dock.w);
  renderPanelsMenu();
  renderDock();
  el('dockPin').onclick = () => {
    el('dockPin').blur();
    dock.pinned = !dock.pinned;
    el('dockPin').classList.toggle('pinned', dock.pinned);
    el('dockPin').title = dock.pinned ? 'Unpin — the dock hides itself to maximize the sheet' : 'Pin — keep the dock always visible';
    if (dock.pinned){ clearTimeout(dock.hideT); dockShow(); } else dockScheduleHide();
  };
  el('dockHandle').onclick = () => {
    el('dockHandle').blur();
    if (dock.hidden){ dockShow(); dockScheduleHide(); }
    else { clearTimeout(dock.hideT); dock.hidden = true; dockApply(); }
  };
  el('dock').addEventListener('pointerenter', () => clearTimeout(dock.hideT));
  el('dock').addEventListener('pointerleave', dockScheduleHide);
  const grip = el('dockResize');
  grip.addEventListener('pointerdown', ev => {
    ev.preventDefault();
    grip.setPointerCapture(ev.pointerId);
    grip.classList.add('active'); el('dock').classList.add('resizing');
    const startW = dock.w;
    const move = e => dockSetWidth(window.innerWidth - e.clientX, true);
    const up = () => {
      grip.classList.remove('active'); el('dock').classList.remove('resizing');
      grip.removeEventListener('pointermove', move); grip.removeEventListener('pointerup', up);
      if (dock.w < DOCK_COLLAPSE_W){ dockSetWidth(Math.max(startW, DOCK_MIN_W)); dock.hidden = true; dockApply(); }
      else dockSetWidth(dock.w);
      dock.save(); render();
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
  });
  const menu = el('panelsMenu');
  el('btnPanels').onclick = ev => { ev.stopPropagation(); menu.hidden = !menu.hidden; renderPanelsMenu(); };
  document.addEventListener('click', ev => { if (!menu.hidden && !menu.contains(ev.target)) menu.hidden = true; });
}
