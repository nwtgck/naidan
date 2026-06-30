import { readonly, shallowReactive, shallowRef } from 'vue';

import type { Strings, StringKey } from '@/strings/catalogs/en';
import type { UiLocale } from '@/strings/types';

export type StringBoundaryModule = Partial<Strings> & Partial<Record<string, Strings[StringKey]>>;

export type StringBoundaryLoaders = Readonly<Record<
  UiLocale,
  () => Promise<StringBoundaryModule>
>>;

type StringBoundaryRegistration = {
  boundaryId: string;
  keys: readonly string[];
  loaders: StringBoundaryLoaders;
};

const registries = {
  en: shallowReactive<StringBoundaryModule>({}),
  ja: shallowReactive<StringBoundaryModule>({}),
} satisfies Record<UiLocale, StringBoundaryModule>;
const boundaryRegistrations = new Map<string, StringBoundaryRegistration>();
const boundaryIdsByKey = new Map<string, Set<string>>();
const loadedBoundaryModules: Record<UiLocale, Map<string, StringBoundaryModule>> = {
  en: new Map(),
  ja: new Map(),
};
const loadingBoundaries = new Map<string, Promise<void>>();
const usedBoundaryIds = new Set<string>();
const warmedBoundaryIds = new Set<string>();
const scheduledBoundaryWarmups = new Map<string, () => void>();
const nonMessageAccessorProperties = new Set([
  '_isVue',
  'then',
  'toJSON',
]);
/* eslint-disable local-rules-named-args/require-named-args -- Proxy adapters preserve each message's zero-argument or one-object call signature. */
type LazyStringAccessor = (...args: readonly unknown[]) => string | undefined;
type EnsureStringAccessor = (...args: readonly unknown[]) => Promise<string>;
/* eslint-enable local-rules-named-args/require-named-args */

const lazyStringAccessorCache = new Map<string, LazyStringAccessor>();
const ensureStringAccessorCache = new Map<string, EnsureStringAccessor>();
let localeSwitchRequest = 0;

export function resolveBrowserLocale(): UiLocale {
  const browserLocale = typeof navigator === 'undefined' ? undefined : navigator.language;
  if (browserLocale?.toLowerCase().startsWith('ja') === true) {
    return 'ja';
  }
  return 'en';
}

function applyDocumentLocale({ locale }: {
  locale: UiLocale;
}): void {
  if (typeof document !== 'undefined') {
    document.documentElement.lang = locale;
  }
}

const initialLocale = resolveBrowserLocale();
const currentLocaleState = shallowRef<UiLocale>(initialLocale);
applyDocumentLocale({ locale: initialLocale });
export const currentLocale = readonly(currentLocaleState);

function boundaryLoadKey({ boundaryId, locale }: {
  boundaryId: string;
  locale: UiLocale;
}): string {
  return `${locale}:${boundaryId}`;
}

async function ensureBoundaryLoaded({ boundaryId, locale }: {
  boundaryId: string;
  locale: UiLocale;
}): Promise<void> {
  const loadKey = boundaryLoadKey({ boundaryId, locale });

  while (!loadedBoundaryModules[locale].has(boundaryId)) {
    const existing = loadingBoundaries.get(loadKey);
    if (existing !== undefined) {
      await existing;
      continue;
    }

    const registration = boundaryRegistrations.get(boundaryId);
    if (registration === undefined) {
      throw new Error(`Missing Boundary Strings registration for ${boundaryId}.`);
    }

    const promise = (async () => {
      const module = await registration.loaders[locale]();
      if (boundaryRegistrations.get(boundaryId) !== registration) {
        return;
      }

      const loadedMessages: StringBoundaryModule = {};
      for (const key of registration.keys) {
        const message = module[key];
        if (typeof message !== 'function') {
          throw new Error(
            `Boundary Strings boundary ${boundaryId} did not provide message ${key} for locale ${locale}.`,
          );
        }
        loadedMessages[key] = message;
      }
      loadedBoundaryModules[locale].set(boundaryId, loadedMessages);
      Object.assign(registries[locale], loadedMessages);
    })();
    loadingBoundaries.set(loadKey, promise);
    try {
      await promise;
    } finally {
      if (loadingBoundaries.get(loadKey) === promise) {
        loadingBoundaries.delete(loadKey);
      }
    }
  }
}

function resolveBoundaryId({ key, locale }: {
  key: string;
  locale: UiLocale;
}): string {
  const boundaryIds = boundaryIdsByKey.get(key);
  if (boundaryIds === undefined || boundaryIds.size === 0) {
    throw new Error(`Boundary Strings key ${String(key)} has not been registered by a loaded module.`);
  }

  const candidates = [...boundaryIds].map((boundaryId) => {
    const registration = boundaryRegistrations.get(boundaryId);
    if (registration === undefined) {
      throw new Error(`Missing Boundary Strings registration for ${boundaryId}.`);
    }
    return {
      boundaryId,
      isLoadedOrLoading: loadedBoundaryModules[locale].has(boundaryId)
        || loadingBoundaries.has(boundaryLoadKey({ boundaryId, locale })),
      keyCount: registration.keys.length,
    };
  });
  candidates.sort((left, right) => {
    if (left.isLoadedOrLoading !== right.isLoadedOrLoading) {
      return left.isLoadedOrLoading ? -1 : 1;
    }
    return left.keyCount - right.keyCount || left.boundaryId.localeCompare(right.boundaryId);
  });

  const boundaryId = candidates[0]?.boundaryId;
  if (boundaryId === undefined) {
    throw new Error(`Boundary Strings key ${String(key)} has no usable boundary registration.`);
  }
  return boundaryId;
}

async function ensureKeyLoaded({ key, locale }: {
  key: string;
  locale: UiLocale;
}): Promise<void> {
  if (registries[locale][key] !== undefined) {
    return;
  }

  const boundaryId = resolveBoundaryId({ key, locale });
  usedBoundaryIds.add(boundaryId);
  await ensureBoundaryLoaded({ boundaryId, locale });
}

function getLoadedMessage({ key, locale }: {
  key: string;
  locale: UiLocale;
}): Strings[StringKey] | undefined {
  return registries[locale][key];
}

function scheduleBoundaryWarmup({ boundaryId }: {
  boundaryId: string;
}): void {
  if (scheduledBoundaryWarmups.has(boundaryId)) {
    return;
  }

  const registration = boundaryRegistrations.get(boundaryId);
  if (registration === undefined) {
    throw new Error(`Missing Boundary Strings registration for ${boundaryId}.`);
  }

  const run = () => {
    scheduledBoundaryWarmups.delete(boundaryId);
    if (boundaryRegistrations.get(boundaryId) !== registration) {
      return;
    }
    warmedBoundaryIds.add(boundaryId);
    void ensureBoundaryLoaded({
      boundaryId,
      locale: currentLocaleState.value,
    }).catch((error: unknown) => {
      if (boundaryRegistrations.get(boundaryId) !== registration) {
        return;
      }
      warmedBoundaryIds.delete(boundaryId);
      console.error('[Boundary Strings] Failed to warm a message boundary.', error);
    });
  };

  // Registration means the owning JavaScript module is already close to use.
  // Warming during idle time prepares component, composable, and helper text
  // without maintaining a second UI graph or adding preload calls to app code.
  if (typeof globalThis.requestIdleCallback === 'function') {
    const handle = globalThis.requestIdleCallback(run, { timeout: 1000 });
    scheduledBoundaryWarmups.set(boundaryId, () => {
      globalThis.cancelIdleCallback(handle);
    });
    return;
  }

  const handle = globalThis.setTimeout(run, 200);
  scheduledBoundaryWarmups.set(boundaryId, () => {
    globalThis.clearTimeout(handle);
  });
}

function promoteScheduledBoundaryWarmups(): void {
  for (const [boundaryId, cancel] of scheduledBoundaryWarmups) {
    cancel();
    scheduledBoundaryWarmups.delete(boundaryId);
    warmedBoundaryIds.add(boundaryId);
  }
}

function rebuildRegistryMessage({ key, locale }: {
  key: string;
  locale: UiLocale;
}): void {
  const boundaryIds = boundaryIdsByKey.get(key);
  if (boundaryIds !== undefined) {
    for (const boundaryId of boundaryIds) {
      const message = loadedBoundaryModules[locale].get(boundaryId)?.[key];
      if (typeof message === 'function') {
        registries[locale][key] = message;
        return;
      }
    }
  }
  delete registries[locale][key];
}

function clearRegistry({ registry }: {
  registry: StringBoundaryModule;
}): void {
  for (const key of Object.keys(registry)) {
    delete registry[key];
  }
}

function getLazyStringAccessor({ key }: {
  key: string;
}): LazyStringAccessor {
  const cached = lazyStringAccessorCache.get(key);
  if (cached !== undefined) {
    return cached;
  }

  // This Proxy adapter must preserve both zero-argument and one-object message signatures.
  // eslint-disable-next-line local-rules-named-args/require-named-args
  const accessor = (...args: readonly unknown[]): string | undefined => {
    const locale = currentLocaleState.value;
    const message = getLoadedMessage({ key, locale });
    if (message === undefined) {
      void ensureKeyLoaded({ key, locale }).catch((error: unknown) => {
        console.error('[Boundary Strings] Failed to load a message boundary.', error);
      });
      return undefined;
    }
    return Reflect.apply(message, undefined, args) as string;
  };
  lazyStringAccessorCache.set(key, accessor);
  return accessor;
}

export function registerStringBoundary({ boundaryId, keys, loaders }: {
  boundaryId: string;
  keys: readonly string[];
  loaders: StringBoundaryLoaders;
}): void {
  if (keys.length === 0 || new Set(keys).size !== keys.length) {
    throw new Error(
      `Boundary Strings boundary ${boundaryId} must register a non-empty list of unique message keys.`,
    );
  }

  const previous = boundaryRegistrations.get(boundaryId);
  if (previous !== undefined) {
    for (const key of previous.keys) {
      const boundaryIds = boundaryIdsByKey.get(key);
      boundaryIds?.delete(boundaryId);
      if (boundaryIds?.size === 0) {
        boundaryIdsByKey.delete(key);
      }
    }
    scheduledBoundaryWarmups.get(boundaryId)?.();
    scheduledBoundaryWarmups.delete(boundaryId);
    for (const locale of ['en', 'ja'] as const) {
      loadedBoundaryModules[locale].delete(boundaryId);
      loadingBoundaries.delete(boundaryLoadKey({ boundaryId, locale }));
      for (const key of previous.keys) {
        rebuildRegistryMessage({ key, locale });
      }
    }
  }

  boundaryRegistrations.set(boundaryId, {
    boundaryId,
    keys,
    loaders,
  });
  for (const key of keys) {
    const boundaryIds = boundaryIdsByKey.get(key) ?? new Set<string>();
    boundaryIds.add(boundaryId);
    boundaryIdsByKey.set(key, boundaryIds);
  }

  // Naidan already evaluates async child modules while their parent is idle.
  // Scheduling from registration therefore follows real code proximity and
  // reduces empty first renders without handwritten component-specific hints.
  scheduleBoundaryWarmup({ boundaryId });
}

/**
 * Reads a message synchronously for a reactive render path.
 *
 * A missing locale boundary starts loading and returns undefined. Callers
 * must therefore use this accessor only where Vue will evaluate the expression
 * again after the reactive locale registry receives the message implementation.
 */
/* eslint-disable local-rules-named-args/require-named-args -- This type adapter preserves the exact zero-argument or one-object message contract. */
type LazyString<Message> = Message extends () => infer Result
  ? () => Awaited<Result> | undefined
  : Message extends (args: infer Args) => infer Result
    ? (args: Args) => Awaited<Result> | undefined
    : never;
/* eslint-enable local-rules-named-args/require-named-args */

export type LazyStrings = {
  readonly [Key in keyof Strings]: LazyString<Strings[Key]>;
};

export const lazyStrings = new Proxy({}, {
  get(target, property) {
    if (
      typeof property !== 'string'
      || property in target
      || property.startsWith('__v_')
      || nonMessageAccessorProperties.has(property)
    ) {
      return Reflect.get(target, property);
    }
    return getLazyStringAccessor({ key: property });
  },
}) as LazyStrings;

/* eslint-disable local-rules-named-args/require-named-args -- This type adapter preserves the exact zero-argument or one-object message contract. */
type EnsureString<Message> = Message extends () => infer Result
  ? () => Promise<Awaited<Result>>
  : Message extends (args: infer Args) => infer Result
    ? (args: Args) => Promise<Awaited<Result>>
    : never;
/* eslint-enable local-rules-named-args/require-named-args */

export type EnsureStrings = {
  readonly [Key in keyof Strings]: EnsureString<Strings[Key]>;
};

function getEnsureStringAccessor({ key }: {
  key: string;
}): EnsureStringAccessor {
  const cached = ensureStringAccessorCache.get(key);
  if (cached !== undefined) {
    return cached;
  }

  // This Proxy adapter must preserve both zero-argument and one-object message signatures.
  // eslint-disable-next-line local-rules-named-args/require-named-args
  const accessor = async (...args: readonly unknown[]): Promise<string> => {
    const locale = currentLocaleState.value;
    await ensureKeyLoaded({ key, locale });
    const message = getLoadedMessage({ key, locale });
    if (message === undefined) {
      throw new Error(`Boundary Strings message ${String(key)} was not registered.`);
    }
    return Reflect.apply(message, undefined, args) as string;
  };
  ensureStringAccessorCache.set(key, accessor);
  return accessor;
}

/**
 * Ensures the current-locale boundary is loaded before resolving a message.
 *
 * Use this accessor when a completed string is required immediately, such as
 * for a confirmation, prompt, toast, or another one-shot imperative action.
 */
export const ensureStrings = new Proxy({}, {
  get(target, property) {
    if (
      typeof property !== 'string'
      || property in target
      || property.startsWith('__v_')
      || nonMessageAccessorProperties.has(property)
    ) {
      return Reflect.get(target, property);
    }
    return getEnsureStringAccessor({ key: property });
  },
}) as EnsureStrings;

export async function prepareLocale({ locale }: {
  locale: UiLocale;
}): Promise<void> {
  while (true) {
    promoteScheduledBoundaryWarmups();
    const activeBoundaryIds = new Set([
      ...usedBoundaryIds,
      ...warmedBoundaryIds,
    ]);
    await Promise.all([...activeBoundaryIds].map(async (boundaryId) => {
      await ensureBoundaryLoaded({ boundaryId, locale });
    }));

    const hasUnpreparedBoundary = [...usedBoundaryIds, ...warmedBoundaryIds].some((boundaryId) => {
      return !loadedBoundaryModules[locale].has(boundaryId);
    });
    if (!hasUnpreparedBoundary && scheduledBoundaryWarmups.size === 0) {
      return;
    }
  }
}

export async function setLocale({ locale }: {
  locale: UiLocale;
}): Promise<void> {
  const request = ++localeSwitchRequest;
  await prepareLocale({ locale });
  if (request !== localeSwitchRequest) {
    return;
  }

  if (currentLocaleState.value !== locale) {
    currentLocaleState.value = locale;
    applyDocumentLocale({ locale });
  }
}

export const TEST_ONLY = (__BUILD_MODE_IS_TEST__ && {
  boundaryIdsByKey,
  boundaryRegistrations,
  ensureBoundaryLoaded,
  async ensureAllRegisteredBoundariesForTest({ locale }: {
    locale: UiLocale;
  }): Promise<void> {
    await Promise.all([...boundaryRegistrations.keys()].map(async (boundaryId) => {
      await ensureBoundaryLoaded({ boundaryId, locale });
    }));
    currentLocaleState.value = locale;
    applyDocumentLocale({ locale });
  },
  loadedBoundaryModules,
  loadingBoundaries,
  registries,
  resolveBrowserLocale,
  reset(): void {
    clearRegistry({ registry: registries.en });
    clearRegistry({ registry: registries.ja });
    boundaryRegistrations.clear();
    boundaryIdsByKey.clear();
    loadedBoundaryModules.en.clear();
    loadedBoundaryModules.ja.clear();
    loadingBoundaries.clear();
    for (const cancel of scheduledBoundaryWarmups.values()) {
      cancel();
    }
    scheduledBoundaryWarmups.clear();
    usedBoundaryIds.clear();
    warmedBoundaryIds.clear();
    localeSwitchRequest = 0;
    currentLocaleState.value = 'en';
    applyDocumentLocale({ locale: 'en' });
  },
  scheduledBoundaryWarmups,
  usedBoundaryIds,
  warmedBoundaryIds,
}) || undefined;
