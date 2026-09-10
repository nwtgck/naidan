import { describe, expect, it } from 'vitest';
import { ordinaryProviderRuntimeCompletionSchema } from './provider-load-runtime-completion';

describe('ordinary Provider runtime completion schema', () => {
  it('does not promote a legacy receipt-free accepted result to ordinary Provider acceptance', () => {
    expect(ordinaryProviderRuntimeCompletionSchema.safeParse({ schemaVersion: 1, source: 'ordinary-provider-load', status: 'accepted',
      repositoryResolvedRevision: 'a'.repeat(40), cacheRevision: 'a'.repeat(40), loaderRevisionOption: 'a'.repeat(40),
      selectedCandidate: { device: 'wasm', dtype: 'q4' } }).success).toBe(false);
  });

  it('keeps unavailable observation distinct from unperformed independent acceptance work', () => {
    const unavailable = { schemaVersion: 1, source: 'ordinary-provider-load', status: 'exhausted',
      repositoryResolvedRevision: 'a'.repeat(40), cacheRevision: null, loaderRevisionOption: null,
      error: { name: 'ProductionLoadReceiptUnavailable', message: 'Receipt was not recorded' } };
    expect(ordinaryProviderRuntimeCompletionSchema.safeParse(unavailable).success).toBe(true);
    for (const field of ['cacheReuse', 'preparation', 'cacheAfter']) {
      expect(ordinaryProviderRuntimeCompletionSchema.safeParse({ ...unavailable, [field]: { status: 'accepted' } }).success).toBe(false);
    }
    expect(ordinaryProviderRuntimeCompletionSchema.safeParse({ ...unavailable, cacheRevision: 'a'.repeat(40) }).success).toBe(false);
  });
});
