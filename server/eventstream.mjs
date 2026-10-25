const MAX_FRAME = 16 * 1024 * 1024;
const crcTable = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let value = i;
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  crcTable[i] = value >>> 0;
}

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255];
  return (crc ^ 0xffffffff) >>> 0;
}

function decodeHeaders(bytes) {
  const headers = Object.create(null);
  let offset = 0;
  const requireBytes = (length) => {
    if (offset + length > bytes.length) throw new Error("Truncated AWS event-stream header");
  };
  while (offset < bytes.length) {
    const nameLength = bytes[offset++];
    requireBytes(nameLength + 1);
    const name = bytes.toString("utf8", offset, offset + nameLength);
    offset += nameLength;
    const type = bytes[offset++];
    let length;
    if (type === 0 || type === 1) {
      headers[name] = type === 0;
      continue;
    }
    if (type === 6 || type === 7) {
      requireBytes(2);
      length = bytes.readUInt16BE(offset);
      offset += 2;
    } else {
      length = { 2: 1, 3: 2, 4: 4, 5: 8, 8: 8, 9: 16 }[type];
      if (length === undefined) throw new Error("Unknown AWS event-stream header type");
    }
    requireBytes(length);
    if (type === 7) headers[name] = bytes.toString("utf8", offset, offset + length);
    offset += length;
  }
  return headers;
}

// AWS/Smithy event-stream: 12-byte prelude, typed headers, payload, CRC32.
export async function* decodeEventStream(body, signal, onChunk = () => {}) {
  if (!body) throw new Error("Kiro returned an empty event stream");
  const reader = body.getReader();
  let pending = Buffer.alloc(0);
  const abort = () => {
    void reader.cancel(signal.reason).catch(() => {});
  };
  signal?.addEventListener("abort", abort, { once: true });
  let complete = false;
  try {
    signal?.throwIfAborted();
    while (true) {
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      onChunk();
      const bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
      pending = pending.length ? Buffer.concat([pending, bytes]) : bytes;
      while (pending.length >= 12) {
        const total = pending.readUInt32BE(0);
        const headerLength = pending.readUInt32BE(4);
        if (
          total < 16 ||
          total > MAX_FRAME ||
          headerLength > total - 16 ||
          headerLength > 128 * 1024
        )
          throw new Error("Invalid AWS event-stream frame length");
        if (crc32(pending.subarray(0, 8)) !== pending.readUInt32BE(8))
          throw new Error("AWS event-stream prelude checksum mismatch");
        if (pending.length < total) break;
        const frame = pending.subarray(0, total);
        if (crc32(frame.subarray(0, total - 4)) !== frame.readUInt32BE(total - 4))
          throw new Error("AWS event-stream message checksum mismatch");
        const headers = decodeHeaders(frame.subarray(12, 12 + headerLength));
        const payload = frame.subarray(12 + headerLength, total - 4);
        let data;
        try {
          data = payload.length ? JSON.parse(payload.toString("utf8")) : {};
        } catch {
          throw new Error("Invalid JSON in Kiro event stream");
        }
        pending = pending.subarray(total);
        yield { headers, data };
      }
    }
    if (pending.length) throw new Error("Truncated AWS event stream");
    complete = true;
  } catch (error) {
    // Fetch may reject its pending read with AbortError before cancel() settles.
    // Preserve the scope's timeout reason (or the caller's cancellation reason).
    signal?.throwIfAborted();
    throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
    if (!complete) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
