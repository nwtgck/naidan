<script setup lang="ts">
import { ensureStrings, lazyStrings } from '@/strings';
import { computed, nextTick, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ClipboardCheckIcon, FlaskConicalIcon } from 'lucide-vue-next';
import { useToast } from '@/composables/useToast';
import {
  DEBUG_FILE_PROTOCOL_STANDALONE_VERIFICATION_ROUTE_PATH,
  debugRunFileProtocolStandaloneVerification,
  debugSerializeFileProtocolStandaloneVerificationReportForCopy,
  type DebugFileProtocolStandaloneVerificationReport,
} from '@/features/file-protocol-standalone/debug/verification/report';
import { debugVerifyFileProtocolStandaloneWorkerFactory } from '@/features/file-protocol-standalone/debug/verification/worker-probe';

const route = useRoute();
const router = useRouter();
const { addToast } = useToast();
const isStandaloneBuild = computed(() => __BUILD_MODE_IS_STANDALONE__);

const isRunning = ref(false);
const verificationReport = ref<DebugFileProtocolStandaloneVerificationReport>();
const tailwindStyleProbeElement = ref<HTMLElement>();
const scopedStyleProbeElement = ref<HTMLElement>();
const lazyStyleProbeElement = ref<HTMLElement>();

const verificationReportJson = computed(() => verificationReport.value === undefined
  ? ''
  : debugSerializeFileProtocolStandaloneVerificationReportForCopy({ report: verificationReport.value }));

const lazyStyleInitialMarkerAttribute = 'data-debug-file-protocol-standalone-lazy-style-initial-marker';

function debugGetOrCaptureFileProtocolStandaloneLazyStyleInitialMarker({ element }: { element: HTMLElement }): string {
  const root = document.documentElement;
  const existing = root.getAttribute(lazyStyleInitialMarkerAttribute);
  if (existing !== null) return existing;

  const measured = getComputedStyle(element)
    .getPropertyValue('--debug-file-protocol-standalone-lazy-style-marker')
    .trim();
  root.setAttribute(lazyStyleInitialMarkerAttribute, measured);
  return measured;
}

async function debugLoadFileProtocolStandaloneLazyStyleProbeModule({ signal }: { signal: AbortSignal }): Promise<Readonly<{ marker: string }>> {
  signal.throwIfAborted();
  const loaded = await import('@/features/file-protocol-standalone/debug/verification/lazy-style-probe');
  signal.throwIfAborted();
  return { marker: loaded.STANDALONE_VERIFICATION_LAZY_STYLE_MARKER };
}

async function debugExerciseFileProtocolStandaloneRouteRoundTrip({ signal }: { signal: AbortSignal }): Promise<Readonly<{
  beforePath: string,
  transitionedPath: string,
  restoredPath: string,
}>> {
  signal.throwIfAborted();
  if (!route.fullPath.startsWith(DEBUG_FILE_PROTOCOL_STANDALONE_VERIFICATION_ROUTE_PATH)) {
    throw new Error(`Unexpected standalone debug route: ${route.fullPath}`);
  }
  const before = route.fullPath;
  const probeQueryKey = '__standalone-verification-route-probe';
  let transitioned: string | undefined;
  let transitionError: unknown | undefined;
  try {
    await router.replace({
      path: route.path,
      hash: route.hash,
      query: {
        ...route.query,
        [probeQueryKey]: route.query[probeQueryKey] === '1' ? '2' : '1',
      },
    });
    await nextTick();
    signal.throwIfAborted();
    transitioned = route.fullPath;
  } catch (error) {
    transitionError = error;
  }

  let restoreError: unknown | undefined;
  try {
    await router.replace(before);
    await nextTick();
  } catch (error) {
    restoreError = error;
  }

  if (transitionError !== undefined) throw transitionError;
  if (restoreError !== undefined) throw restoreError;
  if (transitioned === undefined) {
    throw new Error('Standalone verification route transition produced no transitioned route.');
  }

  return {
    beforePath: before,
    transitionedPath: transitioned,
    restoredPath: route.fullPath,
  };
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
    return;
  }

  isRunning.value = true;
  verificationReport.value = undefined;
  try {
    const lazyStyleInitialMarker = debugGetOrCaptureFileProtocolStandaloneLazyStyleInitialMarker({
      element: lazyStyleProbeElement.value,
    });
    const resolved = router.resolve(route.fullPath);
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
      lazyStyleInitialMarker,
      debugLoadFileProtocolStandaloneLazyStyleProbeModule,
      debugExerciseFileProtocolStandaloneRouteRoundTrip,
      debugRunWorkerProbe: async ({ signal }) => {
        signal.throwIfAborted();
        const result = await debugVerifyFileProtocolStandaloneWorkerFactory();
        signal.throwIfAborted();
        return result;
      },
      checkTimeoutMs: 60_000,
    });
  } catch (error) {
    addToast({
      message: await ensureStrings.StandaloneVerificationPage__verification_failed_to_run({ errorMessage: error instanceof Error ? error.message : String(error) }),
      duration: 8000,
    });
  } finally {
    isRunning.value = false;
  }
}

function copyWithSelectionFallback({ text }: { text: string }): boolean {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();

  try {
    return document.execCommand('copy');
  } finally {
    textarea.remove();
  }
}

async function copyVerificationReportJson(): Promise<void> {
  if (verificationReportJson.value.length === 0) {
    return;
  }

  try {
    let copied = false;
    if (navigator.clipboard?.writeText !== undefined) {
      try {
        await navigator.clipboard.writeText(verificationReportJson.value);
        copied = true;
      } catch {
        // file:// clipboard permissions differ by browser. Fall back to an
        // explicit selection copy before reporting failure to the user.
      }
    }
    if (!copied) {
      copied = copyWithSelectionFallback({ text: verificationReportJson.value });
    }
    if (!copied) {
      throw new Error('The browser rejected both clipboard methods.');
    }
    addToast({
      message: await ensureStrings.StandaloneVerificationPage__standalone_verification_json_copied(),
      duration: 4000,
    });
  } catch (error) {
    addToast({
      message: await ensureStrings.StandaloneVerificationPage__failed_to_copy_verification_json({ errorMessage: error instanceof Error ? error.message : String(error) }),
      duration: 8000,
    });
  }
}

defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
      // ESLint-required for defineExpose.
    },
  }) || {}),
});
</script>

<template>
  <main class="min-h-full bg-gray-50 px-4 py-8 dark:bg-gray-950 sm:px-8" data-testid="standalone-verification-page">
    <section class="mx-auto max-w-5xl space-y-5 rounded-2xl border border-cyan-200 bg-white p-5 shadow-sm dark:border-cyan-900/50 dark:bg-gray-900">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 class="text-lg font-bold text-cyan-900 dark:text-cyan-200">{{ lazyStrings.StandaloneVerificationPage__standalone_verification() }}</h1>
          <p class="mt-1 max-w-2xl text-sm font-medium leading-relaxed text-cyan-800/70 dark:text-cyan-300/70">
            {{ lazyStrings.StandaloneVerificationPage__checks_file_protocol_startup_routing_styles_lazy_chunks_systemjs_and_repeated_worker_creation_without_changing_chats_or_settings() }}
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
            {{ isRunning ? lazyStrings.StandaloneVerificationPage__running() : lazyStrings.StandaloneVerificationPage__run_standalone_verification() }}
          </button>
          <button
            v-if="verificationReport"
            class="inline-flex items-center gap-2 rounded-xl border border-cyan-300 bg-white px-4 py-2.5 text-xs font-bold text-cyan-900 shadow-sm transition hover:bg-cyan-50 dark:border-cyan-800 dark:bg-gray-950 dark:text-cyan-200"
            data-testid="copy-standalone-verification-json-button"
            @click="copyVerificationReportJson"
          >
            <ClipboardCheckIcon class="h-4 w-4" />
            {{ lazyStrings.StandaloneVerificationPage__copy_json() }}
          </button>
        </div>
      </div>

      <p
        v-if="!isStandaloneBuild"
        class="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm font-medium text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-200"
        data-testid="standalone-verification-unavailable"
      >
        {{ lazyStrings.StandaloneVerificationPage__these_checks_require_a_standalone_build_opened_through_file() }}
      </p>

      <p class="text-xs text-gray-500 dark:text-gray-400">
        {{ lazyStrings.StandaloneVerificationPage__copied_diagnostics_may_contain_local_file_paths_in_browser_provided_error_stacks_or_resource_timing_entries() }}
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
          {{ lazyStrings.StandaloneVerificationPage__verification_summary({ status: verificationReport.status, passed: verificationReport.summary.passed, failed: verificationReport.summary.failed }) }}
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
