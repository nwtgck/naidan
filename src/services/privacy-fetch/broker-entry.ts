import {
  privacyFetchCancelMessageSchema,
  privacyFetchRequestMessageSchema,
} from './schemas'
import { PRIVACY_FETCH_PROTOCOL } from './protocol'
import { validatePrivacyFetchUrl } from './validate-url'
import type {
  PrivacyFetchCancelMessage,
  PrivacyFetchErrorCode,
  PrivacyFetchHeaderEntries,
  PrivacyFetchRequestMessage,
} from './types'

const activeRequests = new Map<string, AbortController>()

function postMessageToParent({
  message,
  transfer,
}: {
  message: unknown;
  transfer: Transferable[];
}): void {
  window.parent.postMessage(message, '*', transfer)
}

function createHeadersEntries({
  response,
}: {
  response: Response;
}): PrivacyFetchHeaderEntries {
  return Array.from(response.headers.entries())
}

function sendReadyMessage(): void {
  postMessageToParent({
    message: {
      protocol: PRIVACY_FETCH_PROTOCOL,
      type: 'ready',
      capabilities: {
        responseBody: 'arrayBuffer',
        transferArrayBuffer: true,
        headers: 'entries',
      },
    },
    transfer: [],
  })
}

function sendErrorMessage({
  requestId,
  code,
  message,
}: {
  requestId: string;
  code: PrivacyFetchErrorCode;
  message: string;
}): void {
  postMessageToParent({
    message: {
      protocol: PRIVACY_FETCH_PROTOCOL,
      type: 'error',
      requestId,
      ok: false,
      code,
      message,
    },
    transfer: [],
  })
}

function handleCancelMessage({
  message,
}: {
  message: PrivacyFetchCancelMessage;
}): void {
  const controller = activeRequests.get(message.requestId)
  if (controller === undefined) {
    return
  }

  controller.abort()
  activeRequests.delete(message.requestId)
}

async function handleRequestMessage({
  message,
}: {
  message: PrivacyFetchRequestMessage;
}): Promise<void> {
  if (activeRequests.has(message.requestId)) {
    sendErrorMessage({
      requestId: message.requestId,
      code: 'duplicate_request_id',
      message: `Privacy fetch requestId is already active: ${message.requestId}`,
    })
    return
  }

  const validationResult = validatePrivacyFetchUrl({
    urlText: message.url,
  })

  if (!validationResult.ok) {
    postMessageToParent({
      message: {
        protocol: PRIVACY_FETCH_PROTOCOL,
        type: 'rejected',
        requestId: message.requestId,
        ok: false,
        validationResult,
      },
      transfer: [],
    })
    return
  }

  const controller = new AbortController()
  activeRequests.set(message.requestId, controller)

  try {
    const response = await fetch(validationResult.normalizedUrl, {
      method: 'GET',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      signal: controller.signal,
    })
    const body = await response.arrayBuffer()
    postMessageToParent({
      message: {
        protocol: PRIVACY_FETCH_PROTOCOL,
        type: 'response',
        requestId: message.requestId,
        ok: true,
        url: response.url,
        status: response.status,
        statusText: response.statusText,
        redirected: response.redirected,
        responseType: response.type,
        headers: createHeadersEntries({ response }),
        body,
        bodyByteLength: body.byteLength,
        validationResult,
      },
      transfer: [body],
    })
  } catch (error) {
    const code: PrivacyFetchErrorCode = controller.signal.aborted ? 'aborted' : 'fetch_failed'
    sendErrorMessage({
      requestId: message.requestId,
      code,
      message: String(error),
    })
  } finally {
    activeRequests.delete(message.requestId)
  }
}

window.addEventListener('message', (event) => {
  if (event.source !== window.parent) {
    return
  }

  const parsedRequest = privacyFetchRequestMessageSchema.safeParse(event.data)
  if (parsedRequest.success) {
    void handleRequestMessage({
      message: parsedRequest.data,
    })
    return
  }

  const parsedCancel = privacyFetchCancelMessageSchema.safeParse(event.data)
  if (parsedCancel.success) {
    handleCancelMessage({
      message: parsedCancel.data,
    })
  }
})

sendReadyMessage()
