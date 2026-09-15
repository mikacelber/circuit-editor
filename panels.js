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
  // a field being typed in survives the re-render: same id, same caret
  const ae = document.activeElement;
  const focus = ae && body.contains(ae) && ae.id ? { id:ae.id, s:ae.selectionStart, e:ae.selectionEnd } : null;
  body.dataset.pane = pane.id;
  body.innerHTML = '';
  pane.render(body);
  body.scrollTop = keepScroll;
  if (focus){
    const f = el(focus.id);
    if (f){ f.focus(); try { if (focus.s != null) f.setSelectionRange(focus.s, focus.e); } catch(e){} }
  }
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
    <div class="sechead">Bill of materials</div>
    <div class="kv"><label>Parts picked on DigiKey / Mouser</label><div class="val">${stats.picked} of ${stats.placed}
      ${stats.picked ? ' · unit cost so far ' + dkFmtPrice(stats.bom, stats.cur) : ''}
      ${stats.nostock ? ` · <span style="color:var(--warn)">${stats.nostock} with no stock</span>` : ''}</div></div>
    <div class="btnrow" style="margin-top:4px"><button id="pjSearchCfg">Part search settings</button></div>
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
  el('pjSearchCfg').onclick = openSearchSettings;
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
  const comps = S.parts.filter(p => !(SYMBOLS[p.kind] && SYMBOLS[p.kind].port));
  const picked = comps.filter(p => p.pick);
  const cur = searchOptions().currency;
  return {
    placed: comps.length,
    components: (S.netlist && S.netlist.components.length) || 0,
    nets: nets.length, wires: S.wires.length, done,
    donePct: nets.length ? Math.round(100 * done / nets.length) : 0,
    picked: picked.length, cur,
    bom: picked.reduce((a, p) => a + (p.pick.price != null ? +p.pick.price : 0), 0),
    nostock: picked.filter(p => !p.pick.stock).length,
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
   PROPERTIES — whatever is selected, editable; and the way a symbol
   becomes a physical part (DigiKey / Mouser search, as in the
   architecture editor)
   ================================================================ */
function paneProperties(body){
  const sel = S.sel;
  if (!sel){ body.innerHTML = '<p>Nothing selected. Click a part or a wire on the sheet — Shift+click adds to the selection, Shift+drag draws a marquee.</p>'; return; }
  if (sel.type === 'wire') return paneWire(body, sel.id);
  const part = S.parts.find(p => p.id === sel.id);
  if (!part){ body.innerHTML = '<p>That object is gone.</p>'; return; }
  const many = S.selIds.size > 1;
  const def = SYMBOLS[part.kind];
  const isPort = !!def.port;
  const rec = part.partNumber ? DB.match(part.partNumber) : null;
  // the parameters this kind of component carries (resistance, tolerance…),
  // each an editable field; whatever else the netlist said is listed after
  const ctype = isPort ? null : componentType(part);
  const fields = ctype ? COMPONENT_TYPES[ctype].fields : [];
  const aliasKeys = new Set(fields.flatMap(f => FIELD_ALIASES[f] || []));
  const otherProps = Object.entries(part.props || {}).filter(([k]) => !fields.includes(k) && !aliasKeys.has(k));
  const pinRows = partPins(part).map(pin => {
    const net = S.pinNets.get(part.id + '|' + pin.name);
    const g = S.lastCheck ? S.lastCheck.conn.groupOf.get(part.id + '|' + pin.name) : null;
    const wired = g && (S.lastCheck.conn.members.get(g) || []).length > 1;
    return `<tr><td class="mono">${esc(pin.name)}</td><td class="mono">${esc(net || '—')}</td>
      <td class="mono" style="color:var(--${wired ? 'ok' : 'warn'})">${wired ? 'wired' : 'open'}</td></tr>`;
  }).join('');

  body.innerHTML = h`
    ${many ? `<p class="hint" style="margin-top:0"><b>${S.selIds.size} parts selected</b> — rotate, mirror, duplicate, nudge and delete act on all of them; the fields below edit ${esc(part.ref || 'the primary one')}.</p>` : ''}
    <div class="kv"><label>Symbol</label><div class="val">${esc(def.label)}${ctype ? ' · <span class="mono-ish">' + esc(ctype) + '</span>' : ''}${part.fromNetlist ? ' · from netlist' : ''}</div></div>
    ${isPort ? h`<div class="kv"><label>${def.port === 'label' ? 'Net label' : def.port === 'note' ? 'Text' : 'Net name'}</label>
        <input type="text" id="ppNet" data-pp="${def.port === 'note' ? 'text' : 'net'}" value="${esc(def.port === 'note' ? (part.text || '') : (part.net || def.net || ''))}"></div>`
      : h`<div class="row"><div class="kv"><label>Reference</label><input type="text" id="ppRef" data-pp="ref" value="${esc(part.ref || '')}"></div>
          <div class="kv"><label>Value</label><input type="text" id="ppVal" data-pp="value" value="${esc(part.value || '')}"></div></div>
        <div class="kv"><label>Part number</label><input type="text" id="ppPn" data-pp="partNumber" value="${esc(part.partNumber || '')}"></div>
        <div class="row"><div class="kv"><label>Group</label><input type="text" id="ppGroup" data-pp="group" value="${esc(part.group || '')}"></div>
          <div class="kv"><label>Role</label><input type="text" id="ppRole" data-pp="role" value="${esc(part.role || '')}"></div></div>`}
    <div class="btnrow">
      <button id="ppRot">Rotate 90°</button><button id="ppMir">Mirror</button>
      <button class="danger" id="ppDel">Delete</button>
    </div>
    ${fields.length ? h`
      <div class="sechead">Parameters · ${esc(ctype)}</div>
      <div class="params">${fields.map(f => h`
        <div class="kv"><label>${esc(f.replace(/_/g, ' '))}</label>
          <input type="text" id="pf_${f}" data-pfield="${f}" value="${esc(propValue(part.props, f))}" placeholder="—"></div>`).join('')}</div>` : ''}
    ${isPort ? '' : partPickMarkup(part)}
    ${isPort ? '' : h`
      <div class="sechead">Pins (${partPins(part).length})</div>
      <table class="facttbl"><thead><tr><th>Pin</th><th>Imported net</th><th>State</th></tr></thead><tbody>${pinRows}</tbody></table>`}
    ${otherProps.length ? h`
      <div class="sechead">${fields.length ? 'Other netlist attributes' : 'Netlist attributes'}</div>
      <table class="facttbl"><tbody>${otherProps.map(([k, v]) =>
        `<tr><td class="mono">${esc(k)}</td><td>${esc(typeof v === 'object' ? JSON.stringify(v) : v)}</td></tr>`).join('')}</tbody></table>` : ''}
    ${rec ? h`<div class="sechead">Datasheet</div>
      <p style="font-size:11.5px">Matched <b>${esc(rec.gpn || '')}</b> in the database.</p>
      <div class="btnrow"><button id="ppDb">Open in Database panel</button></div>` : ''}`;

  body.querySelectorAll('[data-pp]').forEach(inp => inp.onchange = () => {
    commit(); part[inp.dataset.pp] = inp.value;
    if (inp.dataset.pp === 'ref') part.ref = inp.value.toUpperCase();
    render(); renderDock();
  });
  body.querySelectorAll('[data-pfield]').forEach(inp => inp.onchange = () => {
    const f = inp.dataset.pfield, v = inp.value.trim();
    commit();
    if (!part.props) part.props = {};
    const old = propValue(part.props, f);
    for (const a of FIELD_ALIASES[f] || []) delete part.props[a];       // the canonical spelling wins
    if (v) part.props[f] = v; else delete part.props[f];
    // the field the symbol shows as its value keeps the symbol in step
    if (ctype && COMPONENT_TYPES[ctype].value === f && (!part.value || part.value === String(old))) part.value = v;
    render(); renderDock();
  });
  el('ppRot').onclick = rotateSel;
  el('ppMir').onclick = mirrorSel;
  el('ppDel').onclick = deleteSel;
  if (!isPort) wirePartPick(part);
  if (rec) el('ppDb').onclick = () => { S.ui.dbSel = rec.path || rec.gpn; setPanel('database'); };
}

/* The wire: which imported nets it carries, what it touches, and its shape. */
function paneWire(body, wid){
  const w = S.wires.find(x => x.id === wid);
  if (!w){ body.innerHTML = '<p>That wire is gone.</p>'; return; }
  const len = w.pts.reduce((a, p, i) => i ? a + Math.abs(p.x - w.pts[i-1].x) + Math.abs(p.y - w.pts[i-1].y) : 0, 0);
  const conn = S.lastCheck && S.lastCheck.conn;
  const g = conn && conn.wireGroup.get(w.id);
  const pins = g ? (conn.members.get(g) || []) : [];
  const nets = [...new Set(pins.map(pk => S.pinNets.get(pk)).filter(Boolean))];
  const touch = pins.map(pk => { const part = S.parts.find(p => p.id === pk.split('|')[0]); return part ? (part.ref || SYMBOLS[part.kind].label) + '-' + pk.split('|')[1] : null; }).filter(Boolean);
  body.innerHTML = h`<div class="kv"><label>Object</label><div class="val">Wire · ${w.pts.length - 1} segment${w.pts.length === 2 ? '' : 's'} · ${Math.round(len)} units</div></div>
    <div class="kv"><label>Net</label><div class="val">${nets.length ? nets.map(n => `<span class="chip">${esc(n)}</span>`).join(' ') : '<span style="color:var(--ink-soft)">not attached to any imported net</span>'}
      ${nets.length > 1 ? '<p class="icwarn">⚠ this conductor joins pins of different nets — a short</p>' : ''}</div></div>
    <div class="kv"><label>Touches</label><div class="val" style="font-family:var(--mono);font-size:11px">${esc(touch.join('  ') || '—')}</div></div>
    <p class="hint">Drag a segment to slide it sideways, drag either end onto another pin — the wire stays horizontal and vertical and keeps its pins. Corners that stop being corners are removed on release.</p>
    <div class="btnrow"><button class="danger" id="wDel">Delete wire</button></div>`;
  el('wDel').onclick = deleteSel;
}

/* ---- part pick: search DigiKey + Mouser and pin the winner to the symbol ---- */
function partPickMarkup(part){
  const st = S.ui.pick[part.id] || {};
  const pk = part.pick;
  return h`
    <div class="sechead">Physical part</div>
    ${pk ? h`<div class="dkchosen"><button class="x" id="pkClear" title="Drop this pick">✕</button>
        <span class="dkpn">${esc(pk.pn)}</span><span class="dksrc">${esc(pk.src || 'DigiKey')}</span><span class="dkman">${esc(pk.man || '')}</span>
        <span class="dkdesc">${esc(pk.desc || '')}</span>
        <span class="dkstock ${pk.stock ? '' : 'nostock'}">${pk.stock ? dkFmtStock(pk.stock) + ' in stock' : 'no stock'}</span>
        <span class="dkprice">${dkFmtPrice(pk.price, pk.currency)}</span>
        ${pk.datasheet ? `<a class="dkdesc" href="${esc(pk.datasheet)}" target="_blank" rel="noreferrer">datasheet ↗</a>` : ''}</div>`
      : `<p class="icwarn">⚠ No physical part picked yet — search DigiKey / Mouser and choose package, price and stock.</p>`}
    <div class="dksearch">
      <div class="kv"><label>Search DigiKey + Mouser</label>
        <div class="row"><input type="text" id="pkQuery" autocomplete="off" value="${esc(st.query != null ? st.query : partQueryFor(part))}">
        <button id="pkGo" style="flex:0 0 auto">Search</button></div></div>
      <div id="pkStatus" class="hint" style="margin:4px 0">${esc(st.status || '')}</div>
      <div id="pkResults" class="dkresults"></div>
      <p class="hint" style="margin-bottom:0">Results from both houses are merged, highest stock first. Picking one fills the part number and pins price, stock and datasheet to this symbol.
        <button class="linklike" id="pkCfg">Part search settings</button></p>
    </div>`;
}
function wirePartPick(part){
  const st = S.ui.pick[part.id] || (S.ui.pick[part.id] = {});
  const renderRows = () => {
    const box = el('pkResults'); if (!box) return;
    const rows = st.rows || [];
    box.innerHTML = rows.map((r, i) => h`
      <button type="button" class="dkrow ${part.pick && part.pick.pn === r.pn && part.pick.src === r.src ? 'on' : ''}" data-i="${i}">
        <span class="dkpn">${esc(r.pn)}</span><span class="dksrc">${esc(r.src)}</span><span class="dkman">${esc(r.man)}</span>
        <span class="dkdesc">${esc(r.desc)}</span>
        <span class="dkstock">${dkFmtStock(r.stock)} in stock</span><span class="dkprice">${dkFmtPrice(r.price, r.currency)}</span></button>`).join('');
    box.querySelectorAll('.dkrow').forEach(b => b.onclick = () => pickPart(part, rows[+b.dataset.i]));
  };
  renderRows();
  const run = async () => {
    const q = el('pkQuery').value.trim();
    st.query = q;
    if (!q){ st.status = 'Type a part number or a value to search.'; el('pkStatus').textContent = st.status; return; }
    st.status = 'Searching…'; st.rows = []; el('pkStatus').textContent = st.status; renderRows();
    try {
      const { rows, notes } = await partSearch(q);
      st.rows = rows;
      st.status = (rows.length ? rows.length + ' part' + (rows.length === 1 ? '' : 's') + ' — highest stock first' : 'No parts found.') +
        (notes.length ? ' · ' + notes.join(' · ') : '');
    } catch (e){ st.status = String(e.message || e); }
    if (S.sel && S.sel.id === part.id){ el('pkStatus').textContent = st.status; renderRows(); }
  };
  el('pkGo').onclick = run;
  el('pkQuery').addEventListener('keydown', ev => { if (ev.key === 'Enter'){ ev.preventDefault(); run(); } });
  el('pkQuery').oninput = () => { st.query = el('pkQuery').value; };
  el('pkCfg').onclick = openSearchSettings;
  if (el('pkClear')) el('pkClear').onclick = () => { commit(); delete part.pick; render(); renderDock(); };
}
function pickPart(part, r){
  commit();
  part.pick = { ...r };
  part.partNumber = r.pn;
  if (!part.props) part.props = {};
  if (r.man) part.props.manufacturer = r.man;
  render(); renderDock();
  toast(part.ref + ' → ' + r.pn + ' · ' + dkFmtPrice(r.price, r.currency) + ' · ' + r.src);
  // a Mouser pick has no datasheet — borrow DigiKey's in the background
  if (!r.datasheet) resolveDatasheetFor(r).then(url => {
    if (!url || part.pick !== undefined && part.pick.pn !== r.pn) return;
    part.pick.datasheet = url; if (S.sel && S.sel.id === part.id) renderDock();
  });
}

/* The distributor keys and options, as a modal: one home for them, reached
   from Properties and from Project. */
function openSearchSettings(){
  const so = searchOptions(), dk = dkConfig(), ms = msConfig();
  openModal('Part search settings', h`
    <div class="kv"><label>Distributors searched</label>
      <div class="row" style="gap:18px;padding:4px 0 2px">
        <label class="switch"><input type="checkbox" id="psUseDk" ${so.digikey ? 'checked' : ''}><span class="knob"></span><span class="swlabel">DigiKey</span></label>
        <label class="switch"><input type="checkbox" id="psUseMs" ${so.mouser ? 'checked' : ''}><span class="knob"></span><span class="swlabel">Mouser</span></label>
      </div></div>
    <div class="kv"><label>Search currency</label>
      <select id="psCur"><option value="USD" ${so.currency === 'USD' ? 'selected' : ''}>US dollars ($)</option><option value="EUR" ${so.currency === 'EUR' ? 'selected' : ''}>Euros (€)</option></select></div>
    <div class="row">
      <div class="kv"><label>DigiKey Client ID</label><input type="text" id="dkId" value="${esc(dk.id)}" autocomplete="off"></div>
      <div class="kv"><label>DigiKey Client Secret</label><input type="text" id="dkSecret" value="${esc(dk.secret)}" autocomplete="off"></div>
    </div>
    <div class="kv"><label>CORS proxy prefix (optional)</label><input type="text" id="dkProxy" value="${esc(dk.proxy)}" placeholder="https://your-proxy/?url=" autocomplete="off"></div>
    <div class="row">
      <div class="kv"><label>Mouser API key — USD (www.mouser.com)</label><input type="text" id="msKeyUsd" value="${esc(ms.usd)}" autocomplete="off"></div>
      <div class="kv"><label>Mouser API key — EUR (eu.mouser.com)</label><input type="text" id="msKeyEur" value="${esc(ms.eur)}" autocomplete="off"></div>
    </div>
    <div class="btnrow" style="margin-top:0"><button id="dkLoadFile">Load from credential/ files</button></div>
    <p class="hint">DigiKey: free credentials at developer.digikey.com (a "Product Information v4" app, client-credentials flow); it follows the currency chosen above.
      Mouser pegs prices to the key's account, so there is one key per currency. Keys and options live only in this browser (localStorage), never in the session or any export.
      DigiKey does not always allow cross-origin browser calls — a CORS proxy prefix fixes that.</p>`,
    `<button id="psCancel">Cancel</button><button class="primary" id="psOk">Save</button>`);
  el('psCancel').onclick = closeModal;
  el('dkLoadFile').onclick = async () => {
    const got = [], errs = [];
    try { const c = await dkLoadCredentialFile(); el('dkId').value = c.id; el('dkSecret').value = c.secret; if (c.proxy) el('dkProxy').value = c.proxy; got.push('DigiKey'); }
    catch (err){ errs.push(String(err.message || err)); }
    try { const m = await msLoadCredentialFile(); if (m.usd) el('msKeyUsd').value = m.usd; if (m.eur) el('msKeyEur').value = m.eur; got.push('Mouser'); }
    catch (err){ errs.push(String(err.message || err)); }
    toast(got.length ? got.join(' + ') + ' credentials loaded from file' : errs.join(' · '));
  };
  el('psOk').onclick = () => {
    dkSaveConfig(el('dkId').value.trim(), el('dkSecret').value.trim(), el('dkProxy').value.trim());
    msSaveConfig(el('msKeyUsd').value.trim(), el('msKeyEur').value.trim());
    saveSearchOptions({ digikey:el('psUseDk').checked, mouser:el('psUseMs').checked, currency:el('psCur').value });
    closeModal(); render(); toast('Part search settings saved');
  };
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
  const k = S.sel ? S.sel.type + ':' + S.sel.id + ':' + S.selIds.size : null;
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
