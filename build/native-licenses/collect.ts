import type { NaidanLicense } from '../../src/01-models/naidan-license';
import type { NativeLicenseIndex } from './index-types';

import type { NativeLicenseSource, NativeLicenseRuntime } from '../../src/01-models/native-license-build-source';
export type { NativeLicenseSource } from '../../src/01-models/native-license-build-source';

function assertRelativePath({ value }: { value: string }): void {
  if (!value || (/[\\:]/u.test(value) || [...value].some(character => character.charCodeAt(0) < 32)) || value.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error(`Unsafe native notice path: ${JSON.stringify(value)}`);
  }
}

function runtimeLabel({ runtime }: { runtime: NativeLicenseRuntime }): string {
  switch (runtime) {
  case 'llama-cpp': return 'llama.cpp';
  case 'stable-diffusion-cpp': return 'stable-diffusion.cpp';
  default: {
    const exhaustive: never = runtime;
    throw new Error(`Unknown native runtime: ${exhaustive}`);
  }
  }
}

export function collectNativeLicenseDependencies({ source, index, watchFile }: {
  source: NativeLicenseSource;
  index: NativeLicenseIndex;
  watchFile: (filePath: string) => void;
}): readonly NaidanLicense[] {
  if (index.components.length === 0) {
    throw new Error('Native license index has no components');
  }
  const ids = new Set<string>();
  const originals = new Set<string>();
  const noticePaths = new Set<string>();
  const texts = new Map<string, string>();
  const readNotice = ({ relative }: { relative: string }): string => {
    assertRelativePath({ value: relative });
    if (!source.files.has(relative)) {
      throw new Error(`Native notice is not in the artifact manifest: ${relative}`);
    }
    const cached = texts.get(relative);
    if (cached !== undefined) {
      return cached;
    }
    const file = source.readArtifact({ relative });
    watchFile(file.filePath);
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(file.data);
    if (!text.trim()) {
      throw new Error(`Empty native notice: ${relative}`);
    }
    texts.set(relative, text);
    return text;
  };
  const result = index.components.map(component => {
    const { id, name, version, license, notices, ...unhandledComponent } = component;
    unhandledComponent satisfies Record<PropertyKey, never>;
    if (!id.trim() || id.includes('\0') || !name.trim() || notices.length === 0) {
      throw new Error('Incomplete native license component');
    }
    if (ids.has(id)) {
      throw new Error(`Duplicate native license component: ${id}`);
    }
    ids.add(id);
    const body = notices.map(notice => {
      const { path: noticePath, sourcePath, ...unhandledNotice } = notice;
      unhandledNotice satisfies Record<PropertyKey, never>;
      if (noticePaths.has(noticePath)) {
        throw new Error(`Duplicate native notice output: ${noticePath}`);
      }
      noticePaths.add(noticePath);
      const original = sourcePath ?? noticePath;
      if (originals.has(original)) {
        throw new Error(`Duplicate native notice ownership: ${original}`);
      }
      originals.add(original);
      if (sourcePath !== undefined) {
        readNotice({ relative: sourcePath });
      }
      return `===== ${noticePath} =====\n${readNotice({ relative: noticePath })}`;
    }).join('\n\n');
    return {
      id: `native:${source.runtime}:${id}`,
      origin: runtimeLabel({ runtime: source.runtime }),
      name: name,
      version: version,
      license: license,
      licenseText: body,
    };
  });
  // No fixed count or software list. Cover originals AND generated notices;
  // their ownership/layout is supplied by bicore, never inferred here.
  for (const relative of source.files) {
    if ((relative === 'LICENSE' || relative.startsWith('licenses/')) && !texts.has(relative)) {
      throw new Error(`Unindexed native notice: ${relative}`);
    }
  }
  return result;
}

export const TEST_ONLY = {
  assertRelativePath,
};
