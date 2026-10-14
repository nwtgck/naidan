import type { DocsLocale } from '../../navigation/routes';
import { defineDocsIslandSpec } from '../spec';

export type BranchingPayload = { locale: DocsLocale };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseBranchingPayload({ serialized }: { serialized: string }): BranchingPayload {
  const value: unknown = JSON.parse(serialized);
  if (!isRecord(value) || Object.keys(value).length !== 1 || (value.locale !== 'en' && value.locale !== 'ja')) {
    throw new Error('Invalid branching demonstration props');
  }
  return { locale: value.locale };
}

export const branchingSpec = defineDocsIslandSpec<BranchingPayload>({
  id: 'branching',
  parse: parseBranchingPayload,
  start: 'interactive',
});
