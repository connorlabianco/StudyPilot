// Small ZIP writer: CRC32 + Deflate (via the browser's CompressionStream) or Store.
// Builds the archive as a list of Blob parts so large files don't need one giant buffer.
// Limits: no ZIP64, so up to 65,535 files and 4 GB total, which is plenty for course folders.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes, crc = 0) {
  let c = ~crc >>> 0;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

// Files that are already compressed gain nothing from Deflate.
const STORE_EXT = /\.(zip|gz|tgz|bz2|xz|7z|rar|png|jpe?g|gif|webp|heic|mp4|mov|mp3|m4a|pdf|pptx|docx|xlsx|parquet|npz|pkl)$/i;

function dosDateTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (Math.floor(d.getSeconds() / 2));
  const date = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

async function deflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Make every path inside the zip safe on Windows/macOS and unique.
export function cleanZipPath(p) {
  return String(p).split("/").filter((s) => s && s !== "." && s !== "..").map((seg) => {
    let s = seg.replace(/[\\:*?"<>|\x00-\x1f]/g, "_").replace(/[. ]+$/g, "").trim();
    if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(s)) s = "_" + s;
    return s.slice(0, 120) || "_";
  }).join("/") || "file";
}

export class ZipWriter {
  constructor() {
    this.parts = [];      // Blob parts in output order
    this.central = [];    // central directory records
    this.offset = 0;
    this.names = new Set();
    this.count = 0;
  }

  uniqueName(name) {
    let n = cleanZipPath(name), i = 2;
    while (this.names.has(n.toLowerCase())) n = cleanZipPath(name).replace(/(\.[^./]+)?$/, ` (${i++})$1`);
    this.names.add(n.toLowerCase());
    return n;
  }

  async add(name, data, { date = new Date() } = {}) {
    if (this.count >= 65535) throw new Error("Too many files for one zip");
    const bytes = data instanceof Uint8Array ? data
      : typeof data === "string" ? new TextEncoder().encode(data)
      : new Uint8Array(await new Blob([data]).arrayBuffer());
    const path = this.uniqueName(name);
    const nameBytes = new TextEncoder().encode(path);
    const crc = crc32(bytes);
    let method = 0, body = bytes;
    if (!STORE_EXT.test(path) && bytes.length > 256) {
      const def = await deflateRaw(bytes);
      if (def.length < bytes.length * 0.95) { method = 8; body = def; }
    }
    if (this.offset + body.length > 0xfffffff0) throw new Error("Zip would be larger than 4 GB");
    const { time, date: d } = dosDateTime(date instanceof Date ? date : new Date(date));

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);         // version needed
    local.setUint16(6, 0x0800, true);     // flags: UTF-8 names
    local.setUint16(8, method, true);
    local.setUint16(10, time, true);
    local.setUint16(12, d, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, body.length, true);
    local.setUint32(22, bytes.length, true);
    local.setUint16(26, nameBytes.length, true);
    local.setUint16(28, 0, true);
    this.parts.push(local.buffer, nameBytes, body);

    const cen = new DataView(new ArrayBuffer(46));
    cen.setUint32(0, 0x02014b50, true);
    cen.setUint16(4, 20, true);
    cen.setUint16(6, 20, true);
    cen.setUint16(8, 0x0800, true);
    cen.setUint16(10, method, true);
    cen.setUint16(12, time, true);
    cen.setUint16(14, d, true);
    cen.setUint32(16, crc, true);
    cen.setUint32(20, body.length, true);
    cen.setUint32(24, bytes.length, true);
    cen.setUint16(28, nameBytes.length, true);
    cen.setUint32(42, this.offset, true);
    this.central.push(cen.buffer, nameBytes);

    this.offset += 30 + nameBytes.length + body.length;
    this.count++;
    return path;
  }

  finish() {
    const cenSize = this.central.reduce((a, p) => a + (p.byteLength ?? p.length), 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, this.count, true);
    end.setUint16(10, this.count, true);
    end.setUint32(12, cenSize, true);
    end.setUint32(16, this.offset, true);
    return new Blob([...this.parts, ...this.central, end.buffer], { type: "application/zip" });
  }
}
