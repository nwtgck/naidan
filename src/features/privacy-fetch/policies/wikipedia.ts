import type {
  PrivacyFetchValidationAcceptedResult,
  PrivacyFetchValidationRejectedCode,
  PrivacyFetchValidationRejectedResult,
  PrivacyFetchValidationResult,
} from '@/features/privacy-fetch/types';

const WIKIPEDIA_POLICY_NAME = 'wikipedia_api';
const WIKIPEDIA_MAX_SEARCH_LIMIT = 30;
const WIKIPEDIA_MAX_SEARCH_QUERY_LENGTH = 120;
const WIKIPEDIA_LANGUAGE_LABEL_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/i;

function createRejectedResult({
  code,
  message,
}: {
  code: PrivacyFetchValidationRejectedCode,
  message: string,
}): PrivacyFetchValidationRejectedResult {
  return {
    ok: false,
    code,
    message,
  };
}

function createAcceptedResult({
  normalizedUrl,
}: {
  normalizedUrl: string,
}): PrivacyFetchValidationAcceptedResult {
  return {
    ok: true,
    policyName: WIKIPEDIA_POLICY_NAME,
    normalizedUrl,
  };
}

function isValidWikipediaHostname({
  hostname,
}: {
  hostname: string,
}): boolean {
  const labels = hostname.toLowerCase().split('.');
  if (labels.length !== 3) {
    return false;
  }

  const [lang, secondLevel, topLevel] = labels;
  if (secondLevel !== 'wikipedia' || topLevel !== 'org') {
    return false;
  }

  return lang !== undefined && WIKIPEDIA_LANGUAGE_LABEL_PATTERN.test(lang);
}

function rejectIfDuplicateQueryParameter({
  url,
}: {
  url: URL,
}): PrivacyFetchValidationRejectedResult | undefined {
  const keys = new Set(url.searchParams.keys());
  for (const key of keys) {
    if (url.searchParams.getAll(key).length > 1) {
      return createRejectedResult({
        code: 'duplicate_query_parameter',
        message: `Duplicate query parameter is not allowed: ${key}`,
      });
    }
  }

  return undefined;
}

function rejectUnknownQueryParameter({
  url,
  allowedKeys,
}: {
  url: URL,
  allowedKeys: readonly string[],
}): PrivacyFetchValidationRejectedResult | undefined {
  const allowed = new Set(allowedKeys);
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key)) {
      return createRejectedResult({
        code: 'invalid_query_parameter',
        message: `Unsupported query parameter: ${key}`,
      });
    }
  }

  return undefined;
}

function requireExactQueryParameter({
  url,
  key,
  expectedValue,
}: {
  url: URL,
  key: string,
  expectedValue: string,
}): PrivacyFetchValidationRejectedResult | undefined {
  const value = url.searchParams.get(key);
  if (value !== expectedValue) {
    return createRejectedResult({
      code: 'invalid_query_parameter_value',
      message: `Invalid value for ${key}`,
    });
  }

  return undefined;
}

function validatePositiveIntegerString({
  value,
}: {
  value: string | null,
}): boolean {
  return value !== null && /^[1-9]\d*$/.test(value);
}

function validateWikipediaSearchQuery({
  url,
}: {
  url: URL,
}): PrivacyFetchValidationResult {
  const unknownQueryParameter = rejectUnknownQueryParameter({
    url,
    allowedKeys: [
      'origin',
      'action',
      'format',
      'formatversion',
      'list',
      'srsearch',
      'srlimit',
      'srnamespace',
      'srprop',
      'srinfo',
    ],
  });
  if (unknownQueryParameter !== undefined) {
    return unknownQueryParameter;
  }

  for (const [key, expectedValue] of [
    ['origin', '*'],
    ['action', 'query'],
    ['format', 'json'],
    ['formatversion', '2'],
    ['list', 'search'],
    ['srnamespace', '0'],
    ['srprop', ''],
    ['srinfo', ''],
  ] as const) {
    const rejected = requireExactQueryParameter({
      url,
      key,
      expectedValue,
    });
    if (rejected !== undefined) {
      return rejected;
    }
  }

  const searchQuery = url.searchParams.get('srsearch');
  if (searchQuery === null || searchQuery.length === 0) {
    return createRejectedResult({
      code: 'invalid_query_parameter_value',
      message: 'srsearch must be a non-empty string',
    });
  }
  if (searchQuery.length > WIKIPEDIA_MAX_SEARCH_QUERY_LENGTH) {
    return createRejectedResult({
      code: 'invalid_query_parameter_value',
      message: `srsearch must be ${WIKIPEDIA_MAX_SEARCH_QUERY_LENGTH} characters or less`,
    });
  }

  const searchLimit = url.searchParams.get('srlimit');
  if (!validatePositiveIntegerString({ value: searchLimit })) {
    return createRejectedResult({
      code: 'invalid_query_parameter_value',
      message: 'srlimit must be a positive integer',
    });
  }
  if (Number(searchLimit) > WIKIPEDIA_MAX_SEARCH_LIMIT) {
    return createRejectedResult({
      code: 'invalid_query_parameter_value',
      message: `srlimit must be ${WIKIPEDIA_MAX_SEARCH_LIMIT} or less`,
    });
  }

  return createAcceptedResult({
    normalizedUrl: url.toString(),
  });
}

function validateWikipediaExtractQuery({
  url,
}: {
  url: URL,
}): PrivacyFetchValidationResult {
  const unknownQueryParameter = rejectUnknownQueryParameter({
    url,
    allowedKeys: [
      'origin',
      'action',
      'format',
      'formatversion',
      'prop',
      'explaintext',
      'exsectionformat',
      'pageids',
    ],
  });
  if (unknownQueryParameter !== undefined) {
    return unknownQueryParameter;
  }

  for (const [key, expectedValue] of [
    ['origin', '*'],
    ['action', 'query'],
    ['format', 'json'],
    ['formatversion', '2'],
    ['prop', 'extracts'],
    ['explaintext', '1'],
    ['exsectionformat', 'plain'],
  ] as const) {
    const rejected = requireExactQueryParameter({
      url,
      key,
      expectedValue,
    });
    if (rejected !== undefined) {
      return rejected;
    }
  }

  const pageIds = url.searchParams.get('pageids');
  if (!validatePositiveIntegerString({ value: pageIds })) {
    return createRejectedResult({
      code: 'invalid_query_parameter_value',
      message: 'pageids must be a positive integer',
    });
  }

  return createAcceptedResult({
    normalizedUrl: url.toString(),
  });
}

export function validateWikipediaPrivacyFetchUrl({
  url,
}: {
  url: URL,
}): PrivacyFetchValidationResult {
  if (!isValidWikipediaHostname({ hostname: url.hostname })) {
    return createRejectedResult({
      code: 'invalid_hostname',
      message: `Unsupported hostname: ${url.hostname}`,
    });
  }

  if (url.pathname !== '/w/api.php') {
    return createRejectedResult({
      code: 'invalid_pathname',
      message: `Unsupported pathname: ${url.pathname}`,
    });
  }

  const duplicateQueryParameter = rejectIfDuplicateQueryParameter({ url });
  if (duplicateQueryParameter !== undefined) {
    return duplicateQueryParameter;
  }

  const list = url.searchParams.get('list');
  if (list === 'search') {
    return validateWikipediaSearchQuery({ url });
  }

  const prop = url.searchParams.get('prop');
  if (prop === 'extracts') {
    return validateWikipediaExtractQuery({ url });
  }

  return createRejectedResult({
    code: 'unsupported_policy',
    message: 'The request does not match a supported Wikipedia API policy',
  });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
