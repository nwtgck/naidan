import { z } from 'zod';
import { parseCsp } from '@/utils/csp';
import type { CspParseResult, ParsedCsp } from '@/utils/csp';
import type { CspCapturedHeader, CspCapturedHeaders, CspObservationSnapshot, CspObservedPolicy } from './types';

type ObservationEnvironment = {
  getDocumentUrl: () => string,
  fetch: typeof globalThis.fetch,
  parse: ({ serialized }: { serialized: string }) => CspParseResult,
  timeoutMs: number,
};

const responseMetadataSchema = z.object({
  ok: z.literal(true),
  url: z.string().min(1).max(4_096),
  contentType: z.string().max(256),
  enforce: z.string().max(65_536).optional(),
  reportOnly: z.string().max(65_536).optional(),
});

function unavailable({ reason, capturedHeaders }: { reason: Extract<CspObservationSnapshot, { kind: 'unavailable' }>['reason'], capturedHeaders: CspCapturedHeaders | undefined }): CspObservationSnapshot {
  return Object.freeze({ kind: 'unavailable', reason, capturedHeaders });
}

export function captureCspHeadersForDeveloperOnly({ enforce, reportOnly }: { enforce: string | undefined, reportOnly: string | undefined }): CspCapturedHeaders {
  let remaining = 65_536;
  function capture({ serialized }: { serialized: string | undefined }): CspCapturedHeader | undefined {
    if (serialized === undefined) {
      return undefined;
    }
    const limit = Math.min(remaining, serialized.length);
    remaining -= limit;
    if (limit === serialized.length) {
      return Object.freeze({ serialized, originalLength: serialized.length, capture: 'complete' });
    }
    // Copy only the bounded prefix, without retaining a giant sliced backing string.
    const copied: unknown = JSON.parse(JSON.stringify(serialized.slice(0, limit)));
    if (typeof copied !== 'string') {
      return undefined;
    }
    return Object.freeze({ serialized: copied, originalLength: serialized.length, capture: 'truncated' });
  }
  return Object.freeze({ enforce: capture({ serialized: enforce }), reportOnly: capture({ serialized: reportOnly }) });
}

function cancelUnusedBody({ response }: { response: Response }): void {
  try {
    const cancellation = response.body?.cancel();
    void cancellation?.catch(() => undefined);
  } catch {
    // Optional diagnostics never own the application's error channel.
  }
}

function withinAggregateBudget({ values }: { values: readonly ParsedCsp[] }): boolean {
  let policies = 0, directives = 0, tokens = 0;
  for (const value of values) {
    policies += value.policies.length;
    for (const policy of value.policies) {
      directives += policy.directives.length;
      for (const directive of policy.directives) {
        tokens += directive.tokens.length;
      }
    }
  }
  return policies <= 128 && directives <= 1_024 && tokens <= 8_192;
}

/**
 * Presentation observations only. Never enable, disable, skip, route, or retry
 * a feature from this state. Hosted deployments use one CSP header on all
 * paths, and that header does not change during this Document's lifetime.
 * Fetch and parse once, sharing both the promise and terminal snapshot until
 * reload. Docs does not initialize or consume this optional observation.
 */
export function createCspObservationOwner({ environment }: { environment: ObservationEnvironment }) {
  let snapshot: CspObservationSnapshot = Object.freeze({ kind: 'not-started' });
  let pending: Promise<CspObservationSnapshot> | undefined;
  const listeners = new Set<() => void>();

  function publish({ value }: { value: CspObservationSnapshot }): void {
    snapshot = value;
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // A presentation consumer cannot prevent other consumers updating.
      }
    }
  }

  async function read({ signal }: { signal: AbortSignal }): Promise<CspObservationSnapshot> {
    let requestUrl: URL;
    try {
      requestUrl = new URL(environment.getDocumentUrl());
      requestUrl.hash = '';
    } catch {
      return unavailable({ reason: 'invalid-response', capturedHeaders: undefined });
    }
    if (requestUrl.protocol !== 'https:' && requestUrl.protocol !== 'http:') {
      return unavailable({ reason: 'unsupported-protocol', capturedHeaders: undefined });
    }

    let response: Response;
    try {
      response = await environment.fetch(requestUrl.href, {
        method: 'GET',
        mode: 'same-origin',
        credentials: 'same-origin',
        cache: 'default',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        signal,
      });
    } catch {
      return unavailable({ reason: 'request-failed', capturedHeaders: undefined });
    }
    cancelUnusedBody({ response });
    if (signal.aborted) {
      return unavailable({ reason: 'timeout', capturedHeaders: undefined });
    }

    let capturedHeaders: CspCapturedHeaders | undefined;
    try {
      const rawHeaders = z.object({ enforce: z.string().optional(), reportOnly: z.string().optional() }).safeParse({
        enforce: response.headers.get('Content-Security-Policy') ?? undefined,
        reportOnly: response.headers.get('Content-Security-Policy-Report-Only') ?? undefined,
      });
      if (!rawHeaders.success) {
        return unavailable({ reason: 'invalid-response', capturedHeaders: undefined });
      }
      capturedHeaders = captureCspHeadersForDeveloperOnly({ enforce: rawHeaders.data.enforce, reportOnly: rawHeaders.data.reportOnly });
      if ((rawHeaders.data.enforce?.length ?? 0) + (rawHeaders.data.reportOnly?.length ?? 0) > 65_536) {
        return unavailable({ reason: 'budget-exceeded', capturedHeaders });
      }
      const metadata = responseMetadataSchema.safeParse({
        ok: response.ok,
        url: response.url,
        contentType: response.headers.get('Content-Type') ?? '',
        enforce: rawHeaders.data.enforce,
        reportOnly: rawHeaders.data.reportOnly,
      });
      if (!metadata.success) {
        return unavailable({ reason: 'invalid-response', capturedHeaders });
      }
      const { url, contentType, enforce: serializedEnforce, reportOnly: serializedReportOnly } = metadata.data;
      if (new URL(url).origin !== requestUrl.origin || !/^(?:text\/html|application\/xhtml\+xml)(?:\s*;|$)/i.test(contentType)) {
        return unavailable({ reason: 'invalid-response', capturedHeaders });
      }
      const parsedValues: ParsedCsp[] = [];
      function parseHeader({ serialized }: { serialized: string | undefined }): CspObservedPolicy | undefined {
        if (serialized === undefined) {
          return undefined;
        }
        const result = environment.parse({ serialized });
        switch (result.kind) {
        case 'failed':
          throw new Error('CSP observation parsing did not finish.');
        case 'parsed':
          parsedValues.push(result.value);
          return Object.freeze({ serialized, parsed: result.value });
        default: {
          const exhaustive: never = result;
          return exhaustive;
        }
        }
      }
      let enforce: CspObservedPolicy | undefined, reportOnly: CspObservedPolicy | undefined;
      try {
        enforce = parseHeader({ serialized: serializedEnforce });
        reportOnly = parseHeader({ serialized: serializedReportOnly });
      } catch {
        return unavailable({ reason: 'parse-failed', capturedHeaders });
      }
      if (!withinAggregateBudget({ values: parsedValues })) {
        return unavailable({ reason: 'budget-exceeded', capturedHeaders });
      }
      // Queries are needed by the GET, but not by display matching or JSON.
      requestUrl.search = '';
      return Object.freeze({ kind: 'observed', documentUrl: requestUrl.href, enforce, reportOnly });
    } catch {
      return unavailable({ reason: 'invalid-response', capturedHeaders });
    }
  }

  function ensure(): Promise<CspObservationSnapshot> {
    if (pending !== undefined) {
      return pending;
    }
    let complete!: ({ value }: { value: CspObservationSnapshot }) => void;
    pending = new Promise<CspObservationSnapshot>(resolve => {
      complete = ({ value }) => resolve(value);
    });
    // Establish the shared promise before subscribers or injected I/O can reenter.
    publish({ value: Object.freeze({ kind: 'pending' }) });
    let finished = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    function settle({ value }: { value: CspObservationSnapshot }): void {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timer);
      publish({ value });
      complete({ value });
    }
    try {
      const controller = new AbortController();
      timer = setTimeout(() => {
        settle({ value: unavailable({ reason: 'timeout', capturedHeaders: undefined }) });
        try {
          controller.abort();
        } catch {
          // Terminal state does not depend on cancellation succeeding.
        }
      }, environment.timeoutMs);
      void read({ signal: controller.signal }).then(
        value => settle({ value }),
        () => settle({ value: unavailable({ reason: 'request-failed', capturedHeaders: undefined }) }),
      );
    } catch {
      settle({ value: unavailable({ reason: 'request-failed', capturedHeaders: undefined }) });
    }
    return pending;
  }

  return {
    ensure,
    getSnapshot: (): CspObservationSnapshot => snapshot,
    subscribe({ listener }: { listener: () => void }): (() => void) | undefined {
      if (listeners.size >= 512) {
        return undefined;
      }
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

let owner: ReturnType<typeof createCspObservationOwner> | undefined;

export function getCspObservationOwnerForMessagesOnly(): ReturnType<typeof createCspObservationOwner> {
  owner ??= createCspObservationOwner({
    environment: {
      getDocumentUrl: () => document.location.href,
      fetch: (input, init) => globalThis.fetch(input, init),
      parse: parseCsp,
      timeoutMs: 3_000,
    },
  });
  return owner;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
