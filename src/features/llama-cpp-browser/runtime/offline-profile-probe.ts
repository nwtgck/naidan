import { chatProfileSchema, type ChatProfile } from './chat-profiles';

export async function probeOfflineLlamaProfiles({ signal }: { signal: AbortSignal }): Promise<ChatProfile[] | undefined> {
  if (typeof Worker === 'undefined' || signal.aborted) {
    return undefined;
  }
  const worker = new Worker(new URL('./offline-profile-probe-worker.ts', import.meta.url), { type: 'module' });
  const timeout = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
  const recommendation = new Promise<ChatProfile | undefined>(resolve => {
    // eslint-disable-next-line local-rules-worker-transport/no-unchecked-worker-transport -- Only this dedicated worker can supply the schema-checked recommendation.
    worker.onmessage = ({ data }: MessageEvent<unknown>) => {
      const parsed = chatProfileSchema.safeParse(data);
      resolve(parsed.success ? parsed.data : undefined);
    };
    worker.onerror = () => resolve(undefined);
    worker.onmessageerror = () => resolve(undefined);
    timeout.addEventListener('abort', () => resolve(undefined), { once: true });
  });
  try {
    const recommended = await recommendation;
    if (recommended === undefined || timeout.aborted) {
      return undefined;
    }
    // The read-only entry selects in the page, independently of the inference Worker.
    const { resolveRuntimeProfile } = await import('./detect-profile');
    const resolved = chatProfileSchema.safeParse(await resolveRuntimeProfile({ profile: 'auto' }));
    return resolved.success && !timeout.aborted ? [...new Set([recommended, resolved.data])] : undefined;
  } finally {
    worker.terminate();
  }
}

export const TEST_ONLY = {
};
