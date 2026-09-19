import { z } from 'zod';
import type {
  DownloadVerificationRepositoryFile,
  DownloadVerificationResolvedRepository,
  DownloadVerificationRun,
  DownloadVerificationTransportObservation,
} from '@/features/transformers-js/download-verification/types';

const DEFAULT_RANGE_BYTES = 4096;
const DEFAULT_PER_FILE_BYTE_BUDGET = 64 * 1024;
const DEFAULT_TOTAL_BYTE_BUDGET = 2 * 1024 * 1024;
const DEFAULT_MAXIMUM_PROBED_ARTIFACTS = 8;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

const repositoryLfsSchema = z.object({
  oid: z.string().optional(),
  sha256: z.string().optional(),
  size: z.number().finite().nonnegative().optional(),
}).passthrough();

const repositoryFileSchema = z.object({
  rfilename: z.string().min(1),
  size: z.number().finite().nonnegative().optional(),
  blobId: z.string().optional(),
  lfs: repositoryLfsSchema.optional(),
}).passthrough();

const repositoryMetadataSchema = z.object({
  sha: z.string().regex(/^[0-9a-f]{40}$/iu),
  siblings: z.array(repositoryFileSchema),
}).passthrough();

export function normalizePublicHuggingFaceModelId({ modelId }: { modelId: string }): string {
  let value = modelId.trim();
  if (value.startsWith('https://huggingface.co/')) {
    value = value.slice('https://huggingface.co/'.length);
  } else if (value.startsWith('hf.co/')) {
    value = value.slice('hf.co/'.length);
  }

  value = value.replace(/^\/+|\/+$/gu, '');
  const parts = value.split('/');
  if (parts.length !== 2 || parts.some(part => part.length === 0 || part === '.' || part === '..')) {
    throw new Error('Only public Hugging Face model IDs in OWNER/REPO form are supported');
  }
  return parts.join('/');
}

function encodeModelId({ modelId }: { modelId: string }): string {
  return modelId.split('/').map(part => encodeURIComponent(part)).join('/');
}

function remoteUrl({ remoteBaseUrl, path }: { remoteBaseUrl: string; path: string }): string {
  const base = remoteBaseUrl.endsWith('/') ? remoteBaseUrl.slice(0, -1) : remoteBaseUrl;
  return `${base}${path}`;
}

function repositoryApiUrl({ normalizedModelId, remoteBaseUrl }: {
  normalizedModelId: string;
  remoteBaseUrl: string;
}): string {
  return remoteUrl({
    remoteBaseUrl,
    path: `/api/models/${encodeModelId({ modelId: normalizedModelId })}/revision/main?blobs=true`,
  });
}

function artifactResolveUrl({ normalizedModelId, resolvedRevision, path, remoteBaseUrl }: {
  normalizedModelId: string,
  resolvedRevision: string,
  path: string,
  remoteBaseUrl: string,
}): string {
  const encodedPath = path.split('/').map(part => encodeURIComponent(part)).join('/');
  return remoteUrl({
    remoteBaseUrl,
    path: `/${encodeModelId({ modelId: normalizedModelId })}/resolve/${encodeURIComponent(resolvedRevision)}/${encodedPath}`,
  });
}

export function sanitizeObservedUrl({ value }: { value: string | undefined }): string | undefined {
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return undefined;
  }
}

export function sanitizeDiagnosticText({ value }: { value: string }): string {
  return value.replace(/https?:\/\/[^\s"'<>]+/giu, rawUrl => sanitizeObservedUrl({ value: rawUrl }) ?? '[redacted-url]');
}

function optionalFiniteHeaderNumber({ value }: { value: string | null }): number | undefined {
  if (value === null || value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function serializeError({ error }: { error: unknown }): { name: string; message: string } {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: sanitizeDiagnosticText({ value: error.message }),
    };
  }
  return {
    name: 'Error',
    message: sanitizeDiagnosticText({ value: String(error) }),
  };
}

function repositoryFile({ file }: { file: z.infer<typeof repositoryFileSchema> }): DownloadVerificationRepositoryFile {
  return {
    path: file.rfilename,
    size: file.size ?? file.lfs?.size,
    blobId: file.blobId,
    lfsOid: file.lfs?.oid,
    lfsSha256: file.lfs?.sha256,
    lfsSize: file.lfs?.size,
  };
}

function isModelArtifactPath({ path }: { path: string }): boolean {
  return path.endsWith('.onnx') || /\.onnx_data(?:_\d+)?$/u.test(path);
}

function selectProbeFiles({ files, maximumProbedArtifacts }: {
  files: DownloadVerificationRepositoryFile[],
  maximumProbedArtifacts: number,
}): DownloadVerificationRepositoryFile[] {
  return files
    .filter(file => isModelArtifactPath({ path: file.path }))
    .sort((left, right) => {
      const leftSize = left.size ?? -1;
      const rightSize = right.size ?? -1;
      if (leftSize !== rightSize) return rightSize - leftSize;
      return left.path.localeCompare(right.path);
    })
    .slice(0, maximumProbedArtifacts);
}

function requestInit({ method, signal, rangeBytes }: {
  method: 'HEAD' | 'GET',
  signal: AbortSignal,
  rangeBytes?: number,
}): RequestInit {
  const headers = new Headers();
  if (method === 'GET' && rangeBytes !== undefined) {
    headers.set('Range', `bytes=0-${Math.max(0, rangeBytes - 1)}`);
  }
  return {
    method,
    headers,
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
    cache: 'no-store',
    redirect: 'follow',
    signal,
  };
}


function rangeHonoredForMethod({ method, status }: {
  method: DownloadVerificationTransportObservation['method'],
  status: number | undefined,
}): boolean | undefined {
  switch (method) {
  case 'HEAD':
    return undefined;
  case 'GET-range':
    return status === 206;
  default: {
    const _ex: never = method;
    throw new Error(`Unhandled probe method: ${_ex}`);
  }
  }
}

function baseObservation({ path, method, response }: {
  path: string,
  method: DownloadVerificationTransportObservation['method'],
  response: Response,
}): DownloadVerificationTransportObservation {
  const finalUrl = sanitizeObservedUrl({ value: response.url });
  return {
    path,
    method,
    status: response.status,
    redirected: response.redirected,
    finalUrl,
    finalOrigin: finalUrl === undefined ? undefined : new URL(finalUrl).origin,
    contentLength: optionalFiniteHeaderNumber({ value: response.headers.get('content-length') }),
    contentRange: response.headers.get('content-range') ?? undefined,
    acceptRanges: response.headers.get('accept-ranges') ?? undefined,
    contentType: response.headers.get('content-type') ?? undefined,
    etag: response.headers.get('etag') ?? undefined,
    rangeHonored: rangeHonoredForMethod({ method, status: response.status }),
    bytesConsumed: 0,
    abortedByByteBudget: false,
    error: undefined,
  };
}

function failedObservation({ path, method, error }: {
  path: string,
  method: DownloadVerificationTransportObservation['method'],
  error: unknown,
}): DownloadVerificationTransportObservation {
  return {
    path,
    method,
    status: undefined,
    redirected: undefined,
    finalUrl: undefined,
    finalOrigin: undefined,
    contentLength: undefined,
    contentRange: undefined,
    acceptRanges: undefined,
    contentType: undefined,
    etag: undefined,
    rangeHonored: rangeHonoredForMethod({ method, status: undefined }),
    bytesConsumed: 0,
    abortedByByteBudget: false,
    error: serializeError({ error }),
  };
}

async function consumeBoundedBody({ response, controller, byteBudget }: {
  response: Response,
  controller: AbortController,
  byteBudget: number,
}): Promise<{ bytesConsumed: number; abortedByByteBudget: boolean; error: unknown | undefined }> {
  if (!response.body) return { bytesConsumed: 0, abortedByByteBudget: false, error: undefined };

  const reader = response.body.getReader();
  let bytesConsumed = 0;
  let abortedByByteBudget = false;
  let readError: unknown | undefined;
  try {
    while (bytesConsumed < byteBudget) {
      try {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value) continue;
        bytesConsumed += value.byteLength;
        if (bytesConsumed >= byteBudget) {
          abortedByByteBudget = true;
          controller.abort('download verification byte budget reached');
          break;
        }
      } catch (error) {
        readError = error;
        break;
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // The controller may already have aborted or the remote stream may have failed.
    }
  }
  return { bytesConsumed, abortedByByteBudget, error: readError };
}

function requestAbortController({ signal, timeoutMs }: {
  signal: AbortSignal,
  timeoutMs: number,
}): {
  controller: AbortController,
  timedOut: () => boolean,
  dispose: () => void,
} {
  const controller = new AbortController();
  let didTimeOut = false;
  if (signal.aborted) controller.abort(signal.reason);
  const abort = () => controller.abort(signal.reason);
  signal.addEventListener('abort', abort, { once: true });
  // The parent can abort after the first check but before the listener is
  // registered. Re-check after registration so a close/abort cannot leave the
  // underlying fetch alive until the request timeout.
  if (signal.aborted) abort();
  const timeoutId = setTimeout(() => {
    didTimeOut = true;
    controller.abort('download verification request timeout');
  }, timeoutMs);
  return {
    controller,
    timedOut: () => didTimeOut,
    dispose: () => {
      clearTimeout(timeoutId);
      signal.removeEventListener('abort', abort);
    },
  };
}

async function probeArtifact({
  path,
  url,
  browserFetch,
  signal,
  rangeBytes,
  perFileByteBudget,
  remainingTotalByteBudget,
  requestTimeoutMs,
}: {
  path: string,
  url: string,
  browserFetch: typeof fetch,
  signal: AbortSignal,
  rangeBytes: number,
  perFileByteBudget: number,
  remainingTotalByteBudget: number,
  requestTimeoutMs: number,
}): Promise<DownloadVerificationTransportObservation> {
  const headRequest = requestAbortController({ signal, timeoutMs: requestTimeoutMs });
  try {
    const response = await browserFetch(url, requestInit({ method: 'HEAD', signal: headRequest.controller.signal }));
    const observation = baseObservation({ path, method: 'HEAD', response });
    const hasUsefulSize = observation.contentLength !== undefined;
    const advertisesRanges = observation.acceptRanges?.toLowerCase().includes('bytes') === true;
    if (response.ok && hasUsefulSize && advertisesRanges) return observation;
  } catch (error) {
    if (signal.aborted) throw error;
  } finally {
    headRequest.dispose();
  }

  const rangeRequest = requestAbortController({ signal, timeoutMs: requestTimeoutMs });
  const { controller } = rangeRequest;
  try {
    const response = await browserFetch(url, requestInit({
      method: 'GET',
      signal: controller.signal,
      rangeBytes,
    }));
    const observation = baseObservation({ path, method: 'GET-range', response });
    const byteBudget = Math.max(0, Math.min(perFileByteBudget, remainingTotalByteBudget));
    const body = await consumeBoundedBody({ response, controller, byteBudget });
    if (body.error !== undefined) {
      if (signal.aborted) throw body.error;
      const observedError = rangeRequest.timedOut()
        ? new Error('Browser transport probe request timed out')
        : body.error;
      return {
        ...observation,
        bytesConsumed: body.bytesConsumed,
        abortedByByteBudget: body.abortedByByteBudget,
        error: serializeError({ error: observedError }),
      };
    }
    return {
      ...observation,
      bytesConsumed: body.bytesConsumed,
      abortedByByteBudget: body.abortedByByteBudget,
    };
  } catch (error) {
    if (signal.aborted) throw error;
    const observedError = rangeRequest.timedOut()
      ? new Error('Browser transport probe request timed out')
      : error;
    return failedObservation({ path, method: 'GET-range', error: observedError });
  } finally {
    rangeRequest.dispose();
  }
}

export async function runBrowserDownloadVerification({
  modelId,
  resolvedRepository,
  browserFetch = fetch,
  signal = new AbortController().signal,
  now = () => new Date().toISOString(),
  rangeBytes = DEFAULT_RANGE_BYTES,
  perFileByteBudget = DEFAULT_PER_FILE_BYTE_BUDGET,
  totalByteBudget = DEFAULT_TOTAL_BYTE_BUDGET,
  maximumProbedArtifacts = DEFAULT_MAXIMUM_PROBED_ARTIFACTS,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  remoteBaseUrl = 'https://huggingface.co',
}: {
  modelId: string,
  resolvedRepository?: DownloadVerificationResolvedRepository,
  browserFetch?: typeof fetch,
  signal?: AbortSignal,
  now?: () => string,
  rangeBytes?: number,
  perFileByteBudget?: number,
  totalByteBudget?: number,
  maximumProbedArtifacts?: number,
  requestTimeoutMs?: number,
  remoteBaseUrl?: string,
}): Promise<DownloadVerificationRun> {
  signal.throwIfAborted();
  const startedAt = now();
  const normalizedModelId = normalizePublicHuggingFaceModelId({ modelId });
  const repository = await (async (): Promise<DownloadVerificationResolvedRepository> => {
    if (resolvedRepository !== undefined) {
      if (resolvedRepository.normalizedModelId !== normalizedModelId) {
        throw new Error(
          `Frozen repository model mismatch: expected ${normalizedModelId}, received ${resolvedRepository.normalizedModelId}`,
        );
      }
      if (!/^[0-9a-f]{40}$/iu.test(resolvedRepository.resolvedRevision)) {
        throw new Error(`Frozen repository revision is not an exact commit SHA: ${resolvedRepository.resolvedRevision}`);
      }
      return {
        ...resolvedRepository,
        repositoryFiles: [...resolvedRepository.repositoryFiles].sort((a, b) => a.path.localeCompare(b.path)),
      };
    }

    const metadataRequest = requestAbortController({ signal, timeoutMs: requestTimeoutMs });
    let metadataResponse: Response;
    let metadataText: string;
    try {
      metadataResponse = await browserFetch(repositoryApiUrl({ normalizedModelId, remoteBaseUrl }), {
        method: 'GET',
        headers: { Accept: 'application/json' },
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        cache: 'no-store',
        redirect: 'follow',
        signal: metadataRequest.controller.signal,
      });
      if (!metadataResponse.ok) {
        throw new Error(`Hugging Face repository metadata request failed with HTTP ${metadataResponse.status}`);
      }
      metadataText = await metadataResponse.text();
    } catch (error) {
      if (signal.aborted) throw error;
      if (metadataRequest.timedOut()) throw new Error('Hugging Face repository metadata request timed out');
      throw error;
    } finally {
      metadataRequest.dispose();
    }
    const metadata = repositoryMetadataSchema.parse(JSON.parse(metadataText) as unknown);
    return {
      modelId,
      normalizedModelId,
      requestedRevision: 'main',
      resolvedRevision: metadata.sha,
      repositoryFiles: metadata.siblings.map(file => repositoryFile({ file })).sort((a, b) => a.path.localeCompare(b.path)),
    };
  })();
  const repositoryFiles = repository.repositoryFiles;
  const probeFiles = selectProbeFiles({ files: repositoryFiles, maximumProbedArtifacts });
  const totalModelArtifactCount = repositoryFiles.filter(file => isModelArtifactPath({ path: file.path })).length;
  const transportObservations: DownloadVerificationTransportObservation[] = [];
  let bytesConsumed = 0;

  for (const file of probeFiles) {
    signal.throwIfAborted();
    if (bytesConsumed >= totalByteBudget) break;
    const observation = await probeArtifact({
      path: file.path,
      url: artifactResolveUrl({
        normalizedModelId,
        resolvedRevision: repository.resolvedRevision,
        path: file.path,
        remoteBaseUrl,
      }),
      browserFetch,
      signal,
      rangeBytes,
      perFileByteBudget,
      remainingTotalByteBudget: totalByteBudget - bytesConsumed,
      requestTimeoutMs,
    });
    transportObservations.push(observation);
    bytesConsumed += observation.bytesConsumed;
  }

  return {
    modelId,
    normalizedModelId,
    requestedRevision: 'main',
    resolvedRevision: repository.resolvedRevision,
    repositoryFileCount: repositoryFiles.length,
    repositoryFiles,
    transportObservations,
    skippedModelArtifactCount: Math.max(0, totalModelArtifactCount - transportObservations.length),
    bytesConsumed,
    maximumBytes: totalByteBudget,
    startedAt,
    finishedAt: now(),
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  DEFAULT_RANGE_BYTES,
  DEFAULT_PER_FILE_BYTE_BUDGET,
  DEFAULT_TOTAL_BYTE_BUDGET,
  DEFAULT_MAXIMUM_PROBED_ARTIFACTS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  isModelArtifactPath,
  selectProbeFiles,
  requestAbortController,
};
