/** Legacy native BF16 conversion retains the source read buffer while
 * materializing the selected destination type. This per-tensor lower bound
 * does not apply to the versioned bounded device reader. */
export function bf16ConversionMemory({ elements, target }: { elements: bigint, target: 'f32' | 'f16' }): { sourceBytes: bigint, destinationBytes: bigint, simultaneousBytes: bigint } {
  if (elements < 0n) {
    throw new Error('BF16 tensor element count must be nonnegative');
  }
  const sourceBytes = elements * 2n;
  let destinationBytes: bigint;
  switch (target) {
  case 'f32': destinationBytes = elements * 4n;
    break;
  case 'f16': destinationBytes = elements * 2n;
    break;
  default: {
    const exhaustive: never = target;
    throw new Error(String(exhaustive));
  }
  }
  return { sourceBytes, destinationBytes, simultaneousBytes: sourceBytes + destinationBytes };
}

/** Call only for a tensor known to be consumed and converted by this load.
 * Passing this check does not establish that the complete model will fit. */
export function assertBf16ConversionFitsMemory({ tensorName, elements, target, maximumMemoryBytes }: {
  tensorName: string, elements: bigint, target: 'f32' | 'f16', maximumMemoryBytes: bigint,
}): void {
  if (maximumMemoryBytes <= 0n) {
    throw new Error('Wasm memory cap must be positive');
  }
  const { sourceBytes, destinationBytes, simultaneousBytes } = bf16ConversionMemory({ elements, target });
  if (simultaneousBytes > maximumMemoryBytes) {
    throw new Error(`BF16 tensor ${tensorName} cannot be converted to ${target.toUpperCase()} in this configuration: its source read buffer (${sourceBytes} bytes) and destination (${destinationBytes} bytes) require at least ${simultaneousBytes} bytes together, exceeding the Wasm memory cap of ${maximumMemoryBytes} bytes. Host RAM and weight residency do not increase this cap.`);
  }
}

export const TEST_ONLY = {
};
