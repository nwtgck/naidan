import path from 'node:path';

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
  const normalizedModuleId = normalizeModuleId({ moduleId });
  const marker = '/src/strings/messages/';
  const markerIndex = normalizedModuleId.lastIndexOf(marker);
  if (markerIndex < 0) {
    return undefined;
  }

  const relativePath = normalizedModuleId.slice(markerIndex + marker.length);
  const segments = relativePath.split('/');
  if (segments.length !== 2) {
    return undefined;
  }
  const [key, fileName] = segments;
  if (key === undefined || key.length === 0 || (fileName !== 'en.ts' && fileName !== 'ja.ts')) {
    return undefined;
  }
  return key;
}
