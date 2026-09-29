import type { ImageDiagnosticInput } from '@/features/stable-diffusion-cpp-browser/diagnostics';
import type { PreviewFrame } from '@/features/stable-diffusion-cpp-browser/types';
import { encodeImagePixels, type ImagePixels } from './image-output';

type Capture = { image: ImagePixels, maxEdge: number, frame: Omit<PreviewFrame, 'png' | 'width' | 'height'> };

/** One active encoder plus one replaceable pending frame. Never accumulate
 * native pixel copies or unacknowledged RPC callback promises per step. */
export function createPreviewOutput({ publish, valid, onError, onMeasure, now = () => performance.now(), encode = encodeImagePixels }: {
  publish: ({ frame }: { frame: PreviewFrame }) => void,
  valid: ({ revision }: { revision: number }) => boolean,
  onError: ({ error }: { error: unknown }) => void,
  encode?: typeof encodeImagePixels, now?: () => number,
  onMeasure?: ({ fields }: { fields: ImageDiagnosticInput['fields'] }) => void,
}) {
  let pending: (Capture & { queuedAt: number }) | undefined, task: Promise<void> | undefined, closed = false, dropped = 0;
  async function drain(): Promise<void> {
    while (pending && !closed) {
      const capture = pending; pending = undefined;
      if (!valid({ revision: capture.frame.revision })) continue;
      const started = onMeasure ? now() : 0;
      try {
        const image = await encode({ image: capture.image, maxEdge: capture.maxEdge });
        const encodedAt = onMeasure ? now() : 0;
        const delivered = !closed && valid({ revision: capture.frame.revision });
        if (delivered) publish({ frame: { ...capture.frame, ...image } });
        if (!closed && onMeasure) try {
          onMeasure({ fields: { step: capture.frame.step, revision: capture.frame.revision,
            mode: capture.frame.mode, nativeWidth: capture.image.width, nativeHeight: capture.image.height,
            outputWidth: image.width, outputHeight: image.height, maxEdge: capture.maxEdge, pngBytes: image.png.size,
            queueWallMs: Math.max(0, started - capture.queuedAt), encodeWallMs: Math.max(0, encodedAt - started),
            delivered, overwrittenFrames: dropped, includesNativeDecode: false,
          } });
        } catch { /* measurement only */ }
      } catch (error) {
        try {
          onError({ error });
        } catch { /* preview diagnostics cannot fail generation */ }
      }
    }
  }
  function start(): void {
    if (!task && pending && !closed) task = drain().finally(() => {
      task = undefined; start();
    });
  }
  return {
    push({ capture }: { capture: Capture }): void {
      if (closed) return;
      if (pending) dropped++;
      pending = { ...capture, queuedAt: onMeasure ? now() : 0 };
      start();
    },
    async finish(): Promise<void> {
      while (task) await task;
    },
    close(): void {
      closed = true; pending = undefined;
    },
    dropped(): number {
      return dropped;
    },
  };
}
export const TEST_ONLY = {
};
