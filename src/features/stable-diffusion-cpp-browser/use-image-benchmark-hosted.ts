import { computed, watch, onScopeDispose } from 'vue';
import { nanoid } from 'nanoid';
import rawConfiguration from 'virtual:stable-diffusion-cpp-browser/config';
import { ensureStrings } from '@/strings';
import { createBenchmarkForm } from './benchmark-form';
import type { ImageBenchmarkView } from './benchmark-view';
import type { ImageGenerationView } from './use-image-generation-types';
import { configurationSchema } from './types';
import { createImageClient } from '@/features/stable-diffusion-cpp-browser/worker/client';
import { createBenchmarkRunner } from './benchmark/runner';
import { createBenchmarkPlan, benchmarkParameters } from './benchmark/plan';
import { benchmarkArchiveBlob } from './benchmark/archive';

export function useImageBenchmark({ generation }: { generation: ImageGenerationView }): ImageBenchmarkView {
  const form = createBenchmarkForm(), config = configurationSchema.parse(rawConfiguration);
  let disposed = false; const seen = new Set<string>(); let exportControl: AbortController | undefined;
  const available = computed(() => {
    switch (config.kind) {
    case 'available': return true; case 'unavailable': return false; default: { const exhaustive: never = config; throw new Error(String(exhaustive)); }
    }
  });
  const busy = computed(() => form.state.value === 'running');
  const targets = generation.library.benchmarkTargets;
  const runner = createBenchmarkRunner({ createClient: () => createImageClient(), now: () => performance.now(), date: () => new Date().toISOString(),
    observeVisibility({ changed }) {
      changed({ hidden: document.visibilityState === 'hidden' });
      const listener = () => changed({ hidden: document.visibilityState === 'hidden' });
      document.addEventListener('visibilitychange', listener);
      return () => document.removeEventListener('visibilitychange', listener);
    },
    publish({ runs, current, progress }) {
      if (!disposed) {
        form.runs.value = runs; form.current.value = current; form.progress.value = progress;
      }
    },
  });
  watch(targets, values => {
    if (busy.value) return;
    const selectable = values.filter(value => value.models !== undefined).map(value => value.id);
    // A deliberate deselection (including Clear all) survives inventory refreshes.
    form.selected.value = [...form.selected.value.filter(id => selectable.includes(id)), ...selectable.filter(id => !seen.has(id))];
    for (const id of selectable) seen.add(id);
  }, { immediate: true });
  const plannedRuns = computed(() => form.selected.value.length * form.protocol.value.repeats);
  function candidatePlan() {
    const artifact = (() => {
      switch (config.kind) {
      case 'available': return config.artifacts.find(a => a.profile === generation.profile.value);
      case 'unavailable': return undefined;
      default: { const exhaustive: never = config; throw new Error(String(exhaustive)); }
      }
    })();
    if (!artifact) throw new Error('Image runtime is unavailable');
    const chosen = targets.value.filter(t => form.selected.value.includes(t.id));
    if (chosen.length !== form.selected.value.length) throw new Error('Selected model inventory changed');
    return createBenchmarkPlan({ id: '', createdAt: '', appVersion: typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'unknown',
      notes: form.notes.value, protocol: form.protocol.value, targets: chosen, common: form.common.value, overrides: form.overrides.value,
      strategy: form.strategy.value, artifact, baseUrl: new URL(import.meta.env.BASE_URL, window.location.href).href,
      preview: form.preview.value, weightResidency: generation.weightResidency.value, gpuBudgetMiB: generation.gpuBudgetMiB.value === '' ? undefined : generation.gpuBudgetMiB.value,
    });
  }
  const valid = computed(() => {
    try {
      candidatePlan(); return true;
    } catch {
      return false;
    }
  });
  const canStart = computed(() => !disposed && !busy.value && !form.exporting.value && !form.runs.value.length && generation.supported.value && !generation.busy.value && !generation.library.importing.value && !generation.library.downloading.value && generation.library.scanState.value === 'idle' && valid.value);
  async function start(): Promise<void> {
    if (!canStart.value) return;
    const plan = candidatePlan(); plan.id = nanoid(); plan.createdAt = new Date().toISOString();
    if (!generation.acquireBenchmark()) return;
    form.plan.value = plan; form.error.value = ''; form.feedback.value = ''; form.state.value = 'running';
    try {
      await runner.start({ plan });
    } catch (error) {
      if (!disposed) form.error.value = error instanceof Error ? error.message : String(error);
    } finally {
      generation.releaseBenchmark();
      if (!disposed) {
        const state = runner.snapshot()?.state;
        switch (state) {
        case 'cancelled': form.state.value = 'cancelled'; break;
        case 'running': case 'finished': case undefined: form.state.value = 'finished'; break;
        default: { const exhaustive: never = state; void exhaustive; }
        }
      }
    }
  }
  async function download(): Promise<void> {
    // Export outside timed runs, so ZIP work cannot contaminate step measurements.
    if (busy.value || form.exporting.value || !form.runs.value.length || disposed) return;
    const snapshot = runner.snapshot(); if (!snapshot) return;
    form.exporting.value = true; form.feedback.value = ''; const control = new AbortController(); exportControl = control;
    try {
      const blob = await benchmarkArchiveBlob({ snapshot, includePrompts: form.includePrompts.value, exportedAt: new Date().toISOString(), signal: control.signal });
      control.signal.throwIfAborted();
      const url = URL.createObjectURL(blob);
      try {
        const link = document.createElement('a'); link.href = url; link.download = `naidan-image-benchmark-${snapshot.plan.id}-${nanoid()}.zip`; link.click();
      } finally {
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
      const text = await ensureStrings.imageBenchmark__archive_saved(); if (!disposed) form.feedback.value = text;
    } catch (error) {
      if (!disposed) form.error.value = error instanceof Error ? error.message : String(error);
    } finally {
      exportControl = undefined; if (!disposed) form.exporting.value = false;
    }
  }
  onScopeDispose(() => {
    disposed = true; exportControl?.abort(); runner.dispose(); generation.releaseBenchmark();
  });
  return { ...form, available, targets, busy, canStart, plannedRuns, start, stop: () => runner.stop(), download,
    clear() {
      if (busy.value || form.exporting.value) return; runner.clear(); form.runs.value = []; form.plan.value = undefined; form.state.value = 'idle'; form.error.value = ''; form.feedback.value = '';
    },
    select({ mode }) {
      if (busy.value) return; switch (mode) {
      case 'all': form.selected.value = targets.value.filter(t => t.models !== undefined).map(t => t.id); break; case 'none': form.selected.value = []; break; default: { const exhaustive: never = mode; throw new Error(String(exhaustive)); }
      }
    },
    toggle({ id, selected }) {
      if (busy.value || !targets.value.some(t => t.id === id && t.models)) return; form.selected.value = selected ? [...new Set([...form.selected.value, id])] : form.selected.value.filter(value => value !== id);
    },
    effective({ target }) {
      return benchmarkParameters({ common: form.common.value, target, strategy: form.strategy.value, overrides: form.overrides.value[target.id] ?? {} }).parameters;
    },
    change({ id, change }) {
      if (busy.value) return; form.overrides.value = { ...form.overrides.value, [id]: { ...form.overrides.value[id], [change.key]: change.value } };
    },
    inherit({ id, key }) {
      if (busy.value) return; const next = { ...form.overrides.value[id] }; delete next[key]; form.overrides.value = { ...form.overrides.value, [id]: next };
    },
    ...((__BUILD_MODE_IS_TEST__ && {
      TEST_ONLY: {
        // Export internal state and logic used only for testing here. Do not reference these in production logic.
        // ESLint-required for useXxx return objects.
      },
    }) || {}),
  };
}
export const TEST_ONLY = {
};
