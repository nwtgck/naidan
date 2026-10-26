import type { ParsedCsp } from '@/utils/csp';

/** Display inputs only. These types must never become execution permissions. */
export type CspResourceDescription = Readonly<{
  url: string,
  destination: 'connect' | 'image' | 'media' | 'frame' | 'worker' | 'script' | 'style' | 'font' | 'manifest' | 'form',
  realm: 'document' | 'same-origin-worker',
}>;

export type CspHintTarget =
  | Readonly<{ kind: 'connection', endpoint: string | undefined, apiPath: string }>
  | Readonly<{ kind: 'relay', url: string | undefined }>
  | Readonly<{ kind: 'wikipedia' }>
  | Readonly<{ kind: 'huggingface-metadata' }>
  | Readonly<{ kind: 'huggingface-download' }>
  | Readonly<{ kind: 'resource' } & CspResourceDescription>
  | Readonly<{ kind: 'resource-list', resources: readonly CspResourceDescription[] }>;

export type CspSourceDescription =
  | Readonly<{ kind: 'self' | 'loopback' | 'none' }>
  | Readonly<{ kind: 'host' | 'scheme' | 'other', value: string }>;

export type CspHintDetail = Readonly<{
  directive: string,
  sources: readonly string[],
  sourceDescriptions: readonly CspSourceDescription[],
  context: 'document' | 'privacy-broker' | 'same-origin-worker',
}>;

export type CspSuggestedDeploymentId = 'standard' | 'curated';

export type CspSuggestedDeployment = Readonly<{
  id: CspSuggestedDeploymentId,
}>;

export type CspHintMessage = Readonly<{
  tone: 'caution',
  subject: 'connection' | 'wikipedia' | 'huggingface' | 'resource' | 'image' | 'media' | 'frame' | 'worker' | 'script' | 'style' | 'font' | 'manifest' | 'form',
  details: readonly CspHintDetail[],
  suggestedDeployments: readonly CspSuggestedDeployment[],
}>;

export type CspObservedPolicy = Readonly<{ serialized: string, parsed: ParsedCsp }>;

export type CspCapturedHeader = Readonly<{
  serialized: string,
  originalLength: number,
  capture: 'complete' | 'truncated',
}>;

export type CspCapturedHeaders = Readonly<{
  enforce: CspCapturedHeader | undefined,
  reportOnly: CspCapturedHeader | undefined,
}>;

export type CspObservationSnapshot =
  | Readonly<{ kind: 'not-started' }>
  | Readonly<{ kind: 'pending' }>
  | Readonly<{
    kind: 'unavailable',
    reason: 'unsupported-protocol' | 'module-failed' | 'request-failed' | 'invalid-response' | 'parse-failed' | 'budget-exceeded' | 'timeout',
    capturedHeaders: CspCapturedHeaders | undefined,
  }>
  | Readonly<{
    kind: 'observed',
    documentUrl: string,
    enforce: CspObservedPolicy | undefined,
    reportOnly: CspObservedPolicy | undefined,
  }>;

export type CspDeveloperSnapshot = Readonly<{
  observation: CspObservationSnapshot,
  addedMetaParsed: readonly ParsedCsp[] | undefined,
  connectionSummary: readonly CspHintDetail[] | undefined,
}>;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
