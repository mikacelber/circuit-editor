/* ==================================================================
   cfb.js — the two containers the Altium export needs, both ways.

     CFB   the OLE2 / Compound File Binary format (MS-CFB) every Altium
           binary document lives in: .SchDoc, .SchLib, .PcbLib, .PcbDoc.
           A tiny FAT file system inside one file: storages (folders)
           and streams (files).

               CFB.read(bytes)   → { streams: Map('Storage/Data' → Uint8Array), … }
               CFB.write(files)  → Uint8Array     files: { 'FileHeader': bytes,
                                                           'R1/Data': bytes, … }

     ZIP   a stored (uncompressed) .zip, so a whole Altium project —
           the .PrjPcb, its sheets and its library — downloads as one file.

               ZIP.write(files)  → Uint8Array     files: { 'Proj/Proj.PrjPcb': bytes|string, … }
               ZIP.read(bytes)   → Map(name → Uint8Array)   (stored entries)

   Both are format code only: no Altium knowledge lives here (that is
   altium.js), and nothing here touches the DOM, so the same file runs
   in the browser, in the jsdom test suite and in node.

   ---- CFB in one paragraph -------------------------------------------
   A 512-byte header, then fixed-size sectors (512 bytes in version 3,
   the version written here). The FAT chains sectors together; the
   directory is a chain of 128-byte entries forming one red-black tree
   of siblings per storage; streams smaller than 4096 bytes live in the
   "mini stream" — 64-byte mini sectors chained by the mini FAT, the
   whole mini stream itself being the root entry's data. The reader
   accepts version 3 and 4 files, DIFAT chains and the mini stream; the
   writer emits version 3 with as many FAT/DIFAT sectors as it needs.
   ================================================================== */
'use strict';

const CFB = (() => {
  const SIG = [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];
  const FREESECT = 0xFFFFFFFF, ENDOFCHAIN = 0xFFFFFFFE, FATSECT = 0xFFFFFFFD, DIFSECT = 0xFFFFFFFC;
  const NOSTREAM = 0xFFFFFFFF;
  const MINI_CUTOFF = 4096, MINI = 64, SECTOR = 512;

  // realm-blind on purpose: bytes may come from another window, a worker or node
  const tag = v => Object.prototype.toString.call(v);
  const u8 = data => {
    if (data instanceof Uint8Array) return data;
    if (tag(data) === '[object ArrayBuffer]') return new Uint8Array(data);
    if (data && ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    if (typeof data === 'string') return Uint8Array.from(data, c => c.charCodeAt(0) & 0xFF);
    throw new Error('CFB: expected bytes');
  };
  const isCFB = data => {
    try { const b = u8(data); return b.length >= 512 && SIG.every((v, i) => b[i] === v); }
    catch(e){ return false; }
  };

  /* ---------------- reading ---------------- */
  function read(data){
    const b = u8(data);
    if (!isCFB(b)) throw new Error('not an OLE2 compound file');
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const U16 = o => dv.getUint16(o, true), U32 = o => dv.getUint32(o, true);
    const ssz = 1 << U16(30), mssz = 1 << U16(32);
    const nDirSect = U32(40), nFat = U32(44), dirStart = U32(48);
    const cutoff = U32(56) || MINI_CUTOFF;
    const mfStart = U32(60), nMf = U32(64), difStart = U32(68), nDif = U32(72);
    const secOff = s => (s + 1) * ssz;
    const nSectors = Math.floor((b.length - ssz) / ssz) + 1;

    // the FAT sectors: 109 listed in the header, the rest in the DIFAT chain
    const fatSects = [];
    for (let i = 0; i < 109 && fatSects.length < nFat; i++){ const s = U32(76 + i * 4); if (s < 0xFFFFFFFA) fatSects.push(s); }
    for (let s = difStart, k = 0; s < 0xFFFFFFFA && k < nDif && fatSects.length < nFat; k++){
      const per = ssz / 4 - 1;
      for (let i = 0; i < per && fatSects.length < nFat; i++){ const v = U32(secOff(s) + i * 4); if (v < 0xFFFFFFFA) fatSects.push(v); }
      s = U32(secOff(s) + per * 4);
    }
    const fat = new Uint32Array(fatSects.length * ssz / 4);
    fatSects.forEach((s, i) => { for (let j = 0; j < ssz / 4; j++) fat[i * ssz / 4 + j] = U32(secOff(s) + j * 4); });

    const chain = (start, table, limit) => {
      const out = [], seen = new Set();
      for (let s = start; s < 0xFFFFFFFA; s = table[s]){
        if (seen.has(s) || s >= table.length || out.length > limit) throw new Error('CFB: broken sector chain');
        seen.add(s); out.push(s);
      }
      return out;
    };
    const readChain = (start, size) => {
      const out = new Uint8Array(size);
      let off = 0;
      for (const s of chain(start, fat, nSectors + 1)){
        const n = Math.min(ssz, size - off);
        if (n <= 0) break;
        out.set(b.subarray(secOff(s), secOff(s) + n), off); off += n;
      }
      return out;
    };
    const readAll = start => {
      const ss = chain(start, fat, nSectors + 1), out = new Uint8Array(ss.length * ssz);
      ss.forEach((s, i) => out.set(b.subarray(secOff(s), secOff(s) + ssz), i * ssz));
      return out;
    };

    // the directory
    const dirBytes = readAll(dirStart);
    const ddv = new DataView(dirBytes.buffer);
    const entries = [];
    for (let o = 0; o + 128 <= dirBytes.length; o += 128){
      const nameLen = ddv.getUint16(o + 64, true);
      let name = '';
      for (let i = 0; i + 1 < Math.min(nameLen, 64) - 1; i += 2) name += String.fromCharCode(ddv.getUint16(o + i, true));
      entries.push({
        name, type: dirBytes[o + 66],
        left: ddv.getUint32(o + 68, true), right: ddv.getUint32(o + 72, true), child: ddv.getUint32(o + 76, true),
        start: ddv.getUint32(o + 116, true),
        size: ddv.getUint32(o + 120, true) + (ssz === 4096 ? ddv.getUint32(o + 124, true) * 0x100000000 : 0),
      });
    }
    const root = entries[0];
    if (!root || root.type !== 5) throw new Error('CFB: no root entry');

    // the mini stream
    const miniFat = new Uint32Array(nMf * ssz / 4);
    if (nMf) chain(mfStart, fat, nSectors + 1).forEach((s, i) => {
      for (let j = 0; j < ssz / 4; j++) miniFat[i * ssz / 4 + j] = U32(secOff(s) + j * 4);
    });
    const miniStream = root.size ? readChain(root.start, root.size) : new Uint8Array(0);
    const readMini = (start, size) => {
      const out = new Uint8Array(size);
      let off = 0;
      for (const s of chain(start, miniFat, miniFat.length + 1)){
        const n = Math.min(mssz, size - off);
        if (n <= 0) break;
        out.set(miniStream.subarray(s * mssz, s * mssz + n), off); off += n;
      }
      return out;
    };

    // walk the tree: every storage's children are one sibling tree
    const streams = new Map(), storages = new Set();
    const walk = (sid, prefix, seen) => {
      if (sid === NOSTREAM || sid >= entries.length || seen.has(sid)) return;
      seen.add(sid);
      const e = entries[sid];
      walk(e.left, prefix, seen);
      const path = prefix ? prefix + '/' + e.name : e.name;
      if (e.type === 2){
        streams.set(path, e.size < cutoff ? readMini(e.start, e.size) : readChain(e.start, e.size));
      } else if (e.type === 1){
        storages.add(path);
        walk(e.child, path, seen);
      }
      walk(e.right, prefix, seen);
    };
    walk(root.child, '', new Set());
    return {
      version: U16(26), sectorSize: ssz, streams, storages,
      get(path){ return streams.get(path) || null; },
      list(){ return [...streams.keys()]; },
    };
  }

  /* ---------------- writing ---------------- */
  // CFB orders siblings by name length first, then by upper-cased name.
  const cmpName = (a, b) => (a.length - b.length) || (a.toUpperCase() < b.toUpperCase() ? -1 : a.toUpperCase() > b.toUpperCase() ? 1 : 0);

  function write(files){
    // 1. the tree of storages and streams
    const mk = (name, type) => ({ name, type, kids:new Map(), data:null });
    const root = mk('Root Entry', 5);
    for (const [path, data] of Object.entries(files)){
      const parts = String(path).split('/').filter(Boolean);
      if (!parts.length) continue;
      let node = root;
      parts.forEach((p, i) => {
        if (p.length > 31) throw new Error('CFB: entry name longer than 31 characters: ' + p);
        const last = i === parts.length - 1;
        if (!node.kids.has(p)) node.kids.set(p, mk(p, last ? 2 : 1));
        node = node.kids.get(p);
        if (last){
          if (node.type !== 2) throw new Error('CFB: "' + path + '" is both a storage and a stream');
          node.data = u8(data);
        }
      });
    }

    // 2. directory order: root first, then depth first
    const list = [];
    const visit = n => { n.sid = list.length; list.push(n); for (const k of n.kids.values()) visit(k); };
    visit(root);

    // 3. sibling trees: balanced binary search trees, coloured so they are
    //    valid red-black trees (the incomplete last level red, all else black)
    for (const n of list){
      const kids = [...n.kids.values()].sort((a, b) => cmpName(a.name, b.name));
      n.child = NOSTREAM;
      if (!kids.length) continue;
      const fullDepth = Math.floor(Math.log2(kids.length + 1));      // levels that are complete
      const build = (lo, hi, depth) => {
        if (lo > hi) return NOSTREAM;
        const mid = (lo + hi) >> 1, k = kids[mid];
        k.left = build(lo, mid - 1, depth + 1);
        k.right = build(mid + 1, hi, depth + 1);
        k.color = depth >= fullDepth ? 0 : 1;                         // 0 red, 1 black
        return k.sid;
      };
      n.child = build(0, kids.length - 1, 0);
    }

    // 4. the mini stream and the big streams
    const mini = [], miniFat = [], big = [];
    let miniLen = 0;
    for (const n of list){
      if (n.type !== 2) continue;
      const len = n.data.length;
      if (len === 0){ n.start = ENDOFCHAIN; continue; }
      if (len < MINI_CUTOFF){
        const count = Math.ceil(len / MINI);
        n.start = miniLen / MINI;
        for (let i = 0; i < count; i++) miniFat.push(i === count - 1 ? ENDOFCHAIN : n.start + i + 1);
        mini.push(n.data, new Uint8Array(count * MINI - len));
        miniLen += count * MINI;
      } else big.push(n);
    }
    const miniStream = concat(mini, miniLen);

    // 5. sector budget: big streams, mini stream, mini FAT, directory, FAT (+DIFAT)
    const sectorsOf = len => Math.ceil(len / SECTOR);
    const nDir = sectorsOf(list.length * 128);
    const nMiniFat = sectorsOf(miniFat.length * 4);
    const nMini = sectorsOf(miniStream.length);
    const nData = big.reduce((a, n) => a + sectorsOf(n.data.length), 0) + nMini + nMiniFat + nDir;
    let nFat = 1, nDif = 0;
    for (;;){
      nDif = nFat > 109 ? Math.ceil((nFat - 109) / (SECTOR / 4 - 1)) : 0;
      const need = Math.ceil((nData + nFat + nDif) / (SECTOR / 4));
      if (need <= nFat) break;
      nFat = need;
    }
    const total = nData + nFat + nDif;
    const fat = new Uint32Array(nFat * SECTOR / 4).fill(FREESECT);
    let next = 0;
    const allocChain = count => {
      if (!count) return ENDOFCHAIN;
      const start = next;
      for (let i = 0; i < count; i++) fat[start + i] = i === count - 1 ? ENDOFCHAIN : start + i + 1;
      next += count;
      return start;
    };
    for (const n of big) n.start = allocChain(sectorsOf(n.data.length));
    root.start = miniStream.length ? allocChain(nMini) : ENDOFCHAIN;
    root.size = miniStream.length;
    const miniFatStart = nMiniFat ? allocChain(nMiniFat) : ENDOFCHAIN;
    const dirStart = allocChain(nDir);
    const fatStart = next;
    for (let i = 0; i < nFat; i++) fat[next++] = FATSECT;
    const difStart = nDif ? next : ENDOFCHAIN;
    for (let i = 0; i < nDif; i++) fat[next++] = DIFSECT;

    // 6. assemble
    const out = new Uint8Array(SECTOR + total * SECTOR);
    const dv = new DataView(out.buffer);
    const at = s => SECTOR + s * SECTOR;
    SIG.forEach((v, i) => { out[i] = v; });
    dv.setUint16(24, 0x003E, true); dv.setUint16(26, 3, true); dv.setUint16(28, 0xFFFE, true);
    dv.setUint16(30, 9, true); dv.setUint16(32, 6, true);
    dv.setUint32(44, nFat, true); dv.setUint32(48, dirStart, true);
    dv.setUint32(56, MINI_CUTOFF, true);
    dv.setUint32(60, miniFatStart, true); dv.setUint32(64, nMiniFat, true);
    dv.setUint32(68, difStart, true); dv.setUint32(72, nDif, true);
    for (let i = 0; i < 109; i++) dv.setUint32(76 + i * 4, i < nFat ? fatStart + i : FREESECT, true);
    // DIFAT sectors: the FAT sectors past the first 109, chained by their last slot
    for (let d = 0; d < nDif; d++){
      const per = SECTOR / 4 - 1, base = at(difStart + d);
      for (let i = 0; i < per; i++){
        const k = 109 + d * per + i;
        dv.setUint32(base + i * 4, k < nFat ? fatStart + k : FREESECT, true);
      }
      dv.setUint32(base + per * 4, d === nDif - 1 ? ENDOFCHAIN : difStart + d + 1, true);
    }
    for (const n of big) out.set(n.data, at(n.start));
    if (miniStream.length) out.set(miniStream, at(root.start));
    if (nMiniFat){
      for (let i = 0; i < nMiniFat * SECTOR / 4; i++)
        dv.setUint32(at(miniFatStart) + i * 4, i < miniFat.length ? miniFat[i] : FREESECT, true);
    }
    for (let i = 0; i < fat.length; i++) dv.setUint32(at(fatStart) + i * 4, fat[i], true);

    // the directory entries (unused slots are empty entries)
    const dirOff = at(dirStart);
    for (let i = 0; i < nDir * SECTOR / 128; i++){
      const o = dirOff + i * 128, n = list[i];
      if (!n){
        dv.setUint32(o + 68, NOSTREAM, true); dv.setUint32(o + 72, NOSTREAM, true); dv.setUint32(o + 76, NOSTREAM, true);
        continue;
      }
      for (let c = 0; c < n.name.length; c++) dv.setUint16(o + c * 2, n.name.charCodeAt(c), true);
      dv.setUint16(o + 64, (n.name.length + 1) * 2, true);
      out[o + 66] = n.type;
      out[o + 67] = n === root ? 1 : n.color;
      dv.setUint32(o + 68, n === root ? NOSTREAM : n.left, true);
      dv.setUint32(o + 72, n === root ? NOSTREAM : n.right, true);
      dv.setUint32(o + 76, n.type === 2 ? NOSTREAM : n.child, true);
      dv.setUint32(o + 116, n.type === 1 ? 0 : n.start, true);
      dv.setUint32(o + 120, n === root ? root.size : n.type === 2 ? n.data.length : 0, true);
    }
    return out;
  }

  function concat(chunks, len){
    const out = new Uint8Array(len != null ? len : chunks.reduce((a, c) => a + c.length, 0));
    let o = 0;
    for (const c of chunks){ out.set(c, o); o += c.length; }
    return out;
  }

  return { read, write, isCFB, concat, u8 };
})();

/* ------------------------------------------------------------------
   ZIP — stored entries only. A project is a handful of small files and
   the point is one download, not compression; stored entries also keep
   the writer dependency-free and the output byte-for-byte deterministic.
   ------------------------------------------------------------------ */
const ZIP = (() => {
  const CRC = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++){ let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
  })();
  const crc32 = b => { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  const utf8 = s => typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(s) : Uint8Array.from(unescape(encodeURIComponent(s)), c => c.charCodeAt(0));
  const bytesOf = d => typeof d === 'string' ? utf8(d) : CFB.u8(d);

  function write(files, opts){
    const date = (opts && opts.date) || new Date(1980, 0, 1);
    const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
    const dosDate = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
    const locals = [], centrals = [];
    let offset = 0;
    for (const [name, data] of Object.entries(files)){
      const nb = utf8(name), body = bytesOf(data), crc = crc32(body);
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034B50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true);   // UTF-8 names
      lh.setUint16(8, 0, true); lh.setUint16(10, dosTime, true); lh.setUint16(12, dosDate, true);
      lh.setUint32(14, crc, true); lh.setUint32(18, body.length, true); lh.setUint32(22, body.length, true);
      lh.setUint16(26, nb.length, true); lh.setUint16(28, 0, true);
      locals.push(new Uint8Array(lh.buffer), nb, body);
      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014B50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true);
      ch.setUint16(10, 0, true); ch.setUint16(12, dosTime, true); ch.setUint16(14, dosDate, true);
      ch.setUint32(16, crc, true); ch.setUint32(20, body.length, true); ch.setUint32(24, body.length, true);
      ch.setUint16(28, nb.length, true); ch.setUint32(42, offset, true);
      centrals.push(new Uint8Array(ch.buffer), nb);
      offset += 30 + nb.length + body.length;
    }
    const cdSize = centrals.reduce((a, c) => a + c.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    const count = Object.keys(files).length;
    end.setUint32(0, 0x06054B50, true); end.setUint16(8, count, true); end.setUint16(10, count, true);
    end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
    return CFB.concat([...locals, ...centrals, new Uint8Array(end.buffer)]);
  }

  /* Stored entries only — enough to read back what write() produced, and a
     project zipped without compression. A deflated entry is reported. */
  function read(data){
    const b = CFB.u8(data), dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    let e = b.length - 22;
    while (e >= 0 && dv.getUint32(e, true) !== 0x06054B50) e--;
    if (e < 0) throw new Error('not a zip file');
    const n = dv.getUint16(e + 10, true);
    let o = dv.getUint32(e + 16, true);
    const out = new Map();
    const dec = typeof TextDecoder !== 'undefined' ? new TextDecoder() : null;
    for (let i = 0; i < n; i++){
      const method = dv.getUint16(o + 10, true), size = dv.getUint32(o + 20, true);
      const nl = dv.getUint16(o + 28, true), xl = dv.getUint16(o + 30, true), cl = dv.getUint16(o + 32, true);
      const lo = dv.getUint32(o + 42, true);
      const nameBytes = b.subarray(o + 46, o + 46 + nl);
      const name = dec ? dec.decode(nameBytes) : String.fromCharCode(...nameBytes);
      const start = lo + 30 + dv.getUint16(lo + 26, true) + dv.getUint16(lo + 28, true);
      if (method !== 0) throw new Error('zip entry "' + name + '" is compressed; only stored entries are read');
      out.set(name, b.slice(start, start + size));
      o += 46 + nl + xl + cl;
    }
    return out;
  }
  return { write, read, crc32 };
})();

if (typeof module !== 'undefined') module.exports = { CFB, ZIP };
