// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createInitialInvestigationCheckpoint } from './investigation-recovery';
import { createProductionProviderCaptureOwner } from './production-provider-capture-owner';
import { fromPlanningWorkerRun, toPlanningWorkerRun } from './planning-worker-run';

function initialRun() {
  return createInitialInvestigationCheckpoint({ modelId: 'fixture/model', runId: 'planning-capture', now: () => '2026-09-09T00:00:00.000Z' }).run;
}

describe('Planning Worker Provider capture ownership', () => {
  it('omits an undefined host capture while preserving the ordinary planning round trip', () => {
    const run = initialRun();
    const planning = toPlanningWorkerRun({ run: { ...run, productionProviderCapture: undefined } });
    expect(Object.hasOwn(planning, 'productionProviderCapture')).toBe(false);
    expect(fromPlanningWorkerRun({ run: planning })).toEqual(run);
  });

  it('rejects a defined host capture instead of transferring it to the Planning Worker', async () => {
    const run = initialRun();
    const owner = createProductionProviderCaptureOwner({ runId: run.runId, modelId: run.modelId, plan: 'first-only',
      createWorkerClient: () => {
        throw new Error('This serialization test must not create a Worker');
      },
      traceLimits: { maximumEvents: 10, maximumCharacters: 100 },
    });
    try {
      expect(() => toPlanningWorkerRun({ run: { ...run, productionProviderCapture: owner.snapshot() } })).toThrow('Planning Worker must not return Production Provider capture');
    } finally {
      await owner.dispose();
    }
  });

  it('rejects a forged returned capture property even when its value is undefined', () => {
    const planning = toPlanningWorkerRun({ run: initialRun() });
    const forged = { ...planning, productionProviderCapture: undefined };
    expect(() => fromPlanningWorkerRun({ run: forged })).toThrow('Planning Worker must not return Production Provider capture');
  });

  it('rejects a returned capture accessor without executing it', () => {
    const planning = toPlanningWorkerRun({ run: initialRun() });
    const getter = vi.fn(() => {
      throw new Error('Private accessor must not execute');
    });
    const forged = Object.defineProperty({ ...planning }, 'productionProviderCapture', { enumerable: true, get: getter });
    expect(() => fromPlanningWorkerRun({ run: forged })).toThrow('Planning Worker must not return Production Provider capture');
    expect(getter).not.toHaveBeenCalled();
  });

  it('omits an undefined host summary and rejects a forged summary property', () => {
    const run = initialRun();
    const planning = toPlanningWorkerRun({ run: { ...run, productionProviderInvestigation: undefined } });
    expect(Object.hasOwn(planning, 'productionProviderInvestigation')).toBe(false);
    const forgedValue = { ...planning, productionProviderInvestigation: undefined };
    expect(() => fromPlanningWorkerRun({ run: forgedValue })).toThrow('Planning Worker must not return Production Provider capture');
    const getter = vi.fn(() => {
      throw new Error('Private summary accessor');
    });
    const forged = Object.defineProperty({ ...planning }, 'productionProviderInvestigation', { get: getter });
    expect(() => fromPlanningWorkerRun({ run: forged })).toThrow('Planning Worker must not return Production Provider capture');
    expect(getter).not.toHaveBeenCalled();
  });
});
