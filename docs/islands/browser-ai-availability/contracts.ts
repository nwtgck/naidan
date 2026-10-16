import type { DocsLocale } from '../../navigation/routes';
import { defineDocsIslandSpec } from '../spec';

export type BrowserAiAvailabilityPayload = { locale: DocsLocale };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseBrowserAiAvailabilityPayload({ serialized }: { serialized: string }): BrowserAiAvailabilityPayload {
  const value: unknown = JSON.parse(serialized);
  if (!isRecord(value) || Object.keys(value).length !== 1 || (value.locale !== 'en' && value.locale !== 'ja')) {
    throw new Error('Invalid browser AI availability props');
  }
  return { locale: value.locale };
}

export const browserAiAvailabilitySpec = defineDocsIslandSpec<BrowserAiAvailabilityPayload>({
  id: 'browser-ai-availability',
  parse: parseBrowserAiAvailabilityPayload,
  start: 'interactive',
});
