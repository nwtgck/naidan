import { normalizePrivacyFetchHeaders } from './request';
import { streamRequestSchema } from './stream-protocol';
import { receivePrivacyStream } from './stream-port';
import type { PrivacyFetchRequest, PrivacyFetchStreamResponse } from './types';
import { generateId } from '@/01-models/id';
import { idToRaw, toPrivacyFetchRequestId } from '@/01-models/ids';
import type { PrivacyFetchRequestId } from '@/01-models/ids';
import { createPrivacyFetchError } from './errors';
import { PRIVACY_FETCH_PROTOCOL } from './protocol';
import { privacyFetchBrokerToParentMessageSchema } from './schemas';
import { getDevelopmentMetaCspPrivacyBrokerSyncNotForSecurity } from '@/logic/development-meta-csp/privacy-broker-sync';
import type {
  PrivacyFetchBrokerClient,
  PrivacyFetchResponse,
} from './types';

type PromiseCallbacks<T> = Pick<
  ReturnType<typeof Promise.withResolvers<T>>,
  'reject' | 'resolve'
>;

type PendingRequest = PromiseCallbacks<PrivacyFetchResponse> & {
  cleanup: () => void,
};

type Deferred<T> = ReturnType<typeof Promise.withResolvers<T>>;

const PRIVACY_FETCH_BROKER_PATH = '/privacy-fetch-broker.html';

let sharedPrivacyFetchBrokerClient: PrivacyFetchBrokerClient | undefined;
let developmentMetaCspSessionSequence = 0;

type DevelopmentMetaCspSyncOwner = ReturnType<typeof getDevelopmentMetaCspPrivacyBrokerSyncNotForSecurity>;

function createDeferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve'];
  let reject!: Deferred<T>['reject'];
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  void promise.catch(() => undefined);

  return {
    promise,
    reject,
    resolve,
  };
}

function ensureIframeParentNode({
  documentObject,
}: {
  documentObject: Document,
}): HTMLElement {
  const body = documentObject.body;
  if (body instanceof HTMLElement) {
    return body;
  }

  const documentElement = documentObject.documentElement;
  if (documentElement instanceof HTMLElement) {
    return documentElement;
  }

  throw createPrivacyFetchError({
    code: 'broker_unavailable',
    message: 'Privacy fetch broker iframe could not find a parent node',
  });
}

function createBrokerIframe({
  documentObject,
}: {
  documentObject: Document,
}): HTMLIFrameElement {
  const iframe = documentObject.createElement('iframe');
  iframe.referrerPolicy = 'no-referrer';
  iframe.setAttribute('sandbox', 'allow-scripts');
  iframe.style.display = 'none';
  iframe.setAttribute('aria-hidden', 'true');
  iframe.tabIndex = -1;
  iframe.src = PRIVACY_FETCH_BROKER_PATH;
  return iframe;
}

function createPrivacyFetchBrokerClient({
  createBrokerIframeImpl,
  windowObject,
  documentObject,
}: {
  createBrokerIframeImpl?: ({
    documentObject,
  }: {
    documentObject: Document,
  }) => HTMLIFrameElement,
  windowObject: Window,
  documentObject: Document,
}): PrivacyFetchBrokerClient {
  const pendingRequests = new Map<PrivacyFetchRequestId, PendingRequest>();
  const readyDeferred = createDeferred<void>();
  const activeStreams = new Set<() => void>();
  let disposed = false;
  let readyResolved = false;
  let iframe: HTMLIFrameElement | undefined;
  let developmentMetaCspOwner: DevelopmentMetaCspSyncOwner | undefined;
  let developmentMetaCspSessionId: string | undefined;
  let developmentMetaCspSyncSequence = 0;
  let unsubscribeDevelopmentMetaCsp: (() => void) | undefined;

  const syncDevelopmentMetaCsp = () => {
    const owner = developmentMetaCspOwner;
    const sessionId = developmentMetaCspSessionId;
    if (disposed || owner === undefined || sessionId === undefined) {
      return;
    }
    const syncId = `sync-${++developmentMetaCspSyncSequence}`;
    try {
      const policies = owner.getSuccessfulPolicies();
      if (policies.length === 0) {
        return;
      }
      owner.recordSending({ sessionId, syncId, policyCount: policies.length });
      const contentWindow = iframe?.contentWindow;
      if (contentWindow === null || contentWindow === undefined) {
        throw new Error('Development meta CSP broker is unavailable');
      }
      contentWindow.postMessage({
        protocol: PRIVACY_FETCH_PROTOCOL,
        type: 'development-meta-csp-sync',
        sessionId,
        syncId,
        policies,
      }, '*');
    } catch {
      try {
        owner.recordSendFailure({ sessionId, syncId });
      } catch {
        // Development state publication must not interrupt normal transport.
      }
    }
  };

  const prepareDevelopmentMetaCsp = () => {
    developmentMetaCspSessionId = `privacy-broker-${++developmentMetaCspSessionSequence}`;
    developmentMetaCspOwner ??= getDevelopmentMetaCspPrivacyBrokerSyncNotForSecurity();
    developmentMetaCspOwner.beginSession({ sessionId: developmentMetaCspSessionId });
    unsubscribeDevelopmentMetaCsp ??= developmentMetaCspOwner.subscribeSuccessfulAdditions({ listener: syncDevelopmentMetaCsp });
    syncDevelopmentMetaCsp();
  };

  const resolvePendingRequest = ({
    requestId,
    callback,
  }: {
    requestId: PrivacyFetchRequestId,
    callback: ({ pendingRequest }: { pendingRequest: PendingRequest }) => void,
  }): void => {
    const pendingRequest = pendingRequests.get(requestId);
    if (pendingRequest === undefined) {
      return;
    }

    pendingRequest.cleanup();
    pendingRequests.delete(requestId);
    callback({ pendingRequest });
  };

  const handleMessage: NonNullable<Window['onmessage']> = (event) => {
    if (event.source !== iframe?.contentWindow) {
      return;
    }

    const parsed = privacyFetchBrokerToParentMessageSchema.safeParse(event.data);
    if (!parsed.success) {
      return;
    }

    const message = parsed.data;
    switch (message.type) {
    case 'ready':
      try {
        // Queue the full raw history before resolving existing readiness.
        // Its result is display-only; no ACK participates in fetch readiness.
        prepareDevelopmentMetaCsp();
      } catch {
        // Development owner access must fail open even on the first ready.
        try {
          if (developmentMetaCspSessionId !== undefined) {
            developmentMetaCspOwner?.recordSendFailure({ sessionId: developmentMetaCspSessionId, syncId: `sync-${++developmentMetaCspSyncSequence}` });
          }
        } catch {
          // Even failure-state publication is outside normal readiness.
        }
      } finally {
        if (!readyResolved) {
          readyResolved = true;
          readyDeferred.resolve();
        }
      }
      return;
    case 'development-meta-csp-result':
      try {
        developmentMetaCspOwner?.recordResult({
          sessionId: message.sessionId,
          syncId: message.syncId,
          confirmedPolicyCount: message.confirmedPolicyCount,
          outcome: message.outcome,
        });
      } catch {
        // ACKs only update developer diagnostics, never request processing.
      }
      return;
    case 'response':
      resolvePendingRequest({
        requestId: toPrivacyFetchRequestId({ raw: message.requestId }),
        callback: ({ pendingRequest }) => {
          pendingRequest.resolve({
            url: message.url,
            status: message.status,
            statusText: message.statusText,
            ok: message.responseOk,
            redirected: message.redirected,
            responseType: message.responseType,
            headers: new Headers(message.headers),
            body: message.body,
            bodyByteLength: message.bodyByteLength,
            policyName: message.validationResult.policyName,
          });
        },
      });
      return;
    case 'rejected':
      resolvePendingRequest({
        requestId: toPrivacyFetchRequestId({ raw: message.requestId }),
        callback: ({ pendingRequest }) => {
          pendingRequest.reject(createPrivacyFetchError({
            code: 'rejected',
            message: `Privacy fetch rejected [${message.validationResult.code}]: ${message.validationResult.message}`,
          }));
        },
      });
      return;
    case 'error':
      resolvePendingRequest({
        requestId: toPrivacyFetchRequestId({ raw: message.requestId }),
        callback: ({ pendingRequest }) => {
          pendingRequest.reject(createPrivacyFetchError({
            code: message.code,
            message: `Privacy fetch failed [${message.code}]: ${message.message}`,
          }));
        },
      });
      return;
    default: {
      const neverMessage: never = message;
      throw createPrivacyFetchError({
        code: 'unknown',
        message: `Unhandled privacy fetch broker message: ${String(neverMessage)}`,
      });
    }
    }
  };

  windowObject.addEventListener('message', handleMessage);
  iframe = (createBrokerIframeImpl ?? createBrokerIframe)({ documentObject });
  ensureIframeParentNode({ documentObject }).appendChild(iframe);

  const dispose = () => {
    if (disposed) {
      return;
    }

    disposed = true;
    try {
      unsubscribeDevelopmentMetaCsp?.();
    } catch {
      // Continue normal disposal even if development cleanup fails.
    }
    unsubscribeDevelopmentMetaCsp = undefined;
    try {
      if (developmentMetaCspSessionId !== undefined) {
        developmentMetaCspOwner?.disposeSession({ sessionId: developmentMetaCspSessionId });
      }
    } catch {
      // Continue normal disposal even if development publication fails.
    }
    developmentMetaCspOwner = undefined;
    developmentMetaCspSessionId = undefined;
    for (const disposeStream of activeStreams) {
      disposeStream();
    }
    activeStreams.clear();
    windowObject.removeEventListener('message', handleMessage);
    if (!readyResolved) {
      readyDeferred.reject(createPrivacyFetchError({
        code: 'broker_disposed',
        message: 'Privacy fetch broker client was disposed before broker ready',
      }));
    }
    for (const [requestId, pendingRequest] of pendingRequests) {
      pendingRequest.cleanup();
      pendingRequest.reject(createPrivacyFetchError({
        code: 'broker_disposed',
        message: `Privacy fetch request was disposed before completion: ${idToRaw({ id: requestId })}`,
      }));
    }
    pendingRequests.clear();
    iframe?.remove();
    iframe = undefined;
  };

  const waitForBrokerReady = async ({
    signal,
  }: {
    signal: AbortSignal | undefined,
  }): Promise<void> => {
    if (signal === undefined) {
      await readyDeferred.promise;
      return;
    }

    if (signal.aborted) {
      throw createPrivacyFetchError({
        code: 'aborted',
        message: 'Privacy fetch was aborted',
      });
    }

    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        signal.removeEventListener('abort', onAbort);
        reject(createPrivacyFetchError({
          code: 'aborted',
          message: 'Privacy fetch was aborted',
        }));
      };

      readyDeferred.promise.then(
        () => {
          signal.removeEventListener('abort', onAbort);
          resolve();
        },
        (error: unknown) => {
          signal.removeEventListener('abort', onAbort);
          reject(error);
        },
      );

      signal.addEventListener('abort', onAbort, { once: true });
    });
  };

  return {
    // TODO: Unify fetch and fetchStream around the streaming transport, buffering only for callers that need the complete body.
    async fetchStream({ request }: { request: PrivacyFetchRequest }): Promise<PrivacyFetchStreamResponse> {
      if (disposed) {
        throw createPrivacyFetchError({ code: 'broker_disposed', message: 'Privacy fetch broker is disposed' });
      }
      await waitForBrokerReady({ signal: request.signal });
      if (disposed) {
        throw createPrivacyFetchError({ code: 'broker_disposed', message: 'Privacy fetch broker is disposed' });
      }
      if (request.signal?.aborted) {
        throw createPrivacyFetchError({ code: 'aborted', message: 'Privacy fetch was aborted' });
      }
      const contentWindow = iframe?.contentWindow;
      if (!contentWindow) {
        throw createPrivacyFetchError({ code: 'broker_unavailable', message: 'Privacy fetch broker is unavailable' });
      }
      const { signal: _signal, headers, ...requestFields } = request;
      const fields = { ...requestFields, ...(headers === undefined ? {} : { headers: normalizePrivacyFetchHeaders({ headers }) }) };
      if (!streamRequestSchema.safeParse({ protocol: PRIVACY_FETCH_PROTOCOL, type: 'stream-request', ...fields }).success) {
        throw createPrivacyFetchError({ code: 'rejected', message: 'Invalid privacy fetch stream request' });
      }
      const channel = new MessageChannel();
      const stream = receivePrivacyStream({ port: channel.port1, signal: request.signal, onFinish: () => activeStreams.delete(stream.dispose) });
      activeStreams.add(stream.dispose);
      try {
        contentWindow.postMessage({ protocol: PRIVACY_FETCH_PROTOCOL, type: 'stream-request', ...fields }, '*', [channel.port2]);
      } catch {
        stream.dispose();
        channel.port2.close();
      }
      return stream.response;
    },
    async fetch({ request }: { request: PrivacyFetchRequest }): Promise<PrivacyFetchResponse> {
      if (disposed) {
        throw createPrivacyFetchError({
          code: 'broker_disposed',
          message: 'Privacy fetch broker client has been disposed',
        });
      }

      if (request.signal?.aborted) {
        throw createPrivacyFetchError({
          code: 'aborted',
          message: 'Privacy fetch was aborted',
        });
      }

      await waitForBrokerReady({
        signal: request.signal,
      });
      const contentWindow = iframe?.contentWindow;
      if (contentWindow === null || contentWindow === undefined) {
        throw createPrivacyFetchError({
          code: 'broker_unavailable',
          message: 'Privacy fetch broker iframe is not available',
        });
      }

      const headers = normalizePrivacyFetchHeaders({ headers: request.headers });
      const requestId = generateId<PrivacyFetchRequestId>();

      return new Promise<PrivacyFetchResponse>((resolve, reject) => {
        let settled = false;
        let requestSent = false;

        const settle = ({
          callback,
        }: {
          callback: () => void,
        }) => {
          if (settled) {
            return;
          }

          settled = true;
          callback();
        };

        const onAbort = () => {
          if (requestSent) {
            contentWindow.postMessage({
              protocol: PRIVACY_FETCH_PROTOCOL,
              type: 'cancel',
              requestId: idToRaw({ id: requestId }),
            }, '*');
          }

          settle({
            callback: () => {
              cleanup();
              pendingRequests.delete(requestId);
              reject(createPrivacyFetchError({
                code: 'aborted',
                message: 'Privacy fetch was aborted',
              }));
            },
          });
        };

        const cleanup = () => {
          request.signal?.removeEventListener('abort', onAbort);
        };

        const resolvePending: PendingRequest['resolve'] = (response) => settle({ callback: () => resolve(response) });
        const rejectPending: PendingRequest['reject'] = (error) => settle({ callback: () => reject(error) });
        pendingRequests.set(requestId, {
          resolve: resolvePending,
          reject: rejectPending,
          cleanup,
        });

        request.signal?.addEventListener('abort', onAbort, { once: true });

        if (request.signal?.aborted) {
          onAbort();
          return;
        }

        requestSent = true;
        contentWindow.postMessage({
          protocol: PRIVACY_FETCH_PROTOCOL,
          type: 'request',
          requestId: idToRaw({ id: requestId }),
          url: request.url,
          ...(headers === undefined ? {} : { headers }),
        }, '*');
      });
    },
    dispose,
  };
}

export function getPrivacyFetchBrokerClient(): PrivacyFetchBrokerClient {
  if (sharedPrivacyFetchBrokerClient === undefined) {
    const client = createPrivacyFetchBrokerClient({
      windowObject: window,
      documentObject: document,
    });
    sharedPrivacyFetchBrokerClient = {
      fetch: client.fetch,
      fetchStream: client.fetchStream,
      dispose: () => {
        client.dispose();
        sharedPrivacyFetchBrokerClient = undefined;
      },
    };
  }

  return sharedPrivacyFetchBrokerClient;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  createPrivacyFetchBrokerClient,
};
