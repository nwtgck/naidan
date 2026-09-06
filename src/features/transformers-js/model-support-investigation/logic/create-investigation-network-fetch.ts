import { isModelWeightFileName } from '@/features/transformers-js/runtime/configure-hosted-runtime';
import type { ModelSupportInvestigationExternalNetworkPolicy } from '@/features/transformers-js/model-support-investigation/logic/investigation-config';

export class ModelSupportInvestigationNetworkPolicyError extends Error {
  readonly code:
    | 'external-network-disabled'
    | 'unbounded-model-artifact-get'
    | 'model-artifact-range-too-large'
    | 'model-artifact-range-invalid'
    | 'model-artifact-range-not-honored';
  readonly requestUrl: string;

  constructor({
    code,
    requestUrl,
    message,
  }: {
    code: ModelSupportInvestigationNetworkPolicyError['code'];
    requestUrl: string;
    message: string;
  }) {
    super(message);
    this.name = 'ModelSupportInvestigationNetworkPolicyError';
    this.code = code;
    this.requestUrl = requestUrl;
  }
}

function requestUrl({ input }: { input: RequestInfo | URL }): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function requestMethod({ input, init }: {
  input: RequestInfo | URL;
  init: RequestInit | undefined;
}): string {
  return (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
}

function requestHeaders({ input, init }: {
  input: RequestInfo | URL;
  init: RequestInit | undefined;
}): Headers {
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  if (init?.headers !== undefined) {
    new Headers(init.headers).forEach((value, key) => headers.set(key, value));
  }
  return headers;
}

function isModelArtifactUrl({ url }: { url: URL }): boolean {
  const fileName = url.pathname.split('/').at(-1);
  return fileName !== undefined && isModelWeightFileName({ fileName });
}

interface BoundedByteRange {
  start: number;
  end: number;
  length: number;
}

function boundedSingleRange({ value }: { value: string }): BoundedByteRange | undefined {
  const match = /^bytes=(\d+)-(\d+)$/u.exec(value.trim());
  if (match === null) return undefined;
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) return undefined;
  return { start, end, length: end - start + 1 };
}

function contentRangeMatchesRequest({ response, requestedRange }: {
  response: Response;
  requestedRange: BoundedByteRange;
}): boolean {
  if (response.status !== 206) return false;
  const value = response.headers.get('content-range');
  if (value === null) return false;
  const match = /^bytes (\d+)-(\d+)\/(?:\d+|\*)$/u.exec(value.trim());
  if (match === null) return false;
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return false;
  if (start !== requestedRange.start || end > requestedRange.end || end < start) return false;
  const responseLength = end - start + 1;
  const contentLength = response.headers.get('content-length');
  if (contentLength === null) return responseLength <= requestedRange.length;
  const parsedContentLength = Number(contentLength);
  return Number.isSafeInteger(parsedContentLength)
    && parsedContentLength >= 0
    && parsedContentLength === responseLength
    && responseLength <= requestedRange.length;
}

async function cancelResponseBody({ response }: { response: Response }): Promise<void> {
  if (response.body === null) return;
  try {
    await response.body.cancel();
  } catch {
    // Best effort only. The policy error below remains the authoritative result.
  }
}

export function createModelSupportInvestigationNetworkFetch({
  runtimeFetch,
  applicationOrigin,
  externalNetworkPolicy,
  maximumModelArtifactRangeBytes,
}: {
  runtimeFetch: typeof fetch;
  applicationOrigin: string;
  externalNetworkPolicy: ModelSupportInvestigationExternalNetworkPolicy;
  maximumModelArtifactRangeBytes: number;
}): typeof fetch {
  if (!Number.isSafeInteger(maximumModelArtifactRangeBytes) || maximumModelArtifactRangeBytes <= 0) {
    throw new RangeError('maximumModelArtifactRangeBytes must be a positive safe integer');
  }
  const application = new URL(applicationOrigin);

  return async (input, init) => {
    const urlText = requestUrl({ input });
    const url = new URL(urlText, application);
    const sameOrigin = url.origin === application.origin;

    if (!sameOrigin) {
      switch (externalNetworkPolicy) {
      case 'deny':
        throw new ModelSupportInvestigationNetworkPolicyError({
          code: 'external-network-disabled',
          requestUrl: url.href,
          message: `Model Support Investigation external network access is disabled: ${url.href}`,
        });
      case 'allow':
        break;
      default: {
        const _ex: never = externalNetworkPolicy;
        return _ex;
      }
      }
    }

    const method = requestMethod({ input, init });
    if (!isModelArtifactUrl({ url }) || method === 'HEAD') {
      return await runtimeFetch(input, init);
    }

    const range = requestHeaders({ input, init }).get('range');
    if (method !== 'GET' || range === null) {
      throw new ModelSupportInvestigationNetworkPolicyError({
        code: 'unbounded-model-artifact-get',
        requestUrl: url.href,
        message: `Model Support Investigation MUST NOT perform an unbounded model-artifact request: ${url.href}`,
      });
    }

    const requestedRange = boundedSingleRange({ value: range });
    if (requestedRange === undefined) {
      throw new ModelSupportInvestigationNetworkPolicyError({
        code: 'model-artifact-range-invalid',
        requestUrl: url.href,
        message: `Model Support Investigation requires an explicit bounded single byte range for model artifacts: ${range}`,
      });
    }
    if (requestedRange.length > maximumModelArtifactRangeBytes) {
      throw new ModelSupportInvestigationNetworkPolicyError({
        code: 'model-artifact-range-too-large',
        requestUrl: url.href,
        message: `Model Support Investigation model-artifact range exceeds the ${maximumModelArtifactRangeBytes}-byte limit: ${range}`,
      });
    }

    const response = await runtimeFetch(input, init);
    if (!contentRangeMatchesRequest({ response, requestedRange })) {
      await cancelResponseBody({ response });
      throw new ModelSupportInvestigationNetworkPolicyError({
        code: 'model-artifact-range-not-honored',
        requestUrl: url.href,
        message: `Model Support Investigation rejected a model-artifact response that did not honor the bounded Range request: ${url.href}`,
      });
    }
    return response;
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  boundedSingleRange,
  contentRangeMatchesRequest,
};
