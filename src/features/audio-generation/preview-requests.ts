import type { AudioPreviewEvent } from './types';

/** Repeatable user intent, local to one generation. Unlike an AbortSignal, a
 * snapshot request can occur more than once. Pending requests are coalesced.
 * Only a generation-scoped number crosses the Worker boundary, never this object.
 */
export type AudioPreviewRequests = {
  readonly version: number,
  subscribe: ({ listener }: { listener: () => void }) => () => void,
};
export type AudioPreviewDelivery = {
  requests: AudioPreviewRequests,
  onPreview: ({ result, requestVersion }: AudioPreviewEvent) => void | Promise<void>,
};
export function createAudioPreviewRequests(): { requests: AudioPreviewRequests, request: () => void } {
  let version = 0;
  const listeners = new Set<() => void>();
  const requests: AudioPreviewRequests = {
    get version() {
      return version;
    },
    subscribe({ listener }) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return { requests, request: () => {
    if (version === Number.MAX_SAFE_INTEGER) throw new Error('Audio preview request limit reached');
    version++;
    for (const listener of [...listeners]) listener();
  } };
}
export const TEST_ONLY = {
};
