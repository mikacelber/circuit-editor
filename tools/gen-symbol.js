#!/usr/bin/env node
/* ==================================================================
   tools/gen-symbol.js — the offline step that turns a datasheet into
   the symbol of a library component.

       db/approved/<GPN>__….json      (what the pipeline already extracts)
                 │  facts.pinout
                 ▼
       pin assignment  ──  the rules, or the agent (--agent)
                 │
                 ▼
       library/models/<PN>.sym.json   (the IR and where it came from)
                 │
                 ▼
       the editor draws that as it is; the .SchLib is written later,
       when it is asked for, by tools/write-schlib.py

   The agent decides JUDGEMENT (which side a pin goes on, how pins
   group); the geometry is always tools/symbol-layout.js, so the same
   component comes out identical twice.

   Usage:
     node tools/gen-symbol.js <GPN or part number> [options]
     node tools/gen-symbol.js --job <file.symboljob.json>

   Options:
     --db <dir>       the datasheet database folder (db)
     --lib <dir>      the library folder (library)
     --pn <n>         the part number to file it under (default: the record's)
     --pins a,b,c     a pinout by hand, instead of the database's
     --agent          ask Claude for the assignment (needs ANTHROPIC_API_KEY)
     --model <id>     the agent's model (claude-opus-5 by default)
     --out <file>     where to write the IR
     --no-index       leave library.json alone
     --dry-run        print what would be written, write nothing
   ================================================================== */
'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const L = require('./symbol-layout.js');

const DEFAULT_MODEL = 'claude-opus-5';

/* ---------------- arguments ---------------- */
function parseArgs(argv){
  const a = { _:[] };
  for (let i = 0; i < argv.length; i++){
    const t = argv[i];
    if (t === '--agent' || t === '--dry-run' || t === '--no-index') a[t.replace(/^--/, '').replace(/-/g, '')] = true;
    else if (t.startsWith('--')) a[t.slice(2).replace(/-/g, '')] = argv[++i];
    else a._.push(t);
  }
  return a;
}

/* ---------------- the datasheet database ---------------- */
const normPn = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
function findRecord(dbDir, query){
  const q = normPn(query);
  const hits = [];
  for (const status of ['approved', 'drafts']){
    const dir = path.join(dbDir, status);
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir).filter(f => f.endsWith('.json'))){
      const full = path.join(dir, name);
      let rec;
      try { rec = JSON.parse(fs.readFileSync(full, 'utf8')); } catch (e){ continue; }
      const keys = [rec.gpn, ...(rec.part_numbers || []),
                    ...((rec.facts && rec.facts.identity && rec.facts.identity.part_numbers) || [])].filter(Boolean);
      let score = 0;
      for (const k of keys){
        const n = normPn(k);
        if (!n) continue;
        if (n === q) score = Math.max(score, 100);
        else if (q.startsWith(n) || n.startsWith(q)) score = Math.max(score, Math.min(n.length, q.length));
      }
      if (score) hits.push({ rec, path:full, status, score });
    }
  }
  hits.sort((a, b) => b.score - a.score);
  return hits[0] || null;
}

/* ---------------- the agent ----------------
   One call: the pinout goes in, the assignment comes out. It is checked
   against the pinout that went in, and the rules stand in when it does
   not hold up. */
const LAYOUT_TOOL = {
  name: 'emit_symbol_layout',
  description: 'Place every pin of the component on a side of the schematic symbol and group it by function.',
  strict: true,
  input_schema: {
    type: 'object',
    properties: {
      pins: {
        type: 'array',
        description: 'One entry per pin of the component — none left out, none repeated.',
        items: {
          type: 'object',
          properties: {
            pin:   { type:'string', description:'The pin designator, exactly as it came in.' },
            side:  { type:'string', enum:['left','right','top','bottom'] },
            group: { type:'string', description:'Function: power, ground, input, output, control, analog, digital…' },
            order: { type:'integer', description:'Position along its own side, starting at 0.' },
          },
          required: ['pin','side','group','order'],
          additionalProperties: false,
        },
      },
      notes: { type:'string', description:'One sentence on the reasoning behind the layout.' },
    },
    required: ['pins','notes'],
    additionalProperties: false,
  },
};

const AGENT_SYSTEM = `You lay out the pins of a component on a schematic symbol,
following the conventions of electronic CAD:

- supplies at the top; grounds and the thermal pad at the bottom;
- inputs, control and configuration on the left; outputs on the right;
- pins of one bus or one function stay together and in order (D0..D7, a
  port, a channel), with nothing else interleaved;
- differential pairs are adjacent and in order (P before N);
- balance the left and the right so the body is not lopsided — but never
  at the cost of breaking a functional group;
- NC pins go last, on the left.

You return EVERY pin that came in, each exactly once, with its designator
unchanged. Call the emit_symbol_layout tool with the result.`;

async function agentLayout(pins, meta, opts){
  let Anthropic;
  try { const m = require('@anthropic-ai/sdk'); Anthropic = m.default || m; }
  catch (e){
    throw new Error('--agent needs the SDK: npm install @anthropic-ai/sdk');
  }
  const client = new Anthropic();
  const model = (opts && opts.model) || DEFAULT_MODEL;
  const payload = {
    part_number: meta.name, description: meta.description || '',
    package: meta.package || '',
    pins: pins.map(p => ({ pin:p.pin, name:p.name, type:p.type || '', description:p.description || '' })),
  };
  const res = await client.messages.create({
    model, max_tokens: 16000,
    thinking: { type:'adaptive' },
    system: AGENT_SYSTEM,
    tools: [LAYOUT_TOOL],
    tool_choice: { type:'auto' },
    messages: [{ role:'user', content:
      'Lay out the pins of this component and call emit_symbol_layout:\n\n' + JSON.stringify(payload, null, 2) }],
  });
  if (res.stop_reason === 'refusal')
    throw new Error('the model declined the request' + (res.stop_details ? ' (' + res.stop_details.category + ')' : ''));
  const call = res.content.find(b => b.type === 'tool_use' && b.name === LAYOUT_TOOL.name);
  if (!call) throw new Error('the model did not call emit_symbol_layout');
  return { proposed: call.input.pins, notes: call.input.notes || '', model, usage: res.usage };
}

/* ---------------- the library ---------------- */
function updateLibraryIndex(libDir, entry){
  const indexPath = path.join(libDir, 'library.json');
  let index = { format:'circuit-editor/component-library/1', name:path.basename(libDir), components:[] };
  if (fs.existsSync(indexPath)){
    try { index = JSON.parse(fs.readFileSync(indexPath, 'utf8')); } catch (e){}
  }
  index.components = index.components || [];
  const i = index.components.findIndex(c => normPn(c.part_number || c.partNumber) === normPn(entry.part_number));
  if (i < 0) index.components.push(entry);
  else {
    const old = index.components[i];
    index.components[i] = { ...old, ...entry,
      parameters:{ ...(old.parameters || {}), ...(entry.parameters || {}) },
      models:{ ...(old.models || {}), ...(entry.models || {}) } };
  }
  index.components.sort((a, b) => String(a.part_number).localeCompare(String(b.part_number), undefined, { numeric:true }));
  index.generated = new Date().toISOString();
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2) + '\n');
  return indexPath;
}

/* ---------------- main ---------------- */
async function main(){
  const a = parseArgs(process.argv.slice(2));
  const dbDir = a.db || path.join(__dirname, '..', 'db');
  const libDir = a.lib || path.join(__dirname, '..', 'library');

  // A "job" is what the Library panel exports when a symbol is asked for
  // from the interface: the part number, a pinout if it has one, and which
  // GPN to read.
  let job = null;
  if (a.job){
    job = JSON.parse(fs.readFileSync(a.job, 'utf8'));
    if (job.kind && job.kind !== 'symbol') throw new Error('that job is not a symbol job: ' + job.kind);
  }
  const query = a._[0] || (job && (job.gpn || job.part_number));
  if (!query){
    console.error('usage: node tools/gen-symbol.js <GPN or part number> [--agent] [--db dir] [--lib dir]');
    process.exit(2);
  }

  // 1. the pinout
  let pins = [], rec = null, hit = null, source = {};
  if (a.pins) pins = L.pinoutFromNames(String(a.pins).split(/[,\s]+/).filter(Boolean));
  else if (job && job.pins && job.pins.length) pins = L.pinoutFromNames(job.pins);
  if (!pins.length){
    hit = findRecord(dbDir, query);
    if (!hit) throw new Error('no record for "' + query + '" under ' + dbDir + ' — pass --pins, or extract the datasheet first');
    rec = hit.rec;
    pins = L.pinoutFromRecord(rec);
    source = { gpn:rec.gpn || '', record:path.relative(path.join(__dirname, '..'), hit.path), status:hit.status,
               sha256:crypto.createHash('sha256').update(fs.readFileSync(hit.path)).digest('hex').slice(0, 16) };
  }
  if (!pins.length) throw new Error('the record carries no pinout — that datasheet is not fully extracted');

  const id = (rec && rec.facts && rec.facts.identity) || {};
  const pn = a.pn || (job && job.part_number) ||
             (rec && ((rec.part_numbers || [])[0] || (id.part_numbers || [])[0] || rec.gpn)) || query;
  const meta = { name:pn, description:id.description || '', package:id.package || '',
                 designator:'U', manufacturer:rec ? rec.manufacturer || '' : '' };

  // 2. the assignment: the agent, with the rules underneath it
  let plan = L.planLayout(pins), how = 'rules', notes = '', model = null;
  if (a.agent){
    try {
      const got = await agentLayout(pins, meta, { model:a.model });
      const applied = L.applyAgentPlan(pins, got.proposed);
      if (applied.ok){ plan = applied.plan; how = 'agent'; notes = got.notes; model = got.model; }
      else console.warn('· the agent assignment does not hold (' + applied.reason + ') — using the rules');
    } catch (e){
      console.warn('· the agent failed (' + e.message + ') — using the rules');
    }
  }

  // 3. the geometry, always deterministic
  const ir = L.irFromPlan(plan, meta);
  const file = L.symbolFile(ir, {
    part_number: pn, source, layout: how, model, notes,
    generator: 'tools/gen-symbol.js', pin_count: pins.length,
  });

  const outPath = a.out || path.join(libDir, 'models', pn.replace(/[^\w.-]+/g, '_') + '.sym.json');
  const byside = s => plan.filter(p => p.side === s).length;
  console.log(`${pn} · ${pins.length} pins · laid out by ${how === 'agent' ? 'the agent (' + model + ')' : 'the rules'}`);
  console.log(`  left ${byside('left')} · right ${byside('right')} · top ${byside('top')} · bottom ${byside('bottom')}`);
  if (notes) console.log('  ' + notes);
  if (a.dryrun){ console.log(JSON.stringify(file, null, 2)); return; }

  fs.mkdirSync(path.dirname(outPath), { recursive:true });
  fs.writeFileSync(outPath, JSON.stringify(file, null, 2) + '\n');
  console.log('  → ' + outPath);

  if (!a.noindex){
    const rel = path.relative(libDir, outPath).split(path.sep).join('/');
    const entry = {
      part_number: pn,
      description: meta.description || undefined,
      manufacturer: meta.manufacturer || undefined,
      package: meta.package || undefined,
      pins: pins.map(p => p.name),
      parameters: {},
      models: { symbol_ir: rel },
    };
    if (rec && rec.source_url) entry.models.datasheet = rec.source_url;
    console.log('  → ' + updateLibraryIndex(libDir, entry));
  }
}

if (require.main === module) main().catch(e => { console.error('error: ' + e.message); process.exit(1); });
module.exports = { findRecord, updateLibraryIndex, LAYOUT_TOOL, AGENT_SYSTEM };
