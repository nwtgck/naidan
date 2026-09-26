import type { PreviewFrame } from '@/features/stable-diffusion-cpp-browser/types';
import { encodeImagePixels, type ImagePixels } from './image-output';

type Capture = { image: ImagePixels, maxEdge: number, frame: Omit<PreviewFrame, 'png' | 'width' | 'height'> };

/** One active encoder plus one replaceable pending frame. Never accumulate
 * native pixel copies or unacknowledged RPC callback promises per step. */
export function createPreviewOutput({ publish, valid, onError, encode = encodeImagePixels }: {
  publish: ({ frame }: { frame: PreviewFrame }) => void,
  valid: ({ revision }: { revision: number }) => boolean,
  onError: ({ error }: { error: unknown }) => void,
  encode?: typeof encodeImagePixels,
}) {
  let pending: Capture | undefined, task: Promise<void> | undefined, closed = false, dropped = 0;
  async function drain(): Promise<void> {
    while (pending && !closed) {
      const capture = pending; pending = undefined;
      if (!valid({ revision: capture.frame.revision })) continue;
      try {
        const image = await encode({ image: capture.image, maxEdge: capture.maxEdge });
        if (!closed && valid({ revision: capture.frame.revision })) publish({ frame: { ...capture.frame, ...image } });
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
      pending = capture;
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
