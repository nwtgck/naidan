import {
  privacyFetchCancelMessageSchema,
  privacyFetchRequestMessageSchema,
} from './schemas';
import { idToRaw, toPrivacyFetchRequestId } from '@/01-models/ids';
import type { PrivacyFetchRequestId } from '@/01-models/ids';
import { PRIVACY_FETCH_PROTOCOL } from './protocol';
import { validatePrivacyFetchUrl } from './validate-url';
import type {
  PrivacyFetchCancelMessage,
  PrivacyFetchErrorCode,
  PrivacyFetchHeaderEntries,
  PrivacyFetchRequestMessage,
} from './types';

const activeRequests = new Map<PrivacyFetchRequestId, AbortController>();

function postMessageToParent({
  message,
  transfer,
}: {
  message: unknown,
  transfer: Transferable[],
}): void {
  window.parent.postMessage(message, '*', transfer);
}

function createHeadersEntries({
  response,
}: {
  response: Response,
}): PrivacyFetchHeaderEntries {
  return Array.from(response.headers.entries());
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
  });
}

function sendErrorMessage({
  requestId,
  code,
  message,
}: {
  requestId: PrivacyFetchRequestId,
  code: PrivacyFetchErrorCode,
  message: string,
}): void {
  postMessageToParent({
    message: {
      protocol: PRIVACY_FETCH_PROTOCOL,
      type: 'error',
      requestId: idToRaw({ id: requestId }),
      ok: false,
      code,
      message,
    },
    transfer: [],
  });
}

function handleCancelMessage({
  message,
}: {
  message: PrivacyFetchCancelMessage,
}): void {
  const requestId = toPrivacyFetchRequestId({ raw: message.requestId });
  const controller = activeRequests.get(requestId);
  if (controller === undefined) {
    return;
  }

  controller.abort();
  activeRequests.delete(requestId);
}

async function handleRequestMessage({
  message,
}: {
  message: PrivacyFetchRequestMessage,
}): Promise<void> {
  const requestId = toPrivacyFetchRequestId({ raw: message.requestId });

  if (activeRequests.has(requestId)) {
    sendErrorMessage({
      requestId,
      code: 'duplicate_request_id',
      message: `Privacy fetch requestId is already active: ${idToRaw({ id: requestId })}`,
    });
    return;
  }

  const validationResult = validatePrivacyFetchUrl({
    urlText: message.url,
  });

  if (!validationResult.ok) {
    postMessageToParent({
      message: {
        protocol: PRIVACY_FETCH_PROTOCOL,
        type: 'rejected',
        requestId: idToRaw({ id: requestId }),
        ok: false,
        validationResult,
      },
      transfer: [],
    });
    return;
  }

  const controller = new AbortController();
  activeRequests.set(requestId, controller);

  try {
    const response = await fetch(validationResult.normalizedUrl, {
      method: 'GET',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      signal: controller.signal,
    });
    const body = await response.arrayBuffer();
    postMessageToParent({
      message: {
        protocol: PRIVACY_FETCH_PROTOCOL,
        type: 'response',
        requestId: idToRaw({ id: requestId }),
        ok: true,
        responseOk: response.ok,
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
    });
  } catch (error) {
    const code: PrivacyFetchErrorCode = controller.signal.aborted ? 'aborted' : 'fetch_failed';
    sendErrorMessage({
      requestId,
      code,
      message: String(error),
    });
  } finally {
    activeRequests.delete(requestId);
  }
}

window.addEventListener('message', (event) => {
  if (event.source !== window.parent) {
    return;
  }

  const parsedRequest = privacyFetchRequestMessageSchema.safeParse(event.data);
  if (parsedRequest.success) {
    void handleRequestMessage({
      message: parsedRequest.data,
    });
    return;
  }

  const parsedCancel = privacyFetchCancelMessageSchema.safeParse(event.data);
  if (parsedCancel.success) {
    handleCancelMessage({
      message: parsedCancel.data,
    });
  }
});

sendReadyMessage();
