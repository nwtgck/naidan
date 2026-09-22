import { urlToPath, writeToOpfs } from '@/features/transformers-js/utils';
import { readCompletedOpfsSnapshot, withOpfsFileLease } from '@/features/transformers-js/runtime/opfs-access';

export interface RuntimeMetadataStorage {
  read({ url }: { url: string }): Promise<{ byteLength: number, response: Response } | undefined>;
  stat({ url }: { url: string }): Promise<number | undefined>;
  write({ url, response }: { url: string, response: Response }): Promise<void>;
}

async function completedFile({ url }: { url: string }): Promise<File | undefined> {
  const path = urlToPath({ url });
  if (!path) throw new Error('Invalid metadata storage identity');
  return await withOpfsFileLease({ path, mode: 'shared', availability: 'wait', signal: undefined, run: async ({ lease }) =>
    await readCompletedOpfsSnapshot({ path, lease }) });
}

/** Strict metadata-only storage. Model-weight cache behavior is unchanged. */
export function createRuntimeMetadataStorage(): RuntimeMetadataStorage {
  return {
    async read({ url }) {
      const file = await completedFile({ url });
      if (file === undefined) return undefined;
      return { byteLength: file.size, response: new Response(file.stream(), {
        headers: { 'Content-Length': String(file.size), 'Content-Type': url.endsWith('.json') ? 'application/json' : 'text/plain' },
      }) };
    },
    async stat({ url }) {
      // getFile obtains a size snapshot; no stream, arrayBuffer or hash is read.
      return (await completedFile({ url }))?.size;
    },
    async write({ url, response }) {
      const path = urlToPath({ url });
      if (!path) throw new Error('Invalid metadata storage identity');
      await writeToOpfs({ path, response });
    },
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
export const TEST_ONLY = {
};
