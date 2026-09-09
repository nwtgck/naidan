// @vitest-environment node
import { MessageChannel } from 'node:worker_threads';
import nodeEndpoint from 'comlink/dist/esm/node-adapter';
import { expect, it } from 'vitest';
import { exposeWorkerRemote, releaseWorkerRemote, workerProxy, wrapWorkerRemote, type WorkerServerApi } from '@/utils/worker-transport';
import type { IModelSupportInvestigationWorker, ModelSupportInvestigationPlanningWorkerRun } from '@/features/transformers-js/model-support-investigation/types';
import { freshMetadataResultSchema, type FreshMetadataResult } from '@/features/transformers-js/model-support-investigation/fresh-metadata-worker/types';
import { createInitialInvestigationCheckpoint } from '@/features/transformers-js/model-support-investigation/logic/investigation-recovery';
import { toPlanningWorkerRun } from '@/features/transformers-js/model-support-investigation/logic/planning-worker-run';

type PlanningApi = Pick<IModelSupportInvestigationWorker, 'runPartialInvestigation'>;

it('round-trips fresh raw metadata through the real top-level Comlink callback and planning checkpoint', async () => {
  const ports = new MessageChannel();
  const modelId = 'fixture/model';
  const revision = 'a'.repeat(40);
  const expected: FreshMetadataResult = {
    summary: {
      schemaVersion: 1, modelId, revision, source: 'fresh-network-memory', status: 'prepared',
      maximumBytes: 1024, receivedBytes: 2,
      requests: [{ consumer: 'runtime-preparation', path: 'config.json', request: 'full', status: 'complete', receivedBytes: 2 }],
      preparation: { processor: 'tokenizer', resourcePlansByCandidate: {} },
    },
    replayMetadata: {
      schemaVersion: 1, modelId, revision, status: 'complete', budgetBytes: 1024, receivedBytes: 2, retainedBytes: 2,
      files: [{ path: 'config.json', status: 'collected', source: 'remote-exact', byteLength: 2, sha256: '0'.repeat(64) }],
    },
    files: [{ path: 'config.json', blob: new Blob(['{}']) }],
  };
  const api: WorkerServerApi<PlanningApi> = {
    // Actual Comlink method with top-level proxy callbacks.
    async runPartialInvestigation(request, _onEvent, onCheckpoint, collect) {
      const result = freshMetadataResultSchema.parse(await collect({ request: {
        modelId: request.modelId, revision, maximumBytes: 1024, repositoryFiles: [{ path: 'config.json', size: 2 }],
      } }));
      const checkpoint = createInitialInvestigationCheckpoint({ modelId, runId: 'transport-fixture', now: () => '2026-09-09T00:00:00.000Z' });
      const run = toPlanningWorkerRun({ run: { ...checkpoint.run, freshMetadata: result.summary, replayMetadata: result.replayMetadata } });
      await onCheckpoint({ run, replayMetadata: result.files });
      return run;
    },
  };
  // Comlink's Node adapter bridges EventEmitter ports to its browser Endpoint interface.
  exposeWorkerRemote<PlanningApi>({ api, endpoint: nodeEndpoint(ports.port1) });
  const remote = wrapWorkerRemote<PlanningApi>({ endpoint: nodeEndpoint(ports.port2) });
  const checkpointReceived = Promise.withResolvers<{ run: ModelSupportInvestigationPlanningWorkerRun, files: Array<{ path: string, blob: Blob }> }>();
  try {
    const run = await remote.runPartialInvestigation(
      { modelId, externalNetworkPolicy: 'allow', executionPlan: { repositoryDownload: true, modelLoad: false, generation: false, continuity: false, capabilityProbes: false } },
      workerProxy({ value: () => undefined }),
      workerProxy({ value: ({ run, replayMetadata }) => checkpointReceived.resolve({ run, files: replayMetadata ?? [] }) }),
      workerProxy({ value: async ({ request }) => {
        expect(request).toEqual({ modelId, revision, maximumBytes: 1024, repositoryFiles: [{ path: 'config.json', size: 2 }] });
        return expected;
      } }),
    );
    const received = await checkpointReceived.promise;
    expect(run.freshMetadata).toEqual(expected.summary);
    expect(received.run.replayMetadata).toEqual(expected.replayMetadata);
    expect(received.files[0]?.path).toBe('config.json');
    expect(await received.files[0]!.blob.text()).toBe('{}');
  } finally {
    await releaseWorkerRemote({ remote });
    ports.port1.close();
    ports.port2.close();
  }
});
