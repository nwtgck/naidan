import type {
  ModelSupportInvestigationCacheInventory,
  ModelSupportInvestigationCacheProvenance,
  ModelSupportInvestigationEvent,
  ModelSupportInvestigationModelDeclarations,
  ModelSupportInvestigationModelFilePlan,
  ModelSupportInvestigationPersistenceRoundTrip,
  ModelSupportInvestigationRepository,
  ModelSupportInvestigationRun,
  ModelSupportInvestigationStep,
  ModelSupportInvestigationStepId,
  ModelSupportInvestigationTemplateBehavior,
} from '@/features/transformers-js/model-support-investigation/types';
import { serializeInvestigationError } from '@/features/transformers-js/model-support-investigation/logic/serialize-investigation-error';


function recordStepError({
  run,
  stepId,
  error,
}: {
  run: ModelSupportInvestigationRun,
  stepId: ModelSupportInvestigationStepId,
  error: unknown,
}) {
  const serialized = serializeInvestigationError({ error });
  run.stepErrors ??= {};
  run.stepErrors[stepId] = [...(run.stepErrors[stepId] ?? []), serialized];
  return serialized;
}

function updateStep({
  steps,
  stepId,
  status,
  detail,
}: {
  steps: ModelSupportInvestigationStep[],
  stepId: ModelSupportInvestigationStepId,
  status: ModelSupportInvestigationStep['status'],
  detail: string,
}): ModelSupportInvestigationStep[] {
  return steps.map((step) => {
    if (step.id === stepId) return { ...step, status, detail };
    return step;
  });
}

export async function runPartialModelSupportInvestigation({
  runRuntimePreflight,
  inspectPersistenceRoundTrip,
  inspectRepository,
  inspectCache,
  verifyCacheProvenance,
  inspectDeclarations,
  inspectTemplateBehavior,
  inspectModelFilePlan,
  onEvent,
  onRunUpdate = () => undefined,
  now,
}: {
  runRuntimePreflight: () => Promise<ModelSupportInvestigationRun>,
  inspectPersistenceRoundTrip: () => Promise<ModelSupportInvestigationPersistenceRoundTrip>,
  inspectRepository: () => Promise<ModelSupportInvestigationRepository>,
  inspectCache: () => Promise<ModelSupportInvestigationCacheInventory>,
  verifyCacheProvenance: ({ repository, cache }: {
    repository: ModelSupportInvestigationRepository,
    cache: ModelSupportInvestigationCacheInventory,
  }) => Promise<ModelSupportInvestigationCacheProvenance>,
  inspectDeclarations: ({ repository }: {
    repository: ModelSupportInvestigationRepository,
  }) => Promise<ModelSupportInvestigationModelDeclarations>,
  inspectTemplateBehavior: ({ repository }: {
    repository: ModelSupportInvestigationRepository,
  }) => Promise<ModelSupportInvestigationTemplateBehavior>,
  inspectModelFilePlan: ({ repository, declarations, cache }: {
    repository: ModelSupportInvestigationRepository,
    declarations: ModelSupportInvestigationModelDeclarations,
    cache: ModelSupportInvestigationCacheInventory | undefined,
  }) => Promise<ModelSupportInvestigationModelFilePlan>,
  onEvent: ({ event }: { event: ModelSupportInvestigationEvent }) => void,
  onRunUpdate?: ({ run }: { run: ModelSupportInvestigationRun }) => void,
  now: () => string,
}): Promise<ModelSupportInvestigationRun> {
  const runtimeRun = await runRuntimePreflight();
  const run: ModelSupportInvestigationRun = {
    ...runtimeRun,
    scope: 'partial-runtime-repository-cache-declarations-template-model-files',
    repository: undefined,
    cache: undefined,
    declarations: undefined,
    templateBehavior: undefined,
    modelFilePlan: undefined,
    loadAttempts: [],
    productionLane: { status: "not-run", observation: undefined, partialObservation: undefined, error: undefined },
    laneComparison: undefined,
    stepErrors: structuredClone(runtimeRun.stepErrors ?? {}),
  };
  try {
    run.persistenceRoundTrip = await inspectPersistenceRoundTrip();
  } catch (error) {
    run.persistenceRoundTrip = {
      status: 'failed',
      fixtureId: 'tool-call-history-v1',
      method: 'chat-content-dto-json-roundtrip-v1',
      error: serializeInvestigationError({ error }),
    };
  }
  onRunUpdate({ run: structuredClone(run) });

  const errors: string[] = (() => {
    switch (runtimeRun.status) {
    case 'failed':
      return [runtimeRun.error ?? runtimeRun.currentOperation];
    case 'passed':
      return [];
    default: {
      const exhaustiveStatus: never = runtimeRun.status;
      return exhaustiveStatus;
    }
    }
  })();
  const emit = ({ stepId, status, detail }: {
    stepId: ModelSupportInvestigationStepId,
    status: ModelSupportInvestigationStep['status'],
    detail: string,
  }): void => {
    run.steps = updateStep({ steps: run.steps, stepId, status, detail });
    run.currentOperation = detail;
    run.completedAt = now();
    onRunUpdate({ run: structuredClone(run) });
    onEvent({ event: { stepId, status, detail } });
  };

  emit({ stepId: 'repository-information', status: 'running', detail: 'Resolving Hugging Face repository metadata and commit SHA' });
  try {
    run.repository = await inspectRepository();
    emit({
      stepId: 'repository-information',
      status: 'passed',
      detail: `Resolved ${run.repository.resolvedRevision} with ${run.repository.fileCount} repository files`,
    });
  } catch (error) {
    const detail = recordStepError({ run, stepId: 'repository-information', error }).message;
    errors.push(detail);
    emit({ stepId: 'repository-information', status: 'failed', detail });
  }

  emit({ stepId: 'existing-model-data', status: 'running', detail: 'Inspecting existing OPFS model files and completion markers' });
  try {
    run.cache = await inspectCache();
    onRunUpdate({ run: structuredClone(run) });
    let detail = run.cache.exists
      ? `Found ${run.cache.fileCount} files (${run.cache.totalBytes} bytes), ${run.cache.incompleteFileCount} incomplete`
      : 'No existing OPFS model directory was found';
    let status: ModelSupportInvestigationStep['status'] = 'passed';
    if (run.repository !== undefined && run.cache.exists) {
      try {
        run.cache.provenance = await verifyCacheProvenance({ repository: run.repository, cache: run.cache });
        detail = `${detail}; bounded cache provenance: ${run.cache.provenance.status}`;
      } catch (error) {
        const provenanceError = recordStepError({ run, stepId: 'existing-model-data', error }).message;
        errors.push(provenanceError);
        detail = `${detail}; bounded cache provenance failed: ${provenanceError}`;
        status = 'failed';
      }
    }
    emit({ stepId: 'existing-model-data', status, detail });
  } catch (error) {
    const detail = recordStepError({ run, stepId: 'existing-model-data', error }).message;
    errors.push(detail);
    emit({ stepId: 'existing-model-data', status: 'failed', detail });
  }

  if (run.repository === undefined) {
    const blockedDetail = 'Blocked because the resolved repository revision is unavailable';
    emit({
      stepId: 'model-declarations',
      status: 'blocked',
      detail: blockedDetail,
    });
    emit({
      stepId: 'template-behavior',
      status: 'blocked',
      detail: blockedDetail,
    });
    emit({
      stepId: 'model-file-plan',
      status: 'blocked',
      detail: blockedDetail,
    });
  } else {
    emit({
      stepId: 'model-declarations',
      status: 'running',
      detail: 'Fetching lightweight declarations from the resolved commit and checking public Auto classes',
    });
    try {
      run.declarations = await inspectDeclarations({ repository: run.repository });
      const supported = run.declarations.classCapabilities
        .filter(entry => entry.supports === true)
        .map(entry => entry.autoClass);
      const modelType = run.declarations.modelType ?? 'missing model_type';
      emit({
        stepId: 'model-declarations',
        status: 'passed',
        detail: run.declarations.fileFailures.length === 0
          ? `${modelType}: ${supported.length} public Auto classes support this model type`
          : `${modelType}: ${supported.length} public Auto classes support this model type; ${run.declarations.fileFailures.length} optional declaration files failed and were preserved as evidence`,
      });
    } catch (error) {
      const detail = recordStepError({ run, stepId: 'model-declarations', error }).message;
      errors.push(detail);
      emit({ stepId: 'model-declarations', status: 'failed', detail });
    }

    if (run.declarations === undefined) {
      emit({
        stepId: 'model-file-plan',
        status: 'blocked',
        detail: 'Blocked because model declarations are unavailable',
      });
    } else {
      emit({
        stepId: 'model-file-plan',
        status: 'running',
        detail: 'Planning fixed q4f16 and q4 model files with Transformers.js ModelRegistry',
      });
      try {
        run.modelFilePlan = await inspectModelFilePlan({
          repository: run.repository,
          declarations: run.declarations,
          cache: run.cache,
        });
        const eligible = run.modelFilePlan.candidates.filter(candidate => candidate.eligibility === 'eligible').length;
        const failed = run.modelFilePlan.candidates.filter(candidate => candidate.registryStatus === 'failed').length;
        emit({
          stepId: 'model-file-plan',
          status: 'passed',
          detail: `${eligible} of ${run.modelFilePlan.candidates.length} fixed candidates have all required repository files; ${failed} Registry failures`,
        });
      } catch (error) {
        const detail = recordStepError({ run, stepId: 'model-file-plan', error }).message;
        errors.push(detail);
        emit({ stepId: 'model-file-plan', status: 'failed', detail });
      }
    }

    emit({
      stepId: 'template-behavior',
      status: 'running',
      detail: 'Loading the tokenizer through the normal Chat revision while preserving the resolved commit as evidence',
    });
    try {
      run.templateBehavior = await inspectTemplateBehavior({ repository: run.repository });
      const passed = run.templateBehavior.cases.filter(item => item.status === 'passed').length;
      const failed = run.templateBehavior.cases.length - passed;
      emit({
        stepId: 'template-behavior',
        status: 'passed',
        detail: `${run.templateBehavior.tokenizerClass}: ${passed} template cases rendered, ${failed} recorded as unsupported or failed`,
      });
    } catch (error) {
      const detail = recordStepError({ run, stepId: 'template-behavior', error }).message;
      errors.push(detail);
      emit({ stepId: 'template-behavior', status: 'failed', detail });
    }
  }

  run.completedAt = now();
  run.status = errors.length === 0 ? 'passed' : 'failed';
  run.error = errors.length === 0 ? undefined : errors.join('; ');
  run.currentOperation = errors.length === 0
    ? 'Runtime, repository, existing model data, declaration, template behavior, and model file plan evidence collected'
    : 'Partial evidence collected with investigation failures';
  return run;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
