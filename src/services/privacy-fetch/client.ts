import { generateId } from '@/utils/id'
import { PRIVACY_FETCH_DEFAULT_TIMEOUT_MS, createPrivacyFetchError } from './errors'
import {
  privacyFetchBrokerToParentMessageSchema,
} from './schemas'
import { PRIVACY_FETCH_PROTOCOL } from './protocol'
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
  resolve: (value: T) => void;
  reject: (reason: Error) => void;
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

  return {
    promise,
    resolve,
    reject,
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
  iframe.src = PRIVACY_FETCH_BROKER_PATH
  iframe.referrerPolicy = 'no-referrer'
  iframe.setAttribute('sandbox', 'allow-scripts')
  iframe.sandbox?.add('allow-scripts')
  iframe.style.display = 'none'
  iframe.setAttribute('aria-hidden', 'true')
  iframe.tabIndex = -1
  ensureIframeParentNode({ documentObject }).appendChild(iframe)
  return iframe
}

export function createPrivacyFetchBrokerClient({
  windowObject,
  documentObject,
}: {
  windowObject: Window;
  documentObject: Document;
}): PrivacyFetchBrokerClient {
  const iframe = createBrokerIframe({ documentObject })
  const pendingRequests = new Map<string, PendingRequest>()
  const readyDeferred = createDeferred<void>()
  let disposed = false
  let readyResolved = false

  const dispose = () => {
    if (disposed) {
      return
    }

    disposed = true
    windowObject.removeEventListener('message', handleMessage)
    for (const [requestId, pendingRequest] of pendingRequests) {
      pendingRequest.cleanup()
      pendingRequest.reject(createPrivacyFetchError({
        message: `Privacy fetch request was disposed before completion: ${requestId}`,
      }))
    }
    pendingRequests.clear()
    iframe.remove()
  }

  const handleMessage = (event: MessageEvent) => {
    if (event.source !== iframe.contentWindow) {
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
    case 'response': {
      const pendingRequest = pendingRequests.get(message.requestId)
      if (pendingRequest === undefined) {
        return
      }

      pendingRequest.cleanup()
      pendingRequests.delete(message.requestId)
      pendingRequest.resolve({
        url: message.url,
        status: message.status,
        statusText: message.statusText,
        ok: message.ok,
        redirected: message.redirected,
        responseType: message.responseType,
        headers: message.headers,
        body: message.body,
        bodyByteLength: message.bodyByteLength,
        policyName: message.validationResult.policyName,
      })
      return
    }
    case 'rejected': {
      const pendingRequest = pendingRequests.get(message.requestId)
      if (pendingRequest === undefined) {
        return
      }

      pendingRequest.cleanup()
      pendingRequests.delete(message.requestId)
      pendingRequest.reject(createPrivacyFetchError({
        message: `Privacy fetch rejected [${message.validationResult.code}]: ${message.validationResult.message}`,
      }))
      return
    }
    case 'error': {
      const pendingRequest = pendingRequests.get(message.requestId)
      if (pendingRequest === undefined) {
        return
      }

      pendingRequest.cleanup()
      pendingRequests.delete(message.requestId)
      pendingRequest.reject(createPrivacyFetchError({
        message: `Privacy fetch failed [${message.code}]: ${message.message}`,
      }))
      return
    }
    default: {
      const neverMessage: never = message
      throw createPrivacyFetchError({
        message: `Unhandled privacy fetch broker message: ${String(neverMessage)}`,
      })
    }
    }
  }

  windowObject.addEventListener('message', handleMessage)

  return {
    async fetch(request: PrivacyFetchRequest): Promise<PrivacyFetchResponse> {
      if (disposed) {
        throw createPrivacyFetchError({
          message: 'Privacy fetch broker client has been disposed',
        })
      }

      await readyDeferred.promise
      const contentWindow = iframe.contentWindow
      if (contentWindow === null) {
        throw createPrivacyFetchError({
          message: 'Privacy fetch broker iframe is not available',
        })
      }

      const requestId = generateId<string>()
      const timeoutMs = request.timeoutMs ?? PRIVACY_FETCH_DEFAULT_TIMEOUT_MS

      return new Promise<PrivacyFetchResponse>((resolve, reject) => {
        let settled = false

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

        const timeoutId = windowObject.setTimeout(() => {
          contentWindow.postMessage({
            protocol: PRIVACY_FETCH_PROTOCOL,
            type: 'cancel',
            requestId,
          }, '*')
          settle({
            callback: () => {
              pendingRequests.delete(requestId)
              reject(createPrivacyFetchError({
                message: `Privacy fetch timed out after ${timeoutMs} ms`,
              }))
            },
          })
        }, timeoutMs)

        const onAbort = () => {
          contentWindow.postMessage({
            protocol: PRIVACY_FETCH_PROTOCOL,
            type: 'cancel',
            requestId,
          }, '*')
          settle({
            callback: () => {
              pendingRequests.delete(requestId)
              reject(createPrivacyFetchError({
                message: 'Privacy fetch was aborted',
              }))
            },
          })
        }

        request.signal?.addEventListener('abort', onAbort, { once: true })

        const cleanup = () => {
          windowObject.clearTimeout(timeoutId)
          request.signal?.removeEventListener('abort', onAbort)
        }

        pendingRequests.set(requestId, {
          resolve: (response) => settle({ callback: () => resolve(response) }),
          reject: (error) => settle({ callback: () => reject(error) }),
          cleanup,
        })

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

export async function privacyFetch(
  request: PrivacyFetchRequest,
): Promise<PrivacyFetchResponse> {
  return getPrivacyFetchBrokerClient().fetch(request)
}

export async function privacyFetchText(
  request: PrivacyFetchRequest,
): Promise<string> {
  const response = await privacyFetch(request)
  return new TextDecoder().decode(response.body)
}

export async function privacyFetchJson<T = unknown>(
  request: PrivacyFetchRequest,
): Promise<T> {
  const text = await privacyFetchText(request)
  return JSON.parse(text) as T
}
