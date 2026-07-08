/**
 * AWS `application/vnd.amazon.eventstream` binary encoder.
 *
 * Frame layout (all integers big-endian):
 *   [totalLength u32][headersLength u32][preludeCRC u32]
 *   [headers...][payload...][messageCRC u32]
 *
 * Header layout:
 *   [nameLen u8][name][valueType u8=7 (string)][valueLen u16][value]
 *
 * Kiro's bundled CodeWhisperer client parses exactly this format for the
 * streaming AI response, so the proxy must emit it verbatim.
 */

export const EVENT_STREAM_CONTENT_TYPE = "application/vnd.amazon.eventstream";

const HEADER_TYPE_STRING = 7;

const CRC32_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer, start: number, end: number): number {
  let crc = 0xffffffff;
  for (let i = start; i < end; i++) {
    crc = CRC32_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ -1) >>> 0;
}

function encodeHeader(name: string, value: string): Buffer {
  const nameBuf = Buffer.from(name, "utf8");
  const valBuf = Buffer.from(value, "utf8");
  const buf = Buffer.alloc(1 + nameBuf.length + 1 + 2 + valBuf.length);
  let off = 0;
  buf.writeUInt8(nameBuf.length, off);
  off += 1;
  nameBuf.copy(buf, off);
  off += nameBuf.length;
  buf.writeUInt8(HEADER_TYPE_STRING, off);
  off += 1;
  buf.writeUInt16BE(valBuf.length, off);
  off += 2;
  valBuf.copy(buf, off);
  return buf;
}

function encodeFrame(headers: Buffer, payload: Buffer): Buffer {
  const headersLen = headers.length;
  const total = 12 + headersLen + payload.length + 4;
  const buf = Buffer.alloc(total);
  let off = 0;
  buf.writeUInt32BE(total, off);
  off += 4;
  buf.writeUInt32BE(headersLen, off);
  off += 4;
  buf.writeUInt32BE(crc32(buf, 0, 8), off);
  off += 4;
  headers.copy(buf, off);
  off += headersLen;
  payload.copy(buf, off);
  off += payload.length;
  buf.writeUInt32BE(crc32(buf, 0, off), off);
  return buf;
}

/** Encode a normal `event` message with a JSON payload. */
export function encodeEvent(eventType: string, payload: unknown): Buffer {
  const headers = Buffer.concat([
    encodeHeader(":message-type", "event"),
    encodeHeader(":event-type", eventType),
    encodeHeader(":content-type", "application/json"),
  ]);
  return encodeFrame(headers, Buffer.from(JSON.stringify(payload), "utf8"));
}

/** Encode an `exception` message (used for error surfacing to Kiro). */
export function encodeException(exceptionType: string, payload: unknown): Buffer {
  const headers = Buffer.concat([
    encodeHeader(":message-type", "exception"),
    encodeHeader(":exception-type", exceptionType),
    encodeHeader(":content-type", "application/json"),
  ]);
  return encodeFrame(headers, Buffer.from(JSON.stringify(payload), "utf8"));
}
