# The component library

An open-ended list of components. Each one is a **part number**, whatever
**parameters** the designer decided to keep, and up to **four attached models**:

| Model | File | What the editor does with it |
|-------|------|------------------------------|
| `datasheet` | `.pdf` (or a URL) | opened from the Library panel — and the input of the symbol generator |
| `symbol` | Altium `.SchLib` | **parsed into the schematic symbol** the sheet draws |
| `footprint` | Altium `.PcbLib` | carried with the part, handed to the layout stage |
| `spice` | LTspice `.lib` / `.mod` / `.sub` / `.cir` / `.asy` | its `.subckt` and pin order are read |
| `symbol_ir` | `<PN>.sym.json` | the symbol **generated from the datasheet** — what the sheet draws when there is no readable `.SchLib` |

Nothing but the part number is required: a component with no parameters and no
models is still a component, and a component can gain a model at any time
(*attach* in the Library panel).

---

## Where a library comes from

Three sources, one interface — so a repository in the cloud is a drop-in later:

| Source | How | Reattached on the next visit |
|--------|-----|------------------------------|
| **files** | *Choose folder…* / *Choose files…* in the library dialog. Models are read straight off the disk, nothing is fetched. | no — a browser cannot reopen a file the user picked |
| **folder** | a served directory holding `library.json` next to its models (`library/`). | yes |
| **remote** | a URL: a raw repository file, an API, a cloud service. An access token can be given. | yes |

A future cloud backend registers itself instead of being fetched directly:

```js
LIB.registerAdapter('nexo-cloud', {
  async load(cfg){            // cfg: {url, token, …}
    const res = await fetch(cfg.url + '/components', { headers:{ Authorization:'Bearer ' + cfg.token } });
    return { name:'Nexo cloud', base:cfg.url + '/files/', components: await res.json() };
  },
});
await LIB.connectRemote('https://…', { adapter:'nexo-cloud', token });
```

`LIB.push()` is the placeholder for writing a library back to such a repository;
until then **Export library.json** downloads it.

## `library.json`

```json
{
  "format": "circuit-editor/component-library/1",
  "name": "Sample library",
  "components": [
    {
      "part_number": "BQ24075RGTR",
      "manufacturer": "Texas Instruments",
      "category": "battery charger",
      "description": "1-A linear charger with power path",
      "package": "VQFN-16",
      "pins": ["IN1", "IN2", "PMID", "OUT1", "…", "EP"],
      "parameters": {
        "input_voltage_max": "28 V",
        "charge_current_max": "1.5 A",
        "internal_code": "NX-PM-0001"
      },
      "models": {
        "datasheet": "https://www.ti.com/lit/ds/symlink/bq24075.pdf",
        "symbol": "models/BQ24075RGTR.SchLib",
        "footprint": "models/BQ24075RGTR.PcbLib",
        "spice": "models/BQ24075RGTR.lib"
      }
    }
  ]
}
```

| Field | |
|-------|--|
| `part_number` | the identity, and the only required field. `partNumber`, `pn`, `mpn` are read too. |
| `parameters` | free-form: **the fields are the user's to choose**. `params`, `attributes`, `specs` and `properties` are read as well, and any loose scalar key on the record (`rds_on: "1.6 mΩ"`) becomes a parameter. |
| `models` | the four slots. A value is a path relative to the library, an absolute URL, or an object `{path, name, size}`. The slot may also be named at the top level of the record (`datasheet`, `schlib`, `pcblib`, `ltspice`…). |
| `category` | free text. It groups the panel's filter, and when it names one of the generic component types (`capacitor`, `MOSFET`, `connector`…) it also picks the fallback symbol. |
| `pins` | the pin names, in order. They draw the fallback symbol while the `.SchLib` parser is a placeholder, so a 17-pin part is drawn with its 17 pins. |
| `value`, `package`, `description`, `manufacturer`, `notes` | optional, shown in the panel. |

The file may also be a bare array of components, or `{parts: […]}`, or one
component per file — all of them are read.

### A folder with no index

Every model file whose name is a part number is a component by itself:

```
parts/ldo/TPS7A2033PDBVR.SchLib   →  component TPS7A2033PDBVR, category "ldo"
parts/ldo/TPS7A2033PDBVR.pdf      →  …its datasheet
parts/fet/CSD17573Q5B.lib         →  component CSD17573Q5B, category "fet"
```

Rebuild the index for a served library after changing the folder:

```bash
npm run lib:index          # node tools/build-library-index.js [libraryDir]
```

It keeps whatever the existing `library.json` said and fills in the model files
it finds.

---

## Where a symbol comes from

Two ways in, one thing drawn. Whichever way a component is created, the sheet
draws it from the **IR** — so the symbol in the editor is the symbol in Altium,
never a parallel approximation:

```
(A)  datasheet.pdf ─[pipeline]→ facts.pinout ─[gen-symbol.js]→ IR ─[write-schlib.py]→ .SchLib ─┐
                                                                │                              │
(B)  the user's .SchLib ────────────────────────────────────────┼──[altium.js parser]──────────┘
                                                                ▼
                                                        the symbol on the sheet
```

### (A) From the datasheet

The generator is an **offline step**, run next to the repository — the editor is
a static page and cannot run it itself. The Library panel's *Generate from
datasheet…* writes the job and gives you the command:

```bash
node tools/gen-symbol.js <GPN or part number> --agent     # npm run symbol -- <GPN> --agent
node tools/gen-symbol.js --job BQ29707.symboljob.json     # the job the panel exported
```

It reads the pinout the datasheet pipeline already extracted
(`db/approved/<GPN>__….json` → `facts.pinout`), so nothing is re-extracted and
nothing is invented, and writes `library/models/<PN>.sym.json` plus the entry in
`library.json`.

The work is split on purpose:

| | Who | Why |
|--|-----|-----|
| **Judgement** — which side a pin goes on, how pins group, the order within a side | the agent (`--agent`, Claude), or the rules when it is off or unavailable | grouping a bus, spotting a differential pair or reading a pin description is what a model is good at |
| **Geometry** — body size, 100-mil pitch, coordinates, the IR | `tools/symbol-layout.js`, always | the same component must come out identical twice; a model never decides a coordinate |

The agent's answer is **validated against the pinout that went in** — every pin
exactly once, on a real side — and thrown away whole if it does not hold up,
falling back to the rules. The rules alone already give: supplies at the top,
grounds and the thermal pad at the bottom, outputs on the right, everything else
on the left, ordered by group and pin number.

The result is marked `generated` and the panel says *generated · not reviewed*
until you press **Approve symbol** — the same draft/approved discipline the
datasheet database uses. `symbol_status` rides in `library.json`.

### (A′) The Altium file, when you want it

Writing the `.SchLib` is an **optional step you can run at any time** from the
component's *Write .SchLib…*:

```bash
python3 tools/write-schlib.py <PN>        # npm run symbol:schlib -- <PN>
```

It turns the IR into the `|KEY=VALUE|` records of a SchLib component (real,
deterministic, tested) and writes them as `<PN>.schlib.txt`. **Putting those
records inside the OLE2 container is not implemented yet**, so it says so and
writes no `.SchLib` rather than a file that only looks like one. The notes for
finishing it are at the top of the script.

### (B) From an Altium file

Attach a `.SchLib` on the component's *Altium symbol* row (or drop a folder of
them in) and the parser below takes over. A `.SchLib` always wins over a
generated IR: it is the source of truth.

---

## The symbol: the Altium parser

`altium.js` is where a `.SchLib` becomes something the sheet can draw:

```
.SchLib  →  Altium.parseSchLib()  →  IR  →  Altium.symbolDefFromAltium()  →  a symbols.js def
```

**`parseSchLib()` and `parsePcbLib()` are placeholders.** They report
`implemented:false`, and the component still places — with a body generated from
its pin list — while the Library panel says why. Everything *downstream* of the
IR is real: the conversion, the mil→unit scaling, the y-axis flip, the grid
snap, the pin sides and the body all work and are covered by the test suite, so
implementing the reader is a matter of filling the IR in.

### The IR a reader must produce

```js
{
  ok, implemented, reason, warnings:[…], units:'mil',
  symbols: [{
    name, description, designator:'U',
    pins: [{ name, designator, x, y, length, orientation, electrical, hidden }],
    primitives: [
      { type:'rect',     x1, y1, x2, y2, filled },
      { type:'line',     x1, y1, x2, y2 },
      { type:'polyline', points:[[x,y]…] },
      { type:'polygon',  points:[[x,y]…], filled },
      { type:'arc',      cx, cy, r, start, end },
      { type:'ellipse',  cx, cy, rx, ry, filled },
      { type:'label',    x, y, text }
    ]
  }]
}
```

- coordinates are **mils**, with Altium's axes: `+x` right, `+y` **up**;
- a pin's `x, y` is its **electrical end** (where a wire lands), and
  `orientation` (0/90/180/270) is the way the lead runs *from* there *into* the
  body — so `0` puts the pin on the left edge, `90` on the bottom, `180` on the
  right, `270` on the top;
- 100 mil becomes one grid cell (10 world units), the y axis is flipped for the
  sheet, and every pin is snapped onto the lattice so wires land on it.

### Reading the file itself, when the time comes

A `.SchLib` is an OLE2 compound document. Each component is a storage whose
`Data` stream is a run of records — a 4-byte little-endian length, then that
many bytes of ASCII made of `|KEY=VALUE` pairs. `RECORD=1` opens a component,
`RECORD=2` is a pin, `RECORD=14` a rectangle, `RECORD=13` a line, `RECORD=6` a
polyline, `RECORD=7` a polygon, `RECORD=12` an arc, `RECORD=4` a label.
`LOCATION.X` / `LOCATION.Y` are in Altium internal units (1/10000 inch), so
divide by 10 for the mils the IR wants.

---

## On the sheet

- **Place on sheet** (or drag a row straight onto it) creates a part with the
  component's part number, its parameters as the part's parameters, and the
  symbol the library resolved — the Altium one when it could be read, the
  generated body otherwise.
- The **Symbol** section of a component says where its drawing came from —
  `Altium`, `generated · approved`, `generated · not reviewed` or `fallback` —
  with the datasheet it was generated from and whether the agent or the rules
  laid it out.
- **Apply to `<ref>`** pins the component onto a symbol that is already drawn:
  part number, parameters, and the symbol when there is one.
- The part keeps a `lib` record (`{id, library, source, models}`), so a saved
  session still knows where the component came from, and the Properties panel
  shows it with a way back into the Library panel.
- The Properties panel also matches a part number against the library by
  **family** (`BQ24075-Q1` finds `BQ24075RGTR`), the same way the datasheet
  Explorer does.
