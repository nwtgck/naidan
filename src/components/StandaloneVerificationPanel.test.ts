import { flushPromises, mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  addToast: vi.fn(),
  runStandaloneVerification: vi.fn(),
  runStandaloneWorkerFactoryVerification: vi.fn(),
}))

vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ addToast: mocks.addToast }),
}))

vi.mock('@/services/standalone-verification/report', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/services/standalone-verification/report')>()
  return {
    ...original,
    runStandaloneVerification: mocks.runStandaloneVerification,
  }
})

vi.mock('@/services/standalone-verification/worker-probe', () => ({
  runStandaloneWorkerFactoryVerification: mocks.runStandaloneWorkerFactoryVerification,
}))

import StandaloneVerificationPanel from './StandaloneVerificationPanel.vue'
import type { StandaloneVerificationReport } from '@/services/standalone-verification/report'

function createReport(): StandaloneVerificationReport {
  return {
    format: 'naidan-standalone-verification-v1',
    generatedAt: '2026-06-20T00:00:00.000Z',
    status: 'pass',
    summary: {
      passed: 8,
      failed: 0,
      durationMs: 12,
    },
    environment: {
      href: 'file:///tmp/naidan/index.html#/',
      protocol: 'file:',
      origin: 'null',
      userAgent: 'test-agent',
      readyState: 'complete',
      performanceMemory: undefined,
    },
    checks: [],
    runtime: {
      startup: undefined,
      systemJsPatch: undefined,
      systemJsRetry: undefined,
      worker: undefined,
      resourceEntries: [],
    },
  }
}

async function mountPanel() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', name: 'home', component: { template: '<div>home</div>' } }],
  })
  await router.push('/')
  await router.isReady()

  return mount(StandaloneVerificationPanel, {
    global: { plugins: [router] },
  })
}

describe('StandaloneVerificationPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.runStandaloneVerification.mockResolvedValue(createReport())
    mocks.runStandaloneWorkerFactoryVerification.mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: undefined,
    })
  })

  it('runs the verification with route and style probes and renders detailed JSON', async () => {
    const wrapper = await mountPanel()

    await wrapper.get('[data-testid="run-standalone-verification-button"]').trigger('click')
    await flushPromises()

    expect(mocks.runStandaloneVerification).toHaveBeenCalledOnce()
    const call = mocks.runStandaloneVerification.mock.calls[0]?.[0] as {
      route: { fullPath: string, name: string | undefined, resolvedHref: string }
      tailwindProbe: HTMLElement
      scopedProbe: HTMLElement
      lazyCssProbe: HTMLElement
      loadLazyProbe: () => Promise<Readonly<{ marker: string }>>
      runWorkerProbe: unknown
    }
    expect(call.route).toMatchObject({
      fullPath: '/',
      name: 'home',
      resolvedHref: '/',
    })
    expect(call.tailwindProbe.dataset.testid).toBe('standalone-tailwind-probe')
    expect(call.scopedProbe.dataset.testid).toBe('standalone-scoped-probe')
    expect(call.lazyCssProbe.dataset.testid).toBe('standalone-lazy-css-probe')
    await expect(call.loadLazyProbe()).resolves.toEqual({ marker: 'standalone-verification-lazy-probe-v1' })
    expect(call.runWorkerProbe).toBe(mocks.runStandaloneWorkerFactoryVerification)

    expect(wrapper.get('[data-testid="standalone-verification-status"]').text()).toContain('pass')
    const json = wrapper.get('[data-testid="standalone-verification-json"]').text()
    expect(JSON.parse(json)).toEqual(createReport())
  })

  it('copies the JSON through the Clipboard API and shows a success toast', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    const wrapper = await mountPanel()
    await wrapper.get('[data-testid="run-standalone-verification-button"]').trigger('click')
    await flushPromises()

    await wrapper.get('[data-testid="copy-standalone-verification-json-button"]').trigger('click')
    await flushPromises()

    expect(writeText).toHaveBeenCalledWith(JSON.stringify(createReport(), undefined, 2))
    expect(mocks.addToast).toHaveBeenCalledWith({
      message: 'Standalone verification JSON copied',
      duration: 4000,
    })
  })

  it('falls back to selection-based copying when file protocol clipboard permission is denied', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('permission denied'))
    const execCommand = vi.fn().mockReturnValue(true)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: execCommand,
    })
    const wrapper = await mountPanel()
    await wrapper.get('[data-testid="run-standalone-verification-button"]').trigger('click')
    await flushPromises()

    await wrapper.get('[data-testid="copy-standalone-verification-json-button"]').trigger('click')
    await flushPromises()

    expect(writeText).toHaveBeenCalledOnce()
    expect(execCommand).toHaveBeenCalledWith('copy')
    expect(mocks.addToast).toHaveBeenCalledWith({
      message: 'Standalone verification JSON copied',
      duration: 4000,
    })
  })

  it('prevents duplicate verification runs while the first run is pending', async () => {
    let resolveReport: ((report: StandaloneVerificationReport) => void) | undefined
    mocks.runStandaloneVerification.mockReturnValue(new Promise<StandaloneVerificationReport>((resolve) => {
      resolveReport = resolve
    }))
    const wrapper = await mountPanel()
    const button = wrapper.get('[data-testid="run-standalone-verification-button"]')

    await button.trigger('click')
    await button.trigger('click')

    expect(mocks.runStandaloneVerification).toHaveBeenCalledOnce()
    expect(button.attributes('disabled')).toBeDefined()
    expect(button.text()).toContain('Running')

    resolveReport?.(createReport())
    await flushPromises()

    expect(button.attributes('disabled')).toBeUndefined()
    expect(wrapper.get('[data-testid="standalone-verification-status"]').text()).toContain('pass')
  })

  it('shows a toast when the verification cannot start', async () => {
    mocks.runStandaloneVerification.mockRejectedValue(new Error('synthetic verification failure'))
    const wrapper = await mountPanel()

    await wrapper.get('[data-testid="run-standalone-verification-button"]').trigger('click')
    await flushPromises()

    expect(mocks.addToast).toHaveBeenCalledWith({
      message: 'Standalone verification failed to run: synthetic verification failure',
      duration: 8000,
    })
    expect(wrapper.find('[data-testid="standalone-verification-json"]').exists()).toBe(false)
  })

  it('shows a failure toast when both clipboard mechanisms are rejected', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('permission denied'))
    const execCommand = vi.fn().mockReturnValue(false)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: execCommand,
    })
    const wrapper = await mountPanel()
    await wrapper.get('[data-testid="run-standalone-verification-button"]').trigger('click')
    await flushPromises()

    await wrapper.get('[data-testid="copy-standalone-verification-json-button"]').trigger('click')
    await flushPromises()

    expect(mocks.addToast).toHaveBeenCalledWith({
      message: 'Failed to copy standalone verification JSON: The browser rejected both clipboard methods.',
      duration: 8000,
    })
  })

})
