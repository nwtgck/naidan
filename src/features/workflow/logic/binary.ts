import type { WorkflowOutput } from './output-store';
import { readOutput } from './values';

/** Validate declared and actual byte counts before publishing an in-memory copy. */
export async function readWorkflowBinary({ output, maxBytes, signal }: {
  output: WorkflowOutput, maxBytes: number, signal: AbortSignal,
}): Promise<Uint8Array<ArrayBuffer>> {
  signal.throwIfAborted();
  const size = output.byteLength;
  if (!Number.isSafeInteger(size) || size < 1 || size > maxBytes) {
    throw new Error(`Binary input must contain 1–${maxBytes} bytes.`);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for await (const chunk of readOutput({ output, signal })) {
    if (chunk.byteLength > size - offset) {
      throw new Error('Binary input exceeds its declared size.');
    }
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  signal.throwIfAborted();
  if (offset !== size) {
    throw new Error('Binary input is truncated.');
  }
  return bytes;
}

export const TEST_ONLY = {
};
