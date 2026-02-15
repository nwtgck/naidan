import type { Reporter } from 'vitest/reporters'
import type { TestCase, Vitest } from 'vitest/node'

interface LogAny {
  type: string
  content: string
}

type UserConsoleLog = LogAny;

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

interface TaskResult {
  state: 'run' | 'pass' | 'fail' | 'skipped' | 'todo' | 'pending' | 'only' | 'bench' | 'failed' | 'passed'
  errors?: VitestError[]
}

interface VitestTask {
  name?: string
  moduleId?: string
  relativeModuleId?: string
  result?: TaskResult
  task?: {
    result?: TaskResult
  }
}

export default class FailedOnlyReporter implements Reporter {
  private total = 0
  private passed = 0
  private failed = 0
  private vitest!: Vitest
  private headerPrinted = false
  private logs: UserConsoleLog[] = []
  private endReported = false

  onInit(vitest: Vitest) {
    this.vitest = vitest
  }

  onUserConsoleLog(log: UserConsoleLog) {
    this.logs.push(log)
  }

  async onTestCaseResult(testCase: TestCase) {
    this.total++
    const result = testCase.result()
    if (!result) {
      return
    }

    const state = result.state
    switch (state) {
    case 'failed': {
      this.failed++
      if (!this.headerPrinted) {
        this.vitest.logger.log('\nFAILED TESTS:')
        this.headerPrinted = true
      }

      const mod = testCase.module as unknown as ExtendedTestModule
      const filename = mod.relativeModuleId || mod.name || 'unknown'
      const name = `${filename} > ${testCase.fullName}`
      const errors = (result.errors || []) as unknown as VitestError[]

      // Filter logs for this specific test case if possible,
      // but Vitest doesn't easily map logs to test cases in this hook.
      // We'll show all logs accumulated so far and then clear them.
      if (this.logs.length > 0) {
        this.vitest.logger.log(`\n  --- Logs for ${name} ---`)
        for (const log of this.logs) {
          this.vitest.logger.log(`  [${log.type}] ${log.content}`)
        }
        this.logs = []
      }

      await this.printFailure({ name, errors })
      break
    }
    case 'passed': {
      this.passed++
      this.logs = [] // Clear logs for passed tests to keep it clean
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

  private async printFailure({ name, errors }: { name: string; errors: VitestError[] }) {
    this.vitest.logger.log(`\n\u276f ${name}`)
    for (const error of errors) {
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async onFinished(files: any = [], errors: any = []) {
    await this.reportEnd(files, errors)
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async onTestRunEnd(testModules: any = [], unhandledErrors: any = []) {
    await this.reportEnd(testModules, unhandledErrors)
  }

  private async reportEnd(files: readonly VitestTask[], errors: readonly VitestError[]) {
    if (this.endReported) {
      return
    }
    this.endReported = true

    for (const file of files) {
      const result = file.result || file.task?.result
      if (!result) {
        continue
      }

      const state = result.state
      switch (state) {
      case 'fail':
      case 'failed': {
        const fileErrors = result.errors || []
        if (fileErrors.length > 0) {
          this.failed++
          this.total++
          if (!this.headerPrinted) {
            this.vitest.logger.log('\nFAILED TESTS:')
            this.headerPrinted = true
          }
          const name = file.name || file.relativeModuleId || file.moduleId || 'unknown'
          await this.printFailure({ name, errors: fileErrors })
        }
        break
      }
      case 'run':
      case 'pass':
      case 'passed':
      case 'skipped':
      case 'todo':
      case 'pending':
      case 'only':
      case 'bench': {
        break
      }
      default: {
        const _ex: never = state
        throw new Error(`Unhandled state: ${_ex}`)
      }
      }
    }

    for (const error of errors) {
      this.failed++
      this.total++
      if (!this.headerPrinted) {
        this.vitest.logger.log('\nFAILED TESTS:')
        this.headerPrinted = true
      }
      await this.printFailure({ name: 'Global Error', errors: [error] })
    }

    this.vitest.logger.log(`\nTests: ${this.passed} passed, ${this.failed} failed, ${this.total} total`)
  }
}
