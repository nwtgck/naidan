export const STANDALONE_WORKER_CLIENT_FACADES = [
  '@/services/advanced-text-editor-v3/worker/client',
  '@/services/highlight/worker/client',
  '@/services/wesh/worker/client',
  '@/services/global-search/worker/client',
  '@/services/file-explorer/worker/client',
  '@/services/transformers-js/worker/client',
  '@/services/transformers-js/scanner/worker/client',
]

export function createStandaloneWorkerClientAliases({ resolvePath }) {
  return Object.fromEntries(
    STANDALONE_WORKER_CLIENT_FACADES.map((facadePath) => [
      facadePath,
      resolvePath(
        `${facadePath.replace('@/services/', 'src/services/')}-standalone.ts`,
      ),
    ]),
  )
}
