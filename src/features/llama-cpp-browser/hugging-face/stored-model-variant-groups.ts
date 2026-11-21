import { describeStoredModelVariant } from './presentation';

export type StoredModelVariantGroup<Item> =
  | { kind: 'single', key: string, item: Item }
  | { kind: 'variants', key: string, name: string, source: string, variants: readonly { item: Item, label: string | undefined }[] };

export function groupStoredModelVariants<Item>({ items, identity }: {
  items: readonly Item[], identity: ({ item }: { item: Item }) => { id: string, modelId: string | undefined, fallback?: { name: string, source: string } },
}): readonly StoredModelVariantGroup<Item>[] {
  const rows: Array<{ item: Item, id: string, variant: { key: string, name: string, source: string, label: string | undefined } | undefined }> = [];
  const groups = new Map<string, Array<{ item: Item, label: string | undefined }>>();
  for (const item of items) {
    const { id, modelId, fallback } = identity({ item });
    const variant = modelId === undefined ? undefined : describeStoredModelVariant({ modelId }) ?? {
      key: id,
      name: fallback?.name ?? modelId,
      source: fallback?.source ?? '',
      label: undefined,
    };
    rows.push({ item, id, variant });
    if (variant !== undefined) {
      const variants = groups.get(variant.key) ?? [];
      variants.push({ item, label: variant.label });
      groups.set(variant.key, variants);
    }
  }
  const result: StoredModelVariantGroup<Item>[] = [];
  for (const { item, id, variant } of rows) {
    const variants = variant === undefined ? undefined : groups.get(variant.key);
    if (variant === undefined || variants === undefined) {
      result.push({ kind: 'single', key: id, item });
    } else if (variants[0]?.item === item) {
      result.push({ kind: 'variants', key: variant.key, name: variant.name, source: variant.source, variants });
    }
  }
  return result;
}

export const TEST_ONLY = {
};
