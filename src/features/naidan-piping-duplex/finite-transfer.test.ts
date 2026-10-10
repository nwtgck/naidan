// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { AttemptError } from '@/features/naidan-piping-duplex/finite';
import { FiniteTransferEndpoint } from '@/features/naidan-piping-duplex/finite-transfer';
import { PipingRetirementError } from '@/features/naidan-piping-duplex/lifetime';

function endpoint() {
  return new FiniteTransferEndpoint({ baseUrl: 'https://relay.example', policy: 'https-only', timeoutMs: 1000 });
}

afterEach(() => vi.restoreAllMocks());

it('does not report a finite POST complete just because its 200 headers arrived', async () => {
  let status!: ReadableStreamDefaultController<Uint8Array>;
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      status = controller; controller.enqueue(new Uint8Array([1]));
    },
  })));
  let complete = false;
  const sent = endpoint().send({ route: 'post', bytes: new Uint8Array([7]), signal: new AbortController().signal }).then(() => {
    complete = true;
  });
  await Promise.resolve(); await Promise.resolve(); expect(complete).toBe(false);
  status.close(); await sent; expect(complete).toBe(true);
});

it('bounds a split GET and rejects trailing bytes instead of accepting a valid prefix', async () => {
  const cancel = vi.fn();
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1])); controller.enqueue(new Uint8Array([2, 3]));
    },
    cancel,
  })));
  await expect(endpoint().read({
    route: 'trailing',
    maximum: 3,
    signal: new AbortController().signal,
    consume: async ({ body }) => {
      expect(await body.take({ size: 2 })).toEqual(new Uint8Array([1, 2]));
    },
  })).rejects.toBeInstanceOf(AttemptError);
  expect(cancel).toHaveBeenCalledOnce();
});

it('bounds received bytes before retaining an oversized chunk', async () => {
  const cancel = vi.fn();
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(9));
    },
    cancel,
  })));
  await expect(endpoint().receive({ route: 'large', maximum: 8, signal: new AbortController().signal })).rejects.toBeInstanceOf(AttemptError);
  expect(cancel).toHaveBeenCalledOnce();
});

it('does not classify an already-errored response as failure to retire it', async () => {
  const transportError = new Error('connection reset');
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(transportError);
    },
  })));
  await expect(endpoint().receive({ route: 'errored', maximum: 8, signal: new AbortController().signal })).rejects.toBeInstanceOf(AttemptError);
});

it('reports underlying cancellation failure and does not silently release ownership', async () => {
  const retirementError = new Error('cancel failed');
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2]));
    },
    cancel() {
      return Promise.reject(retirementError);
    },
  })));
  await expect(endpoint().read({
    route: 'cancel-error',
    maximum: 2,
    signal: new AbortController().signal,
    consume: async ({ body }) => {
      await body.take({ size: 1 });
    },
  })).rejects.toBeInstanceOf(PipingRetirementError);
});

it('joins pending cancellation before completing an aborted receive', async () => {
  const started = Promise.withResolvers<void>(), retired = Promise.withResolvers<void>();
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new ReadableStream<Uint8Array>({
    pull() {
      started.resolve();
    },
    cancel: () => retired.promise,
  })));
  const controller = new AbortController(), reason = new Error('stop'); let settled = false;
  const reading = endpoint().receive({ route: 'cancel', maximum: 8, signal: controller.signal });
  void reading.then(() => {
    settled = true;
  }, () => {
    settled = true;
  });
  await started.promise; controller.abort(reason); await Promise.resolve(); await Promise.resolve();
  expect(settled).toBe(false); retired.resolve(); await expect(reading).rejects.toBe(reason);
});

it('owns and cancels a non-200 response body before allowing the next request', async () => {
  const cancel = vi.fn();
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new ReadableStream<Uint8Array>({ cancel }), { status: 503 }));
  await expect(endpoint().receive({ route: 'status', maximum: 8, signal: new AbortController().signal })).rejects.toMatchObject({ kind: 'transient', status: 503 });
  expect(cancel).toHaveBeenCalledOnce();
});
