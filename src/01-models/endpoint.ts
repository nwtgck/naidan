import type { Endpoint, EndpointType, HttpEndpoint, SupportedEndpoint } from '@/01-models/types';

export function isHttpEndpoint(endpoint: Endpoint): endpoint is HttpEndpoint {
  switch (endpoint.type) {
  case 'openai':
  case 'ollama':
    return true;
  case 'transformers_js':
  case 'browser_provided_lm':
  case 'unsupported_experimental_endpoint':
    return false;
  default: {
    const _ex: never = endpoint;
    throw new Error(`Unhandled endpoint: ${String(_ex)}`);
  }
  }
}

export function isSupportedEndpoint(endpoint: Endpoint): endpoint is SupportedEndpoint {
  switch (endpoint.type) {
  case 'openai':
  case 'ollama':
  case 'transformers_js':
  case 'browser_provided_lm':
    return true;
  case 'unsupported_experimental_endpoint':
    return false;
  default: {
    const _ex: never = endpoint;
    throw new Error(`Unhandled endpoint: ${String(_ex)}`);
  }
  }
}

export function getSupportedEndpointType({
  endpoint,
}: {
  endpoint: Endpoint,
}): EndpointType | undefined {
  return isSupportedEndpoint(endpoint) ? endpoint.type : undefined;
}

export function isConfiguredEndpoint({ endpoint }: { endpoint: Endpoint }): boolean {
  switch (endpoint.type) {
  case 'openai':
  case 'ollama':
    return endpoint.url !== '';
  case 'transformers_js':
  case 'browser_provided_lm':
    return true;
  case 'unsupported_experimental_endpoint':
    return false;
  default: {
    const _ex: never = endpoint;
    throw new Error(`Unhandled endpoint: ${String(_ex)}`);
  }
  }
}

export function selectHttpEndpointSeed({
  preferred,
  fallback,
}: {
  preferred: Endpoint | undefined,
  fallback: Endpoint | undefined,
}): HttpEndpoint | undefined {
  if (preferred !== undefined && isHttpEndpoint(preferred)) return preferred;
  if (fallback !== undefined && isHttpEndpoint(fallback)) return fallback;
  return undefined;
}

export function cloneEndpoint({ endpoint }: { endpoint: Endpoint }): Endpoint {
  switch (endpoint.type) {
  case 'openai':
  case 'ollama':
    return {
      type: endpoint.type,
      url: endpoint.url,
      httpHeaders: endpoint.httpHeaders?.map(([name, value]) => [name, value]),
    };
  case 'transformers_js':
    return { type: 'transformers_js' };
  case 'browser_provided_lm':
    return { type: 'browser_provided_lm' };
  case 'unsupported_experimental_endpoint':
    return {
      type: 'unsupported_experimental_endpoint',
      persistedType: endpoint.persistedType,
    };
  default: {
    const _ex: never = endpoint;
    throw new Error(`Unhandled endpoint: ${String(_ex)}`);
  }
  }
}

export function cloneOptionalEndpoint({
  endpoint,
}: {
  endpoint: Endpoint | undefined,
}): Endpoint | undefined {
  return endpoint === undefined ? undefined : cloneEndpoint({ endpoint });
}

export function areEndpointModelNamespacesEqual({
  left,
  right,
}: {
  left: Endpoint,
  right: Endpoint,
}): boolean {
  if (left.type !== right.type) return false;

  switch (left.type) {
  case 'openai':
  case 'ollama':
    return right.type === left.type && left.url === right.url;
  case 'transformers_js':
    return right.type === 'transformers_js';
  case 'browser_provided_lm':
    return right.type === 'browser_provided_lm';
  case 'unsupported_experimental_endpoint':
    return (
      right.type === 'unsupported_experimental_endpoint'
      && left.persistedType === right.persistedType
    );
  default: {
    const _ex: never = left;
    throw new Error(`Unhandled endpoint: ${String(_ex)}`);
  }
  }
}

export function areEndpointsEqual({
  left,
  right,
}: {
  left: Endpoint,
  right: Endpoint,
}): boolean {
  if (left.type !== right.type) return false;

  switch (left.type) {
  case 'openai':
  case 'ollama': {
    if (right.type !== left.type || left.url !== right.url) return false;
    const leftHeaders = left.httpHeaders;
    const rightHeaders = right.httpHeaders;
    if (leftHeaders === rightHeaders) return true;
    if (
      leftHeaders === undefined
      || rightHeaders === undefined
      || leftHeaders.length !== rightHeaders.length
    ) {
      return false;
    }
    return leftHeaders.every(
      ([name, value], index) => (
        name === rightHeaders[index]?.[0]
        && value === rightHeaders[index]?.[1]
      ),
    );
  }
  case 'transformers_js':
    return right.type === 'transformers_js';
  case 'browser_provided_lm':
    return right.type === 'browser_provided_lm';
  case 'unsupported_experimental_endpoint':
    return (
      right.type === 'unsupported_experimental_endpoint'
      && left.persistedType === right.persistedType
    );
  default: {
    const _ex: never = left;
    throw new Error(`Unhandled endpoint: ${String(_ex)}`);
  }
  }
}

export function areOptionalEndpointsEqual({
  left,
  right,
}: {
  left: Endpoint | undefined,
  right: Endpoint | undefined,
}): boolean {
  if (left === undefined || right === undefined) return left === right;
  return areEndpointsEqual({ left, right });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
