import type { BrowserAiAvailabilityCopy } from '../../strings/models/browser-provided/checker/en';

export type BrowserAiAvailabilityPayload = { copy: BrowserAiAvailabilityCopy };

const copyFields = ['title', 'scope', 'initial', 'checking', 'available', 'downloadable', 'downloading', 'unavailable', 'apiAbsent', 'unknown', 'rejected', 'recheck', 'limits'] as const satisfies readonly (keyof BrowserAiAvailabilityCopy)[];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseBrowserAiAvailabilityPayload({ serialized }: { serialized: string }): BrowserAiAvailabilityPayload {
  const value: unknown = JSON.parse(serialized);
  if (!isRecord(value) || !isRecord(value.copy)) {
    throw new Error('Invalid browser AI availability props');
  }
  const copy = value.copy;
  if (!copyFields.every(field => typeof copy[field] === 'string')) {
    throw new Error('Invalid browser AI availability props');
  }
  return { copy: copy as BrowserAiAvailabilityCopy };
}
