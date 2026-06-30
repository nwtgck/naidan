import { privacyFetch } from '@/features/privacy-fetch';
import type { PrivacyFetchResponse } from '@/features/privacy-fetch';
import {
  isPrivacyFetchError,
} from '@/features/privacy-fetch/errors';
import {
  countLines,
  saveWikipediaPageTextAsBinaryObject,
  WIKIPEDIA_INLINE_CONTENT_MAX_LINES,
} from './binary-object';
import { resolveWikipediaSearchLanguages } from './language-routing';
import {
  runWikipediaApiRequest,
  waitForWikipediaApiAttemptWindow,
} from './request-scheduler';
import {
  MediaWikiExtractApiResponseSchema,
  MediaWikiSearchApiResponseSchema,
} from './schemas';
import type {
  WikipediaLanguageCode,
  WikipediaPageResult,
  WikipediaSearchGroup,
  WikipediaSearchResult,
} from './types';

export const WIKIPEDIA_SEARCH_LIMIT = 30;
export const WIKIPEDIA_API_MAX_RETRY_AFTER_RETRY_COUNT = 2;
export const WIKIPEDIA_API_MAX_AUTO_RETRY_AFTER_MS = 30_000;
export const WIKIPEDIA_API_CORS_HIDDEN_RATE_LIMIT_RETRY_DELAYS_MS = [2_000, 4_000, 8_000, 16_000] as const;

type RequestWikipediaResponseImpl = ({
  url,
  signal,
}: {
  url: URL,
  signal: AbortSignal | undefined,
}) => Promise<unknown>;

type WikipediaHttpRetryDecision =
  | {
    action: 'retry',
    delayMs: number,
    delaySource: 'fallback_429' | 'retry_after',
    retryAfterMs: number,
    retryAfterValue: string | undefined,
  }
  | {
    action: 'give_up',
    reason:
      | 'fallback_429_retry_count_exhausted'
      | 'invalid_retry_after'
      | 'missing_retry_after'
      | 'retry_after_too_long'
      | 'retry_count_exhausted',
    retryAfterMs: number | undefined,
    retryAfterValue: string | undefined,
  };

type WikipediaFetchFailureRetryDecision =
  | {
    action: 'retry',
    delayMs: number,
    delaySource: 'cors_hidden_rate_limit_fallback',
  }
  | {
    action: 'give_up',
    reason:
      | 'cors_hidden_rate_limit_retry_count_exhausted'
      | 'non_retryable_fetch_error',
  };

type WikipediaFetchFailureClassification =
  | 'aborted'
  | 'cors_hidden_rate_limit_candidate'
  | 'non_retryable_fetch_error';

function createWikipediaApiAbortError(): Error {
  const error = new Error('Wikipedia API request was aborted');
  error.name = 'AbortError';
  return error;
}

function formatWikipediaCorsHiddenRateLimitRetryDelayList(): string {
  return WIKIPEDIA_API_CORS_HIDDEN_RATE_LIMIT_RETRY_DELAYS_MS
    .map((delayMs) => `${delayMs / 1000}s`)
    .join(', ')
    .replace(/, ([^,]+)$/, ', and $1');
}

function createWikipediaApiUrl({ lang }: { lang: string }): URL {
  return new URL(`https://${lang}.wikipedia.org/w/api.php`);
}

function formatWikipediaHttpStatus({
  response,
}: {
  response: PrivacyFetchResponse,
}): string {
  const trimmedStatusText = response.statusText.trim();
  if (trimmedStatusText.length === 0) {
    return `HTTP ${response.status}`;
  }

  return `HTTP ${response.status} ${trimmedStatusText}`;
}

function getWikipediaHttpErrorPrefix({
  response,
}: {
  response: PrivacyFetchResponse,
}): string {
  if (response.status >= 500 && response.status <= 599) {
    return 'Wikipedia API server error';
  }

  return 'Wikipedia API request failed';
}

export function getRetryAfterHeaderValue({
  response,
}: {
  response: PrivacyFetchResponse,
}): string | undefined {
  return response.headers.get('retry-after') ?? undefined;
}

export function parseRetryAfterMs({
  value,
  nowMs,
}: {
  value: string | undefined,
  nowMs: number,
}): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const trimmedValue = value.trim();
  if (trimmedValue.length === 0) {
    return undefined;
  }

  if (/^\d+$/.test(trimmedValue)) {
    return Number(trimmedValue) * 1000;
  }

  if (!/[a-z]/i.test(trimmedValue)) {
    return undefined;
  }

  const parsedDateMs = Date.parse(trimmedValue);
  if (Number.isNaN(parsedDateMs)) {
    return undefined;
  }

  return Math.max(0, parsedDateMs - nowMs);
}

export function createRetryAfterRetryDecision({
  response,
  fallbackRetryCount,
  nowMs,
  retryCount,
}: {
  response: PrivacyFetchResponse,
  fallbackRetryCount: number,
  retryCount: number,
  nowMs: number,
}): WikipediaHttpRetryDecision {
  const retryAfterValue = getRetryAfterHeaderValue({ response });
  if (retryAfterValue === undefined) {
    if (response.status === 429) {
      const fallbackDelayMs =
        WIKIPEDIA_API_CORS_HIDDEN_RATE_LIMIT_RETRY_DELAYS_MS[fallbackRetryCount];
      if (fallbackDelayMs !== undefined) {
        return {
          action: 'retry',
          delayMs: fallbackDelayMs,
          delaySource: 'fallback_429',
          retryAfterMs: 0,
          retryAfterValue: undefined,
        };
      }

      return {
        action: 'give_up',
        reason: 'fallback_429_retry_count_exhausted',
        retryAfterMs: undefined,
        retryAfterValue: undefined,
      };
    }

    return {
      action: 'give_up',
      reason: 'missing_retry_after',
      retryAfterMs: undefined,
      retryAfterValue: undefined,
    };
  }

  const retryAfterMs = parseRetryAfterMs({
    value: retryAfterValue,
    nowMs,
  });
  if (retryAfterMs === undefined) {
    if (response.status === 429) {
      const fallbackDelayMs =
        WIKIPEDIA_API_CORS_HIDDEN_RATE_LIMIT_RETRY_DELAYS_MS[fallbackRetryCount];
      if (fallbackDelayMs !== undefined) {
        return {
          action: 'retry',
          delayMs: fallbackDelayMs,
          delaySource: 'fallback_429',
          retryAfterMs: 0,
          retryAfterValue,
        };
      }

      return {
        action: 'give_up',
        reason: 'fallback_429_retry_count_exhausted',
        retryAfterMs: undefined,
        retryAfterValue,
      };
    }

    return {
      action: 'give_up',
      reason: 'invalid_retry_after',
      retryAfterMs: undefined,
      retryAfterValue,
    };
  }

  if (retryCount >= WIKIPEDIA_API_MAX_RETRY_AFTER_RETRY_COUNT) {
    return {
      action: 'give_up',
      reason: 'retry_count_exhausted',
      retryAfterMs,
      retryAfterValue,
    };
  }

  if (retryAfterMs > WIKIPEDIA_API_MAX_AUTO_RETRY_AFTER_MS) {
    return {
      action: 'give_up',
      reason: 'retry_after_too_long',
      retryAfterMs,
      retryAfterValue,
    };
  }

  return {
    action: 'retry',
    delayMs: retryAfterMs,
    delaySource: 'retry_after',
    retryAfterMs,
    retryAfterValue,
  };
}

function classifyWikipediaFetchFailure({
  error,
}: {
  error: unknown,
}): WikipediaFetchFailureClassification {
  if (isPrivacyFetchError(error)) {
    switch (error.code) {
    case 'aborted':
      return 'aborted';
    case 'fetch_failed':
      return 'cors_hidden_rate_limit_candidate';
    case 'rejected':
    case 'broker_disposed':
    case 'broker_not_ready':
    case 'broker_unavailable':
    case 'duplicate_request_id':
    case 'unknown':
      return 'non_retryable_fetch_error';
    default: {
      const neverCode: never = error.code;
      throw new Error(`Unhandled privacy fetch runtime error code: ${String(neverCode)}`);
    }
    }
  }

  return 'non_retryable_fetch_error';
}

export function createWikipediaFetchFailureRetryDecision({
  error,
  retryCount,
}: {
  error: unknown,
  retryCount: number,
}): WikipediaFetchFailureRetryDecision {
  const classification = classifyWikipediaFetchFailure({ error });

  switch (classification) {
  case 'aborted':
    return {
      action: 'give_up',
      reason: 'non_retryable_fetch_error',
    };
  case 'cors_hidden_rate_limit_candidate': {
    const delayMs = WIKIPEDIA_API_CORS_HIDDEN_RATE_LIMIT_RETRY_DELAYS_MS[retryCount];
    if (delayMs === undefined) {
      return {
        action: 'give_up',
        reason: 'cors_hidden_rate_limit_retry_count_exhausted',
      };
    }

    return {
      action: 'retry',
      delayMs,
      delaySource: 'cors_hidden_rate_limit_fallback',
    };
  }
  case 'non_retryable_fetch_error':
    return {
      action: 'give_up',
      reason: 'non_retryable_fetch_error',
    };
  default: {
    const neverClassification: never = classification;
    throw new Error(`Unhandled Wikipedia fetch failure classification: ${String(neverClassification)}`);
  }
  }
}

function createWikipediaRetryAfterError({
  decision,
  response,
  retryCount,
}: {
  decision: WikipediaHttpRetryDecision,
  response: PrivacyFetchResponse,
  retryCount: number,
}): Error {
  const messagePrefix = getWikipediaHttpErrorPrefix({ response });
  const httpStatus = formatWikipediaHttpStatus({ response });

  switch (decision.action) {
  case 'retry':
    return new Error(`${messagePrefix}: ${httpStatus}.`);
  case 'give_up':
    switch (decision.reason) {
    case 'fallback_429_retry_count_exhausted':
      return new Error(`${messagePrefix}: ${httpStatus}. Retry-After was invalid or unavailable. Retried ${retryCount} times with fallback exponential backoff delays of ${formatWikipediaCorsHiddenRateLimitRetryDelayList()}, then gave up.`);
    case 'missing_retry_after':
      return new Error(`${messagePrefix}: ${httpStatus}. No valid Retry-After header was provided, so the request was not retried automatically.`);
    case 'invalid_retry_after':
      return new Error(`${messagePrefix}: ${httpStatus}. Invalid Retry-After header: "${decision.retryAfterValue ?? ''}". The request was not retried automatically.`);
    case 'retry_after_too_long':
      return new Error(`${messagePrefix}: ${httpStatus}. Retry-After: ${decision.retryAfterValue ?? ''}. Not retrying automatically because it exceeds the 30 second auto-retry limit.`);
    case 'retry_count_exhausted':
      return new Error(`${messagePrefix}: ${httpStatus}. Retry-After: ${decision.retryAfterValue ?? ''}. Retried ${retryCount} times according to Retry-After, then gave up.`);
    default: {
      const neverReason: never = decision.reason;
      throw new Error(`Unhandled Retry-After give-up reason: ${String(neverReason)}`);
    }
    }
  default: {
    const neverDecision: never = decision;
    throw new Error(`Unhandled Retry-After retry decision: ${String(neverDecision)}`);
  }
  }
}

function createWikipediaFetchFailureError({
  decision,
}: {
  decision: WikipediaFetchFailureRetryDecision,
}): Error {
  switch (decision.action) {
  case 'retry':
    return new Error('Wikipedia fetch failure retry is still pending.');
  case 'give_up':
    switch (decision.reason) {
    case 'cors_hidden_rate_limit_retry_count_exhausted':
      return new Error(`Wikipedia API request failed before an HTTP response was exposed to JavaScript. The browser reported a privacy fetch failure. This is likely a CORS-hidden rate limit response, such as HTTP 429 without Access-Control-Allow-Origin. Retried ${WIKIPEDIA_API_CORS_HIDDEN_RATE_LIMIT_RETRY_DELAYS_MS.length} times with fallback delays of ${formatWikipediaCorsHiddenRateLimitRetryDelayList()}, then gave up.`);
    case 'non_retryable_fetch_error':
      return new Error('Wikipedia API request failed before an HTTP response was exposed to JavaScript. The browser reported a privacy fetch failure that is not retried automatically.');
    default: {
      const neverReason: never = decision.reason;
      throw new Error(`Unhandled Wikipedia fetch failure give-up reason: ${String(neverReason)}`);
    }
    }
  default: {
    const neverDecision: never = decision;
    throw new Error(`Unhandled Wikipedia fetch failure retry decision: ${String(neverDecision)}`);
  }
  }
}

export async function waitForRetryAfterDelay({
  delayMs,
  signal,
}: {
  delayMs: number,
  signal: AbortSignal | undefined,
}): Promise<void> {
  if (delayMs <= 0) {
    if (signal?.aborted) {
      throw createWikipediaApiAbortError();
    }
    return;
  }

  if (signal?.aborted) {
    throw createWikipediaApiAbortError();
  }

  await new Promise<void>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);

    const onAbort = () => {
      clearTimeout(timeoutId);
      signal?.removeEventListener('abort', onAbort);
      reject(createWikipediaApiAbortError());
    };

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function requestWikipediaResponseWithRetry({
  url,
  signal,
}: {
  url: URL,
  signal: AbortSignal | undefined,
}): Promise<unknown> {
  let fetchFailureRetryCount = 0;
  let httpRetryCount = 0;

  try {
    while (true) {
      await waitForWikipediaApiAttemptWindow({
        signal,
      });
      let response: PrivacyFetchResponse;
      try {
        response = await privacyFetch({
          request: {
            url: url.toString(),
            signal,
          },
        });
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          throw error;
        }

        const fetchFailureDecision = createWikipediaFetchFailureRetryDecision({
          error,
          retryCount: fetchFailureRetryCount,
        });
        switch (fetchFailureDecision.action) {
        case 'retry':
          await waitForRetryAfterDelay({
            delayMs: fetchFailureDecision.delayMs,
            signal,
          });
          fetchFailureRetryCount += 1;
          continue;
        case 'give_up':
          throw createWikipediaFetchFailureError({
            decision: fetchFailureDecision,
          });
        default: {
          const neverDecision: never = fetchFailureDecision;
          throw new Error(`Unhandled Wikipedia fetch failure retry decision: ${String(neverDecision)}`);
        }
        }
      }

      if (response.ok) {
        const text = new TextDecoder().decode(response.body);
        return JSON.parse(text) as unknown;
      }

      const decision = createRetryAfterRetryDecision({
        fallbackRetryCount: fetchFailureRetryCount,
        response,
        retryCount: httpRetryCount,
        nowMs: Date.now(),
      });
      switch (decision.action) {
      case 'retry':
        await waitForRetryAfterDelay({
          delayMs: decision.delayMs,
          signal,
        });
        switch (decision.delaySource) {
        case 'fallback_429':
          fetchFailureRetryCount += 1;
          break;
        case 'retry_after':
          httpRetryCount += 1;
          break;
        default: {
          const neverDelaySource: never = decision.delaySource;
          throw new Error(`Unhandled Wikipedia retry delay source: ${String(neverDelaySource)}`);
        }
        }
        continue;
      case 'give_up':
        throw createWikipediaRetryAfterError({
          decision,
          response,
          retryCount: (() => {
            switch (decision.reason) {
            case 'fallback_429_retry_count_exhausted':
              return fetchFailureRetryCount;
            case 'invalid_retry_after':
            case 'missing_retry_after':
            case 'retry_after_too_long':
            case 'retry_count_exhausted':
              return httpRetryCount;
            default: {
              const neverReason: never = decision.reason;
              throw new Error(`Unhandled Wikipedia retry give-up reason: ${String(neverReason)}`);
            }
            }
          })(),
        });
      default: {
        const neverDecision: never = decision;
        throw new Error(`Unhandled Retry-After retry decision: ${String(neverDecision)}`);
      }
      }
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw error;
    }

    throw error;
  }
}

async function requestWikipediaResponse({
  url,
  signal,
}: {
  url: URL,
  signal: AbortSignal | undefined,
}): Promise<unknown> {
  try {
    return await runWikipediaApiRequest({
      signal,
      request: async () => requestWikipediaResponseWithRetry({
        url,
        signal,
      }),
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw error;
    }

    throw new Error(`Wikipedia request failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function searchWikipediaLanguage({
  lang,
  query,
  signal,
  requestResponseImpl,
}: {
  lang: WikipediaLanguageCode,
  query: string,
  signal: AbortSignal | undefined,
  requestResponseImpl: RequestWikipediaResponseImpl | undefined,
}): Promise<WikipediaSearchGroup> {
  const url = createWikipediaApiUrl({ lang });
  url.searchParams.set('origin', '*');
  url.searchParams.set('action', 'query');
  url.searchParams.set('format', 'json');
  url.searchParams.set('formatversion', '2');
  url.searchParams.set('list', 'search');
  url.searchParams.set('srsearch', query);
  url.searchParams.set('srlimit', String(WIKIPEDIA_SEARCH_LIMIT));
  url.searchParams.set('srnamespace', '0');
  url.searchParams.set('srprop', '');
  url.searchParams.set('srinfo', '');

  const raw = await (requestResponseImpl ?? requestWikipediaResponse)({
    url,
    signal,
  });
  const parsed = MediaWikiSearchApiResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Wikipedia search response validation failed: ${parsed.error.message}`);
  }

  return {
    lang,
    items: parsed.data.query.search.map((item) => ({
      title: item.title,
      pageId: item.pageid,
    })),
  };
}

export async function searchWikipedia({
  lang,
  query,
  contextLanguage,
  signal,
  requestResponseImpl,
}: {
  lang: string | undefined,
  query: string,
  contextLanguage: string | undefined,
  signal: AbortSignal | undefined,
  requestResponseImpl: RequestWikipediaResponseImpl | undefined,
}): Promise<WikipediaSearchResult> {
  // Tools currently require lang explicitly, so the undefined branch is unused today.
  // Keep the internal router fallback for future call sites that may want heuristic language selection.
  const languages = lang !== undefined
    ? [lang]
    : resolveWikipediaSearchLanguages({
      query,
      contextLanguage,
    }).filter((value): value is string => value !== undefined);

  const groups: WikipediaSearchGroup[] = [];
  for (const searchLang of languages) {
    groups.push(await searchWikipediaLanguage({
      lang: searchLang,
      query,
      signal,
      requestResponseImpl,
    }));
  }

  return { groups };
}

export async function getWikipediaPage({
  lang,
  pageId,
  signal,
  requestResponseImpl,
}: {
  lang: string,
  pageId: number,
  signal: AbortSignal | undefined,
  requestResponseImpl: RequestWikipediaResponseImpl | undefined,
}): Promise<WikipediaPageResult> {
  const url = createWikipediaApiUrl({ lang });
  url.searchParams.set('origin', '*');
  url.searchParams.set('action', 'query');
  url.searchParams.set('format', 'json');
  url.searchParams.set('formatversion', '2');
  url.searchParams.set('prop', 'extracts');
  url.searchParams.set('explaintext', '1');
  url.searchParams.set('exsectionformat', 'plain');
  url.searchParams.set('pageids', String(pageId));

  const raw = await (requestResponseImpl ?? requestWikipediaResponse)({
    url,
    signal,
  });
  const parsed = MediaWikiExtractApiResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Wikipedia page response validation failed: ${parsed.error.message}`);
  }

  const page = parsed.data.query.pages.find((item) => item.pageid === pageId);
  if (page === undefined) {
    throw new Error(`Wikipedia page not found for pageId ${pageId}`);
  }

  const content = page.extract;
  const lineCount = countLines({ text: content });
  if (lineCount <= WIKIPEDIA_INLINE_CONTENT_MAX_LINES) {
    return {
      kind: 'inline',
      lang,
      pageId: page.pageid,
      title: page.title,
      content,
    };
  }

  const saved = await saveWikipediaPageTextAsBinaryObject({
    lang,
    pageId: page.pageid,
    title: page.title,
    content,
    lineCount,
  });

  return {
    kind: 'binary_object',
    lang,
    pageId: page.pageid,
    title: page.title,
    lineCount: saved.lineCount,
    byteLength: saved.byteLength,
    sysfsNaidanDataFilePath: saved.sysfsNaidanDataFilePath,
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
