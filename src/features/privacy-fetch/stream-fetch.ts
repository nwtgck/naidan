import { normalizePrivacyFetchHeaders } from './request';
import { createPrivacyFetchError } from './errors';
import { isAllowedHuggingFaceResponseUrl } from './policies/huggingface';
import { PRIVACY_FETCH_PROTOCOL } from './protocol';
import { streamRequestSchema } from './stream-protocol';
import type { PrivacyFetchRequest, PrivacyFetchStreamResponse } from './types';
import { validatePrivacyFetchUrl } from './validate-url';

function sanitizeBodyErrors({ body, signal }: { body: ReadableStream<Uint8Array<ArrayBuffer>>, signal: AbortSignal | undefined }): ReadableStream<Uint8Array<ArrayBuffer>> {
  const reader = body.getReader();
  const failure = () => createPrivacyFetchError({
    code: signal?.aborted ? 'aborted' : 'fetch_failed', message: 'Privacy fetch response stream failed',
  });
  return new ReadableStream<Uint8Array<ArrayBuffer>>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          controller.close();
          reader.releaseLock();
        } else {
          controller.enqueue(result.value);
        }
      } catch {
        controller.error(failure());
        reader.releaseLock();
      }
    },
    async cancel() {
      try {
        await reader.cancel();
      } catch {
        throw failure();
      } finally {
        reader.releaseLock();
      }
    },
  }, { highWaterMark: 0 });
}

export async function fetchPrivacyStream({ request }: { request: PrivacyFetchRequest }): Promise<PrivacyFetchStreamResponse> {
  const { signal, headers, ...fields } = request;
  const requestFields = { ...fields, headers: normalizePrivacyFetchHeaders({ headers }) };
  const parsed = streamRequestSchema.safeParse({ protocol: PRIVACY_FETCH_PROTOCOL, type: 'stream-request', ...requestFields });
  const validation = validatePrivacyFetchUrl({ urlText: request.url });
  if (!parsed.success || !validation.ok) {
    throw createPrivacyFetchError({ code: 'rejected', message: 'Unsupported privacy fetch stream request' });
  }
  if (signal?.aborted) throw createPrivacyFetchError({ code: 'aborted', message: 'Privacy fetch was aborted' });
  const response = await fetch(validation.normalizedUrl, {
    method: 'GET', credentials: 'omit', referrerPolicy: 'no-referrer', signal, headers: requestFields.headers,
  }).catch(() => {
    throw createPrivacyFetchError({ code: signal?.aborted ? 'aborted' : 'fetch_failed', message: 'Privacy fetch stream request failed' });
  });
  if (validation.policyName === 'huggingface_models' && !isAllowedHuggingFaceResponseUrl({ requestUrl: request.url, responseUrl: response.url })) {
    await response.body?.cancel().catch(() => undefined);
    throw createPrivacyFetchError({ code: 'rejected', message: 'Unsupported Hugging Face delivery URL' });
  }
  return {
    url: response.url, status: response.status, statusText: response.statusText, ok: response.ok,
    redirected: response.redirected, responseType: response.type,
    headers: new Headers(response.headers), policyName: validation.policyName,
    body: response.body === null ? new ReadableStream<Uint8Array<ArrayBuffer>>({ start(controller) {
      controller.close();
    } }) : sanitizeBodyErrors({ body: response.body, signal }),
  };
}

export const TEST_ONLY = {
};
