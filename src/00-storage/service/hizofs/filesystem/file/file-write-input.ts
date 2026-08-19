declare const capturedFileWriteBytesBrand: unique symbol;

/**
 * Bytes synchronously copied from a mutable write caller before any asynchronous
 * boundary. The brand lets internal write layers move ownership of that isolated
 * buffer without taking another full snapshot merely to re-establish the same
 * proof. Once a lower layer accepts ownership, only that owner may erase it.
 */
export type CapturedFileWriteBytes = Uint8Array & Readonly<{
  [capturedFileWriteBytesBrand]: "captured_file_write_bytes";
}>;

export function captureFileWriteBytes({ bytes }: { bytes: Uint8Array }): CapturedFileWriteBytes {
  return bytes.slice() as CapturedFileWriteBytes;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
