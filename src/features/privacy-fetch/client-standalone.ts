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

  try {
    const response = await fetch(validationResult.normalizedUrl, {
      method: 'GET',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      signal: request.signal,
    });
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
      message: String(error),
    });
  }
}
