import { MessageChannel } from "node:worker_threads";
import * as Comlink from "comlink";
import { describe, expect, it, vi } from "vitest";
import type {
  IModelSupportInvestigationWorker,
  ModelSupportInvestigationEvent,
  ModelSupportInvestigationLoadAttemptCheckpoint,
  ModelSupportInvestigationLoadAttemptEvent,
} from "@/features/transformers-js/model-support-investigation/types";
import type {
  ITransformersJsWorker,
  TransformersJsProductionInvestigationProgressCallback,
} from "@/features/transformers-js/types";

async function releaseRemote({ remote, ports }: {
  remote: { [Comlink.releaseProxy]: () => void | Promise<void> },
  ports: MessageChannel,
}): Promise<void> {
  try {
    await remote[Comlink.releaseProxy]();
  } finally {
    ports.port1.close();
    ports.port2.close();
  }
}

describe("Transformers.js Comlink transport contracts", () => {
  it("transports investigation callbacks only as top-level Comlink proxy arguments", async () => {
    const ports = new MessageChannel();
    const planningEvent: ModelSupportInvestigationEvent = {
      stepId: "runtime-assets",
      status: "running",
      detail: "runtime preflight",
    };
    const attemptEvent: ModelSupportInvestigationLoadAttemptEvent = {
      stage: "model-load",
      status: "running",
      detail: "candidate model load",
      at: "2026-08-07T00:00:00.000Z",
    };

    const attemptCheckpoint: ModelSupportInvestigationLoadAttemptCheckpoint = {
      attemptId: "attempt-1",
      candidateId: "webgpu-q4",
      device: "webgpu",
      dtype: "q4",
      autoClass: "AutoModelForCausalLM",
      resolvedRevision: "a".repeat(40),
      startedAt: "2026-08-07T00:00:00.000Z",
      checkpointedAt: "2026-08-07T00:00:01.000Z",
      status: "running",
      currentStage: "model-load",
      events: [attemptEvent],
      inputStrategyAttempts: [],
      activeInputStrategy: undefined,
      selectedInputStrategy: undefined,
      inputTokenCount: undefined,
      inputTokenIds: [],
      inputTensors: [],
      loadedModel: undefined,
      generatedTokenIds: [],
      generatedText: undefined,
      naturalGeneration: undefined,
      toolProtocolProbe: undefined,
      modelType: "llama",
      error: undefined,
    };

    const exposedWorker: IModelSupportInvestigationWorker = {
      async runPartialInvestigation(modelId, onEvent, onRunCheckpoint) {
        onEvent({ event: planningEvent });
        onRunCheckpoint({ run: { modelId } as never });
        return { modelId } as never;
      },
      async inspectDownloadedTemplateBehavior() {
        return {} as never;
      },
      async runCandidateAttempt(
        _repository,
        _declarations,
        _templateBehavior,
        _loaderRevisionOption,
        _candidate,
        onEvent,
        onAttemptEvent,
        onAttemptCheckpoint,
      ) {
        onEvent({ event: planningEvent });
        onAttemptEvent({ event: attemptEvent });
        onAttemptCheckpoint({ attempt: attemptCheckpoint });
        return { status: "passed" } as never;
      },
    };
    Comlink.expose(exposedWorker, ports.port1 as unknown as Comlink.Endpoint);
    const remote = Comlink.wrap<IModelSupportInvestigationWorker>(ports.port2 as unknown as Comlink.Endpoint);
    const onEvent = vi.fn();
    const onRunCheckpoint = vi.fn();
    const onAttemptEvent = vi.fn();
    const onAttemptCheckpoint = vi.fn();

    try {
      const planningResult = await remote.runPartialInvestigation(
        "org/model",
        Comlink.proxy(onEvent),
        Comlink.proxy(onRunCheckpoint),
      );
      await remote.runCandidateAttempt(
        {} as never,
        {} as never,
        {} as never,
        null,
        {} as never,
        Comlink.proxy(onEvent),
        Comlink.proxy(onAttemptEvent),
        Comlink.proxy(onAttemptCheckpoint),
      );

      expect(planningResult).toEqual({ modelId: "org/model" });
      await vi.waitFor(() => {
        expect(onEvent).toHaveBeenCalledTimes(2);
        expect(onRunCheckpoint).toHaveBeenCalledTimes(1);
        expect(onAttemptEvent).toHaveBeenCalledTimes(1);
        expect(onAttemptCheckpoint).toHaveBeenCalledTimes(1);
      });
      expect(onEvent).toHaveBeenCalledWith({ event: planningEvent });
      expect(onRunCheckpoint).toHaveBeenCalledWith({ run: { modelId: "org/model" } });
      expect(onAttemptEvent).toHaveBeenCalledWith({ event: attemptEvent });
      expect(onAttemptCheckpoint).toHaveBeenCalledWith({ attempt: attemptCheckpoint });
    } finally {
      await releaseRemote({ remote, ports });
    }
  });

  it("transports the Production investigation progress callback as a top-level Comlink proxy argument", async () => {
    const ports = new MessageChannel();
    type ProductionRemote = Pick<ITransformersJsWorker, "runModelSupportInvestigationScenario">;
    const exposedWorker: ProductionRemote = {
      async runModelSupportInvestigationScenario(scenario, progressCallback) {
        progressCallback({ event: { kind: "stage", status: "model-support-production-model-load" } });
        return { modelId: scenario.modelId } as never;
      },
    };
    Comlink.expose(exposedWorker, ports.port1 as unknown as Comlink.Endpoint);
    const remote = Comlink.wrap<ProductionRemote>(ports.port2 as unknown as Comlink.Endpoint);
    const progressCallback = vi.fn<TransformersJsProductionInvestigationProgressCallback>();

    try {
      const result = await remote.runModelSupportInvestigationScenario(
        { modelId: "org/model" } as never,
        Comlink.proxy(progressCallback),
        Comlink.proxy(vi.fn()),
      );

      expect(result).toEqual({ modelId: "org/model" });
      await vi.waitFor(() => {
        expect(progressCallback).toHaveBeenCalledTimes(1);
      });
      expect(progressCallback).toHaveBeenCalledWith({
        event: { kind: "stage", status: "model-support-production-model-load" },
      });
    } finally {
      await releaseRemote({ remote, ports });
    }
  });
});
