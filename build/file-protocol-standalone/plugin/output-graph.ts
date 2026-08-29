import type { OutputChunk } from 'rolldown';

export function isOutputChunk(output: {readonly type: string}): output is OutputChunk {
  return output.type === 'chunk';
}

export function collectChunkClosure({ chunkByFileName, entryFileNames }: Readonly<{
  chunkByFileName: ReadonlyMap<string, OutputChunk>;
  entryFileNames: readonly string[];
}>): Set<string> {
  const visited = new Set<string>();
  const queue = [...entryFileNames];
  while (queue.length > 0) {
    const fileName = queue.pop();
    if (!fileName || visited.has(fileName)) continue;
    visited.add(fileName);
    const chunk = chunkByFileName.get(fileName);
    if (!chunk) continue;
    for (const dependency of [...chunk.imports, ...chunk.dynamicImports]) {
      if (!visited.has(dependency)) queue.push(dependency);
    }
  }
  return visited;
}
