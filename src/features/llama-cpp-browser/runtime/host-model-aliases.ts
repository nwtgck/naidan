import { idToRaw, type HostModelDirectoryId } from '@/01-models/ids';
import { LlamaCppBrowserError } from '@/features/llama-cpp-browser/types';
import { parsePublicHostModelReference } from './model-destination-types';
import { modelVariantName } from '@/01-models/llama-cpp-browser-model-id';

type Directories = readonly { id: HostModelDirectoryId, name: string }[];

/** Public names follow registration order, including currently unreadable roots.
 * Reserve literal names before suffixing, and IDs so saved legacy references
 * cannot become names for a different currently registered directory.
 * These are names, not persisted identities: registration edits recompute them.
 */
export function hostModelDirectoryAliases({ directories }: { directories: Directories }): Map<string, string> {
  const names = directories.map(directory => directory.name || 'Folder');
  const ids = new Set(directories.map(directory => idToRaw({ id: directory.id })));
  const reserved = new Set([...names, ...ids]);
  const used = new Set<string>();
  const aliases = new Map<string, string>();
  for (const [index, directory] of directories.entries()) {
    const base = names[index]!;
    let alias = base;
    let suffix = 2;
    if (used.has(alias) || ids.has(alias)) {
      do {
        alias = `${base}-${suffix++}`;
      } while (reserved.has(alias) || used.has(alias));
    }
    aliases.set(idToRaw({ id: directory.id }), alias);
    used.add(alias);
  }
  return aliases;
}

export function formatHostModelId({ directoryId, repository, primaryRelativePath, directories }: { directoryId: string, repository: string, primaryRelativePath: string, directories: Directories }): string {
  const alias = hostModelDirectoryAliases({ directories }).get(directoryId);
  if (alias === undefined) {
    throw new LlamaCppBrowserError({ code: 'missing-model' });
  }
  return `host/${encodeURIComponent(alias)}/${repository}:${modelVariantName({ repository, path: primaryRelativePath })}`;
}

/** Resolve only the current public alias. Storage locations remain structured. */
export function resolveHostModelLocation({ modelId, directories }: { modelId: string, directories: Directories }): { directoryId: string, repository: string } {
  try {
    const { alias, repository, selector } = parsePublicHostModelReference({ modelId });
    const directoryId = [...hostModelDirectoryAliases({ directories })].find(([, value]) => value === alias)?.[0];
    if (directoryId === undefined || selector === undefined) {
      throw new LlamaCppBrowserError({ code: 'missing-model' });
    }
    return { directoryId, repository };
  } catch {
    throw new LlamaCppBrowserError({ code: 'missing-model' });
  }
}

export const TEST_ONLY = {
};
