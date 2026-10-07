import { z } from 'zod';
import { createValidatedMessagePort } from './worker-transport';
import { serveByteStream } from './byte-stream-port';
import { createAbortableByteStream } from './abortable-byte-stream';
import {
  DOWNLOAD_FRAGMENT_PATH, DOWNLOAD_VERSION, DOWNLOAD_CLAIM_TIMEOUT_MS, DOWNLOAD_HEARTBEAT_MS, downloadKeepAliveSchema, downloadStatusSchema, createDownloadUrl,
  downloadMetadataSchema, downloadControlSchema, normalizeDownloadFilename,
} from './download/protocol';

export type StreamDownloadOptions = {
  filename: string,
  /** Exact output byte length only, including zero; never a listing/estimated size. */
  size: number | undefined,
  signal: AbortSignal | undefined,
};

type StreamFactory = () => Promise<ReadableStream<Uint8Array>>;
type DownloadTarget = { registration: ServiceWorkerRegistration, worker: ServiceWorker, base: URL };
const DOWNLOAD_SETUP_TIMEOUT_MS = 5_000;
const DOWNLOAD_BLOB_RELEASE_DELAY_MS = 60_000;
const navigationPreloadStateSchema = z.object({ enabled: z.boolean() });

function clickDownload({ url, filename }: { url: string, filename: string }): void {
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.referrerPolicy = 'no-referrer';
  anchor.hidden = true;
  try {
    document.body.append(anchor);
    anchor.click();
  } finally {
    anchor.remove();
  }
}

/** Existing disk-backed File/Blob values need no stream-to-Blob materialization. */
export function downloadBlob({ blob, filename }: { blob: Blob, filename: string }): void {
  const url = URL.createObjectURL(blob);
  try {
    clickDownload({ url, filename: normalizeDownloadFilename({ filename }) });
  } catch (reason) {
    // No dispatched download needs the URL if setup/click failed synchronously.
    URL.revokeObjectURL(url);
    throw reason;
  }
  // A successful click only dispatches a navigation. Do not revoke its backing
  // bytes before the browser has had an opportunity to start consuming them.
  setTimeout(() => URL.revokeObjectURL(url), DOWNLOAD_BLOB_RELEASE_DELAY_MS);
}

async function waitForDownloadOperation<T>({ operation, signal, timeoutMs }: {
  operation: () => Promise<T>, signal: AbortSignal, timeoutMs: number | undefined,
}): Promise<T> {
  signal.throwIfAborted();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stopped = Promise.withResolvers<never>();
  const onAbort = () => stopped.reject(signal.reason);
  signal.addEventListener('abort', onAbort, { once: true });
  if (timeoutMs !== undefined) {
    timer = setTimeout(() => stopped.reject(new Error('Download setup timed out')), timeoutMs);
  }
  try {
    return await Promise.race([Promise.resolve().then(() => {
      signal.throwIfAborted();
      return operation();
    }), stopped.promise]);
  } finally {
    signal.removeEventListener('abort', onAbort);
    clearTimeout(timer);
  }
}

/** Inspect only existing registrations; dev/first visits need not install a worker. */
async function findDownloadTarget({ signal }: { signal: AbortSignal }): Promise<DownloadTarget | undefined> {
  if (location.protocol === 'file:' || !globalThis.isSecureContext
    || !('serviceWorker' in navigator) || typeof navigator.serviceWorker.getRegistration !== 'function'
    || typeof MessageChannel !== 'function' || typeof globalThis.crypto?.randomUUID !== 'function') return;
  // .ready can remain pending forever when no worker is registered (e.g. dev).
  // getRegistration is a local lookup, not register/update or a network request.
  const registration = await waitForDownloadOperation({
    operation: () => navigator.serviceWorker.getRegistration(),
    signal,
    timeoutMs: DOWNLOAD_SETUP_TIMEOUT_MS,
  });
  signal.throwIfAborted();
  const worker = registration?.active;
  if (!registration || !worker || worker.state !== 'activated') return;
  const base = new URL(registration.scope);
  if (base.origin !== location.origin || !location.pathname.startsWith(base.pathname)) return;
  // An overlapping registration for the reserved path must not receive our
  // navigation. This lookup is local too and contains no token or metadata.
  const destination = new URL(DOWNLOAD_FRAGMENT_PATH, base);
  const target = await waitForDownloadOperation({
    operation: () => navigator.serviceWorker.getRegistration(destination.href),
    signal,
    timeoutMs: DOWNLOAD_SETUP_TIMEOUT_MS,
  });
  if (!target || target.scope !== registration.scope || target.active !== worker) return;
  // A preload can contact the host before the fetch handler runs. Do not enable,
  // disable or otherwise modify the app's registration; use Blob saving instead.
  if (target.navigationPreload) {
    const state = await waitForDownloadOperation({
      operation: () => target.navigationPreload.getState(),
      signal,
      timeoutMs: DOWNLOAD_SETUP_TIMEOUT_MS,
    });
    if (navigationPreloadStateSchema.parse(state).enabled) return;
  }
  signal.throwIfAborted();
  if (target.active !== worker || worker.state !== 'activated') return;
  // A new navigation selects this active worker, not the page's older controller.
  return { registration: target, worker, base };
}

/** Compatibility path: retains the complete output, just like the former saves. */
async function downloadBufferedStream({ openStream, filename, size, signal }: {
  openStream: StreamFactory, filename: string, size: number | undefined, signal: AbortSignal,
}): Promise<void> {
  let openedStream: ReadableStream<Uint8Array> | undefined;
  const chunks: BlobPart[] = [];
  let written = 0;
  try {
    const stream = await waitForDownloadOperation({
      signal,
      timeoutMs: undefined,
      operation: async () => {
      const opened = await openStream();
      // Retain ownership before resolving the setup race: abort can win after
      // this callback returns but before its caller receives the stream.
      openedStream = opened;
      if (signal.aborted) {
        if (!opened.locked) void opened.cancel(signal.reason).catch(() => undefined);
        signal.throwIfAborted();
      }
      return opened;
    },
    });
    // Do not let a producer's never-settling cancel hook hold the UI open.
    await createAbortableByteStream({ stream, signal, onCancel: undefined }).pipeTo(new WritableStream<Uint8Array>({
      write(chunk) {
        if (!ArrayBuffer.isView(chunk) || Object.prototype.toString.call(chunk) !== '[object Uint8Array]') {
          throw new Error('Expected a byte stream');
        }
        written += chunk.byteLength;
        if (size !== undefined && written > size) throw new Error('Download exceeds its declared size');
        // Producers may reuse their buffers: Blob parts must own stable bytes.
        chunks.push(Uint8Array.from(chunk));
      },
    }));
    signal.throwIfAborted();
    if (size !== undefined && written !== size) throw new Error('Download size does not match its declared size');
    downloadBlob({ blob: new Blob(chunks), filename });
  } catch (reason) {
    // Includes a result orphaned by the setup race. A later factory result is
    // handled inside the callback above; never cancel a caller-owned lock.
    if (openedStream && !openedStream.locked) void openedStream.cancel(reason).catch(() => undefined);
    throw reason;
  } finally {
    chunks.length = 0;
  }
}

/**
 * Prefer the existing worker's versioned streaming protocol. Before a response
 * is claimed or the source factory is called, unavailable streaming falls back
 * to the former Blob download (including dev/hosted pages without a worker).
 * Neither cancellation nor a partly consumed one-shot source is retried.
 * Completion is stream EOF / Blob-link dispatch, NOT a durable disk-write event.
 */
export async function downloadStream({ openStream, filename, size, signal }: StreamDownloadOptions & {
  openStream: StreamFactory,
}): Promise<void> {
  await downloadSource({ openStream, filename, size, signal, fallbackFile: undefined });
}

/**
 * The same File/Blob supplies both exact size and bytes. In particular, an OPFS
 * File must not be converted to a buffered Blob just because no SW is active.
 * This does not reopen a path or promise that a modified disk file stays readable.
 */
export async function downloadFile({ file, filename, signal }: {
  file: Blob, filename: string, signal: AbortSignal | undefined,
}): Promise<void> {
  await downloadSource({ openStream: async () => file.stream(), filename, size: file.size, signal, fallbackFile: file });
}

async function downloadSource({ openStream, filename, size, signal, fallbackFile }: StreamDownloadOptions & {
  openStream: StreamFactory,
  fallbackFile: Blob | undefined,
}): Promise<void> {
  signal?.throwIfAborted();
  const metadata = downloadMetadataSchema.parse({ filename: normalizeDownloadFilename({ filename }), size });
  const lifecycle = new AbortController();
  const onAbort = () => lifecycle.abort(signal?.reason);
  const onPageHide = () => lifecycle.abort(new DOMException('Download page closed', 'AbortError'));
  signal?.addEventListener('abort', onAbort, { once: true });
  window.addEventListener('pagehide', onPageHide, { once: true });
  let sourceOpened = false;
  let responseClaimed = false;
  try {
    try {
      const target = await findDownloadTarget({ signal: lifecycle.signal });
      if (target) {
        await downloadWithWorker({
          target,
          metadata,
          signal: lifecycle.signal,
          openStream: async () => {
            // Set BEFORE awaiting: a rejected factory must never be run twice.
            sourceOpened = true;
            return openStream();
          },
          onClaimed: () => {
            responseClaimed = true;
          },
        });
        return;
      }
    } catch (reason) {
      lifecycle.signal.throwIfAborted();
      // Claim may open a save dialog even before the first read. Retrying then
      // could create duplicate downloads. Independent port ordering also means
      // a data pull can arrive before the claimed notification; check both.
      if (sourceOpened || responseClaimed) throw reason;
      // Worker/API/protocol/permission failures before this boundary are safe
      // to retry with the untouched input, after downloadWithWorker's cleanup.
    }
    lifecycle.signal.throwIfAborted();
    if (fallbackFile !== undefined) {
      // Keep the browser-backed File intact: no reader, chunks, or second Blob.
      downloadBlob({ blob: fallbackFile, filename: metadata.filename });
    } else {
      await downloadBufferedStream({ openStream, filename: metadata.filename, size: metadata.size, signal: lifecycle.signal });
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
    window.removeEventListener('pagehide', onPageHide);
  }
}

async function downloadWithWorker({ target: { registration, worker, base }, metadata, openStream, onClaimed, signal }: {
  target: DownloadTarget, metadata: ReturnType<typeof downloadMetadataSchema.parse>,
  openStream: StreamFactory, onClaimed: () => void, signal: AbortSignal,
}): Promise<void> {
  const token = crypto.randomUUID();
  const control = new MessageChannel();
  let data: MessageChannel | undefined;
  let source: ReturnType<typeof serveByteStream> | undefined;
  let channel: ReturnType<typeof createValidatedMessagePort<typeof downloadStatusSchema, typeof downloadControlSchema>> | undefined;
  const abort = new AbortController();
  const completion = Promise.withResolvers<void>();
  void completion.promise.catch(() => undefined);
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let heartbeatTimeout: ReturnType<typeof setTimeout> | undefined;
  type Phase = 'preparing' | 'ready' | 'claimed' | 'finished';
  let phase: Phase = 'preparing';
  let portsTransferred = false;
  let downloadFrame: HTMLIFrameElement | undefined;
  const isFinished = () => {
    switch (phase) {
    case 'finished': return true;
    case 'preparing': case 'ready': case 'claimed': return false;
    default: { const exhaustive: never = phase; throw new Error(`Unknown download phase: ${exhaustive}`); }
    }
  };
  const requirePhase = ({ expected }: { expected: Phase }) => {
    if (phase !== expected) throw new Error(`Unexpected download phase: ${phase}; expected ${expected}`);
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const fail = ({ reason }: { reason: unknown }) => {
    if (isFinished()) return;
    phase = 'finished';
    try {
      channel?.send({ message: { type: 'cancel' }, transferables: [] });
    } catch { /* The peer may already be gone. */ }
    abort.abort(reason);
    completion.reject(reason);
  };
  const onAbort = () => fail({ reason: signal.reason });
  const onWorkerChange = () => {
    if (worker.state === 'redundant' || registration.active !== worker) {
      fail({ reason: new Error('Download worker replaced. Retry the download.') });
    }
  };
  try {
    signal.throwIfAborted();
    data = new MessageChannel();
    source = serveByteStream({
      port: data.port1,
      signal: abort.signal,
      openStream: async () => {
      signal.throwIfAborted();
      // A broken/outdated peer must not consume the input during negotiation.
      if (phase !== 'ready' && phase !== 'claimed') throw new Error('Download was not prepared');
      return openStream();
    },
    });
    void source.completed.catch(reason => fail({ reason }));
    channel = createValidatedMessagePort({
      port: control.port1,
      incomingSchema: downloadStatusSchema,
      outgoingSchema: downloadControlSchema,
      onError: fail,
      onMessage({ message }) {
        if (isFinished()) return;
        try {
          switch (message.type) {
          case 'ready':
            requirePhase({ expected: 'preparing' });
            if (message.version !== DOWNLOAD_VERSION || message.token !== token) throw new Error('Invalid download handshake');
            if (registration.active !== worker || worker.state !== 'activated') throw new Error('Download worker replaced during preparation');
            phase = 'ready';
            heartbeat = setInterval(() => {
              if (heartbeatTimeout !== undefined) return;
              try {
                worker.postMessage(downloadKeepAliveSchema.parse({ type: 'naidan-download/keepalive', version: DOWNLOAD_VERSION, token }), []);
                heartbeatTimeout = setTimeout(() => fail({ reason: new Error('Download worker stopped responding. Retry the download.') }), 120_000);
              } catch (reason) {
                fail({ reason });
              }
            }, DOWNLOAD_HEARTBEAT_MS);
            clearTimeout(timer);
            timer = setTimeout(() => fail({ reason: new Error('The browser did not start the download. Check download permissions and retry.') }), DOWNLOAD_CLAIM_TIMEOUT_MS + 1_000);
            // Keep the producer page and response frame alive until stream EOF.
            // Content-Disposition, not <a download>, supplies the filename.
            downloadFrame = document.createElement('iframe');
            downloadFrame.hidden = true;
            // The token must never enter a request target, Referer or server log.
            downloadFrame.referrerPolicy = 'no-referrer';
            downloadFrame.src = createDownloadUrl({ base, token, version: DOWNLOAD_VERSION }).href;
            document.body.append(downloadFrame);
            return;
          case 'pong':
            clearTimeout(heartbeatTimeout);
            heartbeatTimeout = undefined;
            return;
          case 'claimed':
            requirePhase({ expected: 'ready' });
            phase = 'claimed';
            onClaimed();
            clearTimeout(timer);
            return;
          case 'consumed':
            requirePhase({ expected: 'claimed' });
            phase = 'finished';
            completion.resolve();
            return;
          case 'error':
            throw new Error(message.message);
          default: {
            const exhaustive: never = message;
            throw new Error(`Unknown download status: ${String(exhaustive)}`);
          }
          }
        } catch (reason) {
          fail({ reason });
        }
      },
    });
    signal.addEventListener('abort', onAbort, { once: true });
    worker.addEventListener('statechange', onWorkerChange);
    timer = setTimeout(() => fail({ reason: new Error('Download worker does not support the streaming protocol') }), DOWNLOAD_SETUP_TIMEOUT_MS);
    onWorkerChange();
    if (!isFinished()) {
      worker.postMessage({ type: 'naidan-download/prepare', version: DOWNLOAD_VERSION, token, metadata }, [control.port2, data.port2]);
      portsTransferred = true;
    }
    if (signal.aborted) onAbort();
    await completion.promise;
  } catch (reason) {
    fail({ reason });
    throw reason;
  } finally {
    const frame = downloadFrame;
    if (frame) {
      if (abort.signal.aborted) frame.remove();
      else setTimeout(() => frame.remove(), 60_000);
    }
    clearInterval(heartbeat);
    clearTimeout(heartbeatTimeout);
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
    worker.removeEventListener('statechange', onWorkerChange);
    channel?.close();
    control.port1.close();
    data?.port1.close();
    // Transferred endpoints belong to the worker; close only local endpoints.
    if (!portsTransferred) {
      control.port2.close(); data?.port2.close();
    }
  }
}

/** Takes ownership of stream immediately, including failures before negotiation. */
export async function downloadReadableStream({ stream, ...options }: StreamDownloadOptions & {
  stream: ReadableStream<Uint8Array>,
}): Promise<void> {
  try {
    await downloadStream({ ...options, openStream: async () => stream });
  } catch (reason) {
    if (!stream.locked) void stream.cancel(reason).catch(() => undefined);
    throw reason;
  }
}

export const TEST_ONLY = {
  DOWNLOAD_SETUP_TIMEOUT_MS,
  DOWNLOAD_BLOB_RELEASE_DELAY_MS,
};
