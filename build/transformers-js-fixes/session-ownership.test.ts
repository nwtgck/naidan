// @vitest-environment node
import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { applyTransformersJsFixes, transformersJsFixesSha256 } from './transform';

const original = readFileSync('node_modules/@huggingface/transformers/dist/transformers.web.js', 'utf8');
const transformed = applyTransformersJsFixes({ code: original, version: '4.2.0' }).code;
type Session = { release(): Promise<void> };

function constructorSection({ code }: { code: string }) {
  const from = code.indexOf('async function constructSessions(');
  const to = code.indexOf('function replaceTensors(', from);
  if (from < 0 || to <= from) throw new Error('Missing reviewed session constructor');
  return code.slice(from, to);
}

function construct({ code, create }: { code: string; create: () => Promise<Session> }) {
  // The actual version-bound browser function is executed unchanged. The
  // metadata/backend functions are controlled boundaries, not real GPU work.
  const run = new Function('getSession', 'createInferenceSession', `${constructorSection({ code })}\nreturn constructSessions;`)(
    async () => ({ buffer_or_path: new Uint8Array([1]), session_options: {}, session_config: {} }), create,
  ) as (modelId: string, names: Record<string, string>, options: object) => Promise<Record<string, Session>>;
  return run('synthetic/session-ownership', { first: 'one', second: 'two', third: 'three' }, {});
}

it('retains the original partial-construction ownership failure as unchanged upstream evidence', async () => {
  expect(transformersJsFixesSha256({ code: constructorSection({ code: original }) })).toBe('33fbfa1f6180f9d6cea814affc29154a765489bf525d51a9479d00cc01f9107d');
  const release = vi.fn(async () => undefined);
  const failure = new Error('Original sibling creation failed');
  const create = vi.fn<() => Promise<Session>>()
    .mockResolvedValueOnce({ release }).mockRejectedValueOnce(failure).mockRejectedValueOnce(failure);
  await expect(construct({ code: original, create })).rejects.toBe(failure);
  expect(create).toHaveBeenCalledTimes(3);
  expect(release).not.toHaveBeenCalled();
});

it('transfers every successful session without releasing the completed model resources', async () => {
  const first = { release: vi.fn(async () => undefined) };
  const second = { release: vi.fn(async () => undefined) };
  const third = { release: vi.fn(async () => undefined) };
  const create = vi.fn<() => Promise<Session>>()
    .mockResolvedValueOnce(first).mockResolvedValueOnce(second).mockResolvedValueOnce(third);
  const sessions = await construct({ code: transformed, create });
  expect(sessions).toEqual({ first, second, third });
  expect(sessions.first).toBe(first);
  expect(first.release).not.toHaveBeenCalled();
  expect(second.release).not.toHaveBeenCalled();
  expect(third.release).not.toHaveBeenCalled();
});

it('requests release of all fulfilled siblings exactly once after construction fails', async () => {
  const completed: string[] = [];
  const first = { release: vi.fn(async () => {
    completed.push('first');
  }) };
  const second = { release: vi.fn(async () => {
    completed.push('second');
  }) };
  const failure = new Error('Last session creation failed');
  const create = vi.fn<() => Promise<Session>>()
    .mockResolvedValueOnce(first).mockResolvedValueOnce(second).mockRejectedValueOnce(failure);
  await expect(construct({ code: transformed, create })).rejects.toBe(failure);
  expect(first.release).toHaveBeenCalledOnce();
  expect(second.release).toHaveBeenCalledOnce();
  expect(completed).toEqual(['first', 'second']);
});

it('rejects immediately before any success and releases a late sibling without waiting for an unresolved sibling', async () => {
  const late = Promise.withResolvers<Session>();
  const failure = new Error('First session creation failed');
  const release = vi.fn(async () => undefined);
  const create = vi.fn<() => Promise<Session>>()
    .mockRejectedValueOnce(failure).mockReturnValueOnce(late.promise).mockReturnValueOnce(new Promise(() => undefined));
  await expect(construct({ code: transformed, create })).rejects.toBe(failure);
  expect(release).not.toHaveBeenCalled();
  late.resolve({ release });
  // Observe the late native promise continuation, not a timeout-based cleanup.
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(release).toHaveBeenCalledOnce();
});

it('does not replace the original failure with throwing or rejecting cleanup', async () => {
  const failure = new Error('Original native construction failure');
  const rejectedRelease = vi.fn(async () => {
    throw new Error('Rejected cleanup');
  });
  const throwingRelease = vi.fn((): Promise<void> => {
    throw new Error('Throwing cleanup');
  });
  const create = vi.fn<() => Promise<Session>>()
    .mockResolvedValueOnce({ release: rejectedRelease })
    .mockResolvedValueOnce({ release: throwingRelease }).mockRejectedValueOnce(failure);
  await expect(construct({ code: transformed, create })).rejects.toBe(failure);
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(rejectedRelease).toHaveBeenCalledOnce();
  expect(throwingRelease).toHaveBeenCalledOnce();
});

it('does not delay original rejection while a requested release remains unresolved', async () => {
  const failure = new Error('Sibling failure with held cleanup');
  const release = vi.fn(() => new Promise<void>(() => undefined));
  const create = vi.fn<() => Promise<Session>>()
    .mockResolvedValueOnce({ release }).mockRejectedValueOnce(failure).mockRejectedValueOnce(failure);
  await expect(construct({ code: transformed, create })).rejects.toBe(failure);
  expect(release).toHaveBeenCalledOnce();
});

it('does not release the same session twice if a backend aliases fulfilled handles', async () => {
  const session = { release: vi.fn(async () => undefined) };
  const failure = new Error('Aliased siblings followed by failure');
  const create = vi.fn<() => Promise<Session>>()
    .mockResolvedValueOnce(session).mockResolvedValueOnce(session).mockRejectedValueOnce(failure);
  await expect(construct({ code: transformed, create })).rejects.toBe(failure);
  expect(session.release).toHaveBeenCalledOnce();
});
