/** Bounded admission, not a lossy microphone buffer. Overflow aborts the turn
 * visibly instead of silently sending a different utterance to the model. */
export function createLiveAudioQueue({ maximumSamples, send, onError }: {
  maximumSamples: number,
  send: ({ pcm, sequence }: { pcm: Float32Array, sequence: number }) => Promise<void>,
  onError: ({ error }: { error: unknown }) => void,
}) {
  let tail = Promise.resolve();
  let queuedSamples = 0;
  let sequence = 0;
  let state: 'open' | 'closed' = 'open';
  let failure: { error: unknown } | undefined;
  const fail = ({ error }: { error: unknown }) => {
    if (failure) {
      return;
    }
    failure = { error };
    state = 'closed';
    onError({ error });
  };
  return {
    push({ pcm }: { pcm: Float32Array }): void {
      if (state === 'closed' || !pcm.length) {
        return;
      }
      if (queuedSamples + pcm.length > maximumSamples) {
        fail({ error: new Error('Live audio input cannot keep up; this turn was discarded') });
        return;
      }
      const copy = pcm.slice();
      const index = sequence++;
      queuedSamples += copy.length;
      tail = tail.then(async () => {
        try {
          if (!failure) {
            await send({ pcm: copy, sequence: index });
          }
        } catch (error) {
          fail({ error });
        } finally {
          queuedSamples -= copy.length;
        }
      });
    },
    async finish(): Promise<void> {
      state = 'closed';
      await tail;
      if (failure) {
        throw failure.error;
      }
    },
    async discard(): Promise<void> {
      state = 'closed';
      failure ??= { error: new Error('Live audio input discarded') };
      await tail;
    },
  };
}

export const TEST_ONLY = {
};
