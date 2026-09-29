import { normalizePrivacyFetchHeaders } from './request';
import { isAllowedHuggingFaceResponseUrl } from './policies/huggingface';
export { fetchPrivacyStream as privacyFetchStream } from './stream-fetch';
import { createPrivacyFetchError } from './errors';
import { validatePrivacyFetchUrl } from './validate-url';
import type {
  PrivacyFetchHeaderEntries,
  PrivacyFetchRequest,
  PrivacyFetchResponse,
} from './types';

function createHeadersEntries({
  response,
}: {
  response: Response,
}): PrivacyFetchHeaderEntries {
  return Array.from(response.headers.entries());
}

export async function privacyFetch({
  request,
}: {
  request: PrivacyFetchRequest,
}): Promise<PrivacyFetchResponse> {
  if (request.signal?.aborted) {
    throw createPrivacyFetchError({
      code: 'aborted',
      message: 'Privacy fetch was aborted',
    });
  }

  const validationResult = validatePrivacyFetchUrl({
    urlText: request.url,
  });

  if (!validationResult.ok) {
    throw createPrivacyFetchError({
      code: 'rejected',
      message: `Privacy fetch rejected [${validationResult.code}]: ${validationResult.message}`,
    });
  }

  const headers = normalizePrivacyFetchHeaders({ headers: request.headers });
  try {
    const response = await fetch(validationResult.normalizedUrl, {
      method: 'GET',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      signal: request.signal,
      ...(headers === undefined ? {} : { headers }),
    });
    if (validationResult.policyName === 'huggingface_models' && !isAllowedHuggingFaceResponseUrl({ requestUrl: validationResult.normalizedUrl, responseUrl: response.url })) {
      await response.body?.cancel();
      throw new Error('Unsupported Hugging Face delivery URL');
    }
    const body = await response.arrayBuffer();

    return {
      url: response.url,
      status: response.status,
      statusText: response.statusText,
      ok: response.ok,
      redirected: response.redirected,
      responseType: response.type,
      headers: new Headers(createHeadersEntries({ response })),
      body,
      bodyByteLength: body.byteLength,
      policyName: validationResult.policyName,
    };
  } catch (error) {
    throw createPrivacyFetchError({
      code: request.signal?.aborted ? 'aborted' : 'fetch_failed',
      message: validationResult.policyName === 'huggingface_models' ? 'Hugging Face request failed' : String(error),
    });
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
