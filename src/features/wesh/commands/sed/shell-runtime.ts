import type { WeshCommandContext, WeshFileHandle } from '@/features/wesh/types';
import { createWriteHandleFromStream } from '@/features/wesh/utils/stream';

function concatenateSedShellOutput({
  chunks,
  byteLength,
}: {
  chunks: readonly Uint8Array[];
  byteLength: number;
}): Uint8Array {
  if (chunks.length === 0) return new Uint8Array(0);
  if (chunks.length === 1) return chunks[0]!;
  const output = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

export async function executeSedShellCommand({
  context,
  command,
  stdout,
}: {
  context: WeshCommandContext;
  command: string;
  stdout: WeshFileHandle;
}): Promise<void> {
  await context.executeCommand({
    command: 'sh',
    args: ['-c', command],
    stdin: context.stdin,
    stdout,
    stderr: context.stderr,
    ignoreAliases: true,
  });
}

export async function captureSedShellCommandOutput({
  context,
  command,
}: {
  context: WeshCommandContext;
  command: string;
}): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  const captureHandle = createWriteHandleFromStream({
    target: new WritableStream<Uint8Array>({
      write: async (chunk) => {
        const copy = new Uint8Array(chunk);
        chunks.push(copy);
        byteLength += copy.byteLength;
      },
    }),
  });
  try {
    await context.executeCommand({
      command: 'sh',
      args: ['-c', command],
      stdin: context.stdin,
      stdout: captureHandle,
      stderr: context.stderr,
      ignoreAliases: true,
    });
  } finally {
    await captureHandle.close();
  }
  return concatenateSedShellOutput({ chunks, byteLength });
}

export const TEST_ONLY = {
};
