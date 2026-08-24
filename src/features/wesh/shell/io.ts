import type { WeshFileHandle } from '@/features/wesh/types';
import { createTextIoHelpers } from '@/features/wesh/utils/io';
import { encodeShellTextToBytes } from './byte-text';

async function writeAllShellTextToHandle({ handle, text }: {
  handle: WeshFileHandle,
  text: string,
}): Promise<void> {
  const data = encodeShellTextToBytes({ text });
  let totalWritten = 0;
  while (totalWritten < data.length) {
    const { bytesWritten } = await handle.write({
      buffer: data,
      offset: totalWritten,
      length: data.length - totalWritten,
    });
    if (bytesWritten === 0) {
      return;
    }
    totalWritten += bytesWritten;
  }
}

export function createShellTextIoHelpers({ stdin, stdout, stderr }: {
  stdin: WeshFileHandle,
  stdout: WeshFileHandle,
  stderr: WeshFileHandle,
}) {
  const base = createTextIoHelpers({ stdin, stdout, stderr });
  return {
    input: base.input,
    async print({ text }: { text: string }): Promise<void> {
      await writeAllShellTextToHandle({ handle: stdout, text });
    },
    async error({ text }: { text: string }): Promise<void> {
      await writeAllShellTextToHandle({ handle: stderr, text });
    },
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  writeAllShellTextToHandle,
};
