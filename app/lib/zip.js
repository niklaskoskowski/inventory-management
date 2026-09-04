/**
 * A store-only ZIP writer.
 *
 * There is no bundler and nothing is vendored for this, so the archive is
 * assembled by hand — it is only three record types. Method 0 (stored, no
 * compression) throughout: everything we pack is a PNG, which is already
 * deflated, so compressing it again would cost CPU and save nothing.
 *
 * No ZIP64. The format's 32-bit fields cap an entry and the archive at 4 GB,
 * and a shelf of label PNGs is measured in hundreds of kilobytes.
 */

// Table-based CRC-32 (the ZIP polynomial, 0xEDB88320 reflected). Built once on
// first use rather than at import time — most sessions never write an archive.
let crcTable = null;

function crc32Table() {
  if (crcTable) return crcTable;
  crcTable = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let bit = 0; bit < 8; bit += 1) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    crcTable[i] = c >>> 0;
  }
  return crcTable;
}

function crc32(bytes) {
  const table = crc32Table();
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i += 1) {
    c = table[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/**
 * MS-DOS date and time, the only timestamp the base format has: two-second
 * resolution, local time, no zone, years counted from 1980.
 */
function dosStamp(date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time: time & 0xFFFF, date: day & 0xFFFF };
}

/** Little-endian writer over a DataView, because every ZIP field is LE. */
function writer(view) {
  let at = 0;
  return {
    u16(value) { view.setUint16(at, value, true); at += 2; },
    u32(value) { view.setUint32(at, value, true); at += 4; },
    bytes(src) { new Uint8Array(view.buffer, at, src.length).set(src); at += src.length; },
    get offset() { return at; },
  };
}

/**
 * `entries` is `[{name, data: Uint8Array}]`, in the order they should appear.
 * Returns a `Blob` ready for an object URL.
 */
export function buildZip(entries = []) {
  const utf8 = new TextEncoder();
  const stamp = dosStamp(new Date());

  const rows = entries.map((entry) => ({
    name: utf8.encode(entry.name),
    data: entry.data,
    crc: crc32(entry.data),
  }));

  const localSize = rows.reduce((sum, row) => sum + 30 + row.name.length + row.data.length, 0);
  const centralSize = rows.reduce((sum, row) => sum + 46 + row.name.length, 0);
  const buffer = new ArrayBuffer(localSize + centralSize + 22);
  const out = writer(new DataView(buffer));

  // Flag bit 11 says the name is UTF-8. Ours always is: TextEncoder emits
  // nothing else, and a reader that ignores the bit still gets ASCII right.
  const FLAG_UTF8 = 0x0800;
  const offsets = [];

  rows.forEach((row) => {
    offsets.push(out.offset);
    out.u32(0x04034B50);            // local file header signature
    out.u16(20);                    // version needed to extract (2.0)
    out.u16(FLAG_UTF8);
    out.u16(0);                     // method 0 — stored
    out.u16(stamp.time);
    out.u16(stamp.date);
    out.u32(row.crc);
    out.u32(row.data.length);       // compressed size == uncompressed size
    out.u32(row.data.length);
    out.u16(row.name.length);
    out.u16(0);                     // extra field length
    out.bytes(row.name);
    out.bytes(row.data);
  });

  const centralAt = out.offset;
  rows.forEach((row, index) => {
    out.u32(0x02014B50);            // central directory header signature
    out.u16(20);                    // version made by
    out.u16(20);                    // version needed to extract
    out.u16(FLAG_UTF8);
    out.u16(0);
    out.u16(stamp.time);
    out.u16(stamp.date);
    out.u32(row.crc);
    out.u32(row.data.length);
    out.u32(row.data.length);
    out.u16(row.name.length);
    out.u16(0);                     // extra field length
    out.u16(0);                     // file comment length
    out.u16(0);                     // disk number start
    out.u16(0);                     // internal attributes
    out.u32(0);                     // external attributes
    out.u32(offsets[index]);        // offset of the local header
    out.bytes(row.name);
  });

  out.u32(0x06054B50);              // end of central directory
  out.u16(0);                       // this disk
  out.u16(0);                       // disk with the central directory
  out.u16(rows.length);             // entries on this disk
  out.u16(rows.length);             // entries in total
  out.u32(centralSize);             // size of the central directory
  out.u32(centralAt);               // where it starts
  out.u16(0);                       // archive comment length

  return new Blob([buffer], { type: 'application/zip' });
}
