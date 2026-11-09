// Minimal ZIP reader (enough for .pptx / .docx) using the browser's built-in DecompressionStream.
// Reads the central directory, then inflates only the entries asked for.

export function listZip(buf) {
  const u8 = new Uint8Array(buf), dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  // Find End Of Central Directory record (signature 0x06054b50), scanning back from the end.
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("Not a ZIP file");
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const entries = new Map();
  const dec = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true);
    const size = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true), extraLen = dv.getUint16(p + 30, true), commentLen = dv.getUint16(p + 32, true);
    const localOffset = dv.getUint32(p + 42, true);
    const name = dec.decode(u8.subarray(p + 46, p + 46 + nameLen));
    entries.set(name, { name, method, compSize, size, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return { u8, dv, entries };
}

export async function readEntry(zip, name, as = "text") {
  const e = zip.entries.get(name);
  if (!e) return null;
  const { u8, dv } = zip;
  const lh = e.localOffset;
  const start = lh + 30 + dv.getUint16(lh + 26, true) + dv.getUint16(lh + 28, true);
  const raw = u8.subarray(start, start + e.compSize);
  let bytes;
  if (e.method === 0) bytes = raw;
  else if (e.method === 8) {
    const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  } else throw new Error(`Unsupported ZIP compression ${e.method}`);
  return as === "text" ? new TextDecoder().decode(bytes) : bytes;
}
