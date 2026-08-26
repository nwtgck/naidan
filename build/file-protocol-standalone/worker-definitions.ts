import type { NaidanStandaloneWorkerDefinition } from './plugin.js';

export const FILE_PROTOCOL_STANDALONE_WORKERS = [
  {
    name: 'advanced-text-editor-v3-worker',
    entry: 'src/features/advanced-text-editor-v3/worker/entry.ts',
    virtualId: 'virtual:file-protocol-standalone/worker/advanced-text-editor-v3',
    defaultWorkerName: 'naidan-advanced-text-editor-v3-worker',
  },
  {
    name: 'highlight-worker',
    entry: 'src/features/highlight/worker/entry.ts',
    virtualId: 'virtual:file-protocol-standalone/worker/highlight',
    defaultWorkerName: 'naidan-highlight-worker',
  },
  {
    name: 'wesh-worker',
    entry: 'src/features/wesh/worker/entry.ts',
    virtualId: 'virtual:file-protocol-standalone/worker/wesh',
    defaultWorkerName: 'file-protocol-compatible-wesh-worker',
  },
  {
    name: 'global-search-worker',
    entry: 'src/features/global-search/worker/entry.ts',
    virtualId: 'virtual:file-protocol-standalone/worker/global-search',
    defaultWorkerName: 'global-search-worker',
  },
  {
    name: 'file-explorer-worker',
    entry: 'src/features/file-explorer/worker/entry.ts',
    virtualId: 'virtual:file-protocol-standalone/worker/file-explorer',
    defaultWorkerName: 'naidan-file-explorer-worker',
  },
  {
    name: 'hizofs-benchmark-worker',
    entry: 'src/features/debug-hizofs/benchmark/worker-entry.ts',
    virtualId: 'virtual:file-protocol-standalone/worker/hizofs-benchmark',
    defaultWorkerName: 'naidan-hizofs-benchmark-worker',
  },
] as const satisfies readonly NaidanStandaloneWorkerDefinition[];

export function createFileProtocolStandaloneWorkerDefinitions({ resolvePath }: {
  resolvePath: (relativePath: string) => string;
}) {
  return FILE_PROTOCOL_STANDALONE_WORKERS.map(worker => ({
    ...worker,
    entry: resolvePath(worker.entry),
  }));
}
