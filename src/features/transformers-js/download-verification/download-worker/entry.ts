/* eslint-disable no-restricted-imports -- Explicit Download Worker intentionally imports the Transformers.js runtime directly. */
import {
  AutoConfig,
  AutoProcessor,
  AutoTokenizer,
  env,
  type ProgressCallback as TransformersProgressCallback,
} from '@huggingface/transformers';
import type {
  ITransformersJsDownloadWorker,
  ProgressInfo,
  TransformersJsPrefetchFailureStage,
  TransformersJsPrefetchFileResult,
  TransformersJsPrefetchResult,
  TransformersJsProductionInvestigationError,
  TransformersJsRuntimeArtifactPreparationResult,
} from '@/features/transformers-js/types';
import { exposeWorkerRemote, type WorkerServerApi } from '@/utils/worker-transport';
import { normalizeTransformersJsProductionModelId } from '@/features/transformers-js/production-routing';
import { assertFullResourceResponse, expectedDecodedResponseByteLength, urlToPath, writeIncompleteOpfsFile, writeToOpfsWithStagingUnderLease } from '@/features/transformers-js/utils';
import { assertOpfsFileLease, readCompletedOpfsSnapshot, withOpfsFileLease, type OpfsFileLease } from '@/features/transformers-js/runtime/opfs-access';
import { configureHostedTransformersRuntime } from '@/features/transformers-js/runtime/configure-hosted-runtime';
import { createHostedTransformersModelFetch } from '@/features/transformers-js/runtime/model-fetch';
import { createOpfsModelCache } from '@/features/transformers-js/runtime/opfs-model-cache';
import { prepareRuntimeMetadata } from './prepare-runtime-metadata';
import { createRuntimeMetadataStorage } from './metadata-storage';
import { createDownloadProgressEmitter } from '@/features/transformers-js/download-verification/download-progress-emitter';
import { downloadResourcePath } from '@/features/transformers-js/download-progress';
import { createDownloadMeasurementClock, type DownloadFileTiming } from '@/features/transformers-js/download-timing';

const originalFetch = self.fetch;
const { runtimeFetch } = configureHostedTransformersRuntime({
  env,
  workerLocationUrl: self.location.href,
  environment: import.meta.env.DEV ? 'development' : 'production',
  userAgent: navigator.userAgent,
  vendor: navigator.vendor,
  hardwareConcurrency: navigator.hardwareConcurrency,
  originalFetch,
  createDecompressionStream: () => new DecompressionStream('gzip'),
});
const downloadFetch = createHostedTransformersModelFetch({ runtimeFetch });
self.fetch = downloadFetch;
env.fetch = downloadFetch;
env.allowLocalModels = false;
env.allowRemoteModels = true;
env.useBrowserCache = false;
env.useCustomCache = true;
env.customCache = createOpfsModelCache({ mutationPolicy: 'read-write' });
env.backends.onnx.logLevel = 'error';

let activeDownloadOperation: 'metadata' | 'prefetch' | 'terminal' | undefined;
let metadataIdentity: string | undefined;

function sanitizeUrl({ url }: { url: string }): string {
  try {
    const parsed = new URL(url);
    parsed.search = '';
    parsed.hash = '';
    return parsed.href;
  } catch {
    return url.split(/[?#]/u, 1)[0] ?? url;
  }
}

function fileNameFromUrl({ url }: { url: string }): string | undefined {
  return downloadResourcePath({ url });
}

function sanitizeDiagnosticText({ value }: { value: string }): string {
  return value.replace(/https?:\/\/[^\s"'<>]+/giu, url => sanitizeUrl({ url }));
}

function serializeCause({ error }: { error: unknown }): TransformersJsProductionInvestigationError['cause'] {
  if (!(error instanceof Error)) return undefined;
  return {
    name: error.name,
    message: sanitizeDiagnosticText({ value: error.message }),
    stack: error.stack === undefined ? undefined : sanitizeDiagnosticText({ value: error.stack }),
    thrownType: error.constructor.name || 'Error',
  };
}

function serializeError({ error }: { error: unknown }): TransformersJsProductionInvestigationError {
  if (!(error instanceof Error)) {
    return {
      name: 'NonErrorThrownValue',
      message: sanitizeDiagnosticText({ value: typeof error === 'string' ? error : 'A non-Error value was thrown' }),
      thrownType: error === null ? 'null' : typeof error,
    };
  }
  const cause = 'cause' in error ? serializeCause({ error: error.cause }) : undefined;
  return {
    name: error.name,
    message: sanitizeDiagnosticText({ value: error.message }),
    stack: error.stack === undefined ? undefined : sanitizeDiagnosticText({ value: error.stack }),
    thrownType: error.constructor.name || 'Error',
    cause,
    causeChain: cause === undefined ? undefined : [cause],
  };
}

function prefetchFailure({
  url,
  path,
  failureStage,
  httpStatus,
  error,
}: {
  url: string;
  path: string | undefined;
  failureStage: TransformersJsPrefetchFailureStage;
  httpStatus?: number;
  error: unknown;
}): Extract<TransformersJsPrefetchFileResult, { status: 'failed' }> {
  return {
    status: 'failed',
    url,
    path,
    failureStage,
    httpStatus,
    error: serializeError({ error }),
  };
}

function isNotFoundError({ error }: { error: unknown }): boolean {
  return error instanceof Error && error.name === 'NotFoundError';
}

async function removeIfPresent({ directory, name }: {
  directory: FileSystemDirectoryHandle;
  name: string;
}): Promise<void> {
  try {
    await directory.removeEntry(name);
  } catch (error) {
    if (!isNotFoundError({ error })) throw error;
  }
}

async function completedByteLength({ path, lease }: { path: string; lease: OpfsFileLease }): Promise<number | undefined> {
  assertOpfsFileLease({ path, lease, mode: 'exclusive' });
  const parts = path.split('/');
  const fileName = parts.pop();
  if (fileName === undefined || fileName.length === 0) return undefined;
  let directory = await navigator.storage.getDirectory();
  for (const part of parts) {
    if (part.length === 0) continue;
    try {
      directory = await directory.getDirectoryHandle(part, { create: false });
    } catch (error) {
      if (isNotFoundError({ error })) return undefined;
      throw error;
    }
  }
  const markerName = `.${fileName}.complete`;
  try {
    await directory.getFileHandle(markerName, { create: false });
  } catch (error) {
    if (isNotFoundError({ error })) return undefined;
    throw error;
  }
  try {
    const file = await (await directory.getFileHandle(fileName, { create: false })).getFile();
    if (file.size > 0) return file.size;
  } catch (error) {
    if (!isNotFoundError({ error })) throw error;
  }
  await removeIfPresent({ directory, name: markerName });
  await removeIfPresent({ directory, name: fileName });
  return undefined;
}

const workerApi: WorkerServerApi<ITransformersJsDownloadWorker> = {
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Comlink remote boundary.
  async prepareModelRuntimeArtifacts(modelId, revision, progressCallback): Promise<TransformersJsRuntimeArtifactPreparationResult> {
    const cleanModelId = normalizeTransformersJsProductionModelId({ modelId });
    if (cleanModelId.startsWith('user/')) throw new Error('Runtime artifact preparation only supports public Hugging Face models');
    if (!/^[0-9a-f]{40}$/iu.test(revision)) {
      throw new Error(`Runtime artifact preparation requires an exact 40-character Hugging Face revision SHA: ${revision}`);
    }
    if (activeDownloadOperation !== undefined) throw new Error('Download Worker is busy or terminal; concurrent operations are forbidden');
    const identity = `${cleanModelId}@${revision}`;
    if (metadataIdentity !== undefined && metadataIdentity !== identity) throw new Error('A different metadata identity requires a fresh Worker');
    metadataIdentity = identity;
    activeDownloadOperation = 'metadata';
    const progress = createDownloadProgressEmitter({ callback: ({ info }) => progressCallback(info) });
    let succeeded = false;
    try {
      const result = await prepareRuntimeMetadata({
        modelId: cleanModelId, revision, runtime: { AutoConfig, AutoProcessor, AutoTokenizer, env }, downloadFetch,
        storage: createRuntimeMetadataStorage(), maximumByteLength: 64 * 1024 * 1024,
        progressCallback: (info => progress.publish({ info })) as TransformersProgressCallback,
        onStage: ({ stage }) => progress.publish({ info: { status: `download-metadata:${stage}` } }),
      });
      succeeded = true;
      return result;
    } finally {
      // A failed operation can leave upstream memoized failures or unresponsive
      // cleanup. Only its caller's dispose/terminate may retire that ownership.
      activeDownloadOperation = succeeded ? undefined : 'terminal';
      progress.close();
    }
  },

  // eslint-disable-next-line local-rules-named-args/require-named-args -- Comlink remote boundary.
  async prefetchUrls(urls, progressCallback): Promise<TransformersJsPrefetchResult> {
    if (activeDownloadOperation !== undefined) throw new Error('Download Worker is busy or terminal; concurrent operations are forbidden');
    activeDownloadOperation = 'prefetch';
    const progress = createDownloadProgressEmitter({ callback: ({ info }) => progressCallback(info) });
    try {
      const files: TransformersJsPrefetchFileResult[] = [];
      const measurement = createDownloadMeasurementClock();
      const callStarted = measurement.read();
      let lastFileFinished: number | undefined;
      let fileStarted: number | undefined;
      let fetchStarted: number | undefined;
      let responseReceived: number | undefined;
      let eof: number | undefined;
      let measuredFiles = 0;
      let droppedFiles = 0;
      let saveMethod: DownloadFileTiming['saveMethod'] | undefined;
      function fileTiming({ verified }: { verified: boolean }): DownloadFileTiming | undefined {
        const finished = measurement.read();
        lastFileFinished = finished;
        if (saveMethod === undefined) return undefined;
        if (measuredFiles >= 128) {
          droppedFiles++; return undefined;
        }
        measuredFiles++;
        const admissionMs = measurement.elapsed({ start: fileStarted, end: fetchStarted ?? finished });
        const responseWaitMs = measurement.elapsed({ start: fetchStarted, end: responseReceived });
        const streamMs = measurement.elapsed({ start: fetchStarted, end: eof });
        // EOF is merely the input boundary. Only successful final marker/size
        // verification permits a completed save residual; failure is not zero.
        const eofToVerifiedMs = verified ? measurement.elapsed({ start: eof, end: finished }) : undefined;
        const measured = admissionMs !== undefined && (!verified || (responseWaitMs !== undefined && streamMs !== undefined && eofToVerifiedMs !== undefined));
        return { version: 1, clockId: measurement.clockId, status: measured ? 'measured' : 'unavailable', saveMethod, admissionMs, responseWaitMs, streamMs, eofToVerifiedMs };
      }
      let clockId = measurement.clockId;
      let sequence = 0;
      let requestId = 0;
      let firstFetchStartedAtMs: number | undefined;
      let receivedBytes = 0;
      let cumulativeSequence = 0;
      function cumulativeTiming(): ProgressInfo['downloadCumulativeTiming'] {
        if (clockId === undefined) return 'unavailable';
        if (firstFetchStartedAtMs === undefined) return undefined;
        const observedAtMs = measurement.read();
        if (observedAtMs === undefined || observedAtMs < firstFetchStartedAtMs
          || observedAtMs - firstFetchStartedAtMs > 7 * 24 * 60 * 60 * 1_000
          || !Number.isSafeInteger(receivedBytes) || !Number.isSafeInteger(cumulativeSequence + 1)) {
          clockId = undefined;
          return 'unavailable';
        }
        // This is deliberately wall time since the first real GET, including
        // earlier file saves and inter-file waits. Consumers must not add those
        // saving intervals again. Cached bytes never enter receivedBytes.
        return { clockId, sequence: ++cumulativeSequence, firstFetchStartedAtMs, observedAtMs, receivedBytes };
      }
      function recordFailure({ file }: { file: Extract<TransformersJsPrefetchFileResult, { status: 'failed' }> }): void {
        files.push({ ...file, timing: fileTiming({ verified: false }) });
        // Report the existing failure without waiting for later files or any
        // observer. This does not change its classification or transfer result.
        progress.publish({ info: {
          status: 'error', file: fileNameFromUrl({ url: file.url }),
          loaded: file.transferObservation?.receivedBytes,
          total: file.transferObservation?.expectedBytes,
          downloadCumulativeTiming: cumulativeTiming(),
        } });
      }
      for (const url of urls) progress.publish({ info: { status: 'queued', file: fileNameFromUrl({ url }), loaded: 0 } });
      for (const originalUrl of urls) {
        saveMethod = undefined;
        fileStarted = measurement.read();
        fetchStarted = undefined;
        responseReceived = undefined;
        eof = undefined;
        const url = sanitizeUrl({ url: originalUrl });
        const path = urlToPath({ url: originalUrl });
        if (path === null) {
          recordFailure({ file: prefetchFailure({ url, path: undefined, failureStage: 'resolve-path', error: new Error('The model URL could not be mapped to an OPFS path') }) });
          continue;
        }
        const transfer = async ({ lease }: { lease: OpfsFileLease }): Promise<void> => {
          saveMethod = lease.coordinated ? 'direct' : 'staging-copy';
          let cached: number | undefined;
          try {
            cached = await completedByteLength({ path, lease });
          } catch (error) {
            recordFailure({ file: prefetchFailure({ url, path, failureStage: 'cache-check', error }) });
            return;
          }
          if (cached !== undefined) {
            files.push({ status: 'cached', url, path, byteLength: cached, expectedByteLength: undefined, timing: fileTiming({ verified: false }) });
            progress.publish({ info: { status: 'cached', file: fileNameFromUrl({ url: originalUrl }), loaded: cached, total: cached, progress: 100, downloadCumulativeTiming: cumulativeTiming() } });
            return;
          }
          let response: Response;
          try {
            fetchStarted = measurement.read();
            if (firstFetchStartedAtMs === undefined) {
              firstFetchStartedAtMs = fetchStarted;
              if (fetchStarted === undefined) clockId = undefined;
            }
            response = await downloadFetch(originalUrl);
            responseReceived = measurement.read();
          } catch (error) {
            recordFailure({ file: prefetchFailure({ url, path, failureStage: 'fetch', error }) });
            return;
          }
          try {
            await assertFullResourceResponse({ response });
          } catch (error) {
            recordFailure({ file: prefetchFailure({
              url,
              path,
              failureStage: 'response-status',
              httpStatus: response.status,
              error,
            }) });
            return;
          }
          if (response.body === null) {
            recordFailure({ file: prefetchFailure({ url, path, failureStage: 'fetch', httpStatus: response.status, error: new Error('The model response did not include a readable body') }) });
            return;
          }
          const expected = expectedDecodedResponseByteLength({ response });
          requestId++;
          const currentRequestId = requestId;
          const downloadTotalKind = response.type === 'cors' && response.headers.get('Content-Encoding')?.trim().toLowerCase() !== 'identity'
            ? 'unverified-http' as const : 'decoded-response' as const;
          const timing = () => {
            if (clockId === undefined) return 'unavailable' as const;
            try {
              const observedAtMs = performance.now();
              if (!Number.isFinite(observedAtMs) || observedAtMs < 0) throw new Error('Unavailable timing observation');
              return { clockId, requestId: currentRequestId, sequence: ++sequence, observedAtMs };
            } catch {
            // Only the timing observation is omitted; fetch/write failures keep
            // their original classification and remain terminal below.
            // Disable timing for this prefetch. Sticky unavailability survives
            // coalescing through later progress and terminal notifications;
            // recovery belongs to the next prefetch, not a growing epoch ledger.
              clockId = undefined;
              return 'unavailable' as const;
            }
          };
          let loaded = 0;
          progress.publish({ info: { status: 'download', file: fileNameFromUrl({ url: originalUrl }), loaded: 0, total: expected, downloadTotalKind, downloadTiming: timing(), downloadCumulativeTiming: cumulativeTiming() } });
          const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
              loaded += chunk.byteLength;
              receivedBytes += chunk.byteLength;
              progress.publish({ info: { status: 'progress', file: fileNameFromUrl({ url: originalUrl }), loaded, total: expected, progress: expected === undefined || expected === 0 ? undefined : Math.min(100, 100 * loaded / expected), downloadTotalKind, downloadTiming: timing(), downloadCumulativeTiming: cumulativeTiming() } });
              controller.enqueue(chunk);
            },
            flush() {
              eof = measurement.read();
              progress.publish({ info: { status: 'saving', file: fileNameFromUrl({ url: originalUrl }), loaded, total: expected, progress: expected === undefined || expected === 0 ? undefined : Math.min(100, 100 * loaded / expected), downloadTotalKind, downloadTiming: timing(), downloadCumulativeTiming: cumulativeTiming() } });
            },
          }));
          let written: number;
          try {
            ({ byteLength: written } = await (lease.coordinated ? writeIncompleteOpfsFile : writeToOpfsWithStagingUnderLease)({ path, lease, response: new Response(body, {
              status: response.status, statusText: response.statusText, headers: response.headers,
            }) }));
          } catch (error) {
            recordFailure({ file: { ...prefetchFailure({ url, path, failureStage: 'write', httpStatus: response.status, error }), transferObservation: { receivedBytes: loaded, expectedBytes: expected } } });
            return;
          }
          try {
            const verified = await completedByteLength({ path, lease });
            if (verified === undefined || verified !== written) throw new Error(`Final OPFS verification failed for ${path}`);
            if (expected !== undefined && verified !== expected) {
              throw new Error(`Final OPFS byte length mismatch for ${path}: expected ${expected}, received ${verified}`);
            }
            files.push({ status: 'downloaded', url, path, byteLength: verified, expectedByteLength: expected, timing: fileTiming({ verified: true }) });
            progress.publish({ info: { status: 'done', file: fileNameFromUrl({ url: originalUrl }), loaded: verified, total: verified, progress: 100, downloadCumulativeTiming: cumulativeTiming(), ...clockId === undefined ? { downloadTiming: 'unavailable' as const } : {} } });
          } catch (error) {
            recordFailure({ file: { ...prefetchFailure({ url, path, failureStage: 'verification', httpStatus: response.status, error }), transferObservation: { receivedBytes: loaded, expectedBytes: expected } } });
          }
        };
        try {
          const completed = await withOpfsFileLease({ path, mode: 'shared', availability: 'wait', signal: undefined, run: async ({ lease }) => {
            if (!lease.coordinated) return undefined;
            saveMethod = 'direct';
            return await readCompletedOpfsSnapshot({ path, lease });
          } });
          if (completed !== undefined) {
            const byteLength = completed.size;
            files.push({ status: 'cached', url, path, byteLength, expectedByteLength: undefined, timing: fileTiming({ verified: false }) });
            progress.publish({ info: { status: 'cached', file: fileNameFromUrl({ url: originalUrl }), loaded: byteLength, total: byteLength, progress: 100, downloadCumulativeTiming: cumulativeTiming() } });
          } else {
            // The shared probe is fully released before requesting exclusive.
            // Recheck and all cleanup belong to this same-file lease.
            await withOpfsFileLease({ path, mode: 'exclusive', availability: 'wait', signal: undefined, run: transfer });
          }
        } catch (error) {
          recordFailure({ file: prefetchFailure({ url, path, failureStage: 'cache-check', error }) });
        }
      }
      const cachedCount = files.filter(file => file.status === 'cached').length;
      const downloadedCount = files.filter(file => file.status === 'downloaded').length;
      const failedCount = files.filter(file => file.status === 'failed').length;
      const finished = measurement.read();
      const callMs = measurement.elapsed({ start: callStarted, end: finished });
      return {
        requestedCount: urls.length,
        cachedCount,
        downloadedCount,
        failedCount,
        complete: files.length === urls.length && failedCount === 0,
        files,
        timing: { version: 1, clockId: measurement.clockId, status: callMs === undefined ? 'unavailable' : 'measured', callMs, finalizationMs: measurement.elapsed({ start: lastFileFinished, end: finished }), droppedFiles },
      };
    } finally {
      progress.close();
      activeDownloadOperation = undefined;
    }
  },
};

exposeWorkerRemote<ITransformersJsDownloadWorker>({ api: workerApi, endpoint: undefined });

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
