<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ClipboardCheckIcon, FlaskConicalIcon } from 'lucide-vue-next'
import { useToast } from '@/composables/useToast'
import {
  runStandaloneVerification,
  serializeStandaloneVerificationReportForCopy,
  type StandaloneVerificationReport,
} from '@/services/standalone-verification/report'
import { runStandaloneWorkerFactoryVerification } from '@/services/standalone-verification/worker-probe'

const route = useRoute()
const router = useRouter()
const { addToast } = useToast()
const isStandaloneBuild = __BUILD_MODE_IS_STANDALONE__

const running = ref(false)
const report = ref<StandaloneVerificationReport>()
const tailwindProbe = ref<HTMLElement>()
const scopedProbe = ref<HTMLElement>()
const lazyStyleProbe = ref<HTMLElement>()

const reportJson = computed(() => report.value === undefined
  ? ''
  : serializeStandaloneVerificationReportForCopy({ report: report.value }))

async function loadLazyStyleProbe(): Promise<Readonly<{ marker: string }>> {
  const loaded = await import('@/services/standalone-verification/lazy-style-probe')
  return { marker: loaded.STANDALONE_VERIFICATION_LAZY_STYLE_MARKER }
}

async function exerciseRouteTransition(): Promise<Readonly<{
  before: string
  transitioned: string
  restored: string
}>> {
  const before = route.fullPath
  const probeQueryKey = '__standalone-verification-route-probe'
  await router.replace({
    path: route.path,
    hash: route.hash,
    query: {
      ...route.query,
      [probeQueryKey]: '1',
    },
  })
  await nextTick()
  const transitioned = route.fullPath
  await router.replace(before)
  await nextTick()
  return {
    before,
    transitioned,
    restored: route.fullPath,
  }
}

async function runVerification(): Promise<void> {
  if (
    running.value
    || tailwindProbe.value === undefined
    || scopedProbe.value === undefined
    || lazyStyleProbe.value === undefined
  ) {
    return
  }

  running.value = true
  report.value = undefined
  try {
    const resolved = router.resolve(route.fullPath)
    report.value = await runStandaloneVerification({
      route: {
        fullPath: route.fullPath,
        name: typeof route.name === 'string' ? route.name : undefined,
        matchedPaths: route.matched.map((record) => record.path),
        resolvedHref: resolved.href,
      },
      tailwindProbe: tailwindProbe.value,
      scopedProbe: scopedProbe.value,
      lazyStyleProbe: lazyStyleProbe.value,
      loadLazyStyleProbe,
      exerciseRouteTransition,
      runWorkerProbe: runStandaloneWorkerFactoryVerification,
    })
  } catch (error) {
    addToast({
      message: `Standalone verification failed to run: ${error instanceof Error ? error.message : String(error)}`,
      duration: 8000,
    })
  } finally {
    running.value = false
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

async function copyReportJson(): Promise<void> {
  if (reportJson.value.length === 0) {
    return
  }

  try {
    let copied = false
    if (navigator.clipboard?.writeText !== undefined) {
      try {
        await navigator.clipboard.writeText(reportJson.value)
        copied = true
      } catch {
        // file:// clipboard permissions differ by browser. Fall back to an
        // explicit selection copy before reporting failure to the user.
      }
    }
    if (!copied) {
      copied = copyWithSelectionFallback({ text: reportJson.value })
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
            :disabled="running"
            @click="runVerification"
          >
            <FlaskConicalIcon class="h-4 w-4" />
            {{ running ? 'Running…' : 'Run standalone verification' }}
          </button>
          <button
            v-if="report"
            class="inline-flex items-center gap-2 rounded-xl border border-cyan-300 bg-white px-4 py-2.5 text-xs font-bold text-cyan-900 shadow-sm transition hover:bg-cyan-50 dark:border-cyan-800 dark:bg-gray-950 dark:text-cyan-200"
            data-testid="copy-standalone-verification-json-button"
            @click="copyReportJson"
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
        <div ref="tailwindProbe" class="h-[13px] w-[43px]" data-testid="standalone-tailwind-probe"></div>
        <div ref="scopedProbe" class="standalone-verification-scoped-probe" data-testid="standalone-scoped-probe"></div>
        <div ref="lazyStyleProbe" class="standalone-verification-lazy-style-probe" data-testid="standalone-lazy-style-probe"></div>
      </div>

      <div v-if="report" class="space-y-3">
        <p
          class="inline-flex rounded-full px-3 py-1 text-xs font-bold uppercase tracking-wide"
          :class="report.status === 'pass'
            ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300'
            : 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300'"
          data-testid="standalone-verification-status"
        >
          {{ report.status }} — {{ report.summary.passed }} passed / {{ report.summary.failed }} failed
        </p>
        <pre
          class="max-h-[36rem] overflow-auto rounded-xl bg-gray-950 p-4 text-left text-[11px] leading-5 text-gray-100"
          data-testid="standalone-verification-json"
        >{{ reportJson }}</pre>
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
