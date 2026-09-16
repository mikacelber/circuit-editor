# Circuit Editor

Schematic capture for netlist-driven design. You import the **netlist** of a
circuit (`circuit_data.json`: components, values and nets), the editor places
every component as a symbol on a grid sheet, and from there you draw the real
schematic — wires, grounds, net labels, notes — while the editor keeps checking
what you drew against the netlist you imported.

It is the same shell as the block architecture editor (grid, zoom, auto-fit,
logo bar, collapsible side panel, dark/light) with a schematic editor behind it
and an Altium-style **panel dock**: one panel at a time, tabs at the bottom, and
a **Panels** button in the bottom-right corner of the window that decides which
panels have a tab at all.

Plain HTML, CSS and JavaScript. No build step, no framework, no bundler.

---

## Quick start

```bash
python3 -m http.server 8123      # or: npm run serve
# open http://localhost:8123
```

Then **Import → Sample → Load sample/circuit_data.json** (236 components,
192 nets). `Arrange` re-places everything by functional group, `Check` runs the
rules, `Export` gives you the session, the drawn netlist or the sheet as SVG.

Opening `index.html` straight from disk works too, except for the two things a
browser refuses to `fetch` over `file://`: the bundled sample and the component
database. Use the **File** tab of the Import dialog and the **Load files…**
picker in the Explorer panel instead.

---

## What is on screen

| Area | What it does |
|------|--------------|
| **Top bar** | Logo, project title, undo/redo, Arrange, Check, Import, Export. |
| **Sheet** | Adaptive grid drawn in screen space: it stays on the world lattice at every pan and zoom, and thins out as you zoom away. Wheel zooms about the pointer, drag pans, `F` fits, the bottom-right buttons do the same. |
| **Tool strip** | Floats over the top-centre of the sheet: select, wire, net label, ground, power rail, text, then rotate / mirror / duplicate / delete. |
| **Panel dock** | The right-hand panel group. Pin it, fold it away with the handle on the divider, or drag its left edge to resize. Its tabs stay on **one row**: when the names stop fitting, two triangles appear right after them and step to the next or previous panel, scrolling the strip so the active name is always readable. |
| **Panels button** | Bottom-right corner: check a panel to give it a tab, uncheck it to take the tab away. |
| **Status bar** | Parts, wires, nets imported, how much of the netlist is drawn, and the error/warning count (click it to open Messages). |

## The panels

- **Project** — the design record: title, code, revision, author, customer,
  variant, status, the electrical envelope (input voltage, rails, max current,
  isolation, standards), free notes, and a verification checklist you tick off.
  It also shows how much of the netlist is actually drawn, and the theme and
  sheet-display switches.
- **Components** — the symbol library: passives, discretes, integrated,
  electromechanical, ports and power. Click a symbol then click the sheet, or
  drag it straight in; `R` rotates while placing. Underneath, every component of
  the netlist that is not on the sheet yet, one click away from being placed.
- **Netlist** — every imported net, searchable and filtered by class, each with
  its nodes and its state (`wired`, `3/5`, nothing). Click one to trace it: the
  sheet dims everything else and the view jumps to it.
- **Properties** — opens by itself when you click a part or a wire. For a
  part: reference, value, part number, group, role, rotate / mirror / delete,
  the **parameters** of its component type (a resistor's resistance, tolerance
  and power rating; a capacitor's capacitance, tolerance, voltage rating and
  type; a MOSFET's V<sub>DS</sub>, I<sub>D</sub>, gate voltage and polarity… the
  full table is in `docs/data-formats.md`), each an editable field that is
  written back into the part and exported with it, any other attribute the
  netlist carried, a pin table saying which imported net each pin belongs to
  and whether it is wired yet — and the **physical part**: a
  DigiKey + Mouser search (pre-filled from the part number, or from the value
  and kind for a generic passive) whose rows are merged highest-stock-first;
  picking one pins part number, manufacturer, price, stock and datasheet to the
  symbol, exactly as the architecture editor does for ICs. Keys and options
  live in *Part search settings* (also reachable from Project). For a wire: the
  net it carries, the pins it touches, and a warning if it joins two nets.
- **Explorer** ☁ — the GPN datasheet extracts (see below): identity, pinout,
  supplies, the **required external components** checked one by one against the
  netlist, the designer notes and, last of all, the figures. Assign a part
  number to the selected symbol from here. The blue cloud on its tab says the
  panel reads the component database rather than the sheet.
- **Messages** — the rule check, worst first. Click a line to jump to the net or
  the part it is about.

---

## Working with a netlist

1. **Import** a `circuit_data.json`. Every component becomes a symbol: the
   generic part number picks it first (`resistor`, `shunt resistor`,
   `capacitor`, `inductor`, `choke`, `common-mode choke`, `diode`, `zener
   diode`, `TVS diode`, `thyristor`, `MOSFET`, `GAN`, `IGBT`, `BJT`, `fuse`,
   `transformer`, `connector`, `oscillator`, `ntc`, `relay`, `contactor`,
   `solenoid` — `polarity` decides N/P-channel and NPN/PNP), then the reference
   prefix and the type-specific fields. An IC's pins are read from the net
   nodes themselves (`U1-1`, `U1-EP`), so a 17-pin part is drawn with its 17
   pins even though the netlist never lists them separately.
2. The sheet is laid out by **functional group** — one dashed room per group,
   ICs on the first row, passives packed underneath — deterministically: the
   same netlist always lands the same way.
3. **Draw** the schematic. Every pin shows the net it belongs to, so you always
   know what should reach it.
4. **Check** compares the drawing with the netlist and reports:
   - nets fully drawn, partly drawn (it names the pins still open) or not drawn;
   - **shorts** — one drawn conductor carrying pins of two different nets;
   - components of the netlist not placed, parts on the sheet the netlist does
     not know, duplicate references.
5. **Export** the session (everything), the *drawn* netlist in `circuit_data`
   shape (diff it against the imported one), the **BOM** as CSV (one line per
   component with the part picked on DigiKey / Mouser, its price and stock), or
   the sheet as SVG.

### Wires

A wire is only ever horizontal and vertical, on the grid — the wire tool draws
L-shaped legs (`Space` flips which leg comes first), reshaping keeps every
segment on its axis, and a diagonal in a loaded file is straightened into an L.
Junction dots appear only where three or more conductors actually meet (a T, a
cross with a vertex on it, two wires landing on one pin); two wires that just
continue each other around a corner get none.

Select a wire and drag a **segment** to slide it sideways, or drag either
**end** onto another pin (there are no handles on the corners — a wire is its
line). An end sitting on a pin never comes off it on its own: a new bend
appears next to the pin instead, the way a schematic editor rubber-bands.
**Moving, rotating or mirroring a part** does the same to every wire held by
its pins — each wire end follows its own pin to wherever the pin lands and the
wire bends beside it — so turning a part never breaks its connections. Bends
that stop being bends are removed on release.

### Symbols

The symbols follow the drawing conventions of schematic CAD (Altium's default
look): thin dark-blue outlines and text, pale-yellow filled bodies for ICs,
connectors, resistors and transistor envelopes, solid arrows on diodes and
transistors, pin names inside the body (level whichever way the part is
turned, vertical on a top/bottom edge), designator above and value below, and
dark-red junction dots. An open pin end carries a small red ring until
something reaches it. The dark theme uses the same drawing in lighter inks; the
SVG export always uses the light palette.

### How connectivity is decided

Exactly like a schematic, so the check can be trusted:

- a wire joins another wire where one of them has a **vertex** — an end or a
  corner. Two wires crossing through each other are two nets;
- a wire joins a **pin** where the wire has a vertex on it. A wire that merely
  passes over a pin is not connected to it;
- **net labels** and **power ports** with the same name are the same net,
  anywhere on the sheet;
- junction dots are drawn where a connection actually happens — they are a
  reading of the netlist, never a thing you place.

---

## The component database

The datasheet extraction pipeline writes one JSON per GPN (the general part
number covering a family) plus its figures:

```
db/approved/BQ2970__BQ29707__2c7bf3ab65c3.json
db/drafts/…
db/figures/<GPN>/…
db/index.json          ← generated, this is what the editor fetches
```

A browser cannot list a directory, so regenerate the index whenever the folder
changes:

```bash
npm run db:index          # node tools/build-db-index.js [dbDir]
```

The Explorer panel then matches a symbol's part number to a record — exact
first, then by family (`BQ24075-Q1` → `BQ24075`, `TPS7A20185PDBVR` → `TPS7A20`)
— and turns the record's `external_components` list into a checklist against
the netlist: found (green), probable (amber, when the datasheet names the far
end after a node instead of a pin) or missing. Point the panel at any other
folder, or load the JSON files by hand when there is no server.

---

## Keyboard

| Key | |
|-----|---|
| `S` `W` `L` `G` `P` `T` | select · wire · net label · ground · power rail · text |
| `R` / `M` | rotate / mirror (the selection, or the symbol being placed) — attached wires follow |
| `Shift`+click · `Shift`+drag · `Ctrl+A` | add to the selection · marquee · select everything |
| arrows (`Shift` = ×4) | nudge the selection one grid step |
| `Ctrl+D` | duplicate the selection with fresh designators |
| `Space` | while drawing a wire: flip which leg of the bend comes first |
| `F` / `Shift+F` | fit the sheet / fit the selection |
| `Esc` | finish the wire being drawn (or cancel the tool / clear the selection) |
| `Del` | delete the selection |
| `Ctrl+Z` / `Ctrl+Y` | undo / redo |
| `Ctrl+S` | download the session |
| wheel · drag · right-click | zoom about the pointer · pan · finish a wire |

---

## Repository layout

```
index.html          the shell: header, sheet, tool strip, dock, status bar
styles.css          design tokens and every piece of chrome
symbols.js          the symbol library and its geometry
netlist.js          import, placement, connectivity engine, rules check, export
db.js               the GPN database and the required-external-parts report
parts.js            DigiKey + Mouser part search (ported from the architecture editor)
panels.js           the panel dock and the six panels
app.js              state, view, grid, rendering, tools, import/export
sample/             an example circuit_data.json
db/                 the component database + its generated index
credential/         digikey_credentials.json, mouser_credentials.json (one-click load)
tools/              build-db-index.js
test_circuit.js     headless test suite (jsdom)
```

## Tests

```bash
npm install     # jsdom, only for the tests
npm test
```

The suite loads the real `index.html` and the real scripts in a jsdom window and
exercises the whole path: import, symbol geometry and rotation, the connectivity
rules (crossing versus T, wire over a pin versus wire ending on it), the netlist
check (realised, partial, short), wire reshaping and rubber-banding,
multi-selection, the distributor result normalisers, the BOM, the export
round-trip and the panels.

## Not there yet

Buses and bus entries, multi-sheet projects and hierarchical blocks, copy/paste
across sessions, PDF output, and writing values back into the imported netlist.
