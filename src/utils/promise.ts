type PromiseAllKeyedInput<TPromises extends object> =
  TPromises extends readonly unknown[]
    ? never
    : TPromises extends CallableFunction
      ? never
      : TPromises;

type PromiseAllKeyedResult<TPromises extends object> = {
  -readonly [Key in keyof TPromises]: Awaited<TPromises[Key]>;
};

/**
 * Resolves own enumerable properties in parallel while preserving their keys.
 *
 * The positional argument intentionally mirrors the proposed Promise.allKeyed
 * API so call sites can migrate mechanically if it becomes standard.
 */
export function promiseAllKeyed<const TPromises extends object>(
  promises: PromiseAllKeyedInput<TPromises>,
): Promise<PromiseAllKeyedResult<TPromises>> {
  const keys: PropertyKey[] = [];
  const pendingPromises: Promise<unknown>[] = [];

  try {
    for (const key of Reflect.ownKeys(promises)) {
      const descriptor = Reflect.getOwnPropertyDescriptor(promises, key);
      if (descriptor?.enumerable !== true) continue;

      keys.push(key);
      pendingPromises.push(Promise.resolve(Reflect.get(promises, key)));
    }
  } catch (error) {
    if (pendingPromises.length > 0) {
      void Promise.all(pendingPromises).catch(() => undefined);
    }

    return Promise.reject(error);
  }

  if (keys.length === 0) {
    return Promise.resolve(Object.create(null) as PromiseAllKeyedResult<TPromises>);
  }

  return Promise.all(pendingPromises).then((resolvedValues) => {
    const result = Object.create(null) as Record<PropertyKey, unknown>;

    for (let index = 0; index < keys.length; index++) {
      result[keys[index]!] = resolvedValues[index];
    }

    return result as PromiseAllKeyedResult<TPromises>;
  });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
