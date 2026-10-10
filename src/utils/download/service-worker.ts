import { z } from 'zod';
// eslint-disable-next-line local-rules-imports/prefer-root-alias-imports -- Also compiled by the isolated PWA worker without application path aliases.
import { createValidatedMessagePort } from '../worker-transport';
// eslint-disable-next-line local-rules-imports/prefer-root-alias-imports -- Keep the shared Service Worker dependency graph relative and independently buildable.
import { receiveByteStream, byteStreamPortSchema } from '../byte-stream-port';
import {
  DOWNLOAD_ROOT, DOWNLOAD_CLAIM_TIMEOUT_MS, DOWNLOAD_EVENT_LEASE_MS, createDownloadHeaders, createDownloadUrl,
  downloadPrepareSchema, downloadKeepAliveSchema, downloadControlSchema, downloadStatusSchema, type DownloadVersion,
} from './protocol';

// Structural worker types avoid mixing lib.dom and lib.webworker in the app's
// TypeScript compilation; the existing PWA worker supplies its global directly.
/* eslint-disable local-rules-named-args/require-named-args -- Structural mirrors of external Service Worker DOM signatures (lib.webworker conflicts with lib.dom). */
export interface DownloadMessageEvent {
  data: unknown,
  source: unknown,
  ports: readonly MessagePort[],
  waitUntil(promise: Promise<unknown>): void,
}
export interface DownloadFetchEvent {
  request: Request,
  clientId: string,
  respondWith(response: Response | Promise<Response>): void,
  waitUntil(promise: Promise<unknown>): void,
  stopImmediatePropagation(): void,
}
export interface DownloadWorkerScope {
  registration: { scope: string },
  clients: { get(id: string): Promise<unknown> },
  addEventListener(type: 'message', listener: (event: DownloadMessageEvent) => void): void,
  addEventListener(type: 'fetch', listener: (event: DownloadFetchEvent) => void): void,
}
/* eslint-enable local-rules-named-args/require-named-args */
const clientSchema = z.object({ id: z.string().min(1), type: z.literal('window'), url: z.string().url() });
const MAX_DOWNLOADS = 8;

export function installStreamDownloadWorker({ scope, canPrepare = () => true, onIdle = () => {} }: {
  scope: DownloadWorkerScope;
  canPrepare?: () => boolean;
  onIdle?: () => void;
}): { isIdle: () => boolean } {
  const base = new URL(scope.registration.scope);
  const root = new URL(DOWNLOAD_ROOT, base);
  type Session = {
    url: string,
    token: string,
    version: DownloadVersion,
    ownerId: string,
    ownerUrl: string,
    response: () => Response,
    finish: ({ reason }: { reason: unknown | undefined }) => void,
    extendLifetime: ({ event }: { event: Pick<DownloadMessageEvent, 'waitUntil'> }) => void,
    heartbeat: () => void,
  };
  const pending = new Map<string, Session>();
  const active = new Set<Session>();

  scope.addEventListener('message', event => {
    // Only page-owned live sessions may renew a lease. This is a real Worker
    // message event, not a MessagePort task, and never causes network traffic.
    const keepAlive = downloadKeepAliveSchema.safeParse(event.data);
    if (keepAlive.success) {
      const owner = clientSchema.safeParse(event.source);
      const session = [...active].find(item => item.token === keepAlive.data.token && item.version === keepAlive.data.version);
      for (const port of event.ports) port.close();
      if (owner.success && session?.ownerId === owner.data.id) {
        session.extendLifetime({ event });
        session.heartbeat();
      }
      return;
    }
    // Other messages belong to Workbox (e.g. SKIP_WAITING), not this protocol.
    if (!event.data || typeof event.data !== 'object'
      || !('type' in event.data) || event.data.type !== 'naidan-download/prepare') return;
    const prepared = downloadPrepareSchema.safeParse(event.data);
    const owner = clientSchema.safeParse(event.source);
    const control = event.ports[0];
    const data = event.ports[1];
    if (!byteStreamPortSchema.safeParse(control).success || !byteStreamPortSchema.safeParse(data).success
      || !control || !data || event.ports.length !== 2) {
      for (const port of event.ports) port.close();
      return;
    }
    let sessionForControl: Session | undefined = undefined;
    const channel = createValidatedMessagePort({
      port: control,
      incomingSchema: downloadControlSchema,
      outgoingSchema: downloadStatusSchema,
      onError({ reason }) {
        sessionForControl?.finish({ reason });
      },
      onMessage({ message }) {
        switch (message.type) {
        case 'cancel': sessionForControl?.finish({ reason: new DOMException('Download cancelled', 'AbortError') }); return;
        case 'ping': channel.send({ message: { type: 'pong' }, transferables: [] }); return;
        default: { const exhaustive: never = message; throw new Error(`Unknown download control: ${String(exhaustive)}`); }
        }
      },
    });
    const reject = () => {
      channel.send({ message: { type: 'error', message: 'Streaming download registration rejected' }, transferables: [] });
      channel.close();
      data.close();
    };
    if (!prepared.success || !owner.success || active.size >= MAX_DOWNLOADS || !canPrepare()) {
      reject(); return;
    }
    const ownerUrl = new URL(owner.data.url);
    ownerUrl.hash = '';
    if (ownerUrl.origin !== base.origin || !ownerUrl.pathname.startsWith(base.pathname)) {
      reject(); return;
    }
    const { token, metadata, version } = prepared.data;
    const url = createDownloadUrl({ base, token, version }).href;
    if ([...active].some(session => session.url === url)) {
      reject(); return;
    }
    const receiver = receiveByteStream({ port: data });
    let releaseLease: (() => void) | undefined;
    const preparedLifetime = Promise.withResolvers<void>();
    let finished = false;
    let responseReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let responseController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const session: Session = {
      url,
      token,
      version,
      ownerId: owner.data.id,
      ownerUrl: ownerUrl.href,
      extendLifetime({ event }) {
        if (finished) return;
        const lease = Promise.withResolvers<void>();
        const release = () => {
          clearTimeout(timeout);
          if (releaseLease === release) releaseLease = undefined;
          lease.resolve();
        };
        const timeout = setTimeout(release, DOWNLOAD_EVENT_LEASE_MS);
        const previous = releaseLease;
        releaseLease = release;
        try {
          event.waitUntil(lease.promise);
          // Install the successor first, then finish the preceding event. Only
          // one lease/timer per session is retained, regardless of duration.
          previous?.();
        } catch (reason) {
          release();
          previous?.();
          session.finish({ reason });
        }
      },
      heartbeat() {
        channel.send({ message: { type: 'pong' }, transferables: [] });
      },
      finish({ reason }) {
        if (finished) return;
        finished = true;
        preparedLifetime.resolve();
        clearTimeout(timer);
        clearInterval(watcher);
        pending.delete(url);
        active.delete(session);
        if (reason !== undefined) {
          receiver.abort({ reason });
          responseController?.error(reason);
          const reader = responseReader;
          responseReader = undefined;
          if (reader) void reader.cancel(reason).catch(() => undefined).finally(() => reader.releaseLock());
          channel.send({ message: { type: 'error', message: 'Streaming download interrupted' }, transferables: [] });
        } else channel.send({ message: { type: 'consumed' }, transferables: [] });
        channel.close();
        releaseLease?.();
        if (active.size === 0) onIdle();
      },
      response() {
        preparedLifetime.resolve();
        clearTimeout(timer);
        pending.delete(url); // Single use: a second request can never get the bytes.
        const reader = receiver.stream.getReader();
        responseReader = reader;
        let written = 0;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            responseController = controller;
          },
          async pull(controller) {
            try {
              const result = await reader.read();
              if (finished) return;
              if (result.done) {
                if (metadata.size !== undefined && written !== metadata.size) throw new Error('Download size mismatch');
                controller.close();
                reader.releaseLock();
                responseReader = undefined;
                session.finish({ reason: undefined });
              } else {
                written += result.value.byteLength;
                if (metadata.size !== undefined && written > metadata.size) throw new Error('Download size mismatch');
                controller.enqueue(result.value);
              }
            } catch (reason) {
              session.finish({ reason });
            }
          },
          cancel(reason) {
            session.finish({ reason: reason ?? new DOMException('Download cancelled', 'AbortError') });
          },
        }, { highWaterMark: 0 });
        const response = new Response(body, { headers: createDownloadHeaders({ metadata }) });
        // Initialize the body before acknowledging. A synchronous control-port
        // failure must error this body, not leave a future body open forever.
        channel.send({ message: { type: 'claimed' }, transferables: [] });
        return response;
      },
    };
    sessionForControl = session;
    pending.set(url, session);
    active.add(session);
    const timer = setTimeout(() => session.finish({ reason: new Error('Download was not claimed') }), DOWNLOAD_CLAIM_TIMEOUT_MS);
    // No elapsed-time limit on generation. Check for a vanished page instead of
    // assuming that a slow producer (or a paused download) has failed.
    const watcher = setInterval(() => {
      void scope.clients.get(session.ownerId).then(client => {
        if (!client) session.finish({ reason: new Error('Download page closed') });
      }).catch(reason => session.finish({ reason }));
    }, 15_000);
    void receiver.completed.catch(reason => session.finish({ reason }));
    // waitUntil is a lifetime hint, not a guarantee against OS/browser shutdown.
    event.waitUntil(preparedLifetime.promise);
    channel.send({ message: { type: 'ready', version, token }, transferables: [] });
  });

  scope.addEventListener('fetch', event => {
    const url = new URL(event.request.url);
    if (url.origin !== root.origin || (url.pathname !== root.pathname.slice(0, -1)
      && !url.pathname.startsWith(root.pathname))) return;
    // Own ALL requests below this prefix, including invalid and expired tokens.
    // They must never hit the network, precache or the SPA navigation fallback.
    event.stopImmediatePropagation();
    const unavailable = ({ status }: { status: number }) => new Response(null, {
      status,
      headers: { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' },
    });
    if (event.request.method !== 'GET') {
      event.respondWith(unavailable({ status: 405 })); return;
    }
    if (event.request.headers.has('Range')) {
      event.respondWith(unavailable({ status: 416 })); return;
    }
    const session = pending.get(url.href);
    if (!session) {
      event.respondWith(unavailable({ status: 410 })); return;
    }
    // An iframe can have an empty or different clientId. v2's unguessable
    // fragment is a one-shot bearer capability, registered by an in-scope
    // WindowClient over a private channel, not a referrer-based identity check.
    // It permits navigation only: another client's fetch must not read bytes.
    let authorized: boolean;
    switch (session.version) {
    case 1:
      // Compatibility only for pages opened before fragment downloads existed.
      authorized = event.clientId === session.ownerId
        || (event.request.mode === 'navigate' && event.request.referrer === session.ownerUrl);
      break;
    case 2:
      authorized = event.request.mode === 'navigate';
      break;
    default: { const exhaustive: never = session.version; throw new Error(`Unknown download version: ${exhaustive}`); }
    }
    if (!authorized) {
      event.respondWith(unavailable({ status: 403 })); return;
    }
    try {
      event.respondWith(session.response());
      // Do not tie an event's waitUntil to the entire download: engines may cap
      // individual events. The live page renews short leases while consuming.
      session.extendLifetime({ event });
    } catch (reason) {
      session.finish({ reason });
      event.respondWith(Response.error());
    }
  });
  return { isIdle: () => active.size === 0 };
}

export const TEST_ONLY = {
};
