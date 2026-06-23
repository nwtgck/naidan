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

import StandaloneVerificationPage from './standalone-verification.vue'
import type { StandaloneVerificationReport } from '@/services/standalone-verification/report'

function createReport(): StandaloneVerificationReport {
  return {
    format: 'naidan-standalone-verification-v1',
    generatedAt: '2026-06-23T00:00:00.000Z',
    status: 'pass',
    summary: {
      passed: 12,
      failed: 0,
      durationMs: 12,
    },
    environment: {
      href: 'file:///__nonexistent_file_protocol_test_root__/index.html#/standalone-verification',
      protocol: 'file:',
      origin: 'null',
      userAgent: 'test-agent',
      readyState: 'complete',
      performanceMemory: undefined,
    },
    checks: [],
    runtime: {
      pluginDiagnostics: undefined,
      startup: undefined,
      systemJsPatch: undefined,
      systemJsRetry: undefined,
      worker: undefined,
      resourceEntries: [],
    },
  }
}

async function mountPage() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{
      path: '/standalone-verification',
      name: '/standalone-verification',
      component: StandaloneVerificationPage,
    }],
  })
  await router.push('/standalone-verification')
  await router.isReady()

  return {
    router,
    wrapper: mount(StandaloneVerificationPage, {
      global: { plugins: [router] },
    }),
  }
}

describe('standalone verification page', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.runStandaloneVerification.mockResolvedValue(createReport())
    mocks.runStandaloneWorkerFactoryVerification.mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: undefined,
    })
  })

  it('runs verification with route, style, lazy import, and Worker probes', async () => {
    const { wrapper } = await mountPage()

    await wrapper.get('[data-testid="run-standalone-verification-button"]').trigger('click')
    await flushPromises()

    expect(mocks.runStandaloneVerification).toHaveBeenCalledOnce()
    const call = mocks.runStandaloneVerification.mock.calls[0]?.[0] as {
      route: { fullPath: string, name: string | undefined, matchedPaths: string[], resolvedHref: string }
      tailwindProbe: HTMLElement
      scopedProbe: HTMLElement
      lazyStyleProbe: HTMLElement
      loadLazyStyleProbe: () => Promise<Readonly<{ marker: string }>>
      exerciseRouteTransition: () => Promise<unknown>
      runWorkerProbe: unknown
    }
    expect(call.route).toMatchObject({
      fullPath: '/standalone-verification',
      name: '/standalone-verification',
      matchedPaths: ['/standalone-verification'],
      resolvedHref: '/standalone-verification',
    })
    expect(call.tailwindProbe.dataset.testid).toBe('standalone-tailwind-probe')
    expect(call.scopedProbe.dataset.testid).toBe('standalone-scoped-probe')
    expect(call.lazyStyleProbe.dataset.testid).toBe('standalone-lazy-style-probe')
    expect(call.runWorkerProbe).toBe(mocks.runStandaloneWorkerFactoryVerification)
    await expect(call.loadLazyStyleProbe()).resolves.toEqual({
      marker: 'standalone-verification-lazy-style-probe-v1',
    })
    await expect(call.exerciseRouteTransition()).resolves.toEqual({
      before: '/standalone-verification',
      transitioned: '/standalone-verification?__standalone-verification-route-probe=1',
      restored: '/standalone-verification',
    })
    expect(wrapper.get('[data-testid="standalone-verification-status"]').text()).toContain('12 passed')
  })

  it('copies sanitized report JSON with the selection fallback', async () => {
    const execCommand = vi.fn(() => true)
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: execCommand,
    })
    const { wrapper } = await mountPage()

    await wrapper.get('[data-testid="run-standalone-verification-button"]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-testid="copy-standalone-verification-json-button"]').trigger('click')

    expect(execCommand).toHaveBeenCalledWith('copy')
    expect(mocks.addToast).toHaveBeenCalledWith({
      message: 'Standalone verification JSON copied',
      duration: 4000,
    })
    expect(wrapper.get('[data-testid="standalone-verification-json"]').text()).toContain('<standalone-root>/index.html')
  })
})
