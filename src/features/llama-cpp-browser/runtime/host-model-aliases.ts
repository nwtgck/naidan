import { idToRaw, type HostModelDirectoryId } from '@/01-models/ids';
import { LlamaCppBrowserError } from '@/features/llama-cpp-browser/types';
import { hostModelReference, parseHostModelReference, parsePublicHostModelReference } from './model-destination-types';

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

export function hostModelPublicName({ name, directories }: { name: string, directories: Directories }): string {
  if (!name.startsWith('host/')) return name;
  const { destination, repository, modelPath } = parseHostModelReference({ name });
  const alias = hostModelDirectoryAliases({ directories }).get(destination.directoryId);
  if (alias === undefined) throw new LlamaCppBrowserError({ code: 'missing-model' });
  const canonical = hostModelReference({ directoryId: 'root', repository, modelPath });
  return `host/${encodeURIComponent(alias)}/${canonical.slice('host/root/'.length)}`;
}

export function resolveHostModelName({ name, directories }: { name: string, directories: Directories }): string {
  if (!name.startsWith('host/')) return name;
  try {
    const { alias, repository, modelPath } = parsePublicHostModelReference({ name });
    const aliases = hostModelDirectoryAliases({ directories });
    const directoryId = [...aliases].find(([, value]) => value === alias)?.[0]
      ?? (aliases.has(alias) ? alias : undefined);
    if (directoryId === undefined || modelPath === undefined) throw new LlamaCppBrowserError({ code: 'missing-model' });
    return hostModelReference({ directoryId, repository, modelPath });
  } catch {
    // Never guess a root, fall back to OPFS, or resolve an unregistered ID.
    throw new LlamaCppBrowserError({ code: 'missing-model' });
  }
}

export const TEST_ONLY = {
};
