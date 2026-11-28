export type Entry<N extends string> = { name: N, path: readonly [...string[], N] };

export function entry<N extends string>({ parent, name }: { parent: readonly string[], name: N }): Entry<N> {
  return { name, path: [...parent, name] as const };
}

export function directory<N extends string, E>({ parent, name, entries }: {
  parent: readonly string[], name: N, entries: ({ path }: { path: readonly string[] }) => E,
}): Entry<N> & E {
  const path = [...parent, name] as const;
  return { name, path, ...entries({ path }) };
}

export function storageShardName({ rawId }: { rawId: string }): string {
  return rawId.slice(-2).toLowerCase();
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
export const TEST_ONLY = {
};
