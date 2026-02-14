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

    reporter.onTestCaseResult(mockTestCasePass)
    reporter.onTestCaseResult(mockTestCaseFail)

    await reporter.onTestRunEnd()

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

    reporter.onTestCaseResult(mockTestCasePass)

    await reporter.onTestRunEnd()

    expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining('FAILED TESTS:'))
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('1 passed, 0 failed, 1 total'))
  })
})
