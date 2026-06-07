import { generateId } from '@/utils/id'
import { createPrivacyFetchError } from './errors'
import { PRIVACY_FETCH_PROTOCOL } from './protocol'
import { privacyFetchBrokerToParentMessageSchema } from './schemas'
import type {
  PrivacyFetchBrokerClient,
  PrivacyFetchRequest,
  PrivacyFetchResponse,
} from './types'

type PendingRequest = {
  reject: (reason: Error) => void;
  resolve: (value: PrivacyFetchResponse) => void;
  cleanup: () => void;
}

type Deferred<T> = {
  promise: Promise<T>;
  reject: (reason: Error) => void;
  resolve: (value: T) => void;
}

const PRIVACY_FETCH_BROKER_PATH = '/privacy-fetch-broker.html'

let sharedPrivacyFetchBrokerClient: PrivacyFetchBrokerClient | undefined

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
  })
  void promise.catch(() => undefined)

  return {
    promise,
    reject,
    resolve,
  }
}

function ensureIframeParentNode({
  documentObject,
}: {
  documentObject: Document;
}): HTMLElement {
  const body = documentObject.body
  if (body instanceof HTMLElement) {
    return body
  }

  const documentElement = documentObject.documentElement
  if (documentElement instanceof HTMLElement) {
    return documentElement
  }

  throw createPrivacyFetchError({
    message: 'Privacy fetch broker iframe could not find a parent node',
  })
}

function createBrokerIframe({
  documentObject,
}: {
  documentObject: Document;
}): HTMLIFrameElement {
  const iframe = documentObject.createElement('iframe')
  iframe.referrerPolicy = 'no-referrer'
  iframe.setAttribute('sandbox', 'allow-scripts')
  iframe.style.display = 'none'
  iframe.setAttribute('aria-hidden', 'true')
  iframe.tabIndex = -1
  iframe.src = PRIVACY_FETCH_BROKER_PATH
  return iframe
}

export function createPrivacyFetchBrokerClient({
  createBrokerIframeImpl,
  windowObject,
  documentObject,
}: {
  createBrokerIframeImpl?: ({
    documentObject,
  }: {
    documentObject: Document;
  }) => HTMLIFrameElement;
  windowObject: Window;
  documentObject: Document;
}): PrivacyFetchBrokerClient {
  const pendingRequests = new Map<string, PendingRequest>()
  const readyDeferred = createDeferred<void>()
  let disposed = false
  let readyResolved = false
  let iframe: HTMLIFrameElement | undefined

  const resolvePendingRequest = ({
    requestId,
    callback,
  }: {
    requestId: string;
    callback: (pendingRequest: PendingRequest) => void;
  }): void => {
    const pendingRequest = pendingRequests.get(requestId)
    if (pendingRequest === undefined) {
      return
    }

    pendingRequest.cleanup()
    pendingRequests.delete(requestId)
    callback(pendingRequest)
  }

  const handleMessage = (event: MessageEvent) => {
    if (event.source !== iframe?.contentWindow) {
      return
    }

    const parsed = privacyFetchBrokerToParentMessageSchema.safeParse(event.data)
    if (!parsed.success) {
      return
    }

    const message = parsed.data
    switch (message.type) {
    case 'ready':
      if (!readyResolved) {
        readyResolved = true
        readyDeferred.resolve()
      }
      return
    case 'response':
      resolvePendingRequest({
        requestId: message.requestId,
        callback: (pendingRequest) => {
          pendingRequest.resolve({
            url: message.url,
            status: message.status,
            statusText: message.statusText,
            ok: message.responseOk,
            redirected: message.redirected,
            responseType: message.responseType,
            headers: message.headers,
            body: message.body,
            bodyByteLength: message.bodyByteLength,
            policyName: message.validationResult.policyName,
          })
        },
      })
      return
    case 'rejected':
      resolvePendingRequest({
        requestId: message.requestId,
        callback: (pendingRequest) => {
          pendingRequest.reject(createPrivacyFetchError({
            message: `Privacy fetch rejected [${message.validationResult.code}]: ${message.validationResult.message}`,
          }))
        },
      })
      return
    case 'error':
      resolvePendingRequest({
        requestId: message.requestId,
        callback: (pendingRequest) => {
          pendingRequest.reject(createPrivacyFetchError({
            message: `Privacy fetch failed [${message.code}]: ${message.message}`,
          }))
        },
      })
      return
    default: {
      const neverMessage: never = message
      throw createPrivacyFetchError({
        message: `Unhandled privacy fetch broker message: ${String(neverMessage)}`,
      })
    }
    }
  }

  windowObject.addEventListener('message', handleMessage)
  iframe = (createBrokerIframeImpl ?? createBrokerIframe)({ documentObject })
  ensureIframeParentNode({ documentObject }).appendChild(iframe)

  const dispose = () => {
    if (disposed) {
      return
    }

    disposed = true
    windowObject.removeEventListener('message', handleMessage)
    if (!readyResolved) {
      readyDeferred.reject(createPrivacyFetchError({
        message: 'Privacy fetch broker client was disposed before broker ready',
      }))
    }
    for (const [requestId, pendingRequest] of pendingRequests) {
      pendingRequest.cleanup()
      pendingRequest.reject(createPrivacyFetchError({
        message: `Privacy fetch request was disposed before completion: ${requestId}`,
      }))
    }
    pendingRequests.clear()
    iframe?.remove()
    iframe = undefined
  }

  const waitForBrokerReady = async ({
    signal,
  }: {
    signal: AbortSignal | undefined;
  }): Promise<void> => {
    if (signal === undefined) {
      await readyDeferred.promise
      return
    }

    if (signal.aborted) {
      throw createPrivacyFetchError({
        message: 'Privacy fetch was aborted',
      })
    }

    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        signal.removeEventListener('abort', onAbort)
        reject(createPrivacyFetchError({
          message: 'Privacy fetch was aborted',
        }))
      }

      readyDeferred.promise.then(
        () => {
          signal.removeEventListener('abort', onAbort)
          resolve()
        },
        (error: unknown) => {
          signal.removeEventListener('abort', onAbort)
          reject(error)
        },
      )

      signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  return {
    async fetch(request: PrivacyFetchRequest): Promise<PrivacyFetchResponse> {
      if (disposed) {
        throw createPrivacyFetchError({
          message: 'Privacy fetch broker client has been disposed',
        })
      }

      if (request.signal?.aborted) {
        throw createPrivacyFetchError({
          message: 'Privacy fetch was aborted',
        })
      }

      await waitForBrokerReady({
        signal: request.signal,
      })
      const contentWindow = iframe?.contentWindow
      if (contentWindow === null || contentWindow === undefined) {
        throw createPrivacyFetchError({
          message: 'Privacy fetch broker iframe is not available',
        })
      }

      const requestId = generateId<string>()

      return new Promise<PrivacyFetchResponse>((resolve, reject) => {
        let settled = false
        let requestSent = false

        const settle = ({
          callback,
        }: {
          callback: () => void;
        }) => {
          if (settled) {
            return
          }

          settled = true
          callback()
        }

        const onAbort = () => {
          if (requestSent) {
            contentWindow.postMessage({
              protocol: PRIVACY_FETCH_PROTOCOL,
              type: 'cancel',
              requestId,
            }, '*')
          }

          settle({
            callback: () => {
              cleanup()
              pendingRequests.delete(requestId)
              reject(createPrivacyFetchError({
                message: 'Privacy fetch was aborted',
              }))
            },
          })
        }

        const cleanup = () => {
          request.signal?.removeEventListener('abort', onAbort)
        }

        pendingRequests.set(requestId, {
          resolve: (response) => settle({ callback: () => resolve(response) }),
          reject: (error) => settle({ callback: () => reject(error) }),
          cleanup,
        })

        request.signal?.addEventListener('abort', onAbort, { once: true })

        if (request.signal?.aborted) {
          onAbort()
          return
        }

        requestSent = true
        contentWindow.postMessage({
          protocol: PRIVACY_FETCH_PROTOCOL,
          type: 'request',
          requestId,
          url: request.url,
        }, '*')
      })
    },
    dispose,
  }
}

export function getPrivacyFetchBrokerClient(): PrivacyFetchBrokerClient {
  if (sharedPrivacyFetchBrokerClient === undefined) {
    const client = createPrivacyFetchBrokerClient({
      windowObject: window,
      documentObject: document,
    })
    sharedPrivacyFetchBrokerClient = {
      fetch: client.fetch,
      dispose: () => {
        client.dispose()
        sharedPrivacyFetchBrokerClient = undefined
      },
    }
  }

  return sharedPrivacyFetchBrokerClient
}
