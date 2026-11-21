import path from 'node:path';

import { UI_LOCALES, type UiLocale } from '../../src/01-models/ui-locale.ts';

const localesByModuleFileName = new Map<string, UiLocale>(UI_LOCALES.map((locale) => [`${locale}.ts`, locale]));

const supportedSourceExtensions = new Set([
  '.cjs',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.mts',
  '.ts',
  '.tsx',
  '.vue',
]);

export function stripModuleQuery({ moduleId }: {
  moduleId: string;
}): string {
  const queryIndex = moduleId.indexOf('?');
  return queryIndex < 0 ? moduleId : moduleId.slice(0, queryIndex);
}

export function normalizeModuleId({ moduleId }: {
  moduleId: string;
}): string {
  return stripModuleQuery({ moduleId }).replaceAll('\\', '/');
}

export function isSupportedSourceModuleId({ moduleId }: {
  moduleId: string;
}): boolean {
  return supportedSourceExtensions.has(path.extname(stripModuleQuery({ moduleId })));
}

export function messageKeyFromLocaleModuleId({ moduleId }: {
  moduleId: string;
}): string | undefined {
  return parseLocaleMessageModuleId({ moduleId, messagesDirectoryPath: undefined })?.key;
}

export function parseLocaleMessageModuleId({ moduleId, messagesDirectoryPath }: {
  moduleId: string;
  messagesDirectoryPath: string | undefined;
}): { key: string; locale: UiLocale } | undefined {
  const normalizedModuleId = normalizeModuleId({ moduleId });
  const marker = messagesDirectoryPath === undefined ? '/src/strings/messages/'
    : `${messagesDirectoryPath.replaceAll('\\', '/')}/`;
  const markerIndex = messagesDirectoryPath === undefined ? normalizedModuleId.lastIndexOf(marker)
    : normalizedModuleId.startsWith(marker) ? 0 : -1;
  if (markerIndex < 0) {
    return undefined;
  }

  const relativePath = normalizedModuleId.slice(markerIndex + marker.length);
  const segments = relativePath.split('/');
  if (segments.length !== 2) {
    return undefined;
  }
  const [key, fileName] = segments;
  const locale = fileName === undefined ? undefined : localesByModuleFileName.get(fileName);
  if (key === undefined || key.length === 0 || locale === undefined) {
    return undefined;
  }
  return { key, locale };
}
