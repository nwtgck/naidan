// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { performanceEnvironment, performancePlan, performanceReport } from '@/features/llama-cpp-browser/test-utils/performance';
import type { PerformanceSnapshot, PerformanceTrial } from './types';
import { performanceFindings, summarizePerformance } from './summary';

type PreparationEvents = NonNullable<NonNullable<NonNullable<PerformanceTrial['summary']>['performance']>['preparationEvents']>;

function warmSnapshot({ models, repeats }: { models: number, repeats: number }): PerformanceSnapshot {
  const plan = performancePlan({ models, repeats });
  return {
    plan,
    environment: performanceEnvironment(),
    status: 'completed',
    modelErrors: [],
    trials: plan.steps.filter(step => step.position === 'before' || step.position === 'after').map(step => {
      const summary = performanceReport();
      summary.performance!.preparationEvents = [{ event: 'model-reused', observedMs: 0 }, { event: 'context-ready', observedMs: 1 }];
      return {
        id: step.id,
        stepId: step.id,
        modelIndex: step.modelIndex,
        status: 'succeeded',
        startedAt: plan.createdAt,
        input: [{ role: 'user', content: step.prompt }],
        options: plan.options,
        output: { content: 'same answer', reasoningContent: '', toolCalls: [], finishReason: 'stop' },
        partialText: 'same answer',
        partialReasoning: '',
        receivedEvents: 1,
        hiddenObserved: false,
        warnings: [],
        exclusion: [],
        summary,
      };
    }),
  };
}

describe('warm before/after preparation evidence', () => {
  it('retains the ratio for positively observed model reuse without reload or retry', () => {
    const snapshot = warmSnapshot({ models: 1, repeats: 1 });
    expect(performanceFindings({ snapshot })[0]).toMatchObject({ reasons: [], uncertainties: [], afterToBeforeRatio: 1 });
  });

  it('does not qualify an intentional initial load as a warm-sample reload', () => {
    const snapshot = warmSnapshot({ models: 1, repeats: 1 });
    const initial = snapshot.plan.steps.find(step => step.position === 'initial')!;
    const summary = performanceReport();
    summary.performance!.preparationEvents = (['runtime-ready', 'load-start', 'load-complete', 'context-start', 'context-ready'] as const).map(event => ({ event, observedMs: 0 }));
    snapshot.trials.unshift({ ...snapshot.trials[0]!, id: initial.id, stepId: initial.id, summary });
    expect(performanceFindings({ snapshot })).toMatchObject([{ reasons: [], uncertainties: [], afterToBeforeRatio: 1 }]);
  });

  for (const position of ['before', 'after'] as const) {
    it.each([
      ['load-start', 'model-reloaded'],
      ['load-complete', 'model-reloaded'],
      ['context-retry', 'context-retried'],
    ] as const)(`qualifies ${position} %s even when final workload and output match`, (event, reason) => {
      const snapshot = warmSnapshot({ models: 1, repeats: 1 });
      const trial = snapshot.trials[position === 'before' ? 0 : 1]!;
      trial.summary!.performance!.preparationEvents!.push({ event, observedMs: 1 });
      const finding = performanceFindings({ snapshot })[0]!;
      expect(finding.reasons).toContain(`${position}-${reason}`);
      expect(finding.afterToBeforeRatio).toBeUndefined();
      expect(finding.beforeTokensPerSecond).toBe(10);
      expect(finding.afterTokensPerSecond).toBe(10);
      expect(trial.exclusion).toEqual([]);
      expect(summarizePerformance({ snapshot })).toHaveLength(2);
    });
  }

  it.each([undefined, []] satisfies (PreparationEvents | undefined)[])('does not infer warm reuse from absent or empty evidence (%j)', events => {
    const snapshot = warmSnapshot({ models: 1, repeats: 1 });
    snapshot.trials[1]!.summary!.performance!.preparationEvents = events;
    expect(performanceFindings({ snapshot })[0]).toMatchObject({ reasons: [], uncertainties: ['after-model-reuse-unconfirmed'], afterToBeforeRatio: 1 });
  });

  it('accepts observed reuse below the cap, but cannot certify complete evidence at the cap', () => {
    const snapshot = warmSnapshot({ models: 1, repeats: 1 });
    const events = snapshot.trials[1]!.summary!.performance!.preparationEvents!;
    while (events.length < 63) events.push({ event: 'context-ready', observedMs: events.length });
    expect(performanceFindings({ snapshot })[0]!.reasons).toEqual([]);
    events.push({ event: 'context-ready', observedMs: 63 });
    expect(performanceFindings({ snapshot })[0]).toMatchObject({ reasons: [], uncertainties: ['after-preparation-evidence-at-cap'], afterToBeforeRatio: 1 });
  });

  it('still rejects an observed retry when the evidence also reaches the cap', () => {
    const snapshot = warmSnapshot({ models: 1, repeats: 1 });
    const events = snapshot.trials[0]!.summary!.performance!.preparationEvents!;
    events.push({ event: 'context-retry', observedMs: 2 });
    while (events.length < 64) events.push({ event: 'context-ready', observedMs: events.length });
    expect(performanceFindings({ snapshot })[0]).toMatchObject({
      reasons: ['before-context-retried'],
      uncertainties: ['before-preparation-evidence-at-cap'],
      afterToBeforeRatio: undefined,
    });
  });

  it('joins shuffled trials by step ID across models and repetitions', () => {
    const snapshot = warmSnapshot({ models: 2, repeats: 2 });
    const changed = snapshot.plan.steps.find(step => step.modelIndex === 1 && step.repetition === 2 && step.position === 'before')!;
    const trial = snapshot.trials.find(trial => trial.stepId === changed.id)!;
    trial.summary!.performance!.preparationEvents!.push({ event: 'context-retry', observedMs: 3 });
    snapshot.trials.reverse();
    const findings = performanceFindings({ snapshot });
    expect(findings).toHaveLength(4);
    for (const finding of findings) {
      const before = snapshot.plan.steps.find(step => step.modelIndex === finding.modelIndex && step.repetition === finding.repetition && step.position === 'before')!;
      const after = snapshot.plan.steps.find(step => step.modelIndex === finding.modelIndex && step.repetition === finding.repetition && step.position === 'after')!;
      expect(finding.beforeAttempt).toBe(before.id);
      expect(finding.afterAttempt).toBe(after.id);
      expect(finding.reasons).toEqual(before.id === changed.id ? ['before-context-retried'] : []);
      expect(finding.afterToBeforeRatio).toBe(before.id === changed.id ? undefined : 1);
    }
  });

  it.each([
    ['model-reused', 'model-reused', 'context-retry'],
    ['context-retry', 'context-ready', 'model-reused'],
    ['load-complete', 'model-reused', 'load-start'],
  ] as const)('does not let repeated or reordered reuse observations erase a failure (%j)', (...events) => {
    const snapshot = warmSnapshot({ models: 1, repeats: 1 });
    const step = snapshot.plan.steps.find(step => step.position === 'after')!;
    const trial = snapshot.trials.find(trial => trial.stepId === step.id)!;
    trial.summary!.performance!.preparationEvents = events.map((event, observedMs) => ({ event, observedMs }));
    const finding = performanceFindings({ snapshot })[0]!;
    expect(finding.reasons).toEqual([events.some(event => event === 'context-retry') ? 'after-context-retried' : 'after-model-reloaded']);
    expect(finding.uncertainties).toEqual([]);
    expect(finding.afterToBeforeRatio).toBeUndefined();
  });
});
