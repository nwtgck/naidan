import { trySplitRepositoryModelId } from '@/01-models/llama-cpp-browser-model-id';
import { quantizationName } from './presentation';

export type StoredModelVariantGroup<Item> =
  | { kind: 'single', key: string, item: Item }
  | { kind: 'variants', key: string, name: string, source: string, variants: readonly { item: Item, label: string }[] };

function variantIdentity({ modelId }: { modelId: string | undefined }): { key: string, name: string, source: string, label: string } | undefined {
  const baseId = modelId === undefined ? undefined : trySplitRepositoryModelId({ modelId })?.baseId;
  const match = baseId?.match(/^((?:hf\.co|host\/[^/]+)\/[^/:]+)\/([^/:]+):([^:]+)$/);
  if (match === undefined || match === null) {
    return undefined;
  }
  const [, source, repository, variant] = match;
  if (source === undefined || repository === undefined || variant === undefined) {
    return undefined;
  }
  const quantization = quantizationName({ path: variant });
  if (quantization === undefined || !variant.toUpperCase().endsWith(quantization)) {
    return undefined;
  }
  const prefix = variant.slice(0, -quantization.length);
  if (prefix && !/[-_.]$/.test(prefix)) {
    return undefined;
  }
  const variantName = prefix.slice(0, -1);
  const name = repository + (variantName ? ` · ${variantName}` : '');
  return { key: `${source}/${repository}:${prefix}`, name, source, label: quantization };
}

export function groupStoredModelVariants<Item>({ items, identity }: {
  items: readonly Item[], identity: ({ item }: { item: Item }) => { id: string, modelId: string | undefined },
}): readonly StoredModelVariantGroup<Item>[] {
  const rows: Array<{ item: Item, id: string, variant: ReturnType<typeof variantIdentity> }> = [];
  const groups = new Map<string, Array<{ item: Item, label: string }>>();
  for (const item of items) {
    const { id, modelId } = identity({ item });
    const variant = variantIdentity({ modelId });
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
    if (variant === undefined || variants === undefined || variants.length < 2) {
      result.push({ kind: 'single', key: id, item });
    } else if (variants[0]?.item === item) {
      result.push({ kind: 'variants', key: variant.key, name: variant.name, source: variant.source, variants });
    }
  }
  return result;
}

export const TEST_ONLY = {
};
