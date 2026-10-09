import type { PerformanceSnapshot, PerformanceTrial } from './types';

export function trialRates({ trial }: { trial: PerformanceTrial }) {
  const metrics = trial.summary?.performance;
  const start = metrics?.firstNonEogSampleMs, end = metrics?.lastNonEogSampleMs;
  const tokens = metrics?.nonEogTokens;
  const prefillMs = metrics?.stages.find(stage => stage.stage === 'prefill-decode')?.elapsedMs;
  return {
    generationTokensPerSecond: tokens !== undefined && tokens > 1 && start !== undefined && end !== undefined && end > start
      ? (tokens - 1) * 1000 / (end - start) : undefined,
    prefillTokensPerSecond: prefillMs !== undefined && prefillMs > 0 && metrics?.prefillDecodedTokens
      ? metrics.prefillDecodedTokens * 1000 / prefillMs : undefined,
  };
}
function median({ values }: { values: number[] }): number | undefined {
  if (!values.length) return undefined;
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1]! + sorted[middle]!) / 2;
}
/** Partition by effective context/batch, finish reason and actual work. Never
 * average an allocation fallback or a shortened answer into another condition. */
export function summarizePerformance({ snapshot }: { snapshot: PerformanceSnapshot }) {
  const groups = new Map<string, { modelIndex: number, scenario: string, position: string, profile: string, contextTokens: number | undefined,
    batchTokens: number | undefined, finishReason: string | undefined, parentFinishReason: string | undefined, promptTokens: number | undefined,
    reusedTokens: number | undefined, generatedTokens: number | undefined, trials: PerformanceTrial[] }>();
  for (const trial of snapshot.trials) {
    const step = snapshot.plan.steps.find(step => step.id === trial.stepId);
    if (!step || step.role !== 'measurement' || trial.status !== 'succeeded' || trial.exclusion.length) continue;
    const metrics = trial.summary?.performance;
    const condition = {
      modelIndex: trial.modelIndex,
      scenario: step.scenario,
      position: step.position,
      profile: trial.options.profile,
      contextTokens: metrics?.contextTokens,
      batchTokens: metrics?.prefillBatchTokens,
      finishReason: trial.output?.finishReason,
      parentFinishReason: step.dependsOn === undefined ? undefined : snapshot.trials.find(parent => parent.stepId === step.dependsOn)?.output?.finishReason,
      promptTokens: metrics?.promptTokens,
      reusedTokens: metrics?.reusedTokens,
      generatedTokens: metrics?.nonEogTokens,
    };
    const key = JSON.stringify(condition);
    const group = groups.get(key) ?? { ...condition, trials: [] };
    group.trials.push(trial); groups.set(key, group);
  }
  return Array.from(groups.values(), ({ trials, ...condition }) => ({
    ...condition,
    count: trials.length,
    medianFirstReceivedMs: median({ values: trials.flatMap(trial => trial.firstReceivedMs === undefined ? [] : [trial.firstReceivedMs]) }),
    medianElapsedMs: median({ values: trials.flatMap(trial => trial.elapsedMs === undefined ? [] : [trial.elapsedMs]) }),
    medianGenerationTokensPerSecond: median({
      values: trials.flatMap(trial => {
        const value = trialRates({ trial }).generationTokensPerSecond; return value === undefined ? [] : [value];
      }),
    }),
  }));
}
/** A successful request can reload changed local files or retry allocation.
 * Preserve its measurements, but do not treat it as an unchanged warm sample.
 * The recorder has no dropped count: reaching its cap cannot certify coverage. */
function warmPreparationEvidence({ trial, position }: { trial: PerformanceTrial, position: 'before' | 'after' }) {
  const events = trial.summary?.performance?.preparationEvents;
  const reasons: string[] = [], uncertainties: string[] = [];
  if (events === undefined || !events.some(event => event.event === 'model-reused')) uncertainties.push(`${position}-model-reuse-unconfirmed`);
  if (events !== undefined && events.length >= 64) uncertainties.push(`${position}-preparation-evidence-at-cap`);
  if (events?.some(event => event.event === 'load-start' || event.event === 'load-complete')) reasons.push(`${position}-model-reloaded`);
  if (events?.some(event => event.event === 'context-retry')) reasons.push(`${position}-context-retried`);
  return { reasons, uncertainties };
}
/** An exploratory comparison, never a causal or significance claim. Preserve
 * both attempts and explain every rejected comparison instead of filtering by
 * which direction a result moved. */
export function performanceFindings({ snapshot }: { snapshot: PerformanceSnapshot }) {
  return snapshot.plan.steps.filter(step => step.position === 'before').map(beforeStep => {
    const afterStep = snapshot.plan.steps.find(step => step.modelIndex === beforeStep.modelIndex && step.repetition === beforeStep.repetition && step.position === 'after');
    const before = snapshot.trials.find(trial => trial.stepId === beforeStep.id);
    const after = snapshot.trials.find(trial => trial.stepId === afterStep?.id);
    const reasons: string[] = [], uncertainties: string[] = [];
    if (!before || !after) reasons.push('missing-attempt');
    if (before && after) {
      for (const preparation of [warmPreparationEvidence({ trial: before, position: 'before' }), warmPreparationEvidence({ trial: after, position: 'after' })]) {
        reasons.push(...preparation.reasons); uncertainties.push(...preparation.uncertainties);
      }
      if (before.status !== 'succeeded' || after.status !== 'succeeded') reasons.push('unsuccessful-attempt');
      if (before.exclusion.length || after.exclusion.length) reasons.push('excluded-attempt');
      const a = before.summary?.performance, b = after.summary?.performance;
      if (!a || !b) reasons.push('missing-summary');
      else for (const field of ['contextTokens', 'prefillBatchTokens', 'promptTokens', 'reusedTokens', 'nonEogTokens'] as const) {
        if (a[field] === undefined || b[field] === undefined || a[field] !== b[field]) reasons.push(`different-or-missing-${field}`);
      }
      if (JSON.stringify(before.input) !== JSON.stringify(after.input) || JSON.stringify(before.options) !== JSON.stringify(after.options)) reasons.push('different-input-or-options');
      if (before.output?.content !== after.output?.content || before.output?.reasoningContent !== after.output?.reasoningContent || JSON.stringify(before.output?.toolCalls) !== JSON.stringify(after.output?.toolCalls)) reasons.push('different-generated-output');
      if (before.output?.finishReason !== after.output?.finishReason) reasons.push('different-finish-reason');
    }
    const a = before ? trialRates({ trial: before }).generationTokensPerSecond : undefined;
    const b = after ? trialRates({ trial: after }).generationTokensPerSecond : undefined;
    if (a === undefined || b === undefined || a <= 0) reasons.push('insufficient-output-for-rate');
    return {
      modelIndex: beforeStep.modelIndex,
      repetition: beforeStep.repetition,
      beforeAttempt: before?.id,
      afterAttempt: after?.id,
      meaning: 'chronological-same-workload-comparison-not-a-causal-estimate',
      reasons,
      uncertainties,
      beforeTokensPerSecond: a,
      afterTokensPerSecond: b,
      afterToBeforeRatio: !reasons.length && a !== undefined && b !== undefined ? b / a : undefined,
    };
  });
}
export const TEST_ONLY = {
};
