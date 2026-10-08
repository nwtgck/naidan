// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import * as codec from './codec';
import { FramedDuplex } from './framing';
import { RpcConversation } from './call';
import { encodeProtocolHeader } from './protocol-header';
import { NaidanRpcError, NaidanRpcProtocolError, FRAME_BYTES } from './primitives';
import { createRpcProtocolAdvertisement, validateRpcProtocolAdvertisement } from './protocol-compatibility';

function framedAck(): Uint8Array {
  const payload = codec.encode({ value: { type: 'ack' }, limit: FRAME_BYTES }), bytes = new Uint8Array(payload.length + 4);
  new DataView(bytes.buffer).setUint32(0, payload.length, false); bytes.set(payload, 4); return bytes;
}
function joined({ parts }: { parts: Uint8Array[] }): Uint8Array {
  const bytes = new Uint8Array(parts.reduce((size, item) => size + item.length, 0)); let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset); offset += part.length;
  } return bytes;
}

afterEach(() => vi.restoreAllMocks());

it.each(Array.from({ length: 14 }, (_, split) => split))('validates split %s before reading a coalesced frame and emits its own header once', async split => {
  const header = encodeProtocolHeader(), writes: Uint8Array[] = [], onProtocolFailure = vi.fn();
  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      if (split) controller.enqueue(header.slice(0, split));
      controller.enqueue(joined({ parts: [header.slice(split), framedAck()] })); controller.close();
    },
  });
  const framed = new FramedDuplex({
    duplex: {
      readable,
      writable: new WritableStream({
        write(bytes) {
          writes.push(bytes.slice());
        },
      }),
      closed: Promise.resolve(),
      abort: () => {},
    },
    onProtocolFailure,
  });
  expect(await framed.read()).toEqual({ type: 'ack' }); expect(await framed.read()).toBeUndefined();
  await framed.send({ frame: { type: 'ack' } }); await framed.finish(); await framed.retire();
  expect(joined({ parts: writes })).toEqual(joined({ parts: [header, framedAck()] })); expect(onProtocolFailure).not.toHaveBeenCalled();
});

it.each(Array.from({ length: 13 }, (_, size) => size))('EOF after %s preamble bytes is distinct from successful EOF', async size => {
  const onProtocolFailure = vi.fn(), framed = new FramedDuplex({
    onProtocolFailure,
    duplex: {
      readable: new ReadableStream({
        start(controller) {
          if (size) controller.enqueue(encodeProtocolHeader().slice(0, size)); controller.close();
        },
      }),
      writable: new WritableStream(),
      closed: Promise.resolve(),
      abort: () => {},
    },
  });
  await expect(framed.read()).rejects.toMatchObject({ diagnostic: { kind: 'truncated-header', availableBytes: size } });
  expect(onProtocolFailure).toHaveBeenCalledOnce(); await framed.stop({ error: new Error('Fixture done') });
});

it.each(['wrong-magic', 'invalid', 'stable', 'experimental'] as const)('%s mismatch rejects before any value decoder or capability scan', async variant => {
  const bytes = encodeProtocolHeader();
  switch (variant) {
  case 'wrong-magic': bytes[0] = 1; break;
  case 'invalid': new DataView(bytes.buffer).setUint32(9, 0x80000000, true); break;
  case 'stable': new DataView(bytes.buffer).setUint32(9, 1, true); break;
  case 'experimental': new DataView(bytes.buffer).setUint32(9, 0x80000002, true); break;
  }
  const body = joined({ parts: [bytes, framedAck()] }), decode = vi.spyOn(codec, 'decode'), onProtocolFailure = vi.fn();
  const framed = new FramedDuplex({
    onProtocolFailure,
    duplex: {
      readable: new ReadableStream({
        start(controller) {
          controller.enqueue(body);
        },
      }),
      writable: new WritableStream(),
      closed: Promise.resolve(),
      abort: () => {},
    },
  });
  await expect(framed.read()).rejects.toBeInstanceOf(NaidanRpcProtocolError); expect(decode).not.toHaveBeenCalled();
  expect(onProtocolFailure).toHaveBeenCalledOnce(); await framed.stop({ error: new Error('Fixture done') });
});

it('reads concurrently with a held preamble write and joins that write during retirement', async () => {
  const release = Promise.withResolvers<void>(), writes = vi.fn(() => release.promise);
  const framed = new FramedDuplex({
    onProtocolFailure: () => {},
    duplex: {
      readable: new ReadableStream({
        start(controller) {
          controller.enqueue(joined({ parts: [encodeProtocolHeader(), framedAck()] }));
        },
      }),
      writable: new WritableStream({ write: writes }),
      closed: Promise.resolve(),
      abort: () => {},
    },
  });
  expect(await framed.read()).toEqual({ type: 'ack' }); expect(writes).toHaveBeenCalledOnce();
  let retired = false; const retirement = framed.stop({ error: new Error('Stop') }).then(() => {
    retired = true;
  });
  await Promise.resolve(); expect(retired).toBe(false); release.resolve(); await retirement; expect(retired).toBe(true);
});

it.each(['resolved', 'rejected'] as const)('commits incompatible state before reentrant stop and a late %s write', async outcome => {
  const release = Promise.withResolvers<void>(), writes: Uint8Array[] = [], wrong = encodeProtocolHeader(); wrong[0] = 1;
  let retirement: Promise<void> | undefined, primary: NaidanRpcProtocolError | undefined;
  const framed = new FramedDuplex({
    onProtocolFailure: ({ error }) => {
      primary = error; retirement = framed.stop({ error: new Error('Secondary stop') });
      void expect(framed.finish()).rejects.toBe(error);
    },
    duplex: {
      readable: new ReadableStream({
        start(controller) {
          controller.enqueue(wrong);
        },
      }),
      writable: new WritableStream({
        write(bytes) {
          writes.push(bytes.slice()); return release.promise;
        },
      }),
      closed: Promise.resolve(),
      abort: () => {},
    },
  });
  const queued = framed.send({ frame: { type: 'ack' } }); void queued.catch(() => {});
  await expect(framed.read()).rejects.toBeInstanceOf(NaidanRpcProtocolError); await expect(queued).rejects.toBe(primary);
  if (outcome === 'resolved') release.resolve(); else release.reject(new Error('Late write failure'));
  await retirement; expect(writes).toEqual([encodeProtocolHeader()]);
  await expect(framed.send({ frame: { type: 'ack' } })).rejects.toBe(primary);
});

it('transport-thrown header error lookalikes preserve I/O cause without parser provenance', async () => {
  const original = new NaidanRpcProtocolError({ diagnostic: { kind: 'unsupported-protocol-version', version: 1 } }), onProtocolFailure = vi.fn();
  const framed = new FramedDuplex({
    onProtocolFailure,
    duplex: {
      readable: new ReadableStream({
        start(controller) {
          controller.error(original);
        },
      }),
      writable: new WritableStream(),
      closed: Promise.resolve(),
      abort: () => {},
    },
  });
  await expect(framed.read()).rejects.toMatchObject({ code: 'TRANSPORT_ERROR', cause: original });
  expect(onProtocolFailure).not.toHaveBeenCalled(); await framed.stop({ error: original });
});

it('an unsolicited inbound preamble write failure aborts its pending read and retains the I/O cause', async () => {
  const original = new Error('Preamble transport write failed'), cancel = vi.fn(), onProtocolFailure = vi.fn();
  const call = new RpcConversation({
    role: 'callee',
    timeoutMs: undefined,
    resolveMethod: () => {
      throw new Error('No open expected');
    },
    onProtocolFailure,
    onRetirementFailure: () => {},
    duplex: {
      readable: new ReadableStream({ cancel }),
      writable: new WritableStream({
        write() {
          throw original;
        },
      }),
      closed: new Promise(() => {}),
      abort: () => {},
    },
  });
  await expect(call.closed.promise).rejects.toMatchObject({ code: 'TRANSPORT_ERROR', cause: original }); await call.retired.promise;
  expect(cancel).toHaveBeenCalledOnce(); expect(onProtocolFailure).not.toHaveBeenCalled();
});

it('public advertisement absence is allowed while present data is exactly the selected header', () => {
  expect(() => validateRpcProtocolAdvertisement({ bytes: new Uint8Array() })).not.toThrow();
  const bytes = createRpcProtocolAdvertisement(); expect(bytes).toEqual(encodeProtocolHeader()); validateRpcProtocolAdvertisement({ bytes });
  for (let size = 1; size < 13; size++) expect(() => validateRpcProtocolAdvertisement({ bytes: bytes.slice(0, size) })).toThrow(NaidanRpcProtocolError);
  expect(() => validateRpcProtocolAdvertisement({ bytes: joined({ parts: [bytes, new Uint8Array([0])] }) })).toThrow(NaidanRpcProtocolError);
  expect(() => validateRpcProtocolAdvertisement({ bytes: new Uint8Array(new SharedArrayBuffer(13)) })).toThrow(TypeError);
  new DataView(bytes.buffer).setUint32(9, 1, true);
  expect(() => validateRpcProtocolAdvertisement({ bytes })).toThrow('Incompatible RPC version');
  expect(new NaidanRpcError({ code: 'TRANSPORT_ERROR', cause: 0 }).cause).toBe(0);
});

it.each([undefined, null, false, 0, ''])('a falsy preamble write failure %s stays failed with its exact cause', async original => {
  const framed = new FramedDuplex({
    onProtocolFailure: () => {},
    duplex: {
      readable: new ReadableStream(),
      writable: new WritableStream({
        write() {
          return Promise.reject(original);
        },
      }),
      closed: new Promise(() => {}),
      abort: () => {},
    },
  });
  await expect(framed.preambleSent).rejects.toBe(original);
  await expect(framed.send({ frame: { type: 'ack' } })).rejects.toBe(original);
  await expect(framed.finish()).rejects.toBe(original); await expect(framed.read()).rejects.toBe(original);
  await framed.stop({ error: new Error('Later stop') });
});

it('a canceled late header read cannot report incompatibility or escape its retirement join', async () => {
  const readable = new ReadableStream<Uint8Array>(), readDone = Promise.withResolvers<ReadableStreamReadResult<Uint8Array>>(), originalReader = readable.getReader.bind(readable);
  vi.spyOn(readable, 'getReader').mockImplementation(() => {
    const reader = originalReader(); vi.spyOn(reader, 'read').mockReturnValue(readDone.promise); return reader;
  });
  const onProtocolFailure = vi.fn(), framed = new FramedDuplex({ onProtocolFailure, duplex: { readable, writable: new WritableStream(), closed: Promise.resolve(), abort: () => {} } });
  const reading = framed.read(), reason = new Error('Earlier cancellation'); void reading.catch(() => {});
  let retired = false; const stopped = framed.stop({ error: reason }).then(() => {
    retired = true;
  });
  await Promise.resolve(); expect(retired).toBe(false);
  const wrong = encodeProtocolHeader(); wrong[0] = 255; readDone.resolve({ done: false, value: wrong });
  await expect(reading).rejects.toBe(reason); await stopped; expect(onProtocolFailure).not.toHaveBeenCalled(); expect(readable.locked).toBe(false);
});
