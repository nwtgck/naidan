/** Labels depend only on the repository and group path, never on its siblings. */
export function variantLabel({ repository, path }: { repository: string, path: string }): string {
  const parts = path.split('/'); const filename = parts.pop()!;
  let stem = filename.replace(/(?:-\d{5}-of-\d{5})?\.gguf$/i, '');
  const prefix = repository.split('/').at(-1)!.replace(/[-_.]gguf$/i, '');
  if (prefix && stem.toLowerCase().startsWith(`${prefix.toLowerCase()}-`)) stem = stem.slice(prefix.length + 1);
  return [...parts, stem].join('/');
}
export function isProjector({ path }: { path: string }): boolean {
  return (path.split('/').at(-1) ?? '').toLowerCase().includes('mmproj');
}
export function modelGroups<T extends { path: string }>({ files }: { files: T[] }): { models: T[][], projectors: T[] } {
  const projectors: T[] = []; const groups = new Map<string, T[]>();
  for (const file of files) {
    if (isProjector({ path: file.path })) {
      projectors.push(file); continue;
    }
    const split = /^(.*)-\d{5}-of-(\d{5})(\.gguf)$/i.exec(file.path);
    const key = split ? `${split[1]}-of-${split[2]}${split[3]}` : file.path;
    const group = groups.get(key) ?? []; group.push(file); groups.set(key, group);
  }
  const ordered = ({ group }: { group: T[] }): T[] => group.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { models: [...groups.values()].map(group => ordered({ group })), projectors: ordered({ group: projectors }) };
}
export const TEST_ONLY = {
};
