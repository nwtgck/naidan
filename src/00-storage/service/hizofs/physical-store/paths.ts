declare const canonicalContainerPathBrand: unique symbol;
declare const canonicalContainerDirectoryBrand: unique symbol;

export type CanonicalContainerPath = string & { readonly [canonicalContainerPathBrand]: true };
export type CanonicalContainerDirectory = string & { readonly [canonicalContainerDirectoryBrand]: true };

const MAXIMUM_COMPONENT_BYTE_LENGTH = 255;
const UTF8_ENCODER = new TextEncoder();

export const CANONICAL_CONTAINER_ROOT = '' as CanonicalContainerDirectory;

function assertUnicodeScalarSequence({ value }: { value: string }): void {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new TypeError('container path must not contain an unpaired UTF-16 surrogate');
      }
      index += 1;
      continue;
    }
    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new TypeError('container path must not contain an unpaired UTF-16 surrogate');
    }
  }
}

function containsControlCharacter({ value }: { value: string }): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) return true;
  }
  return false;
}

function validateComponents({ allowRoot, value }: { allowRoot: boolean; value: string }): readonly string[] {
  if (value === '') {
    if (allowRoot) return [];
    throw new TypeError('container file path must not be empty');
  }
  if (value.startsWith('/') || value.endsWith('/')) {
    throw new TypeError('container path must be relative and must not have a trailing separator');
  }
  if (value.includes('\\') || containsControlCharacter({ value })) {
    throw new TypeError('container path must not contain backslashes or control characters');
  }
  assertUnicodeScalarSequence({ value });

  const components = value.split('/');
  for (const component of components) {
    if (component === '' || component === '.' || component === '..') {
      throw new TypeError('container path must not contain empty, current, or parent components');
    }
    if (UTF8_ENCODER.encode(component).byteLength > MAXIMUM_COMPONENT_BYTE_LENGTH) {
      throw new RangeError(`container path component must be at most ${MAXIMUM_COMPONENT_BYTE_LENGTH} UTF-8 bytes`);
    }
  }
  return components;
}

export function canonicalContainerPath({ value }: { value: string }): CanonicalContainerPath {
  validateComponents({ allowRoot: false, value });
  return value as CanonicalContainerPath;
}

export function canonicalContainerDirectory({ value }: { value: string }): CanonicalContainerDirectory {
  validateComponents({ allowRoot: true, value });
  return value as CanonicalContainerDirectory;
}

export function parentContainerDirectory({ path }: { path: CanonicalContainerPath }): CanonicalContainerDirectory {
  const separatorIndex = path.lastIndexOf('/');
  return separatorIndex < 0
    ? CANONICAL_CONTAINER_ROOT
    : canonicalContainerDirectory({ value: path.slice(0, separatorIndex) });
}

export function containerEntryName({ path }: {
  path: CanonicalContainerDirectory | CanonicalContainerPath;
}): string {
  if (path === '') throw new TypeError('container root does not have an entry name');
  const separatorIndex = path.lastIndexOf('/');
  return separatorIndex < 0 ? path : path.slice(separatorIndex + 1);
}

export function containerPathSegments({ path }: {
  path: CanonicalContainerDirectory | CanonicalContainerPath;
}): readonly string[] {
  return path === '' ? [] : path.split('/');
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  maximumComponentByteLength: MAXIMUM_COMPONENT_BYTE_LENGTH,
};
