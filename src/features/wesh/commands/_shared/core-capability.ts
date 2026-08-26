export function getOptionalCoreMethod<TMethod>({
  object,
  name,
}: {
  object: object;
  name: PropertyKey;
}): TMethod | undefined {
  const value = (object as Record<PropertyKey, unknown>)[name];
  return typeof value === 'function'
    ? value.bind(object) as unknown as TMethod
    : undefined;
}

export const DEFAULT_FILE_CREATION_MASK = 0o022;

export function getCoreUmaskOrDefault({
  context,
}: {
  context: object;
}): number {
  const getUmask = getOptionalCoreMethod<() => number>({
    object: context,
    name: 'getUmask',
  });
  return getUmask?.() ?? DEFAULT_FILE_CREATION_MASK;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
