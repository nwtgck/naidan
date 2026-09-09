import { urlToPath, writeToOpfs } from '@/features/transformers-js/utils';

export interface RuntimeMetadataStorage {
  read({ url }: { url: string }): Promise<{ byteLength: number, response: Response } | undefined>;
  stat({ url }: { url: string }): Promise<number | undefined>;
  write({ url, response }: { url: string, response: Response }): Promise<void>;
}

async function completedFile({ url }: { url: string }): Promise<File | undefined> {
  const path = urlToPath({ url });
  if (!path) throw new Error('Invalid metadata storage identity');
  const parts = path.split('/');
  const name = parts.pop();
  if (!name) throw new Error('Missing metadata filename');
  try {
    let directory = await navigator.storage.getDirectory();
    for (const part of parts) {
      if (part) directory = await directory.getDirectoryHandle(part, { create: false });
    }
    await directory.getFileHandle(`.${name}.complete`, { create: false });
    const file = await (await directory.getFileHandle(name, { create: false })).getFile();
    return file.size === 0 ? undefined : file;
  } catch (error) {
    if (error instanceof Error && error.name === 'NotFoundError') return undefined;
    throw error;
  }
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
