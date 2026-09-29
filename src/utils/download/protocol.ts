import { z } from 'zod';

export const DOWNLOAD_ROOT = '__naidan_download__/';
// Retained only for pages already running v1; new pages must use v2 fragments.
export const DOWNLOAD_PATH = `${DOWNLOAD_ROOT}v1/`;
export const DOWNLOAD_FRAGMENT_PATH = `${DOWNLOAD_ROOT}v2/`;
export const DOWNLOAD_VERSION = 2;
const downloadVersionSchema = z.union([z.literal(1), z.literal(DOWNLOAD_VERSION)]);
export type DownloadVersion = z.infer<typeof downloadVersionSchema>;
export const DOWNLOAD_CLAIM_TIMEOUT_MS = 30_000;
export const DOWNLOAD_HEARTBEAT_MS = 15_000;
// Each ExtendableEvent finishes promptly, even for multi-hour downloads.
export const DOWNLOAD_EVENT_LEASE_MS = 90_000;
export const downloadTokenSchema = z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
export const downloadMetadataSchema = z.object({
  filename: z.string().min(1).max(255),
  // Do not permit arbitrary response headers or active document content types.
  size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
});
export const downloadPrepareSchema = z.object({
  type: z.literal('naidan-download/prepare'),
  version: downloadVersionSchema,
  token: downloadTokenSchema,
  metadata: downloadMetadataSchema,
});
export const downloadKeepAliveSchema = z.object({
  type: z.literal('naidan-download/keepalive'),
  version: downloadVersionSchema,
  token: downloadTokenSchema,
});
export const downloadStatusSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready'), version: downloadVersionSchema, token: downloadTokenSchema }),
  z.object({ type: z.literal('claimed') }),
  z.object({ type: z.literal('pong') }),
  z.object({ type: z.literal('consumed') }),
  z.object({ type: z.literal('error'), message: z.string().max(2048) }),
]);
export const downloadControlSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('cancel') }),
  z.object({ type: z.literal('ping') }),
]);

/** Only the one-shot capability belongs in the fragment; never put metadata in a URL. */
export function createDownloadUrl({ base, token, version }: {
  base: URL, token: string, version: DownloadVersion,
}): URL {
  const validToken = downloadTokenSchema.parse(token);
  switch (version) {
  case 1: return new URL(DOWNLOAD_PATH + validToken, base);
  case 2: {
    const url = new URL(DOWNLOAD_FRAGMENT_PATH, base);
    url.hash = `?id=${validToken}`;
    return url;
  }
  default: { const exhaustive: never = version; throw new Error(`Unknown download version: ${exhaustive}`); }
  }
}

export function normalizeDownloadFilename({ filename }: { filename: string }): string {
  // Remove paths, controls, unpaired surrogates and bidi controls. Headers are
  // independently encoded; sanitizing here also protects the Blob fallback.
  // eslint-disable-next-line no-control-regex -- Strip control characters before constructing download headers.
  return filename.toWellFormed().replace(/[\u0000-\u001f\u007f-\u009f/\\\u202a-\u202e\u2066-\u2069]/g, '_')
    .trim().slice(0, 255).toWellFormed() || 'download';
}

export function createDownloadHeaders({ metadata }: {
  metadata: z.infer<typeof downloadMetadataSchema>,
}): Headers {
  const filename = normalizeDownloadFilename({ filename: metadata.filename });
  const fallback = filename.replace(/[^\x20-\x7e]|["\\]/g, '_');
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  const headers = new Headers({
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`,
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    // The hidden download frame must opt into its parent's isolation policy.
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Content-Security-Policy': "default-src 'none'; sandbox allow-downloads",
  });
  if (metadata.size !== undefined) headers.set('Content-Length', String(metadata.size));
  return headers;
}

export const TEST_ONLY = {
};
