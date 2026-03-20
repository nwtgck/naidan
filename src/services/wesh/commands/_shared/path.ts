export function stripTrailingSlashes({
  path,
}: {
  path: string;
}): string {
  if (path.length === 0) {
    return '';
  }

  if (/^\/+$/.test(path)) {
    return '/';
  }

  let end = path.length;
  while (end > 1 && path[end - 1] === '/') {
    end -= 1;
  }

  return path.slice(0, end);
}

export function dirnamePath({
  path,
}: {
  path: string;
}): string {
  const normalized = stripTrailingSlashes({ path });
  if (normalized.length === 0) {
    return '.';
  }

  if (normalized === '/') {
    return '/';
  }

  const lastSlash = normalized.lastIndexOf('/');
  if (lastSlash < 0) {
    return '.';
  }

  const parent = stripTrailingSlashes({
    path: normalized.slice(0, lastSlash),
  });

  return parent.length === 0 ? '/' : parent;
}

export function basenamePath({
  path,
  suffix,
}: {
  path: string;
  suffix: string | undefined;
}): string {
  if (path.length === 0) {
    return '';
  }

  const normalized = stripTrailingSlashes({ path });
  if (normalized.length === 0) {
    return '';
  }

  if (normalized === '/') {
    return '/';
  }

  const lastSlash = normalized.lastIndexOf('/');
  let name = lastSlash < 0 ? normalized : normalized.slice(lastSlash + 1);
  if (suffix !== undefined && suffix.length > 0 && name.endsWith(suffix)) {
    name = name.slice(0, name.length - suffix.length);
  }

  return name;
}
