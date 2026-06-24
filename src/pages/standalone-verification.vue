<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ClipboardCheckIcon, FlaskConicalIcon } from 'lucide-vue-next'
import { useToast } from '@/composables/useToast'
import {
  debugRunFileProtocolStandaloneVerification,
  debugSerializeFileProtocolStandaloneVerificationReportForCopy,
  type DebugFileProtocolStandaloneVerificationReport,
} from '@/services/debug-file-protocol-standalone/verification/report'
import { debugVerifyFileProtocolStandaloneWorkerFactory } from '@/services/debug-file-protocol-standalone/verification/worker-probe'

const route = useRoute()
const router = useRouter()
const { addToast } = useToast()
const isStandaloneBuild = computed(() => __BUILD_MODE_IS_STANDALONE__)

const isRunning = ref(false)
const verificationReport = ref<DebugFileProtocolStandaloneVerificationReport>()
const tailwindStyleProbeElement = ref<HTMLElement>()
const scopedStyleProbeElement = ref<HTMLElement>()
const lazyStyleProbeElement = ref<HTMLElement>()
const lazyStyleInitialOutlineWidth = ref<string>()

const verificationReportJson = computed(() => verificationReport.value === undefined
  ? ''
  : debugSerializeFileProtocolStandaloneVerificationReportForCopy({ report: verificationReport.value }))

async function debugLoadFileProtocolStandaloneLazyStyleProbeModule({ signal }: { signal: AbortSignal }): Promise<Readonly<{ marker: string }>> {
  signal.throwIfAborted()
  const loaded = await import('@/services/debug-file-protocol-standalone/verification/lazy-style-probe')
  signal.throwIfAborted()
  return { marker: loaded.STANDALONE_VERIFICATION_LAZY_STYLE_MARKER }
}

async function debugExerciseFileProtocolStandaloneRouteRoundTrip({ signal }: { signal: AbortSignal }): Promise<Readonly<{
  beforePath: string
  transitionedPath: string
  restoredPath: string
}>> {
  signal.throwIfAborted()
  const before = route.fullPath
  const probeQueryKey = '__standalone-verification-route-probe'
  let transitioned: string | undefined
  let transitionError: unknown | undefined
  try {
    await router.replace({
      path: route.path,
      hash: route.hash,
      query: {
        ...route.query,
        [probeQueryKey]: '1',
      },
    })
    await nextTick()
    signal.throwIfAborted()
    transitioned = route.fullPath
  } catch (error) {
    transitionError = error
  }

  let restoreError: unknown | undefined
  try {
    await router.replace(before)
    await nextTick()
  } catch (error) {
    restoreError = error
  }

  if (transitionError !== undefined) throw transitionError
  if (restoreError !== undefined) throw restoreError
  if (transitioned === undefined) {
    throw new Error('Standalone verification route transition produced no transitioned route.')
  }

  return {
    beforePath: before,
    transitionedPath: transitioned,
    restoredPath: route.fullPath,
  }
}

async function debugRunVerification(): Promise<void> {
  if (
    !isStandaloneBuild.value
    ||
    isRunning.value
    || tailwindStyleProbeElement.value === undefined
    || scopedStyleProbeElement.value === undefined
    || lazyStyleProbeElement.value === undefined
  ) {
    return
  }

  isRunning.value = true
  verificationReport.value = undefined
  try {
    lazyStyleInitialOutlineWidth.value ??= getComputedStyle(lazyStyleProbeElement.value).outlineWidth
    const resolved = router.resolve(route.fullPath)
    verificationReport.value = await debugRunFileProtocolStandaloneVerification({
      route: {
        fullPath: route.fullPath,
        name: typeof route.name === 'string' ? route.name : undefined,
        matchedPaths: route.matched.map((record) => record.path),
        resolvedHref: resolved.href,
      },
      tailwindStyleProbeElement: tailwindStyleProbeElement.value,
      scopedStyleProbeElement: scopedStyleProbeElement.value,
      lazyStyleProbeElement: lazyStyleProbeElement.value,
      lazyStyleInitialOutlineWidth: lazyStyleInitialOutlineWidth.value,
      debugLoadFileProtocolStandaloneLazyStyleProbeModule,
      debugExerciseFileProtocolStandaloneRouteRoundTrip,
      debugRunWorkerProbe: async ({ signal }) => {
        signal.throwIfAborted()
        const result = await debugVerifyFileProtocolStandaloneWorkerFactory()
        signal.throwIfAborted()
        return result
      },
      checkTimeoutMs: 60_000,
    })
  } catch (error) {
    addToast({
      message: `Standalone verification failed to run: ${error instanceof Error ? error.message : String(error)}`,
      duration: 8000,
    })
  } finally {
    isRunning.value = false
  }
}

function copyWithSelectionFallback({ text }: { text: string }): boolean {
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.select()

  try {
    return document.execCommand('copy')
  } finally {
    textarea.remove()
  }
}

async function copyVerificationReportJson(): Promise<void> {
  if (verificationReportJson.value.length === 0) {
    return
  }

  try {
    let copied = false
    if (navigator.clipboard?.writeText !== undefined) {
      try {
        await navigator.clipboard.writeText(verificationReportJson.value)
        copied = true
      } catch {
        // file:// clipboard permissions differ by browser. Fall back to an
        // explicit selection copy before reporting failure to the user.
      }
    }
    if (!copied) {
      copied = copyWithSelectionFallback({ text: verificationReportJson.value })
    }
    if (!copied) {
      throw new Error('The browser rejected both clipboard methods.')
    }
    addToast({
      message: 'Standalone verification JSON copied',
      duration: 4000,
    })
  } catch (error) {
    addToast({
      message: `Failed to copy standalone verification JSON: ${error instanceof Error ? error.message : String(error)}`,
      duration: 8000,
    })
  }
}

defineExpose({
  TEST_ONLY: {
    // Export internal state and logic used only for testing here. Do not reference these in production logic.
    // ESLint-required for defineExpose.
  },
})
</script>

<template>
  <main class="min-h-full bg-gray-50 px-4 py-8 dark:bg-gray-950 sm:px-8" data-testid="standalone-verification-page">
    <section class="mx-auto max-w-5xl space-y-5 rounded-2xl border border-cyan-200 bg-white p-5 shadow-sm dark:border-cyan-900/50 dark:bg-gray-900">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 class="text-lg font-bold text-cyan-900 dark:text-cyan-200">Standalone Verification</h1>
          <p class="mt-1 max-w-2xl text-sm font-medium leading-relaxed text-cyan-800/70 dark:text-cyan-300/70">
            Checks file protocol startup, routing, styles, lazy chunks, SystemJS, and repeated Worker creation without changing chats or settings.
          </p>
        </div>
        <div class="flex flex-wrap gap-2">
          <button
            class="inline-flex items-center gap-2 rounded-xl bg-cyan-700 px-4 py-2.5 text-xs font-bold text-white shadow-sm transition hover:bg-cyan-600 disabled:cursor-not-allowed disabled:opacity-60"
            data-testid="run-standalone-verification-button"
            :disabled="isRunning || !isStandaloneBuild"
            @click="debugRunVerification"
          >
            <FlaskConicalIcon class="h-4 w-4" />
            {{ isRunning ? 'Running…' : 'Run standalone verification' }}
          </button>
          <button
            v-if="verificationReport"
            class="inline-flex items-center gap-2 rounded-xl border border-cyan-300 bg-white px-4 py-2.5 text-xs font-bold text-cyan-900 shadow-sm transition hover:bg-cyan-50 dark:border-cyan-800 dark:bg-gray-950 dark:text-cyan-200"
            data-testid="copy-standalone-verification-json-button"
            @click="copyVerificationReportJson"
          >
            <ClipboardCheckIcon class="h-4 w-4" />
            Copy JSON
          </button>
        </div>
      </div>

      <p
        v-if="!isStandaloneBuild"
        class="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm font-medium text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-200"
        data-testid="standalone-verification-unavailable"
      >
        These checks require a standalone build opened through file://.
      </p>

      <p class="text-xs text-gray-500 dark:text-gray-400">
        Copied diagnostics may contain local file paths in browser-provided error stacks or resource timing entries.
      </p>

      <div class="sr-only" aria-hidden="true">
        <div ref="tailwindStyleProbeElement" class="h-[13px] w-[43px]" data-testid="standalone-tailwind-probe"></div>
        <div ref="scopedStyleProbeElement" class="standalone-verification-scoped-probe" data-testid="standalone-scoped-probe"></div>
        <div ref="lazyStyleProbeElement" class="standalone-verification-lazy-style-probe" data-testid="standalone-lazy-style-probe"></div>
      </div>

      <div v-if="verificationReport" class="space-y-3">
        <p
          class="inline-flex rounded-full px-3 py-1 text-xs font-bold uppercase tracking-wide"
          :class="verificationReport.status === 'pass'
            ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300'
            : 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300'"
          data-testid="standalone-verification-status"
        >
          {{ verificationReport.status }} — {{ verificationReport.summary.passed }} passed / {{ verificationReport.summary.failed }} failed
        </p>
        <pre
          class="max-h-[36rem] overflow-auto rounded-xl bg-gray-950 p-4 text-left text-[11px] leading-5 text-gray-100"
          data-testid="standalone-verification-json"
        >{{ verificationReportJson }}</pre>
      </div>
    </section>
  </main>
</template>

<style scoped>
.standalone-verification-scoped-probe {
  border-left-style: solid;
  border-left-width: 7px;
}
</style>
