import { privacyFetchHeaderEntriesSchema } from './schemas';
import { createPrivacyFetchError } from './errors';
import type { PrivacyFetchHeaderEntries } from './types';

export function normalizePrivacyFetchHeaders({ headers }: { headers: PrivacyFetchHeaderEntries | undefined }): PrivacyFetchHeaderEntries | undefined {
  if (headers === undefined) return undefined;
  try {
    return Array.from(new Headers(privacyFetchHeaderEntriesSchema.parse(headers)).entries());
  } catch {
    throw createPrivacyFetchError({ code: 'rejected', message: 'Invalid privacy fetch request headers' });
  }
}

export const TEST_ONLY = {
};
