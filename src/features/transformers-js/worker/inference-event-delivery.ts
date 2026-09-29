import { inferenceGenerationEventSchema, type InferenceGenerationCallback, type InferenceGenerationEvent } from '@/features/transformers-js/generation-events';

// Synchronous native streamers cannot await host backpressure. Bound their
// queued payload and abort rather than silently dropping an accepted prefix.
const limits = { events: 1024, textCodeUnits: 1024 * 1024 } as const;

function payloadSize({ event }: { event: InferenceGenerationEvent }): number {
  switch (event.type) {
  case 'text_delta': return event.text.length;
  case 'tool_call': return String(event.toolCall.id).length + event.toolCall.function.name.length + event.toolCall.function.arguments.length;
  case 'part_start': case 'part_end': case 'tool_start': case 'result': return 0;
  default: { const exhaustive: never = event; throw new Error(`Unhandled inference event: ${exhaustive}`); }
  }
}

export function createInferenceEventDelivery({ onEvent, onFailure }: {
  onEvent: InferenceGenerationCallback,
  onFailure: () => void,
}) {
  let tail = Promise.resolve();
  let accepting = true;
  let count = 0;
  let size = 0;
  let failure: { error: unknown } | undefined;
  let consumerFailed = false;
  function fail({ error }: { error: unknown }): void {
    if (failure !== undefined) return;
    failure = { error };
    try {
      onFailure();
    } catch { /* Preserve the first delivery failure. */ }
  }
  return {
    enqueue({ event }: { event: InferenceGenerationEvent }): void {
      if (!accepting) throw new Error('Inference delivery is closed.');
      if (failure !== undefined) throw failure.error;
      let copied: InferenceGenerationEvent;
      try {
        copied = inferenceGenerationEventSchema.parse(event);
      } catch (error) {
        fail({ error }); throw error;
      }
      const bytes = payloadSize({ event: copied });
      if (count >= limits.events || size + bytes > limits.textCodeUnits) {
        const error = new Error('Inference delivery buffer limit exceeded.');
        fail({ error }); throw error;
      }
      count++; size += bytes;
      tail = tail.then(async () => {
        // An overflow stops the source but drains earlier accepted events. A
        // failed consumer is different: calling it again is not a safe retry.
        if (!consumerFailed) await onEvent({ event: copied });
      }).catch(error => {
        consumerFailed = true; fail({ error });
      }).finally(() => {
        count--; size -= bytes;
      });
    },
    async finish(): Promise<void> {
      accepting = false;
      await tail;
      if (failure !== undefined) throw failure.error;
    },
  };
}

export const TEST_ONLY = {
  limits,
};
