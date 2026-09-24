# Sample component library

`library.json` is the index the editor reads: one entry per component, each
with its part number, whatever parameters the designer chose to keep, and up to
four attached models (datasheet, Altium `.SchLib` symbol, Altium `.PcbLib`
footprint, LTspice model). Paths are relative to this folder; a `http(s)` URL
works just as well, which is what the datasheets here use.

No Altium model is bundled: the `.SchLib` and `.PcbLib` files are yours to add.
Attach one from the **Library** panel (`attach` on the model row), write its path
into `models` here, or drop a folder of `.SchLib` / `.PcbLib` / `.pdf` files
straight in — every file whose name is a part number becomes a component by
itself. Until a symbol is attached (and until the `.SchLib` reader in
`altium.js` is implemented) a component is drawn as a body with the pins its
record lists.

`BQ29707` shows the other way in: its symbol was **generated from the datasheet**
the extraction pipeline already had, with

```bash
npm run symbol -- BQ2970            # add --agent to have Claude lay the pins out
```

which wrote `models/BQ29707.sym.json` and the entry here. The Library panel marks
it *generated · not reviewed* until somebody approves it.

Rebuild the index after changing the folder:

```bash
npm run lib:index          # node tools/build-library-index.js [libraryDir]
```

The format is documented in `docs/component-library.md`.
