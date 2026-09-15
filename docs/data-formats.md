# Data formats

## 1. The netlist — `circuit_data.json`

What the editor imports. Either a bare object or wrapped in an array (both are
accepted, as are `{circuit_data: …}` and an agent-style `{output: …}`):

```json
[{
  "components": [
    { "partNumber": "BQ24075-Q1", "ref": "U1",
      "package": "RGT-16 QFN", "role": "BATTERY_CHARGER", "group": "BATTERY_CHARGER_FRONT_END" },
    { "partNumber": "capacitor", "ref": "C1", "capacitance": "1 µF",
      "tolerance": "±10%", "voltage_rating": "10 V", "type": "X7R ceramic",
      "role": "INPUT_BYPASS", "group": "BATTERY_CHARGER_FRONT_END" }
  ],
  "nets": [
    { "name": "BQ24075_TS", "type": "ANALOG_SIGNAL", "nodes": ["R3-1", "U1-1"] }
  ]
}]
```

| Field | Meaning |
|-------|---------|
| `ref` | the designator, unique. Its prefix picks the symbol when `partNumber` is generic (`R`, `C`, `L`, `D`, `Q`, `J`, `SW`, `K`, `T`, `U`, `LED`, `TP`…). |
| `partNumber` | a real part number, or one of the generic component types listed below (`resistor`, `capacitor`, `MOSFET`, `relay`…). |
| `role`, `group` | free text. `group` drives the sheet layout: one dashed room per group. |
| anything else | kept as a netlist attribute. The fields of the component's type (table below) become editable **parameters** in Properties; the rest is listed under them. The type's main field (`resistance`, `capacitance`, `turns_ratio`…) becomes the symbol's displayed value. |
| `nets[].nodes` | `"<ref>-<pin>"`. The pin part may be a number or a name (`U1-EP`). **These nodes are what gives an IC its pins**, so they must be complete. |
| `nets[].type` | free text; the known ones colour the net class (`GROUND`, `POWER_DISTRIBUTION`, `HIGH_VOLTAGE_PATH`, `SWITCHING_NODE`, `DIGITAL_LOGIC`, `CONTROL_SIGNAL`, `ANALOG_*`, `SENSING_LINE`, `NO_CONNECT`…). |

### Component types and their parameters

Every passive and discrete type carries these fields. They are read from the
netlist, shown as editable inputs in the Properties panel, stored on the part
and written back by the netlist export. A type not listed here (an IC with a
real part number) has no parameter fields; its attributes are only listed.

| `partNumber` | symbol | fields |
|--------------|--------|--------|
| `resistor` | R | `resistance`, `tolerance`, `power_rating` |
| `shunt resistor` | R (shunt) | `resistance`, `tolerance`, `power_rating` |
| `capacitor` | C (polarized when `type` says electrolytic / tantalum / polymer) | `capacitance`, `tolerance`, `voltage_rating`, `type` |
| `inductor` | L | `inductance`, `tolerance`, `max_operational_frequency`, `current_rating` |
| `choke` | L with core | `inductance`, `tolerance`, `max_operational_frequency`, `current_rating` |
| `common-mode choke` | two windings on one core | `inductance`, `tolerance`, `max_operational_frequency`, `current_rating` |
| `diode` | D (Schottky / LED by `diode_type`) | `diode_type`, `reverse_voltage`, `current_rating` |
| `zener diode` | D (zener) | `zener_voltage`, `power_rating` |
| `TVS diode` | D (bidirectional TVS) | `clamping_voltage_max`, `peak_pulse_power`, `polarity` |
| `thyristor` | SCR | `thyristor_type`, `blocking_voltage`, `current_rating` |
| `MOSFET` | N- or P-channel by `polarity` | `vds_voltage`, `id_current`, `gate_voltage`, `polarity` |
| `GAN` | GaN HEMT | `vds_voltage`, `id_current`, `gate_voltage`, `polarity` |
| `IGBT` | IGBT | `vce_voltage`, `ic_current`, `vge_voltage`, `polarity` |
| `BJT` | NPN or PNP by `polarity` | `vce_voltage` (`vce_voltag` is read too), `ic_current`, `vbe_voltage`, `polarity` |
| `fuse` | F | `current_rating`, `voltage_rating` |
| `transformer` | T | `primary_magnetizing_inductance`, `turns_ratio`, `operational_frequency_range`, `voltage_isolation`, `voltage_primary` |
| `connector` | J (one pin per `number_of_contacts`, or per net node) | `number_of_contacts`, `mounting_type`, `current_rating`, `voltage_rating` |
| `oscillator` | Y (4-pin box: EN, GND, OUT, VDD) | `frequency`, `oscillator_type`, `voltage_rating` |
| `ntc` | RT | `thermistor_type`, `operating_temperature_range`, `power_rating` |
| `relay` | K | `contact_form`, `coil_voltage`, `current_rating`, `voltage_rating` |
| `contactor` | K (coil + power contact) | `contact_form`, `coil_voltage`, `current_rating`, `voltage_rating` |
| `solenoid` | L (coil + plunger) | `contact_form`, `coil_voltage`, `current_rating`, `voltage_rating` |

A two-pin symbol whose netlist nodes use numbers (`D2-1`, `D2-2`) while the
symbol names its pins `A`/`K` is aliased automatically, in pin order. A fixed
symbol asked for more pins than it has falls back to a box with exactly the pins
the netlist names.

## 2. The component database — GPN records

One JSON per GPN, as written by the datasheet extraction pipeline. The editor
reads:

| Path | Used for |
|------|----------|
| `gpn`, `part_numbers` | matching a symbol's part number to the record |
| `manufacturer`, `source_url` | the datasheet link |
| `facts.identity` | package, pin count, description |
| `facts.pinout[]` | the pin table, and the pin → number mapping the external-parts check needs |
| `facts.supplies[]` | the supply table |
| `facts.external_components[]` | the required-parts checklist (`type`, `value`, `from_pin_name`, `to_pin_name`, `mandatory`) |
| `facts.figures[]` | `image_url`, or `file` resolved under `db/figures/<GPN>/` |
| `facts.designer_notes[]` | the notes list |

`db/index.json` is generated by `tools/build-db-index.js`:

```json
{ "generated": "…", "files": [
  { "path": "approved/BQ2970__BQ29707__2c7bf3ab65c3.json", "gpn": "BQ2970",
    "part_numbers": ["BQ29707"], "status": "approved", "manufacturer": "ti", "description": "…" }
]}
```

Only the index is fetched at start-up; a record is fetched in full the first
time it is opened.

## 3. The session — what Export → Session writes

```json
{ "format": "circuit-editor/1",
  "project": { "title": "…", "checklist": [{ "text": "…", "done": false }] },
  "parts":  [{ "id": "p_1_ab", "kind": "res", "ref": "R1", "x": 120, "y": 340,
               "rot": 0, "mir": 0, "value": "1.21 kΩ", "partNumber": "",
               "group": "…", "role": "…", "props": {}, "pinNames": ["1","2"],
               "pick": { "pn": "…", "src": "DigiKey", "man": "…", "desc": "…",
                         "price": 0.43, "currency": "USD", "stock": 1200, "datasheet": "…" } }],
  "wires":  [{ "id": "w_2_cd", "pts": [{ "x": 120, "y": 340 }, { "x": 220, "y": 340 }] }],
  "rooms":  [{ "group": "…", "x": 60, "y": 60, "w": 700, "h": 420, "count": 10 }],
  "netlist": { "components": [], "nets": [], "source": "circuit_data.json" },
  "view": { "tx": 0, "ty": 0, "k": 1 } }
```

Importing a file with `parts` and `wires` restores a session; anything else is
read as a netlist. The same object is autosaved to `localStorage` after every
change and restored on the next visit.

`pick` is present only once a physical part has been chosen in Properties; it
is what the BOM export reads. Distributor keys are never written here.

Coordinates are world units on a 10-unit lattice — every pin of every symbol
lands on it, at any rotation.
