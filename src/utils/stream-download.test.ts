// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import { serveByteStream, receiveByteStream } from './byte-stream-port';
import { StreamingZipWriter, createWebZipCompressionCodec } from './zip-stream';
import { createMemoryZipCentralDirectoryStore, createReadableZipOutput } from './zip-stream/memory';
import { downloadStream, downloadReadableStream, downloadBlob, downloadFile, TEST_ONLY } from './stream-download';
import { DOWNLOAD_HEARTBEAT_MS, DOWNLOAD_CLAIM_TIMEOUT_MS, DOWNLOAD_VERSION, DOWNLOAD_FRAGMENT_PATH, downloadPrepareSchema } from './download/protocol';
import { installStreamDownloadWorker, type DownloadMessageEvent, type DownloadFetchEvent, type DownloadWorkerScope } from './download/service-worker';

let onMessage: (event: DownloadMessageEvent) => void;
let onFetch: (event: DownloadFetchEvent) => void;
let lifetimes: Promise<unknown>[];
let consumed: number[][];
let responseHeaders: Headers[];
let worker: EventTarget & { state: string, postMessage: ReturnType<typeof vi.fn<(message: unknown, ports: MessagePort[]) => void>> };
let registration: { active: typeof worker | null, scope: string, update: ReturnType<typeof vi.fn>, navigationPreload?: { getState: ReturnType<typeof vi.fn>, disable: ReturnType<typeof vi.fn> } };
let getRegistration: ReturnType<typeof vi.fn<() => Promise<typeof registration | undefined>>>;
let navigate: ReturnType<typeof vi.fn<(this: { src: string }) => void>>;
let click: ReturnType<typeof vi.fn>;
let removeFrame: ReturnType<typeof vi.fn>;
let page: EventTarget;
let createObjectURL: ReturnType<typeof vi.fn<typeof URL.createObjectURL>>;
let otherPorts: MessagePort[];
const { DOWNLOAD_SETUP_TIMEOUT_MS } = TEST_ONLY;

beforeEach(() => {
  lifetimes = [];
  consumed = [];
  responseHeaders = [];
  otherPorts = [];
  page = new EventTarget();
  installStreamDownloadWorker({
    scope: {
    registration: { scope: 'https://example.test/app/' },
    clients: { get: async () => ({ id: 'page' }) },
    addEventListener(type: string, listener: unknown) {
      if (type === 'message') onMessage = listener as typeof onMessage;
      if (type === 'fetch') onFetch = listener as typeof onFetch;
    },
  } as DownloadWorkerScope,
  });
  worker = Object.assign(new EventTarget(), {
    state: 'activated',
    postMessage: vi.fn((data: unknown, ports: MessagePort[]) => onMessage({
      data,
      ports,
      source: { id: 'page', type: 'window', url: 'https://example.test/app/index.html' },
      waitUntil(promise) {
        lifetimes.push(promise);
      },
    })),
  });
  registration = { active: worker, scope: 'https://example.test/app/', update: vi.fn() };
  getRegistration = vi.fn(async () => registration);
  navigate = vi.fn(function (this: { src: string }) {
    claimFrame({ src: this.src, consume: true });
  });
  click = vi.fn();
  removeFrame = vi.fn();
  vi.stubGlobal('window', page);
  vi.stubGlobal('document', {
    createElement: (tag: string) => ({ tag, src: '', href: '', download: '', click, remove: tag === 'iframe' ? removeFrame : vi.fn() }),
    body: {
      append: vi.fn((element: { tag: string, src: string }) => {
      if (element.tag === 'iframe') navigate.call(element);
    }),
    },
  });
  vi.stubGlobal('location', { protocol: 'https:', origin: 'https://example.test', pathname: '/app/index.html' });
  vi.stubGlobal('isSecureContext', true);
  vi.stubGlobal('navigator', {
    serviceWorker: {
    controller: worker,
    getRegistration,
    register: vi.fn(),
    get ready() {
      throw new Error('Do not wait for a worker to be installed');
    },
  },
  });
  createObjectURL = vi.fn(() => 'blob:test');
  vi.spyOn(URL, 'createObjectURL').mockImplementation(createObjectURL);
});
afterEach(async () => {
  page.dispatchEvent(new Event('pagehide'));
  await Promise.all(lifetimes);
  for (const port of otherPorts) port.close();
  if (vi.isFakeTimers()) vi.clearAllTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function smallStream(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
    controller.enqueue(new Uint8Array([1, 2, 3])); controller.close();
  },
  });
}
function fakeClock(): void {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
}
function claimFrame({ src, consume }: { src: string, consume: boolean }): void {
  const request = new Request(src, { referrer: '', referrerPolicy: 'no-referrer' });
  Object.defineProperty(request, 'mode', { value: 'navigate' });
  onFetch({
    request,
    clientId: '',
    stopImmediatePropagation() {},
    waitUntil(promise) {
      lifetimes.push(promise);
    },
    respondWith(response) {
      void Promise.resolve(response).then(value => responseHeaders.push(value.headers));
      if (consume) void Promise.resolve(response).then(async value => {
        consumed.push([...new Uint8Array(await value.arrayBuffer())]);
      }).catch(() => undefined);
    },
  });
}
function savedBlob(): Blob {
  expect(createObjectURL).toHaveBeenCalledOnce();
  const blob = createObjectURL.mock.calls[0]![0];
  if (!(blob instanceof Blob)) throw new Error('Expected a saved Blob');
  return blob;
}
async function expectBufferedBytes({ bytes }: { bytes: number[] }): Promise<void> {
  expect([...new Uint8Array(await savedBlob().arrayBuffer())]).toEqual(bytes);
  expect(click).toHaveBeenCalledOnce();
}

// Treat a protocol acknowledgement as the capability check, not a build flag or
// the existence of navigator.serviceWorker. No test enables/registers a dev SW.
describe('download feature detection and fallback', () => {

  it('puts only a capability in the fragment, with no request query or referrer', async () => {
    await downloadReadableStream({ stream: smallStream(), filename: 'private-report.zip', size: 3, signal: undefined });
    const frame = navigate.mock.contexts[0] as unknown as { src: string, referrerPolicy: string };
    const url = new URL(frame.src);
    const prepared = downloadPrepareSchema.parse(worker.postMessage.mock.calls[0]![0]);
    expect(prepared.version).toBe(2);
    expect(url.pathname).toBe('/app/__naidan_download__/v2/');
    expect(url.search).toBe('');
    expect(url.hash).toBe(`#?id=${prepared.token}`);
    expect(frame.referrerPolicy).toBe('no-referrer');
    expect(frame.src).not.toContain('private-report');
    expect(getRegistration).toHaveBeenLastCalledWith(new URL(DOWNLOAD_FRAGMENT_PATH, registration.scope).href);
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it('does not hand the reserved navigation to an overlapping registration', async () => {
    getRegistration.mockResolvedValueOnce(registration).mockResolvedValueOnce({ ...registration, scope: registration.scope + DOWNLOAD_FRAGMENT_PATH });
    await downloadReadableStream({ stream: smallStream(), filename: 'overlap', size: 3, signal: undefined });
    expect(navigate).not.toHaveBeenCalled();
    expect(worker.postMessage).not.toHaveBeenCalled();
    await expectBufferedBytes({ bytes: [1, 2, 3] });
  });

  it.each(['enabled', 'rejected', 'invalid'] as const)('does not navigate when preload state is %s, or change the registration', async mode => {
    const getState = mode === 'rejected' ? vi.fn().mockRejectedValue(new Error('unavailable'))
      : vi.fn().mockResolvedValue({ enabled: mode === 'enabled' ? true : undefined });
    registration.navigationPreload = { getState, disable: vi.fn() };
    const openStream = vi.fn(async () => smallStream());
    await downloadStream({ openStream, filename: 'preloaded', size: 3, signal: undefined });
    expect(getState).toHaveBeenCalledOnce();
    expect(registration.navigationPreload.disable).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    expect(worker.postMessage).not.toHaveBeenCalled();
    expect(openStream).toHaveBeenCalledOnce();
    await expectBufferedBytes({ bytes: [1, 2, 3] });
  });

  it('falls back without starting a navigation when the preload check never resolves', async () => {
    fakeClock();
    const getState = vi.fn(() => new Promise(() => {}));
    registration.navigationPreload = { getState, disable: vi.fn() };
    const openStream = vi.fn(async () => smallStream());
    const pending = downloadStream({ openStream, filename: 'timeout', size: 3, signal: undefined });
    await vi.waitFor(() => expect(getState).toHaveBeenCalledOnce());
    expect(openStream).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(DOWNLOAD_SETUP_TIMEOUT_MS);
    await pending;
    expect(navigate).not.toHaveBeenCalled();
    expect(worker.postMessage).not.toHaveBeenCalled();
    await expectBufferedBytes({ bytes: [1, 2, 3] });
  });

  it('does not fall back when cancelled while checking preload', async () => {
    const abort = new AbortController();
    const getState = vi.fn(() => new Promise(() => {}));
    registration.navigationPreload = { getState, disable: vi.fn() };
    const openStream = vi.fn(async () => smallStream());
    const pending = downloadStream({ openStream, filename: 'cancel', size: 3, signal: abort.signal });
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(getState).toHaveBeenCalledOnce());
    abort.abort();
    await rejected;
    expect(openStream).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it('falls back when the worker changes during the preload check', async () => {
    registration.navigationPreload = {
      getState: vi.fn(async () => {
      registration.active = null;
      return { enabled: false };
    }),
      disable: vi.fn(),
    };
    await downloadReadableStream({ stream: smallStream(), filename: 'changed', size: 3, signal: undefined });
    expect(navigate).not.toHaveBeenCalled();
    expect(worker.postMessage).not.toHaveBeenCalled();
    await expectBufferedBytes({ bytes: [1, 2, 3] });
  });

  it('streams when supported navigation preload is explicitly disabled', async () => {
    registration.navigationPreload = { getState: vi.fn().mockResolvedValue({ enabled: false }), disable: vi.fn() };
    await downloadReadableStream({ stream: smallStream(), filename: 'local', size: 3, signal: undefined });
    expect(navigate).toHaveBeenCalledOnce();
    expect(registration.navigationPreload.disable).not.toHaveBeenCalled();
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it('falls back when a v1 worker rejects v2; never retries a token-bearing path', async () => {
    worker.postMessage.mockImplementation((input, ports) => {
      otherPorts.push(...ports);
      expect(downloadPrepareSchema.parse(input).version).toBe(2);
      ports[0]!.postMessage({ type: 'error', message: 'Streaming download registration rejected' });
    });
    await downloadReadableStream({ stream: smallStream(), filename: 'legacy', size: 3, signal: undefined });
    expect(worker.postMessage).toHaveBeenCalledOnce();
    expect(navigate).not.toHaveBeenCalled();
    await expectBufferedBytes({ bytes: [1, 2, 3] });
  });

  it('streams after the handshake without a Blob, keeping the response frame until its EOF grace period', async () => {
    const openStream = vi.fn(async () => smallStream());
    await downloadStream({ openStream, filename: 'data.zip', size: 3, signal: undefined });
    expect(openStream).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledOnce();
    expect(click).not.toHaveBeenCalled();
    expect(removeFrame).not.toHaveBeenCalled();
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(navigator.serviceWorker.register).not.toHaveBeenCalled();
    expect(registration.update).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(consumed).toEqual([[1, 2, 3]]));
  });

  it('supports a first hosted visit with an active worker and no page controller', async () => {
    vi.stubGlobal('navigator', { serviceWorker: { controller: null, getRegistration } });
    await downloadReadableStream({ stream: smallStream(), filename: 'first', size: undefined, signal: undefined });
    expect(navigate).toHaveBeenCalledOnce();
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it('uses the destination active registration rather than an older page controller', async () => {
    const old = {
      postMessage: vi.fn(() => {
      throw new Error('old protocol');
    }),
    };
    vi.stubGlobal('navigator', { serviceWorker: { controller: old, getRegistration } });
    await downloadReadableStream({ stream: smallStream(), filename: 'updated', size: undefined, signal: undefined });
    expect(worker.postMessage).toHaveBeenCalledOnce();
    expect(old.postMessage).not.toHaveBeenCalled();
  });

  it('downloads immediately without ready, registration or update when dev has no service worker', async () => {
    fakeClock();
    getRegistration.mockResolvedValue(undefined);
    const openStream = vi.fn(async () => smallStream());
    // Do not advance the clock: the old 5-second .ready wait would hang here.
    await downloadStream({ openStream, filename: 'dev.zip', size: undefined, signal: undefined });
    expect(openStream).toHaveBeenCalledOnce();
    await expectBufferedBytes({ bytes: [1, 2, 3] });
    expect(navigate).not.toHaveBeenCalled();
    expect(worker.postMessage).not.toHaveBeenCalled();
    expect(navigator.serviceWorker.register).not.toHaveBeenCalled();
    expect(registration.update).not.toHaveBeenCalled();
  });

  it.each([
    'file', 'insecure', 'missing-service-worker', 'missing-registration-api', 'throwing-service-worker-getter',
    'no-active-worker', 'activating-worker', 'redundant-worker', 'wrong-scope', 'foreign-origin',
    'missing-message-channel', 'missing-random-uuid', 'registration-rejected', 'registration-throws',
  ] as const)('uses the former Blob save for %s', async condition => {
    switch (condition) {
    case 'file': vi.stubGlobal('location', { protocol: 'file:' }); break;
    case 'insecure': vi.stubGlobal('isSecureContext', false); break;
    case 'missing-service-worker': vi.stubGlobal('navigator', {}); break;
    case 'missing-registration-api': vi.stubGlobal('navigator', { serviceWorker: {} }); break;
    case 'throwing-service-worker-getter':
      vi.stubGlobal('navigator', {
        get serviceWorker() {
        throw new DOMException('blocked', 'SecurityError');
      },
      }); break;
    case 'no-active-worker': registration.active = null; break;
    case 'activating-worker': worker.state = 'activating'; break;
    case 'redundant-worker': worker.state = 'redundant'; break;
    case 'wrong-scope': registration.scope = 'https://example.test/other/'; break;
    case 'foreign-origin': registration.scope = 'https://other.test/app/'; break;
    case 'missing-message-channel': vi.stubGlobal('MessageChannel', undefined); break;
    case 'missing-random-uuid': vi.stubGlobal('crypto', {}); break;
    case 'registration-rejected': getRegistration.mockRejectedValue(new DOMException('denied', 'SecurityError')); break;
    case 'registration-throws': getRegistration.mockImplementation(() => {
      throw new Error('unavailable');
    }); break;
    default: { const exhaustive: never = condition; throw new Error(exhaustive); }
    }
    await downloadReadableStream({ stream: smallStream(), filename: 'compatible.zip', size: 3, signal: undefined });
    await expectBufferedBytes({ bytes: [1, 2, 3] });
    expect(worker.postMessage).not.toHaveBeenCalled();
  });

  it('bounds a stalled registration lookup without starting the source', async () => {
    fakeClock();
    getRegistration.mockReturnValue(new Promise(() => {}));
    const openStream = vi.fn(async () => smallStream());
    const pending = downloadStream({ openStream, filename: 'stalled', size: undefined, signal: undefined });
    await vi.waitFor(() => expect(getRegistration).toHaveBeenCalledOnce());
    expect(openStream).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(DOWNLOAD_SETUP_TIMEOUT_MS);
    await pending;
    await expectBufferedBytes({ bytes: [1, 2, 3] });
  });

  it('falls back with an untouched input when an old worker ignores the protocol', async () => {
    fakeClock();
    worker.postMessage.mockImplementation((_message, ports: MessagePort[]) => {
      otherPorts.push(...ports);
    });
    const openStream = vi.fn(async () => smallStream());
    const pending = downloadStream({ openStream, filename: 'old-worker.zip', size: 3, signal: undefined });
    await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalledOnce());
    expect(openStream).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(DOWNLOAD_SETUP_TIMEOUT_MS);
    await pending;
    expect(openStream).toHaveBeenCalledOnce();
    expect(navigate).not.toHaveBeenCalled();
    await expectBufferedBytes({ bytes: [1, 2, 3] });
  });

  it.each(['rejected', 'wrong-version', 'wrong-token', 'invalid-message'] as const)('falls back on a %s handshake without navigating', async kind => {
    worker.postMessage.mockImplementation((input, ports) => {
      const message = downloadPrepareSchema.parse(input);
      otherPorts.push(...ports);
      const reply = kind === 'rejected' ? { type: 'error', message: 'not supported' }
        : kind === 'invalid-message' ? { type: 'invalid' }
          : { type: 'ready', version: kind === 'wrong-version' ? 1 : DOWNLOAD_VERSION, token: kind === 'wrong-token' ? crypto.randomUUID() : message.token };
      ports[0]!.postMessage(reply);
    });
    await downloadReadableStream({ stream: smallStream(), filename: 'old-worker', size: undefined, signal: undefined });
    await expectBufferedBytes({ bytes: [1, 2, 3] });
    expect(navigate).not.toHaveBeenCalled();
  });

  it('falls back after a synchronous message transfer failure, not after consuming data', async () => {
    worker.postMessage.mockImplementation(() => {
      throw new DOMException('transfer failed', 'DataCloneError');
    });
    const openStream = vi.fn(async () => smallStream());
    await downloadStream({ openStream, filename: 'transfer', size: undefined, signal: undefined });
    expect(openStream).toHaveBeenCalledOnce();
    await expectBufferedBytes({ bytes: [1, 2, 3] });
  });

  it('releases locally created ports when constructing the second channel fails', async () => {
    const NativeChannel = MessageChannel;
    const channels: MessageChannel[] = [];
    const closed: ReturnType<typeof vi.spyOn>[] = [];
    vi.stubGlobal('MessageChannel', class extends NativeChannel {
      constructor() {
        if (channels.length === 1) throw new Error('channel unavailable');
        super();
        channels.push(this);
        closed.push(vi.spyOn(this.port1, 'close'), vi.spyOn(this.port2, 'close'));
      }
    });
    await downloadReadableStream({ stream: smallStream(), filename: 'channel', size: undefined, signal: undefined });
    expect(channels).toHaveLength(1);
    for (const close of closed) expect(close).toHaveBeenCalled();
    await expectBufferedBytes({ bytes: [1, 2, 3] });
  });

  it('ignores a late acknowledgement after falling back', async () => {
    fakeClock();
    let acknowledge = () => {};
    worker.postMessage.mockImplementation((input, ports) => {
      const message = downloadPrepareSchema.parse(input);
      otherPorts.push(...ports);
      acknowledge = () => ports[0]!.postMessage({ type: 'ready', version: DOWNLOAD_VERSION, token: message.token });
    });
    const openStream = vi.fn(async () => smallStream());
    const pending = downloadStream({ openStream, filename: 'late-ready', size: undefined, signal: undefined });
    await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(DOWNLOAD_SETUP_TIMEOUT_MS);
    await pending;
    acknowledge();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(navigate).not.toHaveBeenCalled();
    expect(openStream).toHaveBeenCalledOnce();
    await expectBufferedBytes({ bytes: [1, 2, 3] });
  });

  it('does not open the source for a data pull received before protocol readiness', async () => {
    worker.postMessage.mockImplementation((_message, ports: MessagePort[]) => {
      otherPorts.push(...ports);
      ports[1]!.postMessage({ type: 'pull' });
    });
    const openStream = vi.fn(async () => smallStream());
    await downloadStream({ openStream, filename: 'bad-peer', size: undefined, signal: undefined });
    expect(openStream).toHaveBeenCalledOnce();
    expect(navigate).not.toHaveBeenCalled();
    await expectBufferedBytes({ bytes: [1, 2, 3] });
  });

  it('cancels a failed frame setup before falling back', async () => {
    navigate.mockImplementation(() => {
      throw new DOMException('frame blocked', 'SecurityError');
    });
    await downloadReadableStream({ stream: smallStream(), filename: 'frame', size: undefined, signal: undefined });
    expect(removeFrame).toHaveBeenCalledOnce();
    await expectBufferedBytes({ bytes: [1, 2, 3] });
  });

  it('falls back after an unclaimed navigation times out and removes its frame', async () => {
    fakeClock();
    navigate.mockImplementation(() => {});
    const openStream = vi.fn(async () => smallStream());
    const pending = downloadStream({ openStream, filename: 'unclaimed', size: undefined, signal: undefined });
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledOnce());
    expect(openStream).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(DOWNLOAD_CLAIM_TIMEOUT_MS + 1_000);
    await pending;
    expect(openStream).toHaveBeenCalledOnce();
    expect(removeFrame).toHaveBeenCalledOnce();
    await expectBufferedBytes({ bytes: [1, 2, 3] });
  });

  it('falls back if the active worker changes between lookup and acknowledgement', async () => {
    const original = worker.postMessage.getMockImplementation()!;
    worker.postMessage.mockImplementation((...args) => {
      original(...args);
      registration.active = null;
    });
    await downloadReadableStream({ stream: smallStream(), filename: 'replaced', size: undefined, signal: undefined });
    expect(navigate).not.toHaveBeenCalled();
    await expectBufferedBytes({ bytes: [1, 2, 3] });
  });

  it('rechecks availability on the next save rather than caching a failure forever', async () => {
    getRegistration.mockResolvedValueOnce(undefined);
    await downloadReadableStream({ stream: smallStream(), filename: 'before', size: undefined, signal: undefined });
    await expectBufferedBytes({ bytes: [1, 2, 3] });
    createObjectURL.mockClear();
    await downloadReadableStream({ stream: smallStream(), filename: 'after', size: undefined, signal: undefined });
    expect(navigate).toHaveBeenCalledOnce();
    expect(createObjectURL).not.toHaveBeenCalled();
  });
});

describe('no fallback for cancellation or already-started downloads', () => {
  it('cancels an already supplied stream when the caller had aborted before detection', async () => {
    const abort = new AbortController();
    abort.abort(new Error('user cancelled'));
    const cancel = vi.fn();
    await expect(downloadReadableStream({ stream: new ReadableStream({ cancel }), filename: 'cancelled', size: undefined, signal: abort.signal })).rejects.toThrow('user cancelled');
    expect(cancel).toHaveBeenCalledOnce();
    expect(getRegistration).not.toHaveBeenCalled();
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it.each(['abort', 'pagehide'] as const)('does not buffer on %s during registration lookup', async action => {
    getRegistration.mockReturnValue(new Promise(() => {}));
    const abort = new AbortController();
    const openStream = vi.fn(async () => smallStream());
    const pending = downloadStream({ openStream, filename: 'wait', size: undefined, signal: abort.signal });
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(getRegistration).toHaveBeenCalledOnce());
    if (action === 'abort') abort.abort();
    else page.dispatchEvent(new Event('pagehide'));
    await rejected;
    expect(openStream).not.toHaveBeenCalled();
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it('cancels an unclaimed reservation without invoking the producer', async () => {
    navigate.mockImplementation(() => {});
    const abort = new AbortController();
    const openStream = vi.fn(async () => smallStream());
    const pending = downloadStream({ openStream, filename: 'blocked', size: undefined, signal: abort.signal });
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledOnce());
    abort.abort();
    await rejected;
    expect(openStream).not.toHaveBeenCalled();
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it('does not retry a rejected factory, even when it produced no bytes', async () => {
    const openStream = vi.fn(async (): Promise<ReadableStream<Uint8Array>> => {
      throw new Error('source failed');
    });
    await expect(downloadStream({ openStream, filename: 'failed', size: undefined, signal: undefined })).rejects.toThrow();
    expect(openStream).toHaveBeenCalledOnce();
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it('does not replay a source when the data pull arrived before the claimed notification', async () => {
    let control!: MessagePort;
    let data!: MessagePort;
    worker.postMessage.mockImplementation((input, ports) => {
      const message = downloadPrepareSchema.parse(input);
      otherPorts.push(...ports);
      [control, data] = ports as [MessagePort, MessagePort];
      control.postMessage({ type: 'ready', version: DOWNLOAD_VERSION, token: message.token });
    });
    navigate.mockImplementation(() => {
      data.postMessage({ type: 'pull' });
    });
    const openStream = vi.fn(async () => smallStream());
    const pending = downloadStream({ openStream, filename: 'data-first', size: undefined, signal: undefined });
    const rejected = expect(pending).rejects.toThrow('lost worker');
    await vi.waitFor(() => expect(openStream).toHaveBeenCalledOnce());
    control.postMessage({ type: 'error', message: 'lost worker' });
    await rejected;
    expect(openStream).toHaveBeenCalledOnce();
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it('uses real worker heartbeat events and does not buffer a claimed response on worker failure', async () => {
    fakeClock();
    navigate.mockImplementation(function (this: { src: string }) {
      claimFrame({ src: this.src, consume: false });
    });
    const openStream = vi.fn(async () => smallStream());
    const pending = downloadStream({ openStream, filename: 'paused', size: undefined, signal: undefined });
    const failed = expect(pending).rejects.toThrow('heartbeat transfer failed');
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(DOWNLOAD_HEARTBEAT_MS);
    expect(worker.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'naidan-download/keepalive' }), []);
    await new Promise<void>(resolve => setImmediate(resolve));
    worker.postMessage.mockImplementation(() => {
      throw new Error('heartbeat transfer failed');
    });
    await vi.advanceTimersByTimeAsync(DOWNLOAD_HEARTBEAT_MS);
    await failed;
    expect(openStream).not.toHaveBeenCalled();
    expect(createObjectURL).not.toHaveBeenCalled();
  });
});

describe('buffered compatibility data and ownership', () => {
  beforeEach(() => {
    getRegistration.mockResolvedValue(undefined);
  });

  it('preserves reused producer buffers instead of retaining mutable views', async () => {
    const bytes = new Uint8Array(2);
    let produced = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
      if (produced === 3) {
        controller.close(); return;
      }
      bytes.fill(++produced);
      controller.enqueue(bytes);
    },
    }, { highWaterMark: 0 });
    await downloadReadableStream({ stream, filename: 'copy.bin', size: 6, signal: undefined });
    await expectBufferedBytes({ bytes: [1, 1, 2, 2, 3, 3] });
  });

  it('saves an empty stream as a zero-byte file', async () => {
    await downloadReadableStream({
      stream: new ReadableStream({
      start(controller) {
      controller.close();
    },
    }),
      filename: 'empty',
      size: 0,
      signal: undefined,
    });
    await expectBufferedBytes({ bytes: [] });
  });

  it.each([0, 2, 4])('does not save a partial or oversized file when declared size is %s', async size => {
    await expect(downloadReadableStream({ stream: smallStream(), filename: 'bad-size', size, signal: undefined })).rejects.toThrow('size');
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it('does not save a partial file after a producer error', async () => {
    let produced = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
      if (produced) controller.error(new Error('read failed'));
      else {
        produced = true; controller.enqueue(new Uint8Array([1]));
      }
    },
    }, { highWaterMark: 0 });
    await expect(downloadReadableStream({ stream, filename: 'broken', size: undefined, signal: undefined })).rejects.toThrow('read failed');
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it('aborts while waiting for the fallback factory and cancels its eventual stream', async () => {
    const opened = Promise.withResolvers<ReadableStream<Uint8Array>>();
    const openStream = vi.fn(() => opened.promise);
    const abort = new AbortController();
    const cancel = vi.fn();
    const pending = downloadStream({ openStream, filename: 'late', size: undefined, signal: abort.signal });
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(openStream).toHaveBeenCalledOnce());
    abort.abort();
    await rejected;
    opened.resolve(new ReadableStream({ cancel }));
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it.each(['abort', 'pagehide'] as const)('ends a buffered read on %s even if producer cancellation never settles', async action => {
    const abort = new AbortController();
    const pull = vi.fn(() => new Promise<void>(() => {}));
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const pending = downloadReadableStream({
      stream: new ReadableStream({ pull, cancel }, { highWaterMark: 0 }),
      filename: 'cancelled',
      size: undefined,
      signal: abort.signal,
    });
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(pull).toHaveBeenCalledOnce());
    if (action === 'abort') abort.abort();
    else page.dispatchEvent(new Event('pagehide'));
    await rejected;
    expect(cancel).toHaveBeenCalledOnce();
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it.each(['unregistered', 'protocol-rejected'] as const)('saves a generated ZIP across a real byte bridge with a %s worker', async condition => {
    if (condition === 'protocol-rejected') {
      getRegistration.mockResolvedValue(registration);
      worker.postMessage.mockImplementation((_input, ports) => {
        otherPorts.push(...ports);
        ports[0]!.postMessage({ type: 'error', message: 'not supported' });
      });
    }
    const output = createReadableZipOutput({ highWaterMarkBytes: 4096 });
    const directory = createMemoryZipCentralDirectoryStore();
    const writer = new StreamingZipWriter({ output: output.sink, centralDirectoryStore: directory, compressionCodec: createWebZipCompressionCodec() });
    const bytes = new Uint8Array(128 * 1024);
    for (let start = 0; start < bytes.length; start += 64 * 1024) crypto.getRandomValues(bytes.subarray(start, start + 64 * 1024));
    const produced = (async () => {
      await writer.addFile({ name: 'テスト/data.bin', stream: new Blob([bytes]).stream(), modifiedAt: new Date(2020, 0, 1), compression: 'deflate' });
      await writer.finalize();
      await output.close();
    })();
    void produced.catch(() => undefined);
    const wire = new MessageChannel();
    const sender = serveByteStream({ port: wire.port1, openStream: async () => output.stream, signal: undefined });
    const receiver = receiveByteStream({ port: wire.port2 });
    try {
      // Consume first, rather than awaiting the bounded ZIP producer's result.
      await downloadReadableStream({ stream: receiver.stream, filename: 'directory.zip', size: undefined, signal: undefined });
      await produced;
      await sender.completed;
      const archive = await JSZip.loadAsync(await savedBlob().arrayBuffer());
      expect(await archive.file('テスト/data.bin')?.async('uint8array')).toEqual(bytes);
      expect(navigate).not.toHaveBeenCalled();
      expect(click).toHaveBeenCalledOnce();
    } finally {
      sender.abort({ reason: new Error('test cleanup') });
      receiver.abort({ reason: new Error('test cleanup') });
      await output.abort({ reason: new Error('test cleanup') });
      await produced.catch(() => undefined);
      await directory.dispose();
    }
  });

  it('rejects non-byte output without starting a download', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
      controller.enqueue('not bytes' as unknown as Uint8Array); controller.close();
    },
    });
    await expect(downloadReadableStream({ stream, filename: 'invalid', size: undefined, signal: undefined })).rejects.toThrow('byte stream');
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it('reports a fallback size error without waiting for a blocked cancellation hook', async () => {
    const cleanup = Promise.withResolvers<void>();
    const cancel = vi.fn(() => cleanup.promise);
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
      },
      cancel,
    }, { highWaterMark: 0 });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const operation = downloadReadableStream({ stream, filename: 'invalid-size', size: 1, signal: undefined });
      await expect(Promise.race([operation, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Blocked behind producer cleanup')), 200);
      })])).rejects.toThrow('exceeds its declared size');
      expect(cancel).toHaveBeenCalledOnce();
      expect(stream.locked).toBe(false);
      expect(createObjectURL).not.toHaveBeenCalled();
    } finally {
      clearTimeout(timer);
      cleanup.resolve();
    }
  });

  it('defers object-URL cleanup for the standalone fallback', async () => {
    fakeClock();
    vi.stubGlobal('location', { protocol: 'file:' });
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    await downloadReadableStream({ stream: smallStream(), filename: 'local.zip', size: undefined, signal: undefined });
    await expectBufferedBytes({ bytes: [1, 2, 3] });
    expect(getRegistration).not.toHaveBeenCalled();
    expect(revoke).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(revoke).toHaveBeenCalledWith('blob:test');
  });
});

// Cancellation can run between a factory result and the setup race continuation.
describe('buffered factory ownership races', () => {
  it.each(Array.from({ length: 12 }, (_unused, index) => index))('cancels the returned source with an abort after %i microtasks', async ticks => {
    getRegistration.mockResolvedValue(undefined);
    const abort = new AbortController();
    const cancel = vi.fn();
    const source = new ReadableStream<Uint8Array>({ cancel }, { highWaterMark: 0 });
    const reason = new DOMException('Cancelled while opening', 'AbortError');
    const openStream = vi.fn(async () => {
      void (async () => {
        for (let i = 0; i < ticks; i++) await Promise.resolve();
        abort.abort(reason);
      })();
      return source;
    });
    await expect(downloadStream({ openStream, filename: 'cancelled.bin', size: undefined, signal: abort.signal })).rejects.toBe(reason);
    await Promise.resolve();
    expect(openStream).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledExactlyOnceWith(reason);
    expect(source.locked).toBe(false);
    expect(click).not.toHaveBeenCalled();
  });
});

describe('Blob download URL lifetime', () => {
  it('retains successfully dispatched bytes for the grace period and then releases once', async () => {
    fakeClock();
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    downloadBlob({ blob: new Blob(['data']), filename: 'data.bin' });
    expect(revoke).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(TEST_ONLY.DOWNLOAD_BLOB_RELEASE_DELAY_MS - 1);
    expect(revoke).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:test');
  });

  it('revokes immediately on click failure, without a delayed duplicate revoke', () => {
    fakeClock();
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    const failure = new Error('download denied');
    click.mockImplementation(() => {
      throw failure;
    });
    expect(() => downloadBlob({ blob: new Blob(['data']), filename: 'data.bin' })).toThrow(failure);
    expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:test');
    expect(vi.getTimerCount()).toBe(0);
  });
});


describe('native File snapshots and exact output lengths', () => {
  it.each([0, 3])('uses the same File for Content-Length and bytes (%i bytes)', async length => {
    const file = new File([new Uint8Array(length).fill(7)], 'source.bin');
    const stream = vi.spyOn(file, 'stream');
    const arrayBuffer = vi.spyOn(file, 'arrayBuffer');
    await downloadFile({ file, filename: 'saved.bin', signal: undefined });
    const prepared = downloadPrepareSchema.parse(worker.postMessage.mock.calls[0]![0]);
    expect(prepared.metadata.size).toBe(length);
    expect(responseHeaders[0]!.get('content-length')).toBe(String(length));
    expect(consumed).toEqual([Array.from({ length }, () => 7)]);
    expect(stream).toHaveBeenCalledOnce();
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it.each([3, undefined])('passes an exact stream length through or omits an unknown length (%s)', async size => {
    await downloadReadableStream({ stream: smallStream(), filename: 'output', size, signal: undefined });
    expect(responseHeaders[0]!.get('content-length')).toBe(size === undefined ? null : '3');
    expect(consumed).toEqual([[1, 2, 3]]);
  });

  it('saves the original File without reading it when no worker is registered', async () => {
    fakeClock();
    getRegistration.mockResolvedValue(undefined);
    const file = new File(['unchanged'], 'disk.bin');
    const stream = vi.spyOn(file, 'stream');
    const arrayBuffer = vi.spyOn(file, 'arrayBuffer');
    const text = vi.spyOn(file, 'text');
    await downloadFile({ file, filename: 'download.bin', signal: undefined });
    expect(savedBlob()).toBe(file);
    expect(stream).not.toHaveBeenCalled();
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(text).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    expect(worker.postMessage).not.toHaveBeenCalled();
    expect(navigator.serviceWorker.register).not.toHaveBeenCalled();
    expect(registration.update).not.toHaveBeenCalled();
    expect(click).toHaveBeenCalledOnce();
  });

  it('does not wait for initial precaching and uses the activated worker on the next save without reload', async () => {
    fakeClock();
    const file = new File(['file'], 'model.gguf');
    const stream = vi.spyOn(file, 'stream');
    const register = vi.fn();
    registration.active = null;
    worker.state = 'installing';
    Object.assign(registration, { installing: worker });
    vi.stubGlobal('navigator', {
      serviceWorker: {
      controller: null,
      getRegistration,
      register,
      get ready() {
        throw new Error('Must not wait for precaching');
      },
    },
    });
    await downloadFile({ file, filename: file.name, signal: undefined });
    expect(savedBlob()).toBe(file);
    expect(stream).not.toHaveBeenCalled();
    expect(worker.postMessage).not.toHaveBeenCalled();
    // Only browser lifecycle changes; neither reload nor clients.claim is needed.
    registration.active = worker;
    worker.state = 'activated';
    Object.assign(registration, { installing: null });
    await downloadFile({ file, filename: file.name, signal: undefined });
    expect(stream).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledOnce();
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(responseHeaders[0]!.get('content-length')).toBe('4');
    expect(register).not.toHaveBeenCalled();
    expect(registration.update).not.toHaveBeenCalled();
  });

  it('can use the active worker while the replacement is still installing', async () => {
    const replacement = { state: 'installing', postMessage: vi.fn() };
    Object.assign(registration, { installing: replacement });
    await downloadFile({ file: new Blob(['old worker still serves']), filename: 'during-update', signal: undefined });
    expect(navigate).toHaveBeenCalledOnce();
    expect(replacement.postMessage).not.toHaveBeenCalled();
    expect(registration.update).not.toHaveBeenCalled();
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it('keeps the original File when worker preparation fails before reading', async () => {
    fakeClock();
    const file = new File(['data'], 'file');
    const stream = vi.spyOn(file, 'stream');
    worker.postMessage.mockImplementation(() => {
      throw new DOMException('cannot send', 'DataCloneError');
    });
    await downloadFile({ file, filename: file.name, signal: undefined });
    expect(savedBlob()).toBe(file);
    expect(stream).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('does not retry a File that became unreadable after the download was claimed', async () => {
    const file = new File(['data'], 'changed');
    const stream = vi.spyOn(file, 'stream').mockImplementation(() => {
      throw new DOMException('changed', 'NotReadableError');
    });
    await expect(downloadFile({ file, filename: file.name, signal: undefined })).rejects.toThrow();
    expect(stream).toHaveBeenCalledOnce();
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(click).not.toHaveBeenCalled();
  });

  it('does not turn cancellation during File preparation into a native fallback', async () => {
    const file = new File(['data'], 'cancel');
    const stream = vi.spyOn(file, 'stream');
    const abort = new AbortController();
    worker.postMessage.mockImplementation((_data, ports) => {
      otherPorts.push(...ports);
    });
    const operation = downloadFile({ file, filename: file.name, signal: abort.signal });
    const rejected = expect(operation).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalledOnce());
    abort.abort();
    await rejected;
    expect(stream).not.toHaveBeenCalled();
    expect(createObjectURL).not.toHaveBeenCalled();
  });
});
