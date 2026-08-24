export function concatBytes({ chunks }: { chunks: readonly Uint8Array[] }): Uint8Array {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

export function bytesToHex({ bytes }: { bytes: Uint8Array }): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

export function hexToBytes({ hex }: { hex: string }): Uint8Array {
  if (!/^[0-9a-f]+$/u.test(hex) || hex.length % 2 !== 0) {
    throw new Error(`Invalid hexadecimal value: ${hex}`);
  }
  const result = new Uint8Array(hex.length / 2);
  for (let index = 0; index < result.length; index += 1) {
    result[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return result;
}

export function compareBytes({ left, right }: { left: Uint8Array, right: Uint8Array }): number {
  const commonLength = Math.min(left.byteLength, right.byteLength);
  for (let index = 0; index < commonLength; index += 1) {
    const difference = left[index]! - right[index]!;
    if (difference !== 0) return difference;
  }
  return left.byteLength - right.byteLength;
}

export const TEST_ONLY = {
};
