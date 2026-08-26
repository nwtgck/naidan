export type GitRepositoryPathSource = 'index' | 'tree' | 'worktree';


const gitPathDecoder = new TextDecoder('utf-8', { fatal: true });

function bytesEqualAscii({ bytes, start, end, value }: {
  bytes: Uint8Array,
  start: number,
  end: number,
  value: string,
}): boolean {
  if (end - start !== value.length) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (bytes[start + index] !== value.charCodeAt(index)) return false;
  }
  return true;
}

export function assertSafeGitRepositoryPathBytes({ bytes, source }: {
  bytes: Uint8Array,
  source: 'index' | 'tree',
}): void {
  if (bytes.byteLength === 0 || bytes[0] === 0x2f || bytes.includes(0)) {
    throw new Error(`invalid ${source} pathname bytes`);
  }
  let segmentStart = 0;
  for (let offset = 0; offset <= bytes.byteLength; offset += 1) {
    if (offset < bytes.byteLength && bytes[offset] !== 0x2f) continue;
    if (offset === segmentStart
      || bytesEqualAscii({ bytes, start: segmentStart, end: offset, value: '.' })
      || bytesEqualAscii({ bytes, start: segmentStart, end: offset, value: '..' })
      || bytesEqualAscii({ bytes, start: segmentStart, end: offset, value: '.git' })) {
      throw new Error(`invalid ${source} pathname bytes`);
    }
    segmentStart = offset + 1;
  }
}

export function decodeGitPathBytes({ bytes, source }: {
  bytes: Uint8Array,
  source: 'index' | 'tree',
}): string {
  try {
    return gitPathDecoder.decode(bytes);
  } catch {
    // TODO: Real Git preserves non-UTF-8 pathname bytes and exposes them through -z output.
    // Wesh command paths are strings, so lossless materialization needs filesystem-layer pathname support.
    throw new Error(`non-UTF-8 ${source} pathname is not supported yet`);
  }
}

export function assertSafeGitRepositoryPath({ path, source }: {
  path: string,
  source: GitRepositoryPathSource,
}): void {
  if (path.length === 0 || path.startsWith('/')) {
    throw new Error(`invalid ${source} path '${path}'`);
  }
  const segments = path.split('/');
  for (const segment of segments) {
    if (segment.length === 0 || segment === '.' || segment === '..' || segment === '.git') {
      throw new Error(`invalid ${source} path '${path}'`);
    }
  }

  // TODO: Real Git treats `.wesh-system` as an ordinary tracked pathname, so this Git validator must not reserve it.
  // Wesh-internal metadata with that name should instead be hidden or protected by the filesystem/VFS layer.
}

export function assertSafeGitTreeEntryName({ name }: { name: string }): void {
  if (name.length === 0 || name.includes('/') || name === '.' || name === '..' || name === '.git') {
    throw new Error(`invalid tree entry name '${name}'`);
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
