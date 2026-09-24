#!/usr/bin/env python3
"""tools/write-schlib.py - the symbol IR, written back out as Altium.

    library/models/<PN>.sym.json   (the IR, from tools/gen-symbol.js)
              |
              v
    records_from_ir()      the |KEY=VALUE| records of a SchLib component
              |
              v
    write_schlib()         the OLE2 container  <- NOT IMPLEMENTED YET
              |
              v
    library/models/<PN>.SchLib

This is the writing half of altium.js's reading half, and it is staged the
same way: everything down to the records is real, deterministic and covered
by the test suite; putting those records inside an OLE2 compound document is
the one piece still to do. Until it is, this writes the records next to the
library as <PN>.schlib.txt so they can be read, diffed and checked against
what Altium expects.

Writing is the easier direction: you only emit the record types you use,
whereas a reader has to survive everything anyone else ever wrote.

To finish it:
  * an OLE2/CFB container with one storage per component, each holding a
    "Data" stream, plus the "FileHeader" stream that lists them;
  * every record in a stream is a 4-byte little-endian length followed by
    that many bytes of ASCII;
  * pin records (RECORD=2) are stored in Altium's packed binary form rather
    than as plain text - the text this file emits is the same information in
    the readable shape, so the mapping is mechanical;
  * coordinates are in Altium internal units, 1/10000 inch, which is what
    to_internal() below produces from the IR's mils.

Usage:
    python3 tools/write-schlib.py <PN or file.sym.json> [--lib library] [--out file]
    python3 tools/write-schlib.py --job <file.schlibjob.json> [--lib library]
"""
import argparse, json, os, re, sys

MIL_TO_INTERNAL = 10            # the IR is in mils; Altium counts 1/10000 inch

# Altium's electrical-type codes for a pin.
ELECTRICAL = {
    'input': 0, 'io': 1, 'output': 2, 'open_collector': 3,
    'passive': 4, 'hiz': 5, 'emitter': 6, 'power': 7,
}
# Bits 0-1 of PINCONGLOMERATE hold the orientation (0/90/180/270 -> 0..3);
# the two bits above them show the pin's name and its designator.
PIN_SHOW_NAME = 0x08
PIN_SHOW_DESIGNATOR = 0x10


def to_internal(mils):
    return int(round(float(mils) * MIL_TO_INTERNAL))


def record(fields):
    """One Altium record: |KEY=VALUE| pairs, in the order given."""
    return ''.join('|%s=%s' % (k, v) for k, v in fields if v is not None) + '|'


def records_from_ir(symbol):
    """Every record of one IR symbol, header first, exactly as a Data stream
    holds them. Deterministic: same symbol in, same records out."""
    out = [record([
        ('RECORD', 1),
        ('LIBREFERENCE', symbol.get('name', 'SYMBOL')),
        ('COMPONENTDESCRIPTION', symbol.get('description', '')),
        ('DESIGNATOR', (symbol.get('designator') or 'U') + '?'),
        ('PARTCOUNT', 2),                 # Altium counts parts from 2
        ('DISPLAYMODECOUNT', 1),
        ('CURRENTPARTID', 1),
    ])]

    for p in symbol.get('primitives', []):
        kind = p.get('type')
        if kind == 'rect':
            x1, x2 = sorted((to_internal(p['x1']), to_internal(p['x2'])))
            y1, y2 = sorted((to_internal(p['y1']), to_internal(p['y2'])))
            out.append(record([
                ('RECORD', 14), ('OWNERPARTID', 1),
                ('LOCATION.X', x1), ('LOCATION.Y', y1),
                ('CORNER.X', x2), ('CORNER.Y', y2),
                ('ISSOLID', 'T' if p.get('filled') else 'F'),
                ('AREACOLOR', 11599871), ('COLOR', 128),
            ]))
        elif kind == 'line':
            out.append(record([
                ('RECORD', 13), ('OWNERPARTID', 1),
                ('LOCATION.X', to_internal(p['x1'])), ('LOCATION.Y', to_internal(p['y1'])),
                ('CORNER.X', to_internal(p['x2'])), ('CORNER.Y', to_internal(p['y2'])),
                ('LINEWIDTH', 1), ('COLOR', 128),
            ]))
        elif kind in ('polyline', 'polygon'):
            pts = p.get('points') or []
            fields = [('RECORD', 6 if kind == 'polyline' else 7), ('OWNERPARTID', 1),
                      ('LOCATIONCOUNT', len(pts))]
            for i, (px, py) in enumerate(pts, start=1):
                fields.append(('X%d' % i, to_internal(px)))
                fields.append(('Y%d' % i, to_internal(py)))
            fields.append(('COLOR', 128))
            if kind == 'polygon':
                fields.append(('ISSOLID', 'T' if p.get('filled') else 'F'))
            out.append(record(fields))
        elif kind == 'arc':
            out.append(record([
                ('RECORD', 12), ('OWNERPARTID', 1),
                ('LOCATION.X', to_internal(p['cx'])), ('LOCATION.Y', to_internal(p['cy'])),
                ('RADIUS', to_internal(p['r'])),
                ('STARTANGLE', p.get('start', 0)), ('ENDANGLE', p.get('end', 360)),
                ('LINEWIDTH', 1), ('COLOR', 128),
            ]))
        elif kind == 'label':
            out.append(record([
                ('RECORD', 4), ('OWNERPARTID', 1),
                ('LOCATION.X', to_internal(p['x'])), ('LOCATION.Y', to_internal(p['y'])),
                ('TEXT', p.get('text', '')), ('COLOR', 128),
            ]))

    for pin in symbol.get('pins', []):
        orientation = int(pin.get('orientation', 0)) % 360 // 90
        conglomerate = orientation | PIN_SHOW_NAME | PIN_SHOW_DESIGNATOR
        out.append(record([
            ('RECORD', 2), ('OWNERPARTID', 1),
            ('DESIGNATOR', pin.get('designator', '')),
            ('NAME', pin.get('name', '')),
            ('ELECTRICAL', ELECTRICAL.get(str(pin.get('electrical', 'passive')).lower(), 4)),
            ('PINCONGLOMERATE', conglomerate),
            ('PINLENGTH', to_internal(pin.get('length', 300))),
            ('LOCATION.X', to_internal(pin['x'])), ('LOCATION.Y', to_internal(pin['y'])),
        ]))
    return out


def write_schlib(path, records):
    """PLACEHOLDER: the records, inside an OLE2 compound document.

    See the notes at the top of this file. Raising is deliberate - a file
    with the right name and the wrong insides is worse than no file."""
    raise NotImplementedError(
        'writing the OLE2 container is not implemented yet; '
        'the records were written next to it as .schlib.txt')


def load_ir(arg, lib_dir):
    """A .sym.json path, a job file, or a part number to look up."""
    if os.path.isfile(arg):
        doc = json.load(open(arg, encoding='utf-8'))
        if doc.get('kind') == 'schlib' or doc.get('kind') == 'symbol':      # a job
            return load_ir(doc['part_number'], lib_dir)
        return doc.get('ir', doc), doc
    safe = re.sub(r'[^\w.-]+', '_', arg)
    for candidate in (os.path.join(lib_dir, 'models', safe + '.sym.json'),
                      os.path.join(lib_dir, safe + '.sym.json')):
        if os.path.isfile(candidate):
            doc = json.load(open(candidate, encoding='utf-8'))
            return doc.get('ir', doc), doc
    raise SystemExit('no symbol for "%s" under %s - run tools/gen-symbol.js first' % (arg, lib_dir))


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument('target', nargs='?', help='a part number, or a .sym.json file')
    ap.add_argument('--job', help='a job file exported by the Library panel')
    ap.add_argument('--lib', default=os.path.join(here, '..', 'library'))
    ap.add_argument('--out', help='where to write the .SchLib')
    args = ap.parse_args()

    target = args.job or args.target
    if not target:
        ap.error('give a part number, a .sym.json file, or --job')

    ir, doc = load_ir(target, args.lib)
    symbols = ir.get('symbols') or []
    if not symbols:
        raise SystemExit('that file holds no symbol')

    name = (doc.get('provenance', {}) or {}).get('part_number') or symbols[0].get('name') or 'SYMBOL'
    safe = re.sub(r'[^\w.-]+', '_', name)
    out = args.out or os.path.join(args.lib, 'models', safe + '.SchLib')
    os.makedirs(os.path.dirname(out), exist_ok=True)

    records = []
    for symbol in symbols:
        records.extend(records_from_ir(symbol))

    dump = os.path.splitext(out)[0] + '.schlib.txt'
    with open(dump, 'w', encoding='utf-8') as fh:
        fh.write('\n'.join(records) + '\n')
    print('%s · %d records · %d pins' % (name, len(records), len(symbols[0].get('pins', []))))
    print('  -> ' + dump)

    try:
        write_schlib(out, records)
        print('  -> ' + out)
    except NotImplementedError as exc:
        print('  .SchLib not written: %s' % exc)
        return 3
    return 0


if __name__ == '__main__':
    sys.exit(main() or 0)
