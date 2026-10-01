# Altium projects — export, and the way back

**Export → Altium project** writes the sheet as an Altium Designer project. This
page is the map of how it is done and of the file formats underneath, written so
that the reverse — *Import Altium project* — is a matter of wiring the readers
that already exist to a button.

```
<Project>/<Project>.PrjPcb      INI text: the project and its documents
<Project>/<Sheet>.SchDoc        the sheet: binary (OLE2) or ASCII
<Project>/<Project>.SchLib      OLE2: every symbol the sheet uses
```

---

## The layers

Every layer has its writer and its reader side by side, and each pair is tested
to invert:

| Layer | Writer | Reader | File |
|-------|--------|--------|------|
| bytes ⇄ container | `CFB.write(files)` | `CFB.read(bytes)` | `cfb.js` |
| | `ZIP.write(files)` | `ZIP.read(bytes)` (stored entries) | `cfb.js` |
| container ⇄ records | `Altium.encodeRecords` | `Altium.decodeRecords`, `decodeAscii` | `altium.js` |
| binary pin ⇄ record | `Altium.encodePin` | `Altium.decodePin` | `altium.js` |
| records ⇄ symbol library | `Altium.writeSchLib(symbols)` | `Altium.readSchLib(bytes)` | `altium.js` |
| records ⇄ sheet | `Altium.writeSchDoc(records)` | `Altium.readSchDoc(bytes)` | `altium.js` |
| sheet model ⇄ records | `Altium.sheetRecords(model)` | `Altium.sheetModel(records)` | `altium.js` |
| project file | `Altium.writePrjPcb` | `Altium.readPrjPcb` | `altium.js` |
| editor ⇄ sheet model | `AltiumProject.sheetFromEditor` | `AltiumProject.editorFromSheet` | `altium-project.js` |
| whole project | `AltiumProject.build(state, opts)` | `AltiumProject.readProject(files)` | `altium-project.js` |

### Export

```js
const r = await AltiumProject.build({ project:S.project, parts:S.parts, wires:S.wires },
                                    { name:'My project', format:'binary', library:LIB });
r.files      // { 'My project/My project.PrjPcb': text, 'My project/Sheet1.SchDoc': bytes, … }
r.zip()      // one .zip
r.report     // per sheet: components, wires, junctions…; symbols; warnings
```

`state.sheets = [{ name, parts, wires }, …]` exports several sheets into one
project; without it the editor's single sheet is exported under
`S.project.sheetName`.

### Import (the reading half, ready)

```js
const proj = AltiumProject.readProject({ 'X.PrjPcb': text, 'Sheet1.SchDoc': bytes, 'X.SchLib': bytes });
// proj.sheets = [{ name, format, model }], proj.libraries = { 'X.SchLib': [symbols] }
const { parts, wires } = AltiumProject.editorFromSheet(proj.sheets[0].model);
```

Every component comes back as a part carrying its Altium symbol as `libSymbol`
(drawn through the same `symbolDefFromAltium` the library uses), at the right
place, rotation and mirror; power ports, net labels, no-connects, notes and
wires come back as their editor counterparts. The test suite exports the
236-part sample, reads it back, and finds every pin of every part where it was.

What an import button still needs: a file picker taking a `.PrjPcb` with its
`.SchDoc`s (or a zip — `ZIP.read` handles stored entries; deflated ones need
`DecompressionStream('deflate-raw')`), a choice of sheet while the editor has
one sheet, and a `commit()` + `S.parts = parts; S.wires = wires`.

---

## Coordinates

| | Editor | Altium |
|--|--------|--------|
| unit | world unit | 10 mil ("DXP unit"; `_FRAC` keys add 1/100000) |
| grid | 10 units | 100 mil = 10 units |
| y axis | down | **up** |
| rotation | `rot` 0/90/180/270, clockwise on screen | `ORIENTATION` 0–3, counter-clockwise quarter turns |
| mirror | `mir` (x flipped, before the rotation) | `ISMIRRORED=T` (x flipped in the part's frame, before the rotation) |

So `X = x + ox`, `Y = oy − y`, `ORIENTATION = (4 − rot/90) mod 4`, with `ox`,
`oy` whole inches chosen to put the drawing inside the sheet border (1" margin,
1.5" under the drawing for the title block). The sheet is a custom size fitted
to the drawing.

---

## The files

### Records

Both the `.SchDoc` and the `.SchLib` are runs of records. In a binary file each
record is a little-endian `uint32` — low 24 bits the length, high byte the type
— then the body: type `0` is `|KEY=VALUE|…` text in Windows-1252 ending in a
NUL, type `1` binary (only pins in a `.SchLib`). Text outside 1252 is written
twice: `|%UTF8%TEXT=<utf-8 bytes>|TEXT=<1252 with ?>`, and the reader prefers the
UTF-8 twin. Keys are case-blind; the code holds them upper-case.

### `.SchDoc`

OLE2 streams `FileHeader` and `Storage`. `FileHeader` is a header record
(`|HEADER=Protel for Windows - Schematic Capture Binary File Version 5.0|WEIGHT=<n>`)
then the records; the ASCII flavour is the same records one per line between
`|HEADER=…Ascii File Version 5.0…` lines.

A record's position in that list is its index; `OWNERINDEX` points at the owner
(`0` is the sheet record). What the export writes:

| Record | What | Notes |
|--------|------|-------|
| `31` | the sheet | font table, grid, custom size |
| `41` (unowned) | sheet parameters | Title, DocumentNumber, Revision, Author, SheetNumber… for the title block |
| `1` | a component | `LIBREFERENCE`, `LOCATION`, `ORIENTATION`, `ISMIRRORED`, `SOURCELIBRARYNAME`, `ALLPINCOUNT` |
| `2` | a pin (owned) | `LOCATION` = body end, `PINLENGTH`, `PINCONGLOMERATE` bits 0–1 = direction out of the body (0 right, 1 up, 2 left, 3 down), `0x08` show name, `0x10` show number |
| `6` `7` `8` `12` `13` `14` | the symbol drawing (owned) | stored at their final sheet coordinates |
| `34` / `41` (owned) | designator, comment, parameters | parameters hidden |
| `44`–`48` (owned) | implementation (footprint…) | copied from the `.SchLib` when it has them, nested 44 → 45 → 46/48 → 47 |
| `27` | wire | `LOCATIONCOUNT`, `X1 Y1 X2 Y2…` |
| `29` | junction | where three conductors meet, as on the editor's sheet |
| `25` | net label | location = the connection point |
| `17` | power port | `STYLE` 2 bar (rail), 4 power ground, 5 signal ground, 6 earth; `ORIENTATION` the way the symbol points |
| `22` | no-ERC (no-connect) | |
| `4` | text | the sheet's notes, one per line |

### `.SchLib`

OLE2 streams `FileHeader` (library properties, `COMPCOUNT`, `LIBREF<i>`,
`COMPDESCR<i>`, `PARTCOUNT<i>`), `Storage`, optionally `SectionKeys`
(`LIBREF<i>` → `SECTIONKEY<i>` for names that do not fit a 31-character storage
name), and one storage per component holding its `Data` stream: `RECORD=1`,
then the children in the component's own frame. Pins are binary:

```
int32 RECORD(=2)  u8 0  int16 OWNERPARTID  u8 OWNERPARTDISPLAYMODE
u8 SYMBOL_INNEREDGE  u8 SYMBOL_OUTEREDGE  u8 SYMBOL_INSIDE  u8 SYMBOL_OUTSIDE
pascal DESCRIPTION  u8 FORMALTYPE  u8 ELECTRICAL  u8 PINCONGLOMERATE
int16 PINLENGTH  int16 LOCATION.X  int16 LOCATION.Y  uint32 COLOR
pascal NAME  pascal DESIGNATOR  pascal SWAPIDGROUP  pascal PARTANDSEQUENCE("|&|")  pascal DEFAULTVALUE
```

`ELECTRICAL`: 0 input, 1 I/O, 2 output, 3 open collector, 4 passive, 5 Hi-Z,
6 open emitter, 7 power.

### `.PrjPcb`

INI text: `[Design]`, `[Electrical Rules Check]`, one `[Document<n>]` with
`DocumentPath=` per sheet and library, and `[Parameters]` carrying the project
fields (customer, variant, status, the electrical envelope).

---

## Symbols

- A part placed from the **component library** whose `.SchLib` the library can
  still reach is written with that symbol, its records copied and moved through
  the part's placement. Before that, the hot spot of every pin is checked
  against the pin the editor draws; a symbol that disagrees is converted from
  the editor's drawing instead, with a warning, so wires always connect.
- Every **other part** is converted from its `symbols.js` def: the body becomes
  a filled rectangle or polygons, strokes become polylines (SVG arcs and curves
  flattened), the circles of terminals become ellipses, and each pin becomes an
  Altium pin with the same hot spot, its lead running back to the body.
- The designator and comment of a converted part sit where the editor draws
  them; a library part keeps its own.
- Every symbol used goes into `<Project>.SchLib` once (same drawing, same
  symbol), and each component names that file as its `SOURCELIBRARYNAME`, so
  the project is self-contained.

## Connectivity

Altium and the editor agree on wire ends, T-junctions, crossings without a
junction, net labels and power ports. The one difference: Altium joins a wire
to a pin end the wire merely passes over, the editor does not — the export
lists every such pin in its report so it can be checked.

## Still open

- Footprints: the `.PcbLib` reader is a placeholder, so footprints come across
  only when a library `.SchLib` already carries its implementation records.
- Multi-part components export part 1 (the editor draws one part).
- Pins with fractional coordinates (Altium's `PinFrac` stream) are rounded to
  whole units.
- Mirror and rotation follow Altium's documented order (mirror in the part's
  frame, then rotate). Children are written at their final coordinates, so the
  drawing is right regardless; the order only matters if a mirrored, rotated
  part is later re-synced from its library inside Altium.
