import type {
  ModelSupportInvestigationPlanningWorkerRun,
  ModelSupportInvestigationRun,
} from '@/features/transformers-js/model-support-investigation/types';

export function toPlanningWorkerRun({
  run,
}: {
  run: ModelSupportInvestigationRun,
}): ModelSupportInvestigationPlanningWorkerRun {
  const {
    loadAttempts,
    activeLoadAttempt,
    productionLane,
    laneComparison,
    ...planningRun
  } = run;
  if (loadAttempts.length !== 0) {
    throw new Error('Planning Worker must not return model load attempts');
  }
  if (activeLoadAttempt !== undefined) {
    throw new Error('Planning Worker must not return an active model load attempt');
  }
  switch (productionLane.status) {
  case 'not-run':
    break;
  case 'passed':
  case 'failed':
  case 'running':
    throw new Error(`Planning Worker must not return Production Lane status ${productionLane.status}`);
  default: {
    const _ex: never = productionLane.status;
    throw new Error(`Unhandled Production Lane status: ${String(_ex)}`);
  }
  }
  if (laneComparison !== undefined) {
    throw new Error('Planning Worker must not return lane comparison evidence');
  }
  return planningRun;
}

export function fromPlanningWorkerRun({
  run,
}: {
  run: ModelSupportInvestigationPlanningWorkerRun,
}): ModelSupportInvestigationRun {
  return {
    ...run,
    loadAttempts: [],
    activeLoadAttempt: undefined,
    productionLane: {
      status: 'not-run',
      observation: undefined,
      partialObservation: undefined,
      error: undefined,
    },
    laneComparison: undefined,
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
