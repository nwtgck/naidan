import type { ModelSupportInvestigationRun, ModelSupportInvestigationLoadAttemptError } from '@/features/transformers-js/model-support-investigation/types';
import { resolveInvestigationExecutionPlan } from './investigation-config';
import type { CaptureScenario } from './production-provider-capture-plan';

export type InvestigationFeatureOutcome = 'passed' | 'failed' | 'observed' | 'blocked' | 'not-run' | 'not-selected' | 'not-recorded' | 'unavailable';
export type InvestigationFeatureKind = 'first-turn' | 'continuity' | 'tool-result' | 'reasoning' | 'multimodal' | 'template' | 'reference-load' | 'input-strategy' | 'natural-generation' | 'tool-probe' | 'tool-parser' | 'tool-template' | 'stage';
export interface InvestigationFeatureResult {
  id: string;
  kind: InvestigationFeatureKind;
  context: string;
  outcome: InvestigationFeatureOutcome;
  detail: string | undefined;
  comparisonMismatch: boolean;
  needsAttention: boolean;
}

type Observation = { status: 'passed' | 'failed' | 'observed' | 'not-run' | 'unavailable' | 'blocked'; error?: ModelSupportInvestigationLoadAttemptError | undefined; reason?: string };

function providerFeatureKind({ scenario }: { scenario: CaptureScenario }): InvestigationFeatureKind {
  switch (scenario) {
  case 'first-turn': return 'first-turn';
  case 'continuity': return 'continuity';
  case 'independent-next-input': case 'system-user': case 'supplied-history': return 'natural-generation';
  case 'reasoning-none': case 'reasoning-low': case 'reasoning-medium': case 'reasoning-high': return 'reasoning';
  case 'natural-tool-minimal': case 'natural-tool-representative': return 'tool-probe';
  case 'structured-tool-history': return 'tool-result';
  case 'image': return 'multimodal';
  default: { const exhaustive: never = scenario; return exhaustive; }
  }
}

/** Presentation of recorded checks, never an inference that the model is correct. */
export function investigationFeatureResults({ run }: { run: ModelSupportInvestigationRun }) {
  const plan = run.executionPlan ?? (run.requestedConfiguration === undefined ? undefined
    : resolveInvestigationExecutionPlan({ scope: run.requestedConfiguration.scope }));
  const results: InvestigationFeatureResult[] = [];
  function add({ id, kind, context, observation, selected, comparisonMismatch }: {
    id: string; kind: InvestigationFeatureKind; context: string;
    observation: Observation | undefined; selected: boolean | undefined; comparisonMismatch: boolean;
  }) {
    const notExecuted = observation === undefined || observation.status === 'not-run' || observation.status === 'unavailable';
    const outcome = notExecuted && selected === false ? 'not-selected' : observation?.status ?? 'not-recorded';
    results.push({
      id, kind, context, outcome,
      detail: observation?.error === undefined ? observation?.reason : `${observation.error.name}: ${observation.error.message}`,
      comparisonMismatch,
      needsAttention: outcome === 'failed' || outcome === 'blocked' || outcome === 'not-run'
        || (outcome === 'unavailable' && selected === true),
    });
  }
  const provider = run.productionProviderCapture;
  const summary = run.productionProviderInvestigation;
  if (provider !== undefined || summary !== undefined) {
    // The small validated summary remains available even if the bounded raw
    // Provider envelope was refused. Neither fulfillment nor collection is a
    // correctness oracle for the generated response or its native replay.
    const requests = summary?.requests ?? provider!.requests.map(request => ({
      requestId: request.requestId, scenario: request.scenario, status: request.status,
      notStartedReason: request.notStartedReason, outcome: request.trace.settled?.outcome.status,
      completeness: request.trace.completeness,
    }));
    for (const request of requests) {
      let outcome: InvestigationFeatureOutcome;
      let detail: string | undefined;
      switch (request.status) {
      case 'settled':
        switch (request.outcome) {
        case 'rejected': outcome = 'failed'; detail = 'The Provider request rejected.'; break;
        case 'fulfilled': outcome = 'observed'; detail = 'The Provider request fulfilled; response correctness was not certified.'; break;
        case undefined: outcome = 'not-recorded'; detail = 'The settlement outcome was not recorded.'; break;
        default: { const exhaustive: never = request.outcome; throw new Error('Unhandled Provider outcome: ' + exhaustive); }
        }
        break;
      case 'awaiting-settlement':
        outcome = 'not-run'; detail = 'The request started, but settlement was not observed at the cutoff.';
        break;
      case 'not-started':
        switch (request.notStartedReason) {
        case 'scope-not-selected': outcome = 'not-selected'; break;
        case undefined: case 'not-yet-started': case 'first-settlement-unavailable': case 'legacy-script-stopped':
        case 'runtime-unavailable': case 'aborted': case 'deadline': case 'disposed': outcome = 'blocked'; break;
        default: { const exhaustive: never = request.notStartedReason; throw new Error('Unhandled Provider not-started reason: ' + exhaustive); }
        }
        detail = request.notStartedReason;
        break;
      default: { const exhaustive: never = request.status; throw new Error('Unhandled Provider request status: ' + exhaustive); }
      }
      results.push({ id: `provider-${request.requestId}`, kind: providerFeatureKind({ scenario: request.scenario }),
        context: `Provider / ${request.scenario}`, outcome, detail, comparisonMismatch: false,
        needsAttention: outcome === 'failed' || outcome === 'blocked' || outcome === 'not-run',
      });
      switch (request.completeness) {
      case 'complete': break;
      case 'incomplete':
        results.push({ id: `provider-recording-${request.requestId}`, kind: 'stage', context: `Provider / ${request.scenario}`,
          outcome: 'not-recorded', detail: 'The bounded callback projection is incomplete; the request outcome above is unchanged.', comparisonMismatch: false, needsAttention: true });
        break;
      default: { const exhaustive: never = request.completeness; throw new Error('Unhandled Provider completeness: ' + exhaustive); }
      }
    }
    if (run.loadAttempts.length === 0) results.push({ id: 'reference-not-selected', kind: 'reference-load', context: 'Reference', outcome: 'not-selected',
      detail: 'This investigation used the ordinary Provider route; the separate Reference comparison was not executed.', comparisonMismatch: false, needsAttention: false });
  } else {
    const production = run.productionLane.observation ?? run.productionLane.partialObservation;
    add({ id: 'production-first-turn', kind: 'first-turn', context: 'Production', observation: production?.firstTurn, selected: plan?.generation, comparisonMismatch: false });
    add({ id: 'production-continuity', kind: 'continuity', context: 'Production', observation: production?.continuity, selected: plan?.continuity,
      comparisonMismatch: production?.continuity?.status === 'passed' && production.continuity.prefixComparison.exactPrefixMatch === false });
    add({ id: 'production-tool-result', kind: 'tool-result', context: 'Production', observation: production?.toolResultContinuation, selected: plan?.capabilityProbes,
      comparisonMismatch: production?.toolResultContinuation?.status === 'passed' && !production.toolResultContinuation.inputTokenExactMatch });
    add({ id: 'production-reasoning', kind: 'reasoning', context: 'Production', observation: production?.reasoning, selected: plan?.capabilityProbes, comparisonMismatch: false });
    add({ id: 'production-multimodal', kind: 'multimodal', context: 'Production', observation: production?.multimodal, selected: plan?.capabilityProbes, comparisonMismatch: false });
  }

  // A stage can finish collecting evidence while a nested check fails. Only
  // actual stage failures/blockers are repeated here, with their own reasons.
  for (const step of run.steps) {
    if (step.status !== 'failed' && step.status !== 'blocked') continue;
    add({ id: `stage-${step.id}`, kind: 'stage', context: step.id,
      observation: { status: step.status, reason: step.detail }, selected: undefined, comparisonMismatch: false });
  }
  for (const item of run.templateBehavior?.cases ?? []) {
    add({ id: `template-${item.caseId}`, kind: 'template', context: item.caseId, observation: item, selected: undefined, comparisonMismatch: false });
  }
  for (const attempt of run.loadAttempts) {
    const context = `Reference / ${attempt.candidateId} / ${attempt.attemptId}`;
    add({ id: `reference-${attempt.attemptId}`, kind: 'reference-load', context, observation: attempt, selected: plan?.modelLoad, comparisonMismatch: false });
    for (const [index, input] of attempt.inputStrategyAttempts.entries()) {
      add({ id: `${attempt.attemptId}-input-${index}`, kind: 'input-strategy', context: `${context} / ${input.strategy}`, observation: input, selected: plan?.generation, comparisonMismatch: false });
    }
    add({ id: `${attempt.attemptId}-natural`, kind: 'natural-generation', context, observation: attempt.naturalGeneration, selected: plan?.generation, comparisonMismatch: false });
    const probe = attempt.toolProtocolProbe;
    add({ id: `${attempt.attemptId}-tools`, kind: 'tool-probe', context, observation: probe, selected: plan?.capabilityProbes,
      comparisonMismatch: probe?.status === 'observed' && !probe.exactMatch });
    if (probe === undefined) continue;
    switch (probe.status) {
    case 'observed':
      add({ id: `${attempt.attemptId}-parser`, kind: 'tool-parser', context, observation: probe.parserObservation, selected: plan?.capabilityProbes, comparisonMismatch: false });
      add({ id: `${attempt.attemptId}-tool-template`, kind: 'tool-template', context, observation: probe.toolResultTemplateRoundTrip, selected: plan?.capabilityProbes, comparisonMismatch: false });
      break;
    case 'failed':
    case 'unavailable': break;
    default: {
      const exhaustive: never = probe;
      throw new Error(`Unhandled tool probe: ${exhaustive}`);
    }
    }
  }
  // Keep actionable failures and blockers above successful/observed checks.
  results.sort((left, right) => Number(right.needsAttention) - Number(left.needsAttention));
  return {
    results,
    failed: results.filter(item => item.outcome === 'failed').length,
    notRun: results.filter(item => item.needsAttention && item.outcome !== 'failed').length,
  };
}

export function renderInvestigationFeatureResults({ run }: { run: ModelSupportInvestigationRun }): string {
  const summary = investigationFeatureResults({ run });
  return `\
## Recorded feature checks

Collection completion does not certify feature correctness. Passed means the recorded check executed successfully; observed means evidence was collected without a correctness verdict. Unselected scopes are not pending work. A comparison mismatch is an observation, not by itself a feature failure.

- Checks: ${summary.failed} failed; ${summary.notRun} blocked or not run.
${summary.results.map(item => `- ${item.id}: ${item.outcome} (${item.context})${item.detail === undefined ? '' : ` — ${item.detail}`}${item.comparisonMismatch ? ' — Comparison mismatch observed; correctness not determined.' : ''}`).join('\n')}
`;
}

export const TEST_ONLY = {
};
