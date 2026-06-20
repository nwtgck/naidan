import { beforeAll, describe, expect, it } from 'vitest'
import { ESLint } from 'eslint'
import path from 'path'
import * as parser from '@typescript-eslint/parser'
import { rule } from './ensure-file-protocol-init.js'

describe('ensure-file-protocol-init rule', () => {
  let eslint: ESLint
  const repoRoot = path.resolve(__dirname, '..')

  beforeAll(() => {
    eslint = new ESLint({
      cwd: repoRoot,
      overrideConfigFile: true,
      overrideConfig: {
        files: ['**/*.ts'],
        languageOptions: {
          parser,
          parserOptions: {
            sourceType: 'module',
            ecmaVersion: 'latest',
          },
        },
        plugins: {
          'local-rules-file-protocol-init': {
            rules: {
              'ensure-file-protocol-init': rule,
            },
          },
        },
        rules: {
          'local-rules-file-protocol-init/ensure-file-protocol-init': 'error',
        },
      },
    })
  })

  async function lintText({ code }: { code: string }) {
    const [result] = await eslint.lintText(code, {
      filePath: path.resolve(repoRoot, 'src/main.ts'),
    })
    return result.messages
  }

  it('accepts a ready-state-aware scheduler whose bootstrap owns the mount', async () => {
    const messages = await lintText({
      code: `\
app.config.errorHandler = () => {}
async function bootstrapApp() {
  app.mount('#app')
}
scheduleAppStartup({
  document,
  bootstrap: bootstrapApp,
  onFailure: () => {},
})`,
    })

    expect(messages).toHaveLength(0)
  })

  it('rejects the former future-only DOMContentLoaded startup pattern', async () => {
    const messages = await lintText({
      code: `\
app.config.errorHandler = () => {}
window.addEventListener('DOMContentLoaded', () => {
  app.mount('#app')
})`,
    })

    expect(messages).toHaveLength(1)
    expect(messages[0]?.message).toContain('scheduleAppStartup')
  })

  it('does not accept app.mount text that appears only in a comment', async () => {
    const messages = await lintText({
      code: `\
app.config.errorHandler = () => {}
async function bootstrapApp() {
  // app.mount('#app')
}
scheduleAppStartup({
  document,
  bootstrap: bootstrapApp,
  onFailure: () => {},
})`,
    })

    expect(messages).toHaveLength(1)
    expect(messages[0]?.message).toContain('must contain app.mount()')
  })

  it('requires the scheduled bootstrap to own the Vue mount', async () => {
    const messages = await lintText({
      code: `\
app.config.errorHandler = () => {}
async function bootstrapApp() {}
scheduleAppStartup({
  document,
  bootstrap: bootstrapApp,
  onFailure: () => {},
})`,
    })

    expect(messages).toHaveLength(1)
    expect(messages[0]?.message).toContain('must contain app.mount()')
  })
})
