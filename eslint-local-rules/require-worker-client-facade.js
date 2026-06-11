import path from 'path'
import { STANDALONE_WORKER_CLIENT_FACADES } from '../build/standalone-facades.js'

function normalizePath(filePath) {
  return filePath.replace(/\\/g, '/')
}

const standaloneWorkerClientFacadeSet = new Set(STANDALONE_WORKER_CLIENT_FACADES)

function getFacadePathFromSource({
  filePath,
  source,
}) {
  const aliasMatch = source.match(/^@\/services\/(.+)\/worker\/client-(hosted|standalone)$/)
  if (aliasMatch) {
    return `@/services/${aliasMatch[1]}/worker/client`
  }

  if (source.startsWith('.')) {
    const resolved = normalizePath(path.resolve(path.dirname(filePath), source))
    const resolvedMatch = resolved.match(/\/src\/services\/(.+)\/worker\/client(?:-(?:hosted|standalone))?$/)
    if (resolvedMatch) {
      return `@/services/${resolvedMatch[1]}/worker/client`
    }
  }

  return undefined
}

function isStandaloneWorkerFacade({ facadePath }) {
  return facadePath !== undefined && standaloneWorkerClientFacadeSet.has(facadePath)
}

function isWorkerFacadeFile({ filePath }) {
  return /\/src\/services\/.+\/worker\/client\.ts$/.test(filePath)
}

function isTestFile({ filePath }) {
  return /\.test\.(ts|vue)$/.test(filePath)
}

function getFacadeRecommendation({ filePath, source }) {
  const facadePath = getFacadePathFromSource({ filePath, source })
  if (facadePath) {
    return facadePath
  }

  const fileMatch = filePath.match(/\/src\/services\/(.+)\/worker\/[^/]+$/)
  if (fileMatch) {
    return `@/services/${fileMatch[1]}/worker/client`
  }

  return '@/services/<feature>/worker/client'
}

function resolvesToWorkerClientImplementation({ filePath, source }) {
  if (!source.startsWith('.')) {
    return false
  }

  return isStandaloneWorkerFacade({
    facadePath: getFacadePathFromSource({ filePath, source }),
  })
}

function isForbiddenImportSource({ filePath, source }) {
  if (isWorkerFacadeFile({ filePath }) || isTestFile({ filePath })) {
    return false
  }

  if (isStandaloneWorkerFacade({
    facadePath: getFacadePathFromSource({ filePath, source }),
  })) {
    return true
  }

  return resolvesToWorkerClientImplementation({ filePath, source })
}

export const rule = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Require worker clients to be imported through their public facade alias.',
    },
    messages: {
      requireFacade: 'Import worker clients through "{{ recommended }}" instead of "{{ source }}". Direct implementation imports bypass standalone alias switching.',
    },
    schema: [],
  },
  create(context) {
    const filePath = normalizePath(context.filename)

    function checkNode(node) {
      const rawSource = node.source?.value
      if (typeof rawSource !== 'string') {
        return
      }

      if (!isForbiddenImportSource({ filePath, source: rawSource })) {
        return
      }

      context.report({
        node: node.source ?? node,
        messageId: 'requireFacade',
        data: {
          source: rawSource,
          recommended: getFacadeRecommendation({ filePath, source: rawSource }),
        },
      })
    }

    return {
      ImportDeclaration: checkNode,
      ExportNamedDeclaration: checkNode,
      ExportAllDeclaration: checkNode,
    }
  },
}

export default {
  files: ['**/*.ts', '**/*.vue'],
  plugins: {
    'local-rules-worker-facade': {
      rules: {
        'require-worker-client-facade': rule,
      },
    },
  },
  rules: {
    'local-rules-worker-facade/require-worker-client-facade': 'error',
  },
}
