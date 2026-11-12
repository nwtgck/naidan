/** The execution budget covers persistent state and scheduler compute buffers,
 * not the model's weight files. Views and dead activations must be accounted by
 * the native allocator, not by summing all declared tensor shapes. */
export function checkModelGraphMemoryBudget({ phase, stateBytes, computeBytes, maximumBytes, contextTokens, batchTokens }: {
  phase: 'state' | 'graph'; stateBytes: bigint; computeBytes: bigint; maximumBytes: number; contextTokens: number; batchTokens: number;
}): void {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || stateBytes < 0n || computeBytes < 0n) {
    throw new Error('Invalid model graph memory budget');
  }
  const total = stateBytes + computeBytes;
  if (total <= BigInt(maximumBytes)) {
    return;
  }
  let subject: string;
  switch (phase) {
  case 'state': subject = 'State';
    break;
  case 'graph': subject = 'Graph';
    break;
  default: {
    const exhaustive: never = phase;
    throw new Error(String(exhaustive));
  }
  }
  throw new Error(`${subject} allocation budget exceeded: persistent state ${stateBytes} bytes + compute buffers ${computeBytes} bytes = ${total} bytes; limit ${maximumBytes} bytes (context ${contextTokens}, batch ${batchTokens}). Reduce the context or prefill batch size. Model weights are additional and are not included in this budget.`);
}

/** Size arithmetic must fit size_t before native metadata is constructed.
 * This is an address-width constraint, not the sum of activation lifetimes. */
export function checkModelGraphAddressWidth({ pointerBytes, largestTensorBytes, stateBytes }: {
  pointerBytes: number; largestTensorBytes: number; stateBytes: number;
}): void {
  if (pointerBytes !== 4 && pointerBytes !== 8) {
    throw new Error('Unsupported model graph pointer width');
  }
  if (!Number.isSafeInteger(largestTensorBytes) || !Number.isSafeInteger(stateBytes) || largestTensorBytes < 0 || stateBytes < 0) {
    throw new Error('Invalid model graph tensor byte size');
  }
  if (pointerBytes === 4 && (largestTensorBytes > 0xffffffff || stateBytes > 0xffffffff)) {
    throw new Error('Registered graph tensor or state sizes exceed the 32-bit runtime address width; use a 64-bit runtime or reduce the context');
  }
}

export const TEST_ONLY = {
};
