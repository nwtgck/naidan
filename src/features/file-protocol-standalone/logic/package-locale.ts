import { parseUiLocale, type UiLocale } from '@/01-models/ui-locale';
import {
  STANDALONE_PACKAGE_LOCALE_META_NAME,
  STANDALONE_PACKAGE_LOCALE_WORKER_GLOBAL_NAME,
} from './package-locale-contract';

export {
  STANDALONE_PACKAGE_LOCALE_META_NAME,
  STANDALONE_PACKAGE_LOCALE_WORKER_GLOBAL_NAME,
} from './package-locale-contract';

function parsePackageLocale({ value }: {
  value: string | null;
}): UiLocale {
  if (value !== null) {
    const locale = parseUiLocale({ value });
    if (locale !== undefined) return locale;
  }
  throw new Error(`Unsupported standalone package locale: ${String(value)}`);
}

function resolveStandalonePackageLocaleFromDocument({ documentValue }: {
  documentValue: Document | undefined;
}): UiLocale | undefined {
  if (documentValue === undefined) return undefined;

  const metas = documentValue.querySelectorAll(`meta[name=${JSON.stringify(STANDALONE_PACKAGE_LOCALE_META_NAME)}]`);
  if (metas.length === 0) return undefined;
  if (metas.length !== 1) {
    throw new Error(`Expected at most one standalone package locale metadata element, found ${metas.length}`);
  }
  return parsePackageLocale({ value: metas[0]?.getAttribute('content') ?? null });
}

function resolveStandalonePackageLocaleFromWorkerGlobal({ value }: {
  value: unknown;
}): UiLocale | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new Error(`Unsupported standalone package locale: ${String(value)}`);
  }
  return parsePackageLocale({ value });
}

export function resolveStandalonePackageLocale(): UiLocale | undefined {
  const documentLocale = resolveStandalonePackageLocaleFromDocument({
    documentValue: typeof document === 'undefined' ? undefined : document,
  });
  if (documentLocale !== undefined) return documentLocale;

  return resolveStandalonePackageLocaleFromWorkerGlobal({
    value: Reflect.get(globalThis, STANDALONE_PACKAGE_LOCALE_WORKER_GLOBAL_NAME) as unknown,
  });
}

export const TEST_ONLY = {
  resolveStandalonePackageLocaleFromDocument,
  resolveStandalonePackageLocaleFromWorkerGlobal,
};
