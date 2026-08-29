export interface GitExactRenameCandidate {
  path: string,
  objectId: string,
  mode: number,
}

export interface GitExactRenameMatch {
  sourcePath: string,
  destinationPath: string,
  objectId: string,
  sourceMode: number,
  destinationMode: number,
}

export function exactRenameContentIdentity({ objectId, mode }: { objectId: string, mode: number }): string {
  return `${mode & 0o170000}:${objectId}`;
}

export function findExactRenames({ deleted, added }: {
  deleted: readonly GitExactRenameCandidate[],
  added: readonly GitExactRenameCandidate[],
}): GitExactRenameMatch[] {
  const groups = new Map<string, { deleted: GitExactRenameCandidate[], added: GitExactRenameCandidate[] }>();
  for (const candidate of deleted) {
    const key = exactRenameContentIdentity({ objectId: candidate.objectId, mode: candidate.mode });
    const group = groups.get(key) ?? { deleted: [], added: [] };
    group.deleted.push(candidate);
    groups.set(key, group);
  }
  for (const candidate of added) {
    const key = exactRenameContentIdentity({ objectId: candidate.objectId, mode: candidate.mode });
    const group = groups.get(key) ?? { deleted: [], added: [] };
    group.added.push(candidate);
    groups.set(key, group);
  }

  const matches: GitExactRenameMatch[] = [];
  for (const group of groups.values()) {
    if (group.deleted.length !== 1 || group.added.length !== 1) continue;
    const source = group.deleted[0]!;
    const destination = group.added[0]!;
    matches.push({
      sourcePath: source.path,
      destinationPath: destination.path,
      objectId: source.objectId,
      sourceMode: source.mode,
      destinationMode: destination.mode,
    });
  }
  return matches;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
