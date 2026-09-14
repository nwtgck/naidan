// @vitest-environment node
import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { applyTransformersJsFixes } from './transform';

const original = readFileSync('node_modules/@huggingface/transformers/dist/transformers.web.js', 'utf8');
const transformed = applyTransformersJsFixes({ code: original, version: '4.2.0' }).code;
type Session = { release(): Promise<void>; config?: object };
function fixture({ code, create, isWeb = true }: { code: string; create: () => Promise<Session>; isWeb?: boolean }) {
  const start = code.indexOf('async function createInferenceSession(');
  const end = code.indexOf('\nvar webInferenceChain', start);
  const constructorStart = code.indexOf('async function constructSessions(');
  const constructorEnd = code.indexOf('function replaceTensors(', constructorStart);
  if (start < 0 || end <= start || constructorStart < 0 || constructorEnd <= constructorStart) throw new Error('Missing pinned session boundaries');
  // Execute the real two browser functions together. Only metadata, diagnostic
  // availability and native ORT entry are controlled, without model allocation.
  return new Function('InferenceSession', 'getSession', `
    const apis = { IS_WEB_ENV: ${String(isWeb)} };
    let webInitChain = Promise.resolve();
    const env = {}; const LogLevel = { WARNING: 1 };
    const getOnnxLogSeverityLevel = () => 1;
    const ensureWasmLoaded = async () => {};
    const naidanCreateModelLoadObserver = () => undefined;
    ${code.slice(start, end)}
    ${code.slice(constructorStart, constructorEnd)}
    return { session: () => createInferenceSession(new Uint8Array([1]), {}, {}),
      model: () => constructSessions('synthetic/model', { first: 'one', second: 'two' }, {}) };
  `)({ create }, async () => ({ buffer_or_path: new Uint8Array([1]), session_options: {}, session_config: {} })) as {
    session(): Promise<Session>;
    model(): Promise<Record<string, Session>>;
  };
}

it('retains the original rejected-tail failure as unmodified upstream evidence', async () => {
  const failure = new Error('Original backend initialization failure');
  const create = vi.fn<() => Promise<Session>>().mockRejectedValueOnce(failure)
    .mockResolvedValue({ release: async () => undefined });
  const runtime = fixture({ code: original, create });
  await expect(runtime.session()).rejects.toBe(failure);
  await expect(runtime.session()).rejects.toBe(failure);
  expect(create).toHaveBeenCalledOnce();
});

it('preserves non-Web direct entry without making another caller wait for a held session', async () => {
  const held = Promise.withResolvers<Session>();
  const owned = { release: vi.fn(async () => undefined) };
  const create = vi.fn<() => Promise<Session>>().mockReturnValueOnce(held.promise).mockResolvedValueOnce(owned);
  const runtime = fixture({ code: transformed, create, isWeb: false });
  const failure = new Error('Independent non-Web rejection');
  const first = expect(runtime.session()).rejects.toBe(failure);
  await expect(runtime.session()).resolves.toBe(owned);
  expect(create).toHaveBeenCalledTimes(2);
  held.reject(failure);
  await first;
  expect(owned.release).not.toHaveBeenCalled();
});

it('recovers only the tail while preserving rejection identity and serial order of queued sessions', async () => {
  const a = Promise.withResolvers<Session>();
  const b = Promise.withResolvers<Session>();
  const second = { release: vi.fn(async () => undefined) };
  const third = { release: vi.fn(async () => undefined) };
  const create = vi.fn<() => Promise<Session>>().mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise).mockResolvedValueOnce(third);
  const runtime = fixture({ code: transformed, create });
  const firstRun = runtime.session();
  const secondRun = runtime.session();
  const thirdRun = runtime.session();
  const failure = new Error('First native failure');
  const firstRejected = expect(firstRun).rejects.toBe(failure);
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(create).toHaveBeenCalledOnce();
  a.reject(failure);
  await firstRejected;
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(create).toHaveBeenCalledTimes(2);
  b.resolve(second);
  await expect(secondRun).resolves.toBe(second);
  await expect(thirdRun).resolves.toBe(third);
  expect(create).toHaveBeenCalledTimes(3);
  expect(second.release).not.toHaveBeenCalled();
  expect(third.release).not.toHaveBeenCalled();
});

it('releases a queued late sibling once without releasing the next caller owned session', async () => {
  const failed = Promise.withResolvers<Session>();
  const late = Promise.withResolvers<Session>();
  const orphan = { release: vi.fn(async () => undefined) };
  const owned = { release: vi.fn(async () => undefined) };
  const create = vi.fn<() => Promise<Session>>().mockReturnValueOnce(failed.promise).mockReturnValueOnce(late.promise).mockResolvedValueOnce(owned);
  const runtime = fixture({ code: transformed, create });
  const failure = new Error('Model sibling failed');
  const rejected = expect(runtime.model()).rejects.toBe(failure);
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(create).toHaveBeenCalledOnce();
  failed.reject(failure);
  await rejected;
  const next = runtime.session();
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(create).toHaveBeenCalledTimes(2);
  expect(orphan.release).not.toHaveBeenCalled();
  late.resolve(orphan);
  await expect(next).resolves.toBe(owned);
  expect(orphan.release).toHaveBeenCalledOnce();
  expect(owned.release).not.toHaveBeenCalled();
});
