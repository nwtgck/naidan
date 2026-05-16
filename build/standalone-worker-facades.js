// TODO: Consider renaming this collection if more non-worker standalone aliases are added.
export const STANDALONE_WORKER_CLIENT_FACADES = [
  '@/services/transformers-js/provider',
  '@/services/transformers-js',
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
      resolvePath(facadePath === '@/services/transformers-js'
        ? 'src/services/transformers-js/index-standalone.ts'
        : `${facadePath.replace('@/services/', 'src/services/')}-standalone.ts`,
      ),
    ]),
  )
}
