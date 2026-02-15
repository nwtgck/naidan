import { describe, it, expect, vi } from 'vitest'
import FailedOnlyReporter from './FailedOnlyReporter'

describe('FailedOnlyReporter', () => {
  it('should collect and log failed tests', async () => {
    const reporter = new FailedOnlyReporter()
    const logSpy = vi.fn()
    const mockVitest = {
      logger: {
        log: logSpy,
      }
    } as any

    reporter.onInit(mockVitest)

    const mockTestCasePass = {
      result: () => ({ state: 'passed' }),
      module: { relativeModuleId: 'test.ts' },
      fullName: 'pass test',
    } as any

    const mockTestCaseFail = {
      result: () => ({
        state: 'failed',
        errors: [{ message: 'Assertion Error', expected: 2, actual: 1, showDiff: true }]
      }),
      module: { relativeModuleId: 'test.ts' },
      fullName: 'fail test',
    } as any

    await reporter.onTestCaseResult(mockTestCasePass)
    await reporter.onTestCaseResult(mockTestCaseFail)

    await reporter.onFinished([], [])

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('FAILED TESTS:'))
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('test.ts > fail test'))
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('- Expected: 2'))
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('+ Received: 1'))
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('1 passed, 1 failed, 2 total'))
  })

  it('should not log anything if no failures', async () => {
    const reporter = new FailedOnlyReporter()
    const logSpy = vi.fn()
    const mockVitest = {
      logger: {
        log: logSpy,
      }
    } as any

    reporter.onInit(mockVitest)

    const mockTestCasePass = {
      result: () => ({ state: 'passed' }),
      module: { relativeModuleId: 'test.ts' },
      fullName: 'pass test',
    } as any

    await reporter.onTestCaseResult(mockTestCasePass)

    await reporter.onFinished([], [])

    expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining('FAILED TESTS:'))
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('1 passed, 0 failed, 1 total'))
  })

  it('should log build errors (file-level errors) via file.result', async () => {
    const reporter = new FailedOnlyReporter()
    const logSpy = vi.fn()
    const mockVitest = {
      logger: {
        log: logSpy,
      }
    } as any

    reporter.onInit(mockVitest)

    const mockFileError = {
      name: 'broken.test.ts',
      result: {
        state: 'failed',
        errors: [{ message: 'SyntaxError: Unexpected token', stack: 'at broken.test.ts:1:1' }]
      }
    } as any

    await reporter.onFinished([mockFileError], [])

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('FAILED TESTS:'))
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('broken.test.ts'))
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('SyntaxError: Unexpected token'))
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('0 passed, 1 failed, 1 total'))
  })

  it('should log syntax errors via file.task.result', async () => {
    const reporter = new FailedOnlyReporter()
    const logSpy = vi.fn()
    const mockVitest = {
      logger: {
        log: logSpy,
      }
    } as any

    reporter.onInit(mockVitest)

    const mockFileError = {
      moduleId: 'syntax.test.ts',
      task: {
        result: {
          state: 'fail',
          errors: [{ message: 'Transform failed', stack: 'at syntax.test.ts:1:1' }]
        }
      }
    } as any

    await reporter.onFinished([mockFileError], [])

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('FAILED TESTS:'))
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('syntax.test.ts'))
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Transform failed'))
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('0 passed, 1 failed, 1 total'))
  })
})
