import { readonly, shallowRef } from 'vue';

import type { Strings, StringKey } from '@/strings/catalogs/en';
import { STORAGE_KEY_PREFIX } from '@/models/constants';
import { UiLocaleSchema, type UiLocale } from '@/strings/types';

export type StringBoundaryModule = Partial<Strings>;

export type StringBoundaryLoaders = Readonly<Record<
  UiLocale,
  () => Promise<StringBoundaryModule>
>>;

type StringBoundaryRegistration = {
  boundaryId: string;
  keys: readonly StringKey[];
  loaders: StringBoundaryLoaders;
};

const localeStorageKey = `${STORAGE_KEY_PREFIX}ui_locale`;
const registries: Record<UiLocale, Partial<Strings>> = {
  en: {},
  ja: {},
};
const boundaryRegistrations = new Map<string, StringBoundaryRegistration>();
const boundaryIdsByKey = new Map<StringKey, Set<string>>();
const loadingBoundaries = new Map<string, Promise<void>>();
const usedBoundaryIds = new Set<string>();
const revision = shallowRef(0);
let localeSwitchRequest = 0;

function resolveInitialLocale(): UiLocale {
  if (typeof localStorage !== 'undefined') {
    const saved = UiLocaleSchema.safeParse(localStorage.getItem(localeStorageKey));
    if (saved.success) {
      return saved.data;
    }
  }

  if (typeof navigator !== 'undefined' && navigator.language.toLowerCase().startsWith('ja')) {
    return 'ja';
  }
  return 'en';
}

const currentLocaleState = shallowRef<UiLocale>(resolveInitialLocale());
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
  const existing = loadingBoundaries.get(loadKey);
  if (existing !== undefined) {
    await existing;
    return;
  }

  const registration = boundaryRegistrations.get(boundaryId);
  if (registration === undefined) {
    throw new Error(`Missing Boundary Strings registration for ${boundaryId}.`);
  }

  const promise = registration.loaders[locale]().then((module) => {
    Object.assign(registries[locale], module);
    if (locale === currentLocaleState.value) {
      revision.value += 1;
    }
  }).catch((error: unknown) => {
    loadingBoundaries.delete(loadKey);
    throw error;
  });
  loadingBoundaries.set(loadKey, promise);
  await promise;
}

function resolveBoundaryId({ key }: {
  key: StringKey;
}): string {
  const boundaryIds = boundaryIdsByKey.get(key);
  const boundaryId = boundaryIds?.values().next().value as string | undefined;
  if (boundaryId === undefined) {
    throw new Error(`Boundary Strings key ${String(key)} has not been registered by a loaded module.`);
  }
  return boundaryId;
}

async function ensureKeyLoaded({ key, locale }: {
  key: StringKey;
  locale: UiLocale;
}): Promise<void> {
  if (registries[locale][key] !== undefined) {
    return;
  }

  const boundaryId = resolveBoundaryId({ key });
  usedBoundaryIds.add(boundaryId);
  await ensureBoundaryLoaded({ boundaryId, locale });
}

function getLoadedMessage({ key, locale }: {
  key: StringKey;
  locale: UiLocale;
}): Strings[StringKey] | undefined {
  return registries[locale][key];
}

export function registerStringBoundary({ boundaryId, keys, loaders }: {
  boundaryId: string;
  keys: readonly StringKey[];
  loaders: StringBoundaryLoaders;
}): void {
  const previous = boundaryRegistrations.get(boundaryId);
  if (previous !== undefined) {
    for (const key of previous.keys) {
      const boundaryIds = boundaryIdsByKey.get(key);
      boundaryIds?.delete(boundaryId);
      if (boundaryIds?.size === 0) {
        boundaryIdsByKey.delete(key);
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
}

/**
 * Reads a message synchronously for a reactive render path.
 *
 * A missing locale boundary starts loading and returns an empty string. Callers
 * must therefore use this accessor only where Vue will evaluate the expression
 * again after the boundary registration updates the reactive revision.
 */
export const lazyStrings = new Proxy({}, {
  get(_target, property) {
    if (typeof property !== 'string') {
      return undefined;
    }
    const key = property as StringKey;
    // This Proxy adapter must preserve both zero-argument and one-object message signatures.
    // eslint-disable-next-line local-rules-named-args/require-named-args
    return (...args: readonly unknown[]): string => {
      void revision.value;
      const locale = currentLocaleState.value;
      const message = getLoadedMessage({ key, locale });
      if (message === undefined) {
        void ensureKeyLoaded({ key, locale }).catch((error: unknown) => {
          console.error('[Boundary Strings] Failed to load a message boundary.', error);
        });
        return '';
      }
      return Reflect.apply(message, undefined, args) as string;
    };
  },
}) as Strings;

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

/**
 * Ensures the current-locale boundary is loaded before resolving a message.
 *
 * Use this accessor when a completed string is required immediately, such as
 * for a confirmation, prompt, toast, or another one-shot imperative action.
 */
export const ensureStrings = new Proxy({}, {
  get(_target, property) {
    if (typeof property !== 'string') {
      return undefined;
    }
    const key = property as StringKey;
    // This Proxy adapter must preserve both zero-argument and one-object message signatures.
    // eslint-disable-next-line local-rules-named-args/require-named-args
    return async (...args: readonly unknown[]): Promise<string> => {
      const locale = currentLocaleState.value;
      await ensureKeyLoaded({ key, locale });
      const message = getLoadedMessage({ key, locale });
      if (message === undefined) {
        throw new Error(`Boundary Strings message ${String(key)} was not registered.`);
      }
      return Reflect.apply(message, undefined, args) as string;
    };
  },
}) as EnsureStrings;

export async function setLocale({ locale }: {
  locale: UiLocale;
}): Promise<void> {
  const request = ++localeSwitchRequest;
  await Promise.all([...usedBoundaryIds].map(async (boundaryId) => {
    await ensureBoundaryLoaded({ boundaryId, locale });
  }));
  if (request !== localeSwitchRequest) {
    return;
  }

  currentLocaleState.value = locale;
  revision.value += 1;
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(localeStorageKey, locale);
  }
}

export const TEST_ONLY = {
  boundaryIdsByKey,
  boundaryRegistrations,
  ensureBoundaryLoaded,
  localeStorageKey,
  loadingBoundaries,
  registries,
  reset(): void {
    registries.en = {};
    registries.ja = {};
    boundaryRegistrations.clear();
    boundaryIdsByKey.clear();
    loadingBoundaries.clear();
    usedBoundaryIds.clear();
    localeSwitchRequest = 0;
    currentLocaleState.value = 'en';
    revision.value += 1;
  },
  usedBoundaryIds,
};
