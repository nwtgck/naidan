import type { PeerImageEvent } from '@/features/naidan-peer-rpc/contract';
import { PEER_IMAGE_PREVIEW_CHUNK_BYTES } from '@/features/naidan-peer-rpc/contract';
import type { ImageExecutionOutput, ImageExecutionPreview } from '@/features/image-generation/execution/types';
import type { InferenceBudget } from './budget';
import { validatePng } from '@/features/naidan-peer-rpc/codecs/png';
import { createImageGenerationFailure } from '@/features/naidan-peer-rpc/handlers/inference/image-generation-failure';

const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const MAX_PREVIEW_BYTES = 4 * 1024 * 1024;

/** One native job produces both required streams. Preview delivery never blocks
 * sampling: there is at most one pending preview and one currently being sent.
 * Cancelling either required stream cancels the call, but never another job. */
export function createImageResponse({ signal, seed, width, height, budget, run }: {
  signal: AbortSignal; seed: string; width: number; height: number; budget: InferenceBudget;
  run({ signal, onPreview }: { signal: AbortSignal; onPreview({ frame }: { frame: ImageExecutionPreview }): void }): Promise<ImageExecutionOutput>;
}): { image: ReadableStream<Uint8Array>; events: ReadableStream<PeerImageEvent> } {
  const stop = new AbortController();
  let imageController: ReadableStreamDefaultController<Uint8Array> | undefined;
  let eventsController: ReadableStreamDefaultController<PeerImageEvent> | undefined;
  let job: Promise<ImageExecutionOutput> | undefined;
  let reservation: ReturnType<InferenceBudget['reserve']> | undefined;
  let output: ImageExecutionOutput | undefined;
  let failure: { error: unknown } | undefined;
  let imageDone = false, eventsDone = false, nativeDone = false;
  let pendingPreview: ImageExecutionPreview | undefined;
  let imageReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let wake: (() => void) | undefined;
  let revision = 0;
  // Native completion does not end Blob reads, stream pulls, or generator
  // cleanup. Keep their delivery reservation until all of that work retires.
  const deliveries = new Set<Promise<void>>();
  const changed = () => {
    const notify = wake; wake = undefined; notify?.();
  };
  const cleanup = () => {
    if (!imageDone || !eventsDone || job && !nativeDone || deliveries.size) return;
    pendingPreview = undefined; output = undefined; job = undefined;
    reservation?.release(); reservation = undefined;
    signal.removeEventListener('abort', aborted);
  };
  const track = ({ run }: { run(): Promise<void> }): Promise<void> => {
    const task = Promise.withResolvers<void>();
    deliveries.add(task.promise);
    // Register before running any callback, including synchronous cancellation.
    void Promise.resolve().then(run).then(() => {
      deliveries.delete(task.promise); cleanup(); task.resolve();
    }, error => {
      deliveries.delete(task.promise); cleanup(); task.reject(error);
    });
    void task.promise.catch(() => {});
    return task.promise;
  };
  const abort = ({ reason }: { reason: unknown }) => {
    if (stop.signal.aborted) return;
    stop.abort(reason); failure = { error: reason };
    pendingPreview = undefined;
    // A pending read must fail even when a native implementation ignores abort.
    if (!imageDone) imageController?.error(reason);
    if (!eventsDone) eventsController?.error(reason);
    imageDone = true; eventsDone = true;
    const reader = imageReader;
    if (reader) void track({
      run: async () => {
      try {
        await reader.cancel(reason);
      } finally {
        reader.releaseLock(); if (imageReader === reader) imageReader = undefined;
      }
    },
    });
    // Closing an errored ReadableStream does not close its async generator.
    // return() also waits for a pending preview arrayBuffer()/next() to finish.
    void track({
      run: async () => {
      await iterator.return(undefined);
    },
    });
    changed(); cleanup();
  };
  const aborted = () => abort({ reason: signal.reason });
  const start = (): Promise<ImageExecutionOutput> => {
    stop.signal.throwIfAborted();
    if (job) return job;
    // Reserve before input or native work. Slow readers retain a delivery slot,
    // not the engine's compute lease, which ends when run() settles.
    reservation = budget.reserve({ bytes: MAX_IMAGE_BYTES + 2 * MAX_PREVIEW_BYTES });
    let validating = false;
    job = Promise.resolve().then(async () => {
      stop.signal.throwIfAborted();
      const result = await run({
        signal: stop.signal,
        onPreview({ frame }) {
        if (stop.signal.aborted || nativeDone || frame.png.type !== 'image/png' || frame.png.size < 1 || frame.png.size > MAX_PREVIEW_BYTES ||
          frame.width < 1 || frame.height < 1 || frame.width > 1024 || frame.height > 1024) return;
        pendingPreview = frame; changed();
      },
      });
      stop.signal.throwIfAborted();
      validating = true;
      if (result.png.type !== 'image/png' || result.png.size < 33 || result.png.size > MAX_IMAGE_BYTES || result.width !== width || result.height !== height) throw new Error('Unexpected generated image');
      validatePng({ bytes: new Uint8Array(await result.png.slice(0, 33).arrayBuffer()), width, height });
      stop.signal.throwIfAborted();
      output = result; return result;
    }).catch(error => {
      const failure = stop.signal.aborted ? error : createImageGenerationFailure({
        error,
        stage: validating ? 'output-validation' : 'generation',
        reason: validating ? 'invalid-output' : 'generation-failed',
        profile: undefined,
        gpu: false,
        nativeContext: undefined,
      });
      abort({ reason: failure }); throw failure;
    }).finally(() => {
      nativeDone = true; changed(); cleanup();
    });
    void job.catch(() => {});
    return job;
  };
  const cancel = async ({ reason }: { reason: unknown }): Promise<void> => {
    abort({ reason: reason ?? new DOMException('Image call cancelled', 'AbortError') });
    // RPC retirement must not release reservations while physical work remains.
    await job?.catch(() => {});
    while (deliveries.size) await Promise.allSettled([...deliveries]);
    cleanup();
  };
  async function* imageEvents(): AsyncGenerator<PeerImageEvent> {
    start();
    for (;;) {
      stop.signal.throwIfAborted();
      const preview = pendingPreview; pendingPreview = undefined;
      if (preview) {
        const bytes = new Uint8Array(await preview.png.arrayBuffer());
        stop.signal.throwIfAborted();
        yield {
          type: 'preview-start',
          revision: ++revision,
          step: preview.step,
          steps: preview.steps,
          width: preview.width,
          height: preview.height,
          mode: preview.mode,
          byteLength: bytes.length,
        };
        // Base64 and the event's CBOR fields both count toward the RPC item
        // budget. Raw 16 KiB chunks exceed that budget after encoding.
        for (let at = 0; at < bytes.length; at += PEER_IMAGE_PREVIEW_CHUNK_BYTES) {
          stop.signal.throwIfAborted();
          yield { type: 'preview-chunk', data: btoa(String.fromCharCode(...bytes.subarray(at, at + PEER_IMAGE_PREVIEW_CHUNK_BYTES))) };
        }
        yield { type: 'preview-end' };
      } else if (nativeDone) {
        if (failure) throw failure.error;
        if (!output) throw new Error('Image computation did not produce a result');
        yield { type: 'completed', seed, width, height, modelVersion: output.modelVersion, uniformOutput: output.uniformOutput ?? false };
        return;
      } else {
        await new Promise<void>(resolve => {
          wake = resolve;
        });
      }
    }
  }
  const iterator = imageEvents();
  const image = new ReadableStream<Uint8Array>({
    start(controller) {
      imageController = controller;
    },
    pull(controller) {
      return track({
        run: async () => {
        try {
          const result = await start();
          stop.signal.throwIfAborted();
          imageReader ??= result.png.stream().getReader();
          const item = await imageReader.read();
          if (imageDone) return;
          if (item.done) {
            imageDone = true; controller.close(); imageReader.releaseLock(); imageReader = undefined; cleanup();
          } else controller.enqueue(item.value);
        } catch (error) {
          abort({ reason: stop.signal.aborted ? error : createImageGenerationFailure({ error, stage: 'image-delivery', reason: 'image-delivery-failed', profile: undefined, gpu: false, nativeContext: undefined }) });
        }
      },
      });
    },
    cancel: reason => cancel({ reason }),
  }, { highWaterMark: 0 });
  const events = new ReadableStream<PeerImageEvent>({
    start(controller) {
      eventsController = controller;
    },
    pull(controller) {
      return track({
        run: async () => {
        try {
          const item = await iterator.next();
          if (eventsDone) return;
          if (item.done) {
            eventsDone = true; controller.close(); cleanup();
          } else controller.enqueue(item.value);
        } catch (error) {
          abort({ reason: stop.signal.aborted ? error : createImageGenerationFailure({ error, stage: 'preview-delivery', reason: 'preview-delivery-failed', profile: undefined, gpu: false, nativeContext: undefined }) });
        }
      },
      });
    },
    cancel: reason => cancel({ reason }),
  }, { highWaterMark: 0 });
  signal.addEventListener('abort', aborted, { once: true });
  if (signal.aborted) aborted();
  return { image, events };
}
export const TEST_ONLY = {
};
