import { z } from 'zod';
import { gpuProfilingProfile, type LlamaCppProfile } from '@/features/llama-cpp-browser/types';

type SchemaAsset = NonNullable<typeof import('virtual:llama-cpp-browser-core/availability').q8KernelDiagnosticSchemaAsset>;
const assetSchema = z.object({
  relativePath: z.literal(`${gpuProfilingProfile}/q8-diagnostic-v1.schema.json`),
  bytes: z.number().int().min(1).max(256 * 1024),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();

/** Explicit diagnostic setup only. Verify the published bytes here; the native
 * adapter separately validates JSON, its canonical hash and the compiled ABI. */
export async function loadQ8DiagnosticSchema({ profile, assetBaseURL, asset, signal }: {
  profile: LlamaCppProfile, assetBaseURL: string | undefined, asset: SchemaAsset | undefined, signal: AbortSignal | undefined,
}): Promise<Uint8Array<ArrayBuffer> | undefined> {
  signal?.throwIfAborted();
  if (profile !== gpuProfilingProfile || asset === undefined) {
    return undefined;
  }
  const metadata = assetSchema.parse(asset);
  if (assetBaseURL === undefined) {
    throw new Error('Missing Q8 diagnostic asset base URL');
  }
  const response = await fetch(new URL(metadata.relativePath, assetBaseURL), { signal });
  if (!response.ok || !response.body) {
    throw new Error('Q8 diagnostic schema download failed');
  }
  const bytes = new Uint8Array(metadata.bytes);
  const reader = response.body.getReader();
  let complete = false;
  let offset = 0;
  try {
    while (true) {
      signal?.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) {
        complete = true;
        break;
      }
      if (chunk.value.length > bytes.length - offset) {
        throw new Error('Q8 diagnostic schema exceeds its published size');
      }
      bytes.set(chunk.value, offset);
      offset += chunk.value.length;
    }
  } finally {
    try {
      if (!complete) {
        await reader.cancel();
      }
    } finally {
      reader.releaseLock();
    }
  }
  signal?.throwIfAborted();
  if (offset !== bytes.length) {
    throw new Error('Q8 diagnostic schema is truncated');
  }
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  signal?.throwIfAborted();
  const actual = Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
  if (actual !== metadata.sha256) {
    throw new Error('Q8 diagnostic schema asset integrity mismatch');
  }
  return bytes;
}

export const TEST_ONLY = {
};
