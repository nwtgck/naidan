import type { WeshCommandContext } from '@/services/wesh/types';

export function normalizePath({
  cwd,
  path,
}: {
  cwd: string;
  path: string;
}): string {
  const joined = path.startsWith('/')
    ? path
    : cwd === '/'
      ? `/${path}`
      : `${cwd}/${path}`;

  const segments = joined.split('/');
  const normalizedSegments: string[] = [];

  for (const segment of segments) {
    if (segment.length === 0 || segment === '.') {
      continue;
    }
    if (segment === '..') {
      normalizedSegments.pop();
      continue;
    }
    normalizedSegments.push(segment);
  }

  return normalizedSegments.length === 0 ? '/' : `/${normalizedSegments.join('/')}`;
}

export function resolvePath({
  cwd,
  path,
}: {
  cwd: string;
  path: string;
}): string {
  return normalizePath({ cwd, path });
}

export async function canonicalizePathAllowingMissingLeaf({
  context,
  path,
}: {
  context: WeshCommandContext;
  path: string;
}): Promise<string> {
  if (!path.startsWith('/')) {
    return resolvePath({ cwd: context.cwd, path });
  }

  const normalized = path === '/' ? '/' : path.replace(/\/+$/u, '');
  const segments = normalized.split('/').filter((segment) => segment.length > 0);

  for (let prefixLength = segments.length; prefixLength >= 0; prefixLength--) {
    const prefix = prefixLength === 0 ? '/' : `/${segments.slice(0, prefixLength).join('/')}`;
    try {
      const resolved = await context.files.resolve({ path: prefix });
      const remainder = segments.slice(prefixLength).join('/');
      if (remainder.length === 0) {
        return resolved.fullPath;
      }
      return resolved.fullPath === '/' ? `/${remainder}` : `${resolved.fullPath}/${remainder}`;
    } catch {
      continue;
    }
  }

  return path;
}
