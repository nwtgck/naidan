import type { Reporter } from 'vitest/reporters'
import type { TestCase, Vitest } from 'vitest/node'

interface VitestError {
  message: string
  stack?: string
  stackStr?: string
  expected?: string
  actual?: string
  showDiff?: boolean
}

interface ExtendedTestModule {
  name: string
  relativeModuleId?: string
}

interface ExtendedLogger {
  log: (msg: string) => void
  printCustomError?: (error: VitestError) => Promise<void>
}

export default class FailedOnlyReporter implements Reporter {
  private total = 0
  private passed = 0
  private failures: { name: string; errors: VitestError[] }[] = []
  private vitest!: Vitest

  onInit(vitest: Vitest) {
    this.vitest = vitest
  }

  onTestCaseResult(testCase: TestCase) {
    this.total++
    const result = testCase.result()
    if (!result) {
      return
    }

    const state = result.state
    switch (state) {
    case 'failed': {
      const mod = testCase.module as unknown as ExtendedTestModule
      const filename = mod.relativeModuleId || mod.name || 'unknown'
      this.failures.push({
        name: `${filename} > ${testCase.fullName}`,
        errors: (result.errors || []) as unknown as VitestError[],
      })
      break
    }
    case 'passed': {
      this.passed++
      break
    }
    case 'skipped':
    case 'pending': {
      break
    }
    default: {
      const _ex: never = state
      throw new Error(`Unhandled state: ${_ex}`)
    }
    }  
  }

  async onTestRunEnd() {
    if (this.failures.length > 0) {
      this.vitest.logger.log('\nFAILED TESTS:')
      for (const failure of this.failures) {
        this.vitest.logger.log(`\n\u276f ${failure.name}`)
        for (const error of failure.errors) {
          // Attempt to use internal printer if possible
          const logger = this.vitest.logger as unknown as ExtendedLogger
          if (logger.printCustomError) {
            await logger.printCustomError(error)
          } else {
            this.vitest.logger.log(`\n${error.message}`)
            if (error.showDiff) {
              this.vitest.logger.log(`\n- Expected: ${error.expected}`)
              this.vitest.logger.log(`+ Received: ${error.actual}\n`)
            }
            this.vitest.logger.log(error.stackStr || error.stack || '')
          }
        }
      }
    }
    
    this.vitest.logger.log(`\nTests: ${this.passed} passed, ${this.failures.length} failed, ${this.total} total`)
  }
}
