import type { Settings } from '@/01-models/types';

type Preferences = NonNullable<NonNullable<NonNullable<Settings['experimental']>['translation']>['autoTranslate']>;
export const automaticTranslationDelay = { minimum: 200, maximum: 3000, step: 100, default: 600 } as const;

/** Persisted numbers describe structure; execution applies the finite UI range. */
export function automaticTranslationSettings({ value }: { value: Preferences | undefined }): { enabled: boolean, debounceMs: number } {
  const { enabled, debounceMs, ...unhandled } = value ?? {};
  unhandled satisfies Record<PropertyKey, never>;
  const delay = automaticTranslationDelay;
  return {
    enabled: enabled !== false,
    debounceMs: debounceMs === undefined || !Number.isFinite(debounceMs)
      ? delay.default
      : Math.max(delay.minimum, Math.min(delay.maximum, Math.round(debounceMs / delay.step) * delay.step)),
  };
}

export const TEST_ONLY = {
};
