import { gpuProfilingProfile } from '@/features/llama-cpp-browser/types';
import { gpuProfilePhaseSchema } from './gpu-profile-schema';
import type { PerformanceSnapshot, PerformanceTrial } from './types';

export function isGpuProfileTrial({ trial, snapshot }: { trial: PerformanceTrial, snapshot: PerformanceSnapshot }): boolean {
  return trial.lane === 'gpu-profile' || trial.options.profile === gpuProfilingProfile
    || snapshot.plan.steps.find(step => step.id === trial.stepId)?.lane === 'gpu-profile'
    || trial.summary?.performance?.gpuProfile !== undefined;
}

/** Rankings are request- and phase-local. Never merge warm-up, placement,
 * different tensor grids or another model into an apparently precise average. */
export function summarizeGpuProfiles({ snapshot }: { snapshot: PerformanceSnapshot }) {
  return snapshot.trials.filter(trial => isGpuProfileTrial({ trial, snapshot })).map(trial => {
    const step = snapshot.plan.steps.find(step => step.id === trial.stepId);
    const profile = trial.summary?.performance?.gpuProfile;
    return {
      attemptId: trial.id,
      stepId: trial.stepId,
      modelIndex: trial.modelIndex,
      lane: trial.lane ?? step?.lane,
      scenario: step?.scenario,
      position: step?.position,
      status: trial.status,
      observationStatus: profile?.status ?? 'missing',
      phases: gpuProfilePhaseSchema.options.map(phase => {
        const rows = profile?.rows.filter(row => row.phase === phase) ?? [];
        const retainedGpuMs = rows.reduce((sum, row) => sum + row.totalGpuMs, 0);
        return {
          phase,
          retainedGpuMs,
          rows: rows.toSorted((a, b) => b.totalGpuMs - a.totalGpuMs).map(row => ({
            ...row,
            // This is a share of retained observations, NOT of request wall time.
            shareOfRetainedPhaseGpuTime: retainedGpuMs > 0 ? row.totalGpuMs / retainedGpuMs : undefined,
            amortizedDispatchMs: row.dispatches > 0 ? row.totalGpuMs / row.dispatches : undefined,
          })),
        };
      }),
    };
  });
}

export const TEST_ONLY = {
};
