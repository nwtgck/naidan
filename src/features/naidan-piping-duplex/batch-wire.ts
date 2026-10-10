import { MAX_OFFSET, ownBytes, requireValue } from '@/features/naidan-piping-duplex/bytes';
import { encodeProtocolHeader, inspectProtocolHeader } from '@/features/naidan-piping-duplex/protocol-header';

export const BATCH_BYTES = 1_114_112;
export const BATCH_HEADER_BYTES = 16;
export const CIPHERTEXT_BYTES = 65_536;
export const PLAINTEXT_BYTES = CIPHERTEXT_BYTES - 16;
export const DATA_BYTES = 61_440;
export const RECORDS_PER_BATCH = 256;
export const FRAMES_PER_RECORD = 256;
export const STREAMS = 32;
export const CONNECTION_WINDOW = 4_194_304;
export const STREAM_WINDOW = 1_114_112;
export const MAX_STREAM_ID = 0xffffffff;
export const CONTROL_LIMIT = 128;

export type ReceiveLimits = { streams: number; connectionWindow: number; streamWindow: number };
export type ResetReason = 'cancelled' | 'capacity' | 'draining';
export type Frame =
  | { kind: 'ready'; limits: ReceiveLimits }
  | { kind: 'open'; id: number }
  | { kind: 'accept'; id: number }
  | { kind: 'fin'; id: number }
  | { kind: 'data'; id: number; bytes: Uint8Array }
  | { kind: 'reset'; id: number; reason: ResetReason }
  | { kind: 'window-stream'; id: number; released: bigint }
  | { kind: 'window-connection'; released: bigint }
  | { kind: 'ping' | 'pong' | 'close' | 'close-ack'; token: Uint8Array };

export function validateReceiveLimits({ limits }: { limits: ReceiveLimits }): ReceiveLimits {
  for (const [value, maximum] of [[limits.streams, STREAMS], [limits.connectionWindow, CONNECTION_WINDOW], [limits.streamWindow, STREAM_WINDOW]]) {
    requireValue({ condition: Number.isSafeInteger(value) && value! > 0 && value! <= maximum!, message: 'Invalid receive limits' });
  }
  return { ...limits };
}

function streamId({ id }: { id: number }): void {
  requireValue({ condition: Number.isInteger(id) && id >= 0 && id <= MAX_STREAM_ID, message: 'Invalid stream identifier' });
}

function counter({ value }: { value: bigint }): void {
  requireValue({ condition: typeof value === 'bigint' && value >= 0n && value <= MAX_OFFSET, message: 'Flow counter out of range' });
}

function resetCode({ reason }: { reason: ResetReason }): number {
  switch (reason) {
  case 'cancelled': return 0;
  case 'capacity': return 1;
  case 'draining': return 2;
  default: { const exhaustive: never = reason; throw new Error(String(exhaustive)); }
  }
}

function resetReason({ code }: { code: number }): ResetReason {
  switch (code) {
  case 0: return 'cancelled';
  case 1: return 'capacity';
  case 2: return 'draining';
  default: throw new Error('Unknown RESET reason');
  }
}

/** An owned encoding; no caller buffer can be mutated while native crypto is running. */
export function encodeFrame({ frame }: { frame: Frame }): Uint8Array<ArrayBuffer> {
  let kind: number;
  let payload: Uint8Array<ArrayBuffer>;
  switch (frame.kind) {
  case 'ready': {
    const limits = validateReceiveLimits({ limits: frame.limits });
    kind = 0; payload = new Uint8Array(10);
    const view = new DataView(payload.buffer);
    view.setUint16(0, limits.streams); view.setUint32(2, limits.connectionWindow); view.setUint32(6, limits.streamWindow);
    break;
  }
  case 'open': case 'accept': case 'fin':
    streamId({ id: frame.id });
    switch (frame.kind) {
    case 'open': kind = 1; break;
    case 'accept': kind = 2; break;
    case 'fin': kind = 4; break;
    default: { const exhaustive: never = frame; throw new Error(String(exhaustive)); }
    }
    payload = new Uint8Array(4); new DataView(payload.buffer).setUint32(0, frame.id);
    break;
  case 'data':
    streamId({ id: frame.id });
    requireValue({ condition: frame.bytes.byteLength > 0, message: 'Empty DATA' });
    requireValue({ condition: frame.bytes.byteLength <= DATA_BYTES, message: 'Oversized DATA' });
    kind = 3; payload = new Uint8Array(4 + frame.bytes.byteLength);
    new DataView(payload.buffer).setUint32(0, frame.id);
    payload.set(ownBytes({ bytes: frame.bytes, maxBytes: DATA_BYTES }), 4);
    break;
  case 'reset':
    streamId({ id: frame.id }); kind = 5; payload = new Uint8Array(5);
    new DataView(payload.buffer).setUint32(0, frame.id); payload[4] = resetCode({ reason: frame.reason });
    break;
  case 'window-stream':
    streamId({ id: frame.id }); counter({ value: frame.released }); kind = 7; payload = new Uint8Array(12);
    new DataView(payload.buffer).setUint32(0, frame.id); new DataView(payload.buffer).setBigUint64(4, frame.released);
    break;
  case 'window-connection':
    counter({ value: frame.released }); kind = 8; payload = new Uint8Array(8);
    new DataView(payload.buffer).setBigUint64(0, frame.released);
    break;
  case 'ping': case 'pong': case 'close': case 'close-ack': {
    const token = ownBytes({ bytes: frame.token, maxBytes: 32 });
    requireValue({ condition: token.length === 32, message: 'Invalid control token' });
    switch (frame.kind) {
    case 'ping': kind = 0x10; break;
    case 'pong': kind = 0x11; break;
    case 'close': kind = 0x12; break;
    case 'close-ack': kind = 0x13; break;
    default: { const exhaustive: never = frame; throw new Error(String(exhaustive)); }
    }
    payload = new Uint8Array(kind === 0x12 ? 33 : 32);
    payload.set(token, kind === 0x12 ? 1 : 0); // CLOSE reason 0 is the only v1 reason.
    break;
  }
  default: { const exhaustive: never = frame; throw new Error(String(exhaustive)); }
  }
  const bytes = new Uint8Array(5 + payload.length);
  bytes[0] = kind; new DataView(bytes.buffer).setUint32(1, payload.length); bytes.set(payload, 5);
  return bytes;
}

/** Validate the complete authenticated record before returning any of its frames. */
export function decodeFrames({ bytes }: { bytes: Uint8Array }): Frame[] {
  requireValue({ condition: bytes.byteLength > 0 && bytes.byteLength <= PLAINTEXT_BYTES, message: 'Invalid record plaintext length' });
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), frames: Frame[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    requireValue({ condition: frames.length < FRAMES_PER_RECORD && bytes.length - offset >= 5, message: 'Invalid frame count/header' });
    const kind = view.getUint8(offset), size = view.getUint32(offset + 1); offset += 5;
    requireValue({ condition: size <= bytes.length - offset, message: 'Truncated frame' });
    const exact = ({ expected }: { expected: number }) => requireValue({ condition: size === expected, message: 'Invalid frame size' });
    switch (kind) {
    case 0:
      exact({ expected: 10 });
      frames.push({
        kind: 'ready',
        limits: validateReceiveLimits({
          limits: {
            streams: view.getUint16(offset),
            connectionWindow: view.getUint32(offset + 2),
            streamWindow: view.getUint32(offset + 6),
          },
        }),
      });
      break;
    case 1: case 2: case 4:
      exact({ expected: 4 }); frames.push({ kind: kind === 1 ? 'open' : kind === 2 ? 'accept' : 'fin', id: view.getUint32(offset) }); break;
    case 3:
      requireValue({ condition: size > 4 && size <= DATA_BYTES + 4, message: 'Invalid DATA size' });
      frames.push({ kind: 'data', id: view.getUint32(offset), bytes: bytes.subarray(offset + 4, offset + size) }); break;
    case 5:
      exact({ expected: 5 }); frames.push({ kind: 'reset', id: view.getUint32(offset), reason: resetReason({ code: view.getUint8(offset + 4) }) }); break;
    case 7: case 8: {
      exact({ expected: kind === 7 ? 12 : 8 }); const released = view.getBigUint64(offset + (kind === 7 ? 4 : 0)); counter({ value: released });
      frames.push(kind === 7 ? { kind: 'window-stream', id: view.getUint32(offset), released } : { kind: 'window-connection', released }); break;
    }
    case 0x10: case 0x11: case 0x12: case 0x13: {
      exact({ expected: kind === 0x12 ? 33 : 32 });
      if (kind === 0x12) requireValue({ condition: bytes[offset] === 0, message: 'Unknown CLOSE reason' });
      const token = bytes.slice(offset + (kind === 0x12 ? 1 : 0), offset + size);
      frames.push({ kind: kind === 0x10 ? 'ping' : kind === 0x11 ? 'pong' : kind === 0x12 ? 'close' : 'close-ack', token }); break;
    }
    default: throw new Error('Unknown frame kind');
    }
    offset += size;
  }
  return frames;
}

export function batchHeader({ count }: { count: number }): Uint8Array<ArrayBuffer> {
  requireValue({ condition: Number.isInteger(count) && count > 0 && count <= RECORDS_PER_BATCH, message: 'Invalid record count' });
  const header = new Uint8Array(BATCH_HEADER_BYTES); header.set(encodeProtocolHeader()); header[13] = 0x20;
  new DataView(header.buffer).setUint16(14, count); return header;
}

export function inspectBatchHeader({ header }: { header: Uint8Array }): number {
  requireValue({ condition: header.length === BATCH_HEADER_BYTES && inspectProtocolHeader({ bytes: header, maxBytes: BATCH_HEADER_BYTES }).kind === 'supported' && header[13] === 0x20, message: 'Invalid batch header' });
  const count = new DataView(header.buffer, header.byteOffset, header.byteLength).getUint16(14);
  requireValue({ condition: count > 0 && count <= RECORDS_PER_BATCH, message: 'Invalid record count' }); return count;
}

export const TEST_ONLY = {
};
