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
  '@/services/privacy-fetch',
]

function escapeRegExp({ value }) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function createExactAliasFind({ facadePath }) {
  return new RegExp(`^${escapeRegExp({ value: facadePath })}$`)
}

function resolveStandaloneFacadePath({ facadePath }) {
  switch (facadePath) {
  case '@/services/transformers-js':
    return 'src/services/transformers-js/index-standalone.ts'
  case '@/services/privacy-fetch':
    return 'src/services/privacy-fetch/index-standalone.ts'
  default:
    return `${facadePath.replace('@/services/', 'src/services/')}-standalone.ts`
  }
}

export function createStandaloneWorkerClientAliases({ resolvePath }) {
  return STANDALONE_WORKER_CLIENT_FACADES.map((facadePath) => ({
    find: createExactAliasFind({ facadePath }),
    replacement: resolvePath(resolveStandaloneFacadePath({ facadePath })),
  }))
}
