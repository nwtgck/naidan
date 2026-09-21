import { z } from 'zod';
import { LlamaCppBrowserError } from '@/features/llama-cpp-browser/types';

const probeIdSchema = z.uuid();
function probeName({ probeId }: { probeId: string }): string {
  return `.naidan-llama-shared-probe-${probeIdSchema.parse(probeId)}`;
}

/** Worker endpoint: never accepts an arbitrary model path or reads model data. */
export async function verifyStorage({ probeId }: { probeId: string }): Promise<boolean> {
  const name = probeName({ probeId });
  const root = await navigator.storage.getDirectory();
  const handle = await root.getFileHandle(name);
  const file = await handle.getFile();
  return file.size === probeId.length && await file.text() === probeId;
}

/** A Blob Worker's file:// storage key must actually agree with the window's.
 * The temporary file is separate from model directories and is always removed. */
export async function verifySharedStorage({ verify, signal }: {
  verify: ({ probeId }: { probeId: string }) => Promise<boolean>,
  signal: AbortSignal | undefined,
}): Promise<void> {
  let root: FileSystemDirectoryHandle | undefined;
  let created = false;
  const probeId = crypto.randomUUID();
  const name = probeName({ probeId });
  const check = (): void => {
    if (signal?.aborted) throw new LlamaCppBrowserError({ code: 'aborted' });
  };
  try {
    check();
    root = await navigator.storage.getDirectory();
    check();
    const file = await root.getFileHandle(name, { create: true });
    created = true;
    check();
    const writer = await file.createWritable();
    try {
      check();
      await writer.write(probeId);
      await writer.close();
    } catch (error) {
      await writer.abort().catch(() => {});
      throw error;
    }
    check();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    try {
      const verified = await Promise.race([
        verify({ probeId }),
        new Promise<never>((_resolve, reject) => {
          abort = () => reject(new LlamaCppBrowserError({ code: 'aborted' }));
          signal?.addEventListener('abort', abort, { once: true });
          timeout = setTimeout(() => reject(new LlamaCppBrowserError({ code: 'worker-failed' })), 10_000);
          if (signal?.aborted) abort();
        }),
      ]);
      if (verified !== true) throw new LlamaCppBrowserError({ code: 'unavailable' });
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      if (abort) signal?.removeEventListener('abort', abort);
    }
  } catch (error) {
    if (error instanceof LlamaCppBrowserError) throw error;
    throw new LlamaCppBrowserError({ code: 'unavailable' });
  } finally {
    if (created && root) await root.removeEntry(name);
  }
}
export const TEST_ONLY = {
};
