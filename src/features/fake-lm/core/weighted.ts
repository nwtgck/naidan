import type { SeededNonCryptoPseudoRandom } from '@/features/fake-lm/core/random';

export type WeightedValue<T> = {
  value: T,
  weight: number,
};

export function pickWeighted<T>({ items, random }: {
  items: readonly WeightedValue<T>[],
  random: SeededNonCryptoPseudoRandom,
}): T {
  if (items.length === 0) {
    throw new Error('Cannot pick from an empty weighted list.');
  }

  const total = items.reduce((sum, item) => sum + item.weight, 0);
  let cursor = random() * total;

  for (const item of items) {
    cursor -= item.weight;
    if (cursor <= 0) {
      return item.value;
    }
  }

  return items[items.length - 1]!.value;
}

export function oneOf<T>({ factories, random }: {
  factories: readonly WeightedValue<() => T>[],
  random: SeededNonCryptoPseudoRandom,
}): T {
  return pickWeighted({ items: factories, random })();
}
