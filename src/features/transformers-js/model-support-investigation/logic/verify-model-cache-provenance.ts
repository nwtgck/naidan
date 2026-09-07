import type {
  ModelSupportInvestigationCacheFile,
  ModelSupportInvestigationCacheFileProvenance,
  ModelSupportInvestigationCacheInventory,
  ModelSupportInvestigationCacheProvenance,
  ModelSupportInvestigationCacheRangeSample,
  ModelSupportInvestigationCacheTransportAttempt,
  ModelSupportInvestigationCacheTransportObservation,
  ModelSupportInvestigationRepository,
} from "@/features/transformers-js/model-support-investigation/types";
import { serializeInvestigationError } from "@/features/transformers-js/model-support-investigation/logic/serialize-investigation-error";

export const MODEL_CACHE_PROVENANCE_RANGE_BYTES = 32 * 1024;
export const MODEL_CACHE_PROVENANCE_MAXIMUM_FILE_COUNT = 3;

function remoteFileUrl({ repository, repositoryPath }: {
  repository: ModelSupportInvestigationRepository,
  repositoryPath: string,
}): string {
  const model = repository.normalizedModelId.split("/").map(part => encodeURIComponent(part)).join("/");
  const path = repositoryPath.split("/").map(part => encodeURIComponent(part)).join("/");
  return `https://huggingface.co/${model}/resolve/${encodeURIComponent(repository.resolvedRevision)}/${path}`;
}

async function sha256Hex({ bytes }: { bytes: Uint8Array }): Promise<string> {
  const input = new Uint8Array(bytes.byteLength);
  input.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", input.buffer);
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join("");
}

async function openCachedFile({
  storageRoot,
  normalizedModelId,
  cachePath,
}: {
  storageRoot: FileSystemDirectoryHandle,
  normalizedModelId: string,
  cachePath: string,
}): Promise<File> {
  let directory = await storageRoot.getDirectoryHandle("models", { create: false });
  directory = await directory.getDirectoryHandle("huggingface.co", { create: false });
  for (const part of normalizedModelId.split("/")) {
    directory = await directory.getDirectoryHandle(part, { create: false });
  }
  const parts = cachePath.split("/");
  const fileName = parts.pop();
  if (fileName === undefined) throw new Error(`Invalid cache path: ${cachePath}`);
  for (const part of parts) {
    directory = await directory.getDirectoryHandle(part, { create: false });
  }
  return await (await directory.getFileHandle(fileName, { create: false })).getFile();
}

function rangesForFile({ size, rangeBytes }: { size: number, rangeBytes: number }): Array<{ offset: number, length: number }> {
  if (size <= rangeBytes * 2) return [{ offset: 0, length: size }];
  const middleOffset = Math.max(0, Math.floor((size - rangeBytes) / 2));
  const ranges = [
    { offset: 0, length: rangeBytes },
    { offset: middleOffset, length: rangeBytes },
    { offset: size - rangeBytes, length: rangeBytes },
  ];
  return ranges.filter((range, index) => ranges.findIndex(item => item.offset === range.offset) === index);
}

function sanitizedTransportUrl({ value }: { value: string }): string {
  try {
    const url = new URL(value);
    url.search = "";
    url.hash = "";
    return url.href;
  } catch {
    return value.split(/[?#]/u, 1)[0] ?? value;
  }
}

function transportAttemptFromResponse({
  method,
  requestUrl,
  response,
  status,
}: {
  method: ModelSupportInvestigationCacheTransportAttempt["method"],
  requestUrl: string,
  response: Response,
  status: ModelSupportInvestigationCacheTransportAttempt["status"],
}): ModelSupportInvestigationCacheTransportAttempt {
  return {
    method,
    status,
    requestUrl: sanitizedTransportUrl({ value: requestUrl }),
    responseUrl: response.url.length === 0 ? undefined : sanitizedTransportUrl({ value: response.url }),
    responseStatus: response.status,
    redirected: response.redirected,
    redirectChain: undefined,
    redirectChainReason: "The browser Fetch API exposes the final response URL and redirected flag, not the complete redirect chain",
    contentLength: response.headers.get("content-length") ?? undefined,
    contentRange: response.headers.get("content-range") ?? undefined,
    contentType: response.headers.get("content-type") ?? undefined,
    acceptRanges: response.headers.get("accept-ranges") ?? undefined,
    etag: response.headers.get("etag") ?? undefined,
    lastModified: response.headers.get("last-modified") ?? undefined,
    corsVisibility: "readable",
    error: undefined,
  };
}

function failedTransportAttempt({
  method,
  requestUrl,
  error,
}: {
  method: ModelSupportInvestigationCacheTransportAttempt["method"],
  requestUrl: string,
  error: unknown,
}): ModelSupportInvestigationCacheTransportAttempt {
  return {
    method,
    status: "failed",
    requestUrl: sanitizedTransportUrl({ value: requestUrl }),
    responseUrl: undefined,
    responseStatus: undefined,
    redirected: undefined,
    redirectChain: undefined,
    redirectChainReason: "No readable response was available; the browser did not expose a redirect chain",
    contentLength: undefined,
    contentRange: undefined,
    contentType: undefined,
    acceptRanges: undefined,
    etag: undefined,
    lastModified: undefined,
    corsVisibility: "unresolved",
    error: serializeInvestigationError({ error }),
  };
}

function repositoryMetadataTransport({ repositorySize, reason }: {
  repositorySize: number | undefined,
  reason: string,
}): ModelSupportInvestigationCacheTransportObservation {
  return {
    status: "fallback-metadata",
    attempts: [],
    repositorySize,
    reason,
  };
}

async function observeLightweightTransport({
  requestUrl,
  repositorySize,
  repositoryFetch,
}: {
  requestUrl: string,
  repositorySize: number | undefined,
  repositoryFetch: typeof fetch,
}): Promise<ModelSupportInvestigationCacheTransportObservation> {
  const attempts: ModelSupportInvestigationCacheTransportAttempt[] = [];
  try {
    const response = await repositoryFetch(requestUrl, {
      method: "HEAD",
      cache: "no-store",
      credentials: "omit",
      redirect: "follow",
    });
    await cancelResponseBody({ response });
    const unsupported = response.status === 405 || response.status === 501;
    attempts.push(transportAttemptFromResponse({
      method: "HEAD",
      requestUrl,
      response,
      status: unsupported ? "unsupported" : "observed",
    }));
    if (!unsupported) {
      return {
        status: "observed",
        attempts,
        repositorySize,
        reason: "HEAD exposed lightweight transport metadata without reading a response body",
      };
    }
  } catch (error) {
    attempts.push(failedTransportAttempt({ method: "HEAD", requestUrl, error }));
  }

  try {
    const response = await repositoryFetch(requestUrl, {
      cache: "no-store",
      credentials: "omit",
      redirect: "follow",
      headers: { Range: "bytes=0-0" },
    });
    const supported = response.status === 206;
    const attempt = transportAttemptFromResponse({
      method: "range-0-0",
      requestUrl,
      response,
      status: supported ? "observed" : "unsupported",
    });
    await cancelResponseBody({ response });
    attempts.push(attempt);
    if (supported) {
      return {
        status: "observed",
        attempts,
        repositorySize,
        reason: "A one-byte Range request exposed lightweight transport metadata; its body was cancelled without being saved",
      };
    }
  } catch (error) {
    attempts.push(failedTransportAttempt({ method: "range-0-0", requestUrl, error }));
  }

  return {
    status: "fallback-metadata",
    attempts,
    repositorySize,
    reason: "HEAD and one-byte Range transport observation were unavailable; frozen repository metadata is retained as the fallback",
  };
}

async function cancelResponseBody({ response }: { response: Response }): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The response is already unusable; cancellation is only a bandwidth guard.
  }
}

async function readResponseBodyWithExactLimit({ response, expectedLength }: {
  response: Response,
  expectedLength: number,
}): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (reader === undefined) return new Uint8Array();
  const bytes = new Uint8Array(expectedLength);
  let offset = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (offset + chunk.value.byteLength > expectedLength) {
        await reader.cancel("Range response exceeded the bounded sample length");
        throw new Error(`Range response exceeded ${expectedLength} bytes`);
      }
      bytes.set(chunk.value, offset);
      offset += chunk.value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  if (offset !== expectedLength) throw new Error(`Range response returned ${offset} bytes; expected ${expectedLength}`);
  return bytes;
}

function validContentRange({ value, offset, length, totalSize }: {
  value: string | null,
  offset: number,
  length: number,
  totalSize: number,
}): boolean {
  if (value === null) return false;
  return value === `bytes ${offset}-${offset + length - 1}/${totalSize}`;
}

async function sampleRange({
  file,
  requestUrl,
  offset,
  length,
  totalSize,
  repositoryFetch,
}: {
  file: File,
  requestUrl: string,
  offset: number,
  length: number,
  totalSize: number,
  repositoryFetch: typeof fetch,
}): Promise<ModelSupportInvestigationCacheRangeSample> {
  const localBytes = new Uint8Array(await file.slice(offset, offset + length).arrayBuffer());
  const localSha256 = await sha256Hex({ bytes: localBytes });
  try {
    const response = await repositoryFetch(requestUrl, {
      cache: "no-store",
      credentials: "omit",
      redirect: "follow",
      headers: { Range: `bytes=${offset}-${offset + length - 1}` },
    });
    const contentRange = response.headers.get("content-range");
    const common = {
      localSha256,
      responseStatus: response.status,
      contentRange: contentRange ?? undefined,
      etag: response.headers.get("etag") ?? undefined,
      lastModified: response.headers.get("last-modified") ?? undefined,
    };
    if (response.status !== 206 || !validContentRange({ value: contentRange, offset, length, totalSize })) {
      await cancelResponseBody({ response });
      return {
        offset,
        length,
        status: "range-not-supported",
        ...common,
        remoteSha256: undefined,
        error: undefined,
      };
    }
    const contentLength = response.headers.get("content-length");
    if (contentLength !== null && Number(contentLength) !== length) {
      await cancelResponseBody({ response });
      return {
        offset,
        length,
        status: "failed",
        ...common,
        remoteSha256: undefined,
        error: serializeInvestigationError({
          error: new Error(`Range response declared ${contentLength} bytes; expected ${length}`),
        }),
      };
    }
    const remoteBytes = await readResponseBodyWithExactLimit({ response, expectedLength: length });
    const remoteSha256 = await sha256Hex({ bytes: remoteBytes });
    return {
      offset,
      length,
      status: localSha256 === remoteSha256 ? "matched" : "mismatched",
      ...common,
      remoteSha256,
      error: undefined,
    };
  } catch (error) {
    return {
      offset,
      length,
      status: "failed",
      localSha256,
      remoteSha256: undefined,
      responseStatus: undefined,
      contentRange: undefined,
      etag: undefined,
      lastModified: undefined,
      error: serializeInvestigationError({ error }),
    };
  }
}

function cacheCandidates({
  inventory,
  repository,
  maximumFileCount,
}: {
  inventory: ModelSupportInvestigationCacheInventory,
  repository: ModelSupportInvestigationRepository,
  maximumFileCount: number,
}): ModelSupportInvestigationCacheFile[] {
  const repositoryPaths = new Set(repository.files.map(file => file.path));
  return inventory.files
    .filter(file => (
      file.hasCompletionMarker
      && file.size > 0
      && file.repositoryPath !== undefined
      && (file.cacheRevision === repository.resolvedRevision || file.cacheRevision === repository.requestedRevision)
      && repositoryPaths.has(file.repositoryPath)
    ))
    .sort((left, right) => {
      if (left.isWeightFile !== right.isWeightFile) return left.isWeightFile ? -1 : 1;
      return left.path.localeCompare(right.path);
    })
    .slice(0, maximumFileCount);
}

async function verifyFile({
  fileEntry,
  inventory,
  repository,
  storageRoot,
  repositoryFetch,
  rangeBytes,
}: {
  fileEntry: ModelSupportInvestigationCacheFile,
  inventory: ModelSupportInvestigationCacheInventory,
  repository: ModelSupportInvestigationRepository,
  storageRoot: FileSystemDirectoryHandle,
  repositoryFetch: typeof fetch,
  rangeBytes: number,
}): Promise<ModelSupportInvestigationCacheFileProvenance> {
  const repositoryPath = fileEntry.repositoryPath;
  const cacheRevision = fileEntry.cacheRevision;
  if (repositoryPath === undefined || cacheRevision === undefined) {
    throw new Error("Selected cache provenance file is missing path metadata");
  }
  const repositoryFile = repository.files.find(item => item.path === repositoryPath);
  const repositorySize = repositoryFile?.size;
  if (repositorySize !== undefined && repositorySize !== fileEntry.size) {
    return {
      cachePath: fileEntry.path,
      repositoryPath,
      cacheRevision,
      localSize: fileEntry.size,
      repositorySize,
      status: "mismatched",
      transport: repositoryMetadataTransport({
        repositorySize,
        reason: "Repository size already proves the cache file differs, so no transport request was needed",
      }),
      ranges: [],
      reason: `Local size ${fileEntry.size} differs from repository size ${repositorySize}`,
    };
  }
  try {
    const localFile = await openCachedFile({
      storageRoot,
      normalizedModelId: inventory.normalizedModelId,
      cachePath: fileEntry.path,
    });
    if (localFile.size !== fileEntry.size) {
      return {
        cachePath: fileEntry.path,
        repositoryPath,
        cacheRevision,
        localSize: localFile.size,
        repositorySize,
        status: "mismatched",
        transport: repositoryMetadataTransport({
          repositorySize,
          reason: "The OPFS file disagrees with the local inventory before a transport request is necessary",
        }),
        ranges: [],
        reason: `Actual OPFS file size ${localFile.size} differs from inventory size ${fileEntry.size}`,
      };
    }
    const requestUrl = remoteFileUrl({ repository, repositoryPath });
    const transport = await observeLightweightTransport({
      requestUrl,
      repositorySize,
      repositoryFetch,
    });
    const ranges: ModelSupportInvestigationCacheRangeSample[] = [];
    for (const range of rangesForFile({ size: localFile.size, rangeBytes })) {
      ranges.push(await sampleRange({
        file: localFile,
        requestUrl,
        offset: range.offset,
        length: range.length,
        totalSize: localFile.size,
        repositoryFetch,
      }));
    }
    const hasMismatch = ranges.some(range => range.status === "mismatched");
    const allMatched = ranges.length > 0 && ranges.every(range => range.status === "matched");
    return {
      cachePath: fileEntry.path,
      repositoryPath,
      cacheRevision,
      localSize: fileEntry.size,
      repositorySize,
      status: hasMismatch ? "mismatched" : allMatched ? "bounded-samples-matched" : "partial",
      transport,
      ranges,
      reason: hasMismatch
        ? "At least one bounded local and remote sample hash differed"
        : allMatched
          ? "All bounded local and remote sample hashes matched"
          : "One or more bounded ranges could not be verified without a full download",
    };
  } catch (error) {
    return {
      cachePath: fileEntry.path,
      repositoryPath,
      cacheRevision,
      localSize: fileEntry.size,
      repositorySize,
      status: "partial",
      transport: repositoryMetadataTransport({
        repositorySize,
        reason: "The cache file could not be opened or sampled; only frozen repository metadata is available",
      }),
      ranges: [{
        offset: 0,
        length: 0,
        status: "failed",
        localSha256: undefined,
        remoteSha256: undefined,
        responseStatus: undefined,
        contentRange: undefined,
        etag: undefined,
        lastModified: undefined,
        error: serializeInvestigationError({ error }),
      }],
      reason: "The cache file could not be opened or sampled",
    };
  }
}

export async function verifyModelCacheProvenance({
  inventory,
  repository,
  storageRoot,
  repositoryFetch,
  rangeBytes,
  maximumFileCount,
}: {
  inventory: ModelSupportInvestigationCacheInventory,
  repository: ModelSupportInvestigationRepository,
  storageRoot: FileSystemDirectoryHandle,
  repositoryFetch: typeof fetch,
  rangeBytes: number,
  maximumFileCount: number,
}): Promise<ModelSupportInvestigationCacheProvenance> {
  if (!Number.isSafeInteger(rangeBytes) || rangeBytes <= 0) throw new RangeError("rangeBytes must be a positive safe integer");
  if (!Number.isSafeInteger(maximumFileCount) || maximumFileCount <= 0) throw new RangeError("maximumFileCount must be a positive safe integer");
  const candidates = cacheCandidates({ inventory, repository, maximumFileCount });
  if (candidates.length === 0) {
    return {
      schemaVersion: 1,
      method: "bounded-range-sha256-v1",
      resolvedRevision: repository.resolvedRevision,
      rangeBytes,
      maximumFileCount,
      status: "not-observed",
      confidence: "none",
      files: [],
      reason: "No complete non-empty cache file under the resolved or requested revision path was eligible for bounded sampling",
    };
  }
  const files: ModelSupportInvestigationCacheFileProvenance[] = [];
  for (const candidate of candidates) {
    files.push(await verifyFile({
      fileEntry: candidate,
      inventory,
      repository,
      storageRoot,
      repositoryFetch,
      rangeBytes,
    }));
  }
  const mismatched = files.some(file => file.status === "mismatched");
  const verified = files.length > 0 && files.every(file => file.status === "bounded-samples-matched");
  return {
    schemaVersion: 1,
    method: "bounded-range-sha256-v1",
    resolvedRevision: repository.resolvedRevision,
    rangeBytes,
    maximumFileCount,
    status: mismatched ? "mismatched" : verified ? "bounded-samples-matched" : "partial",
    confidence: mismatched ? "bounded-sample-mismatch" : verified ? "bounded-samples-matched" : "incomplete",
    files,
    reason: mismatched
      ? "At least one sampled cache file differed from the frozen resolved repository file"
      : verified
        ? "All selected cache files matched the frozen resolved repository in bounded beginning/middle/end SHA-256 samples"
        : "Some selected cache files could not be verified against the frozen resolved repository with bounded Range requests",
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  observeLightweightTransport,
  rangesForFile,
  sanitizedTransportUrl,
};
