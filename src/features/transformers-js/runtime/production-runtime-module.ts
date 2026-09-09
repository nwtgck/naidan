import { z } from 'zod';
import { HOSTED_TRANSFORMERS_RUNTIME_ASSET_MANIFEST, hostedTransformersRuntimeAssetManifestEntry } from './runtime-asset-manifest';
import type { HostedTransformersRuntimeAssetUrls } from './configure-hosted-runtime';

export const runtimeModuleVariantSchema = z.enum(['standard', 'asyncify']);
const maximumModuleByteLength = Math.max(...HOSTED_TRANSFORMERS_RUNTIME_ASSET_MANIFEST.variants.map(entry => entry.mjs.byteLength));
export const runtimeModuleBytesSchema = z.instanceof(Uint8Array).refine(bytes => (
  bytes.buffer instanceof ArrayBuffer && bytes.byteOffset === 0
  && bytes.byteLength === bytes.buffer.byteLength && bytes.byteLength > 0 && bytes.byteLength <= maximumModuleByteLength
), 'Runtime module payload must own one bounded, exact ArrayBuffer');

/** Snapshot before awaiting: the digest and the eventual object URL own identical bytes. */
export async function verifiedRuntimeModuleBlob({ bytes: input, variant }: {
  bytes: Uint8Array; variant: z.infer<typeof runtimeModuleVariantSchema>;
}): Promise<Blob> {
  const bytes = runtimeModuleBytesSchema.parse(input);
  const expected = hostedTransformersRuntimeAssetManifestEntry({ variant }).mjs;
  if (bytes.byteLength !== expected.byteLength) throw new Error('Runtime MJS byte length differs from the build manifest');
  const blob = new Blob([Uint8Array.from(bytes)], { type: 'text/javascript' });
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  const actual = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  if (actual !== expected.sha256) throw new Error('Runtime MJS hash differs from the build manifest');
  return blob;
}

/** No model cache, HTTP-import fallback, or runtime factory execution. */
export async function fetchProductionRuntimeModule({ assets, runtimeFetch }: {
  assets: HostedTransformersRuntimeAssetUrls; runtimeFetch: typeof fetch;
}): Promise<Uint8Array<ArrayBuffer>> {
  const response = await runtimeFetch(assets.mjsUrl, { method: 'GET', redirect: 'error' });
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let failed = false;
  try {
    if (response.status !== 200 || response.headers.has('Content-Range')) throw new Error('Runtime MJS requires a complete HTTP 200 response');
    const mime = response.headers.get('Content-Type')?.split(';', 1)[0]?.trim().toLowerCase();
    if (!['text/javascript', 'application/javascript', 'text/ecmascript', 'application/ecmascript'].includes(mime ?? '')) {
      throw new Error('Runtime MJS response is not JavaScript');
    }
    if (!response.body) throw new Error('Runtime MJS response has no body');
    const bytes = new Uint8Array(assets.mjsByteLength);
    let received = 0;
    reader = response.body.getReader();
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (chunk.value.byteLength > bytes.byteLength - received) throw new Error('Runtime MJS exceeds the build manifest byte length');
      bytes.set(chunk.value, received);
      received += chunk.value.byteLength;
    }
    if (received !== bytes.byteLength) throw new Error('Runtime MJS response ended before its complete byte length');
    await verifiedRuntimeModuleBlob({ bytes, variant: assets.variant });
    return bytes;
  } catch (error) {
    failed = true;
    // Failed initialization never resumes. Do not let an unresponsive cancel
    // hide the known failure; the host's startup lifecycle terminates this Realm.
    try {
      const cleanup = reader ? reader.cancel(error) : response.body?.cancel(error);
      void cleanup?.catch(() => undefined);
    } catch { /* Retain the primary initialization failure. */ }
    throw error;
  } finally {
    try {
      reader?.releaseLock();
    } catch (error) {
      // Successful reads still fail if releasing their lock fails. An existing
      // primary read/validation failure is never replaced by cleanup failure.
      // eslint-disable-next-line no-unsafe-finally -- Deliberate success invalidation only, covered by reader-failure regressions.
      if (!failed) throw error;
    }
  }
}

export const TEST_ONLY = {
};
