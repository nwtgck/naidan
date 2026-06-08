import { privacyFetch } from '@/services/privacy-fetch'
import type { PrivacyFetchResponse } from '@/services/privacy-fetch'
import {
  countLines,
  saveWikipediaPageTextAsBinaryObject,
  WIKIPEDIA_INLINE_CONTENT_MAX_LINES,
} from './binary-object'
import { resolveWikipediaSearchLanguages } from './language-routing'
import { runWikipediaApiRequest } from './request-scheduler'
import {
  MediaWikiExtractApiResponseSchema,
  MediaWikiSearchApiResponseSchema,
} from './schemas'
import type {
  WikipediaLanguageCode,
  WikipediaPageResult,
  WikipediaSearchGroup,
  WikipediaSearchResult,
} from './types'

export const WIKIPEDIA_SEARCH_LIMIT = 30
export const WIKIPEDIA_API_MAX_RETRY_AFTER_RETRY_COUNT = 2
export const WIKIPEDIA_API_MAX_AUTO_RETRY_AFTER_MS = 30_000

type RequestWikipediaResponseImpl = ({
  url,
  signal,
}: {
  url: URL;
  signal: AbortSignal | undefined;
}) => Promise<unknown>

type RetryAfterRetryDecision =
  | {
    action: 'retry';
    delayMs: number;
    retryAfterMs: number;
    retryAfterValue: string;
  }
  | {
    action: 'give_up';
    reason: 'invalid_retry_after' | 'missing_retry_after' | 'retry_after_too_long' | 'retry_count_exhausted';
    retryAfterMs: number | undefined;
    retryAfterValue: string | undefined;
  }

function createWikipediaApiAbortError(): Error {
  const error = new Error('Wikipedia API request was aborted')
  error.name = 'AbortError'
  return error
}

function createWikipediaApiUrl({ lang }: { lang: string }): URL {
  return new URL(`https://${lang}.wikipedia.org/w/api.php`)
}

function formatWikipediaHttpStatus({
  response,
}: {
  response: PrivacyFetchResponse;
}): string {
  const trimmedStatusText = response.statusText.trim()
  if (trimmedStatusText.length === 0) {
    return `HTTP ${response.status}`
  }

  return `HTTP ${response.status} ${trimmedStatusText}`
}

function getWikipediaHttpErrorPrefix({
  response,
}: {
  response: PrivacyFetchResponse;
}): string {
  if (response.status >= 500 && response.status <= 599) {
    return 'Wikipedia API server error'
  }

  return 'Wikipedia API request failed'
}

export function getRetryAfterHeaderValue({
  response,
}: {
  response: PrivacyFetchResponse;
}): string | undefined {
  return response.headers.get('retry-after') ?? undefined
}

export function parseRetryAfterMs({
  value,
  nowMs,
}: {
  value: string | undefined;
  nowMs: number;
}): number | undefined {
  if (value === undefined) {
    return undefined
  }

  const trimmedValue = value.trim()
  if (trimmedValue.length === 0) {
    return undefined
  }

  if (/^\d+$/.test(trimmedValue)) {
    return Number(trimmedValue) * 1000
  }

  if (!/[a-z]/i.test(trimmedValue)) {
    return undefined
  }

  const parsedDateMs = Date.parse(trimmedValue)
  if (Number.isNaN(parsedDateMs)) {
    return undefined
  }

  return Math.max(0, parsedDateMs - nowMs)
}

export function createRetryAfterRetryDecision({
  response,
  retryCount,
  nowMs,
}: {
  response: PrivacyFetchResponse;
  retryCount: number;
  nowMs: number;
}): RetryAfterRetryDecision {
  const retryAfterValue = getRetryAfterHeaderValue({ response })
  if (retryAfterValue === undefined) {
    return {
      action: 'give_up',
      reason: 'missing_retry_after',
      retryAfterMs: undefined,
      retryAfterValue: undefined,
    }
  }

  const retryAfterMs = parseRetryAfterMs({
    value: retryAfterValue,
    nowMs,
  })
  if (retryAfterMs === undefined) {
    return {
      action: 'give_up',
      reason: 'invalid_retry_after',
      retryAfterMs: undefined,
      retryAfterValue,
    }
  }

  if (retryCount >= WIKIPEDIA_API_MAX_RETRY_AFTER_RETRY_COUNT) {
    return {
      action: 'give_up',
      reason: 'retry_count_exhausted',
      retryAfterMs,
      retryAfterValue,
    }
  }

  if (retryAfterMs > WIKIPEDIA_API_MAX_AUTO_RETRY_AFTER_MS) {
    return {
      action: 'give_up',
      reason: 'retry_after_too_long',
      retryAfterMs,
      retryAfterValue,
    }
  }

  return {
    action: 'retry',
    delayMs: retryAfterMs,
    retryAfterMs,
    retryAfterValue,
  }
}

function createWikipediaRetryAfterError({
  decision,
  response,
  retryCount,
}: {
  decision: RetryAfterRetryDecision;
  response: PrivacyFetchResponse;
  retryCount: number;
}): Error {
  const messagePrefix = getWikipediaHttpErrorPrefix({ response })
  const httpStatus = formatWikipediaHttpStatus({ response })

  switch (decision.action) {
  case 'retry':
    return new Error(`${messagePrefix}: ${httpStatus}.`)
  case 'give_up':
    switch (decision.reason) {
    case 'missing_retry_after':
      return new Error(`${messagePrefix}: ${httpStatus}. No valid Retry-After header was provided, so the request was not retried automatically.`)
    case 'invalid_retry_after':
      return new Error(`${messagePrefix}: ${httpStatus}. Invalid Retry-After header: "${decision.retryAfterValue ?? ''}". The request was not retried automatically.`)
    case 'retry_after_too_long':
      return new Error(`${messagePrefix}: ${httpStatus}. Retry-After: ${decision.retryAfterValue ?? ''}. Not retrying automatically because it exceeds the 30 second auto-retry limit.`)
    case 'retry_count_exhausted':
      return new Error(`${messagePrefix}: ${httpStatus}. Retry-After: ${decision.retryAfterValue ?? ''}. Retried ${retryCount} times according to Retry-After, then gave up.`)
    default: {
      const neverReason: never = decision.reason
      throw new Error(`Unhandled Retry-After give-up reason: ${String(neverReason)}`)
    }
    }
  default: {
    const neverDecision: never = decision
    throw new Error(`Unhandled Retry-After retry decision: ${String(neverDecision)}`)
  }
  }
}

export async function waitForRetryAfterDelay({
  delayMs,
  signal,
}: {
  delayMs: number;
  signal: AbortSignal | undefined;
}): Promise<void> {
  if (delayMs <= 0) {
    if (signal?.aborted) {
      throw createWikipediaApiAbortError()
    }
    return
  }

  if (signal?.aborted) {
    throw createWikipediaApiAbortError()
  }

  await new Promise<void>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, delayMs)

    const onAbort = () => {
      clearTimeout(timeoutId)
      signal?.removeEventListener('abort', onAbort)
      reject(createWikipediaApiAbortError())
    }

    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

async function requestWikipediaResponse({
  url,
  signal,
}: {
  url: URL;
  signal: AbortSignal | undefined;
}): Promise<unknown> {
  let retryCount = 0

  try {
    while (true) {
      const response = await runWikipediaApiRequest({
        signal,
        request: async () => privacyFetch({
          url: url.toString(),
          signal,
        }),
      })

      if (response.ok) {
        const text = new TextDecoder().decode(response.body)
        return JSON.parse(text) as unknown
      }

      const decision = createRetryAfterRetryDecision({
        response,
        retryCount,
        nowMs: Date.now(),
      })
      switch (decision.action) {
      case 'retry':
        await waitForRetryAfterDelay({
          delayMs: decision.delayMs,
          signal,
        })
        retryCount += 1
        continue
      case 'give_up':
        throw createWikipediaRetryAfterError({
          decision,
          response,
          retryCount,
        })
      default: {
        const neverDecision: never = decision
        throw new Error(`Unhandled Retry-After retry decision: ${String(neverDecision)}`)
      }
      }
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw error
    }

    throw new Error(`Wikipedia request failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function searchWikipediaLanguage({
  lang,
  query,
  signal,
  requestResponseImpl,
}: {
  lang: WikipediaLanguageCode;
  query: string;
  signal: AbortSignal | undefined;
  requestResponseImpl: RequestWikipediaResponseImpl | undefined;
}): Promise<WikipediaSearchGroup> {
  const url = createWikipediaApiUrl({ lang })
  url.searchParams.set('origin', '*')
  url.searchParams.set('action', 'query')
  url.searchParams.set('format', 'json')
  url.searchParams.set('formatversion', '2')
  url.searchParams.set('list', 'search')
  url.searchParams.set('srsearch', query)
  url.searchParams.set('srlimit', String(WIKIPEDIA_SEARCH_LIMIT))
  url.searchParams.set('srnamespace', '0')
  url.searchParams.set('srprop', '')
  url.searchParams.set('srinfo', '')

  const raw = await (requestResponseImpl ?? requestWikipediaResponse)({
    url,
    signal,
  })
  const parsed = MediaWikiSearchApiResponseSchema.safeParse(raw)
  if (!parsed.success) {
    throw new Error(`Wikipedia search response validation failed: ${parsed.error.message}`)
  }

  return {
    lang,
    items: parsed.data.query.search.map((item) => ({
      title: item.title,
      pageId: item.pageid,
    })),
  }
}

export async function searchWikipedia({
  lang,
  query,
  contextLanguage,
  signal,
  requestResponseImpl,
}: {
  lang: string | undefined;
  query: string;
  contextLanguage: string | undefined;
  signal: AbortSignal | undefined;
  requestResponseImpl: RequestWikipediaResponseImpl | undefined;
}): Promise<WikipediaSearchResult> {
  // Tools currently require lang explicitly, so the undefined branch is unused today.
  // Keep the internal router fallback for future call sites that may want heuristic language selection.
  const languages = lang !== undefined
    ? [lang]
    : resolveWikipediaSearchLanguages({
      query,
      contextLanguage,
    }).filter((value): value is string => value !== undefined)

  const groups: WikipediaSearchGroup[] = []
  for (const searchLang of languages) {
    groups.push(await searchWikipediaLanguage({
      lang: searchLang,
      query,
      signal,
      requestResponseImpl,
    }))
  }

  return { groups }
}

export async function getWikipediaPage({
  lang,
  pageId,
  signal,
  requestResponseImpl,
}: {
  lang: string;
  pageId: number;
  signal: AbortSignal | undefined;
  requestResponseImpl: RequestWikipediaResponseImpl | undefined;
}): Promise<WikipediaPageResult> {
  const url = createWikipediaApiUrl({ lang })
  url.searchParams.set('origin', '*')
  url.searchParams.set('action', 'query')
  url.searchParams.set('format', 'json')
  url.searchParams.set('formatversion', '2')
  url.searchParams.set('prop', 'extracts')
  url.searchParams.set('explaintext', '1')
  url.searchParams.set('exsectionformat', 'plain')
  url.searchParams.set('pageids', String(pageId))

  const raw = await (requestResponseImpl ?? requestWikipediaResponse)({
    url,
    signal,
  })
  const parsed = MediaWikiExtractApiResponseSchema.safeParse(raw)
  if (!parsed.success) {
    throw new Error(`Wikipedia page response validation failed: ${parsed.error.message}`)
  }

  const page = parsed.data.query.pages.find((item) => item.pageid === pageId)
  if (page === undefined) {
    throw new Error(`Wikipedia page not found for pageId ${pageId}`)
  }

  const content = page.extract
  const lineCount = countLines({ text: content })
  if (lineCount <= WIKIPEDIA_INLINE_CONTENT_MAX_LINES) {
    return {
      kind: 'inline',
      lang,
      pageId: page.pageid,
      title: page.title,
      content,
    }
  }

  const saved = await saveWikipediaPageTextAsBinaryObject({
    lang,
    pageId: page.pageid,
    title: page.title,
    content,
    lineCount,
  })

  return {
    kind: 'binary_object',
    lang,
    pageId: page.pageid,
    title: page.title,
    lineCount: saved.lineCount,
    byteLength: saved.byteLength,
    sysfsNaidanDataFilePath: saved.sysfsNaidanDataFilePath,
  }
}
