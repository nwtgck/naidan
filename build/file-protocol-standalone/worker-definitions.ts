import type { NaidanStandaloneWorkerDefinition } from './plugin.js';

export const FILE_PROTOCOL_STANDALONE_WORKERS = [
  { name: 'image-history-worker', entry: 'src/features/image-generation/history/worker/entry.ts', virtualId: 'virtual:file-protocol-standalone/worker/image-history', defaultWorkerName: 'naidan-image-history' },
  { name: 'image-generation-query-worker', entry: 'src/features/image-generation/session/query-worker/entry.ts', virtualId: 'virtual:file-protocol-standalone/worker/image-generation-query', defaultWorkerName: 'naidan-image-generation-query' },
  {
    name: 'llama-cpp-browser-worker',
    entry: 'src/features/llama-cpp-browser/worker/entry.ts',
    virtualId: 'virtual:file-protocol-standalone/worker/llama-cpp-browser',
    defaultWorkerName: 'naidan-llama-cpp-browser',
  },
  {
    name: 'llama-cpp-browser-download-worker',
    entry: 'src/features/llama-cpp-browser/hugging-face/writer-entry.ts',
    virtualId: 'virtual:file-protocol-standalone/worker/llama-cpp-browser-download',
    defaultWorkerName: 'naidan-llama-cpp-browser-download',
  },

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
] as const satisfies readonly NaidanStandaloneWorkerDefinition[];

export function createFileProtocolStandaloneWorkerDefinitions({ resolvePath }: {
  resolvePath: (relativePath: string) => string;
}) {
  return FILE_PROTOCOL_STANDALONE_WORKERS.map(worker => ({
    ...worker,
    entry: resolvePath(worker.entry),
  }));
}
