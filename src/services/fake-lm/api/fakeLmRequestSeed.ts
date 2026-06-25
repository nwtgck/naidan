import type { FakeLmThinkingEffort } from '@/services/fake-lm/core/thinking';
import type { FakeLmSeed } from '@/services/fake-lm/core/random';

export function createFakeLmSeedFromRequest({ model, messages, thinkingEffort }: {
  model: string,
  messages: readonly unknown[],
  thinkingEffort: FakeLmThinkingEffort,
}): FakeLmSeed {
  return hashToUint32({ value: stableStringify({ value: { model, messages, thinkingEffort } }) });
}

function hashToUint32({ value }: {
  value: string,
}): FakeLmSeed {
  let h = 2166136261;

  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }

  return h >>> 0;
}

function stableStringify({ value }: {
  value: unknown,
}): string {
  if (value === undefined) {
    return 'undefined';
  }

  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? String(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify({ value: item })).join(',')}]`;
  }

  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify({ value: record[key] })}`);

  return `{${entries.join(',')}}`;
}
