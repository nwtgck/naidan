import { parseGgufSplitPath } from '@/utils/gguf-file-paths';
export { variantLabel, modelVariantName } from '@/01-models/llama-cpp-browser-model-id';

export function isProjector({ path }: { path: string }): boolean {
  return (path.split('/').at(-1) ?? '').toLowerCase().includes('mmproj');
}

export function modelGroups<T extends { relativePath: string }>({ files }: { files: T[] }): { models: T[][], projectors: T[] } {
  const projectors: T[] = [];
  const groups = new Map<string, T[]>();
  for (const file of files) {
    if (isProjector({ path: file.relativePath })) {
      projectors.push(file);
      continue;
    }
    const split = parseGgufSplitPath({ relativePath: file.relativePath });
    const key = split ? `split:${split.stem}-of-${String(split.count).padStart(5, '0')}${split.extension}` : `file:${file.relativePath}`;
    const group = groups.get(key) ?? [];
    group.push(file);
    groups.set(key, group);
  }
  const ordered = ({ group }: { group: T[] }): T[] => group.sort((a, b) => a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0);
  return { models: [...groups.values()].map(group => ordered({ group })), projectors: ordered({ group: projectors }) };
}

export const TEST_ONLY = {
};
