import { imageModelSelectionSchema, peerImageParametersSchema, peerImagePreviewSchema, peerImageEventSchema } from '@/features/naidan-peer-rpc/contract';
import type { NaidanPeerClient, PeerImageEvent, PeerImageUpload } from '@/features/naidan-peer-rpc/contract';
import type { PeerImageInput, PeerProgress } from '@/features/naidan-peer-rpc/handlers/inference/resources';
import type { ImageExecutionOutput, ImageExecutionPreview, RecoverableImageExecutionOutput } from '@/features/image-generation/execution/types';
import { peerImageDimensions } from '@/features/naidan-peer-rpc/codecs/image-bounds';
import { validatePng } from '@/features/naidan-peer-rpc/codecs/png';

export type PeerImageOutcome =
  | { status: 'completed', output: ImageExecutionOutput, seed: string }
  | { status: 'interrupted', recoverable: RecoverableImageExecutionOutput, message: string }
  | { status: 'cancelled' }
  | { status: 'failed', message: string };
let nextRunId = 0;
export type PeerImageJob = { result: Promise<PeerImageOutcome>, cancel(): void };

function upload({ file }: { file: File }): PeerImageUpload {
  const mimeType = file.type;
  if (mimeType !== 'image/png' && mimeType !== 'image/jpeg' && mimeType !== 'image/webp') throw new Error('Unsupported input image format');
  if (!file.size || file.size > 16 * 1024 * 1024) throw new Error('Input image exceeds its transfer limit');
  return { mimeType, byteLength: file.size, data: file.stream() };
}

/** The caller owns the returned image and its persistence. This adapter neither
 * downloads models nor changes provider settings. No RPC is automatically
 * repeated after a disconnect, a save failure or an uncertain final handshake. */
export function startPeerImage({ client, input, signal, onProgress, onPreview }: {
  client: NaidanPeerClient, input: PeerImageInput, signal: AbortSignal,
  onProgress({ value }: { value: PeerProgress }): void,
  onPreview({ frame }: { frame: ImageExecutionPreview }): void,
}): PeerImageJob {
  if (signal.aborted) return { result: Promise.resolve({ status: 'cancelled' }), cancel() {} };
  // Freeze the effective request before any asynchronous work or input reads.
  const modelSelection = imageModelSelectionSchema.parse(input.modelSelection);
  const parameters = peerImageParametersSchema.parse(input.parameters);
  const preview = peerImagePreviewSchema.parse(input.preview);
  const files = [input.imageInputs.initial, ...input.imageInputs.references].filter((file): file is File => file !== undefined);
  if (input.imageInputs.references.length > 8 || files.reduce((total, file) => total + file.size, 0) > 64 * 1024 * 1024) throw new Error('Input images exceed the aggregate limit');
  const initial = input.imageInputs.initial ? upload({ file: input.imageInputs.initial }) : undefined;
  const references = input.imageInputs.references.map(file => upload({ file }));
  const stop = new AbortController(), lifetime = AbortSignal.any([signal, stop.signal]);
  const runId = ++nextRunId;
  const fileReference = ({ file }: { file: typeof modelSelection.primary.file }) => ({ ...file, expected: file.expected });
  const wireSelection = { primary: { ...modelSelection.primary, file: fileReference({ file: modelSelection.primary.file }) },
    components: modelSelection.components.map(item => ({ ...item, file: fileReference({ file: item.file }) })),
    loras: modelSelection.loras.map(item => ({ ...item, file: fileReference({ file: item.file }) })) };
  const call = client.generateImage({ input: { modelSelection: wireSelection, parameters, preview,
    imageInputs: { initial, references, strength: input.imageInputs.strength } }, on: { progress: onProgress }, signal: lifetime, timeoutMs: undefined });
  // Observe early rejection while result streams are still being read.
  const closed = call.closed.then(() => ({ ok: true as const }), () => ({ ok: false as const }));
  let pixels: Uint8Array<ArrayBuffer> | undefined;
  let completed: Extract<PeerImageEvent, { type: 'completed' }> | undefined;
  let imageReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let eventsReader: ReadableStreamDefaultReader<PeerImageEvent> | undefined;
  const cancelReaders = () => {
    void imageReader?.cancel().catch(() => {});
    void eventsReader?.cancel().catch(() => {});
  };
  const aborted = Promise.withResolvers<{ ok: false }>();
  const cancelled = () => {
    aborted.resolve({ ok: false });
    call.cancel({ reason: 'Image request cancelled' }); cancelReaders();
  };
  lifetime.addEventListener('abort', cancelled, { once: true });
  if (lifetime.aborted) cancelled();
  const result = (async (): Promise<PeerImageOutcome> => {
    try {
      const response = await call.result;
      lifetime.throwIfAborted();
      imageReader = response.image.getReader(); eventsReader = response.events.getReader();
      const readImage = async () => {
        const chunks: Uint8Array[] = []; let size = 0;
        for (;;) {
          const item = await imageReader!.read(); lifetime.throwIfAborted();
          if (item.done) break;
          if (!(item.value instanceof Uint8Array)) throw new Error('Invalid image chunk');
          size += item.value.length;
          if (size > 32 * 1024 * 1024) throw new Error('Image exceeds its transfer limit');
          chunks.push(item.value.slice());
        }
        const bytes = new Uint8Array(size); let at = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, at); at += chunk.length;
        }
        validatePng({ bytes, width: parameters.width, height: parameters.height });
        peerImageDimensions({ bytes, mimeType: 'image/png' });
        pixels = bytes;
      };
      const readEvents = async () => {
        let part: { header: Extract<PeerImageEvent, { type: 'preview-start' }>, bytes: Uint8Array<ArrayBuffer>, length: number } | undefined;
        let revision = 0;
        for (;;) {
          const next = await eventsReader!.read(); lifetime.throwIfAborted();
          if (next.done) {
            if (part || !completed) throw new Error('Image events ended without confirmation'); return;
          }
          const event = peerImageEventSchema.parse(next.value);
          if (completed) throw new Error('Image events continued after completion');
          switch (event.type) {
          case 'preview-start':
            if (!preview.enabled || part || event.revision <= revision || event.steps !== parameters.steps || event.step > event.steps) throw new Error('Invalid preview sequence');
            revision = event.revision; part = { header: event, bytes: new Uint8Array(event.byteLength), length: 0 }; break;
          case 'preview-chunk': {
            if (!part) throw new Error('Preview chunk has no header');
            const text = atob(event.data);
            if (!text.length || btoa(text) !== event.data || text.length > part.bytes.length - part.length) throw new Error('Invalid preview chunk');
            for (let i = 0; i < text.length; i++) part.bytes[part.length++] = text.charCodeAt(i);
            break;
          }
          case 'preview-end': {
            if (!part || part.length !== part.bytes.length) throw new Error('Incomplete preview');
            const { width, height } = peerImageDimensions({ bytes: part.bytes, mimeType: 'image/png' });
            if (width !== part.header.width || height !== part.header.height) throw new Error('Preview dimensions differ');
            onPreview({ frame: { type: 'naidan-image-preview-v1', runId, revision, step: part.header.step, steps: part.header.steps,
              width, height, mode: part.header.mode, png: new Blob([part.bytes], { type: 'image/png' }) } });
            part = undefined; break;
          }
          case 'completed':
            if (part || event.seed !== parameters.seed || event.width !== parameters.width || event.height !== parameters.height) throw new Error('Image confirmation differs from the request');
            completed = event; break;
          default: { const exhaustive: never = event; throw new Error(String(exhaustive)); }
          }
        }
      };
      const guard = async ({ run }: { run(): Promise<void> }) => {
        try {
          await run();
        } catch (error) {
          call.cancel({ reason: 'Invalid or interrupted image response' }); cancelReaders(); throw error;
        }
      };
      // Read both streams concurrently; waiting for one before reading the other
      // can deadlock bounded remote writers. A failure cancels its sibling.
      const tasks = [guard({ run: readImage }), guard({ run: readEvents })];
      const settled = await Promise.allSettled(tasks);
      if (settled.some(item => item.status === 'rejected')) throw new Error('Image delivery was interrupted');
      if (!(await Promise.race([closed, aborted.promise])).ok) throw new Error('Image delivery was not confirmed');
      lifetime.throwIfAborted();
      if (!pixels || !completed) throw new Error('Missing image confirmation');
      return { status: 'completed', seed: completed.seed,
        output: { png: new Blob([pixels], { type: 'image/png' }), width: completed.width, height: completed.height,
          modelVersion: completed.modelVersion, uniformOutput: completed.uniformOutput } };
    } catch {
      call.cancel({ reason: 'Image request ended without confirmed completion' }); cancelReaders();
      if (pixels) return { status: 'interrupted', recoverable: { png: new Blob([pixels], { type: 'image/png' }),
        width: parameters.width, height: parameters.height, reported: completed ? { seed: completed.seed, modelVersion: completed.modelVersion, uniformOutput: completed.uniformOutput } : undefined },
      message: 'Image received, but successful RPC completion was not confirmed' };
      return lifetime.aborted ? { status: 'cancelled' } : { status: 'failed', message: 'Image generation or delivery failed' };
    } finally {
      lifetime.removeEventListener('abort', cancelled);
      imageReader?.releaseLock(); eventsReader?.releaseLock();
    }
  })();
  return { result, cancel() {
    stop.abort();
  } };
}

export async function listPeerImageModels({ client, signal }: { client: NaidanPeerClient, signal: AbortSignal }) {
  const call = client.listImageModels({ input: {}, on: {}, signal, timeoutMs: undefined });
  let reader: ReadableStreamDefaultReader<Awaited<typeof call.result> extends ReadableStream<infer T> ? T : never> | undefined;
  const abort = () => {
    call.cancel({ reason: 'Image catalog cancelled' }); void reader?.cancel().catch(() => {});
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted(); reader = (await call.result).getReader();
    const values = [];
    for (;;) {
      const next = await reader.read(); signal.throwIfAborted(); if (next.done) break; if (values.length >= 256) throw new Error('Too many image models'); values.push(next.value);
    }
    await call.closed; return values;
  } catch (error) {
    abort(); throw error;
  } finally {
    signal.removeEventListener('abort', abort); reader?.releaseLock();
  }
}
export const TEST_ONLY = {
  upload,
};
