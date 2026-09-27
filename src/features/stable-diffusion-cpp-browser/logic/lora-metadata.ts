import type { TensorInfo } from './model-metadata';

/** Header evidence for the adapter formats understood by sd.cpp's name_conversion
 * and LoraModel. This identifies a file's role, not base-model compatibility or
 * successful application. Native loading still owns name/shape validation. */
export function hasLoraTensors({ tensors }: { tensors: readonly TensorInfo[] }): boolean {
  const groups = new Map<string, Set<string>>();
  for (const { name, shape } of tensors) {
    if (shape.length < 1) continue;
    // Full weight/bias deltas are also accepted by the native adapter loader.
    if (/^.+\.(diff|diff_b)$/.test(name)) return true;
    if (shape.length < 2) continue;
    const pair = /^(.*?)(?:\.lora_(down|up)\.weight|\.weight\.lora_(down|up)|[._]lora\.(down|up)\.weight|\.lora_(A|B)(?:\.default\.weight|\.weight)?)$/.exec(name);
    const factor = /^(.*?)\.(hada_w[12]_[ab]|lokr_w[12](?:_[ab])?)$/.exec(name);
    const stem = pair?.[1] ?? factor?.[1];
    if (!stem) continue;
    const side = pair?.[2] ?? pair?.[3] ?? pair?.[4] ?? pair?.[5];
    const key = side === 'A' ? 'down' : side === 'B' ? 'up' : side ?? factor?.[2];
    if (!key) continue;
    const factors = groups.get(stem) ?? new Set<string>();
    factors.add(key); groups.set(stem, factors);
  }
  for (const factors of groups.values()) {
    if (factors.has('down') && factors.has('up')) return true;
    if (['hada_w1_a', 'hada_w1_b', 'hada_w2_a', 'hada_w2_b'].every(key => factors.has(key))) return true;
    if (['1', '2'].every(side => factors.has(`lokr_w${side}`) || factors.has(`lokr_w${side}_a`) && factors.has(`lokr_w${side}_b`))) return true;
  }
  return false;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
