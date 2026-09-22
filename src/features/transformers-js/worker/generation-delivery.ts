/** Owns ordered callback acknowledgements without retaining completed deliveries. */
export function createGenerationDelivery({ onFailure }: { onFailure: () => void }) {
  let tail = Promise.resolve();
  let accepting = true;
  let failure: { error: unknown } | undefined;
  return {
    enqueue({ deliver }: { deliver: () => void | Promise<void> }): void {
      if (!accepting || failure !== undefined) return;
      // Streamers are synchronous. Only this owner awaits remote callbacks;
      // each acknowledgement releases the preceding delivery from the chain.
      tail = tail.then(async () => {
        if (failure !== undefined) return;
        await deliver();
      }).catch(error => {
        failure = { error };
        try {
          onFailure();
        } catch { /* Preserve the delivery error if interruption also fails. */ }
      });
    },
    async finish(): Promise<void> {
      accepting = false;
      await tail;
      if (failure !== undefined) throw failure.error;
    },
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
export const TEST_ONLY = {
};
