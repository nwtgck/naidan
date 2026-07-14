export function concatenateBytes({ parts }: {
  parts: readonly Uint8Array[];
}): Uint8Array {
  let byteLength = 0;
  for (const part of parts) {
    byteLength += part.byteLength;
  }

  const result = new Uint8Array(byteLength);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

export function bytesEqual({ left, right }: {
  left: Uint8Array;
  right: Uint8Array;
}): boolean {
  if (left.byteLength !== right.byteLength) {
    return false;
  }

  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

export function toExactArrayBuffer({ bytes }: {
  bytes: Uint8Array;
}): ArrayBuffer {
  const result = new Uint8Array(bytes.byteLength);
  result.set(bytes);
  return result.buffer;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
