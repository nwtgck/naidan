// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { createOwnedImageEngine, ImageEngineBusyError } from './owned-engine';
import type { ImageClient } from '@/features/stable-diffusion-cpp-browser/worker/types';
import type { Request, WorkerResult, PreviewSettings } from '@/features/stable-diffusion-cpp-browser/types';

function fixture() {
  const gate = Promise.withResolvers<WorkerResult>();
  const raw: ImageClient = {
    generate: vi.fn(() => gate.promise),
    cancel: vi.fn(),
    updatePreview: vi.fn(),
    release: vi.fn(),
    dispose: vi.fn(),
    inspectEngine: vi.fn<ImageClient['inspectEngine']>(async () => ({ status: 'unavailable', reason: 'not-loaded' })),
  };
  const factory = vi.fn(() => raw);
  const engine = createOwnedImageEngine({ createClient: factory });
  const a = engine.createOwner({ onReleased: undefined }), b = engine.createOwner({ onReleased: undefined });
  const args = { request: {} as Request, signal: new AbortController().signal, onProgress() {} };
  const output: WorkerResult = { cancelled: true, modelResident: true };
  return { gate, raw, factory, a, b, args, output };
}
it('is lazy and prevents concurrent native work before it starts', async () => {
  const { a, b, factory, raw, args, gate, output } = fixture();
  expect(factory).not.toHaveBeenCalled();
  const pending = a.generate(args);
  await expect(b.generate(args)).rejects.toBeInstanceOf(ImageEngineBusyError);
  expect(raw.generate).toHaveBeenCalledTimes(1);
  gate.resolve(output); await pending; a.dispose(); b.dispose();
});
it('late cancel, preview and dispose cannot control a later owner', async () => {
  const { a, b, raw, args, gate, output } = fixture();
  const first = a.generate(args); gate.resolve(output); await first;
  const next = Promise.withResolvers<WorkerResult>(); vi.mocked(raw.generate).mockReturnValue(next.promise);
  const second = b.generate(args);
  a.cancel(); a.updatePreview({ settings: {} as PreviewSettings }); a.release(); a.dispose();
  expect(raw.cancel).not.toHaveBeenCalled(); expect(raw.updatePreview).not.toHaveBeenCalled();
  expect(raw.release).not.toHaveBeenCalled(); expect(raw.dispose).not.toHaveBeenCalled();
  next.resolve(output); await second; b.dispose();
  expect(raw.dispose).toHaveBeenCalledTimes(1);
});
it('retains the reservation while a producer ignores an owner abort', async () => {
  const { a, b, raw, args, gate, output } = fixture();
  const pending = a.generate(args); a.dispose();
  expect(vi.mocked(raw.generate).mock.calls[0]![0].signal.aborted).toBe(true);
  await expect(b.generate(args)).rejects.toBeInstanceOf(ImageEngineBusyError);
  gate.resolve(output); await pending;
  await expect(b.generate(args)).resolves.toEqual(output); b.dispose();
});
it('never exposes an engine inspection to a different owner', async () => {
  const { a, b, raw, args, gate, output } = fixture();
  const pending = a.generate(args);
  await expect(b.inspectEngine()).resolves.toEqual({ status: 'unavailable', reason: 'busy' });
  gate.resolve(output); await pending;
  await expect(b.inspectEngine()).resolves.toEqual({ status: 'unavailable', reason: 'not-loaded' });
  expect(raw.inspectEngine).not.toHaveBeenCalled(); a.dispose(); b.dispose();
});
it('a disposed owner cannot restart even after the engine becomes idle', async () => {
  const { a, b, args, factory } = fixture(); a.dispose();
  await expect(a.generate(args)).rejects.toThrow(); expect(factory).not.toHaveBeenCalled(); b.dispose();
});
it('an already aborted request never acquires or creates an engine', async () => {
  const { a, b, args, factory } = fixture(); const stop = new AbortController(); stop.abort();
  await expect(a.generate({ ...args, signal: stop.signal })).rejects.toThrow();
  expect(factory).not.toHaveBeenCalled(); a.dispose(); b.dispose();
});
it('does not return inspection data after the native cache moved to another owner', async () => {
  const { a, b, raw, args, gate, output } = fixture();
  const first = a.generate(args); gate.resolve(output); await first;
  const inspect = Promise.withResolvers<Awaited<ReturnType<ImageClient['inspectEngine']>>>();
  vi.mocked(raw.inspectEngine).mockReturnValueOnce(inspect.promise);
  const pending = a.inspectEngine();
  await b.generate(args);
  const report = { status: 'unavailable', reason: 'unsupported' } as const;
  inspect.resolve(report);
  await expect(pending).resolves.toEqual({ status: 'unavailable', reason: 'not-loaded' });
  a.dispose(); b.dispose();
});
it('ignores a released notification from a disposed native client after replacement', async () => {
  const { args, output } = fixture();
  const callbacks: Array<() => void> = [];
  const clients: ImageClient[] = [];
  const engine = createOwnedImageEngine({
    createClient: ({ onReleased }) => {
      callbacks.push(onReleased);
      const client: ImageClient = {
        generate: vi.fn(async () => output),
        cancel: vi.fn(),
        release: vi.fn(),
        dispose: vi.fn(),
        updatePreview: vi.fn(),
        inspectEngine: vi.fn<ImageClient['inspectEngine']>(async () => ({ status: 'unavailable', reason: 'unsupported' })),
      };
      clients.push(client); return client;
    },
  });
  const old = engine.createOwner({ onReleased: undefined });
  await old.generate(args); old.dispose();
  const notified = vi.fn(), current = engine.createOwner({ onReleased: notified });
  await current.generate(args); callbacks[0]!();
  expect(notified).not.toHaveBeenCalled();
  await expect(current.inspectEngine()).resolves.toEqual({ status: 'unavailable', reason: 'unsupported' });
  expect(clients[1]!.inspectEngine).toHaveBeenCalledOnce(); current.dispose();
});

it('reserves a complete batch without allocating native resources and protects gaps between images', async () => {
  const { a, b, args, factory, raw, gate, output } = fixture();
  const lease = a.reserve!({ signal: args.signal }); expect(factory).not.toHaveBeenCalled();
  await expect(b.generate(args)).rejects.toBeInstanceOf(ImageEngineBusyError);
  const first = a.generate(args); gate.resolve(output); await first;
  await expect(b.generate(args)).rejects.toBeInstanceOf(ImageEngineBusyError);
  b.release(); expect(raw.release).not.toHaveBeenCalled();
  await a.generate(args); lease.release(); await expect(b.generate(args)).resolves.toEqual(output);
  // A delayed old lease release cannot unlock the new owner's reservation.
  const current = b.reserve!({ signal: args.signal }); lease.release();
  await expect(a.generate(args)).rejects.toBeInstanceOf(ImageEngineBusyError);
  current.release(); a.dispose(); b.dispose();
});
it('keeps an aborted batch reserved until native retirement, then releases it', async () => {
  const { a, b, args, gate, output } = fixture(), stop = new AbortController();
  a.reserve!({ signal: stop.signal }); const pending = a.generate({ ...args, signal: stop.signal }); stop.abort();
  await expect(b.generate(args)).rejects.toBeInstanceOf(ImageEngineBusyError);
  gate.resolve(output); await pending;
  await expect(b.generate(args)).resolves.toEqual(output); a.dispose(); b.dispose();
});
it('drops a disposed idle owner reservation without touching another owner', async () => {
  const { a, b, args, gate, output } = fixture();
  a.reserve!({ signal: args.signal }); a.dispose();
  const next = b.generate(args); gate.resolve(output); await expect(next).resolves.toEqual(output); b.dispose();
});
