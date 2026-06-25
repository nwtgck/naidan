import { parse } from 'acorn'
import type { ImportExpression } from 'acorn'
import { simple } from 'acorn-walk'
import { createHash } from 'node:crypto'
import path from 'node:path'

const pluginName = 'file-protocol-standalone'

function computeSha256Hex({ source }: { source: string | Uint8Array }): string {
  return createHash('sha256').update(source).digest('hex')
}

function isWindowsAbsolutePath({ value }: { value: string }): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value)
}

/** @internal Exported for focused plugin tests. */
export function debugSanitizeFileProtocolStandaloneModuleId({ root, moduleId }: {
  root: string
  moduleId: string
}): string {
  if (moduleId.startsWith('\0')) {
    return moduleId.slice(1)
  }

  const normalized = moduleId.replaceAll('\\', '/')
  const normalizedRoot = root.replaceAll('\\', '/').replace(/\/$/, '')
  const windowsPath = isWindowsAbsolutePath({ value: moduleId })
  const windowsRoot = isWindowsAbsolutePath({ value: root })
  const comparableModuleId = windowsPath ? normalized.toLowerCase() : normalized
  const comparableRoot = windowsRoot ? normalizedRoot.toLowerCase() : normalizedRoot
  if (
    windowsPath === windowsRoot
    && comparableModuleId.startsWith(`${comparableRoot}/`)
  ) {
    return `/${normalized.slice(normalizedRoot.length + 1)}`
  }
  if (normalized.includes('/node_modules/')) {
    return `/node_modules/${normalized.split('/node_modules/')[1]}`
  }
  if (path.posix.isAbsolute(normalized) || windowsPath) {
    // Root-external modules are legitimate in monorepos, but exposing the host
    // filesystem path makes diagnostic reports machine-specific and may leak a
    // developer's home directory. Keep a deterministic, useful basename while
    // replacing the private prefix with a short digest.
    return `/outside-root/${computeSha256Hex({ source: normalized }).slice(0, 12)}-${path.posix.basename(normalized)}`
  }
  return normalized
}


type FileProtocolStandaloneScriptRole = 'application-chunk' | 'support-script' | 'worker'

export type FileProtocolStandaloneRuntimeDynamicImportOccurrence = Readonly<{
  kind: 'static-specifier' | 'dynamic-specifier'
  line: number
  column: number
  specifier: string | undefined
}>

type FileProtocolStandaloneScriptValidation = Readonly<{
  runtimeDynamicImports: readonly FileProtocolStandaloneRuntimeDynamicImportOccurrence[]
  systemRegisterCallCount: number
  hostedWorkerUrlCount: number
}>

function readStaticallyKnownImportSpecifier({ node }: { node: ImportExpression }): string | undefined {
  const source = node.source
  if (source.type === 'Literal' && typeof source.value === 'string') {
    return source.value
  }
  if (source.type === 'TemplateLiteral' && source.expressions.length === 0) {
    return source.quasis[0]?.value.cooked ?? source.quasis[0]?.value.raw
  }
  return undefined
}

/** @internal Exported for focused plugin tests. */
export function assertFileProtocolStandaloneClassicScript({
  source,
  label,
  mode,
}: {
  source: string
  label: string
  mode: FileProtocolStandaloneScriptRole
}): FileProtocolStandaloneScriptValidation {
  const ast = parse(source, {
    ecmaVersion: 'latest',
    sourceType: 'script',
    allowHashBang: true,
    locations: true,
  })
  const runtimeDynamicImports: FileProtocolStandaloneRuntimeDynamicImportOccurrence[] = []
  let importMetaFound = false
  let systemRegisterCallCount = 0
  let hostedWorkerUrlCount = 0

  simple(ast, {
    CallExpression(node) {
      const { callee } = node
      if (
        callee.type === 'MemberExpression'
        && callee.object.type === 'Identifier'
        && callee.object.name === 'System'
        && (
          (!callee.computed && callee.property.type === 'Identifier' && callee.property.name === 'register')
          || (callee.computed && callee.property.type === 'Literal' && callee.property.value === 'register')
        )
      ) {
        systemRegisterCallCount += 1
      }
    },
    NewExpression(node) {
      if (
        node.callee.type === 'Identifier'
        && node.callee.name === 'Worker'
        && node.arguments[0]?.type === 'NewExpression'
        && node.arguments[0].callee.type === 'Identifier'
        && node.arguments[0].callee.name === 'URL'
      ) {
        hostedWorkerUrlCount += 1
      }
    },
    ImportExpression(node) {
      const specifier = readStaticallyKnownImportSpecifier({ node })
      runtimeDynamicImports.push({
        kind: specifier === undefined ? 'dynamic-specifier' : 'static-specifier',
        line: node.loc?.start.line ?? 0,
        column: node.loc?.start.column ?? 0,
        specifier,
      })
    },
    MetaProperty(node) {
      if (node.meta.name === 'import' && node.property.name === 'meta') {
        importMetaFound = true
      }
    },
  })

  const modeValidation = (() => {
    switch (mode) {
    case 'application-chunk':
      return {
        rejectedRuntimeImports: runtimeDynamicImports,
        requireSystemRegister: true,
      } as const
    case 'support-script':
      return {
        rejectedRuntimeImports: runtimeDynamicImports,
        requireSystemRegister: false,
      } as const
    case 'worker':
      return {
        rejectedRuntimeImports: runtimeDynamicImports.filter((item) => item.kind === 'static-specifier'),
        requireSystemRegister: false,
      } as const
    default: {
      const _ex: never = mode
      throw new Error(`Unhandled JavaScript validation mode: ${_ex}`)
    }
    }
  })()
  const reasons = [
    modeValidation.rejectedRuntimeImports.length > 0
      ? `${modeValidation.rejectedRuntimeImports.length} unsupported runtime import expression(s) remain`
      : undefined,
    importMetaFound ? 'import.meta remains' : undefined,
    modeValidation.requireSystemRegister && systemRegisterCallCount === 0
      ? 'System.register(...) is missing'
      : undefined,
  ].filter((reason): reason is string => reason !== undefined)
  if (reasons.length > 0) {
    throw new Error(`[${pluginName}] ${label} is not valid standalone classic JavaScript: ${reasons.join(', ')}.`)
  }

  return { runtimeDynamicImports, systemRegisterCallCount, hostedWorkerUrlCount }
}
