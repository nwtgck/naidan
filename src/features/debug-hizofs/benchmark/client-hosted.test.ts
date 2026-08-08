import { describe, expect, it, vi } from "vitest";
import { createHizoFSBenchmarkPresetConfiguration } from "@/features/debug-hizofs/benchmark/presets";
import type {
  HizoFSBenchmarkProgress,
  HizoFSBenchmarkReport,
} from "@/features/debug-hizofs/benchmark/types";
import type { IHizoFSBenchmarkWorker } from "@/features/debug-hizofs/benchmark/worker-client";
import { TEST_ONLY } from "@/features/debug-hizofs/benchmark/client-hosted";

function remote({
  onRun,
}: {
  onRun?: (
    progress: ({ progress }: { progress: HizoFSBenchmarkProgress }) => void,
  ) => Promise<HizoFSBenchmarkReport>;
} = {}): IHizoFSBenchmarkWorker {
  return {
    cancelCurrentOperation: vi.fn(async () => undefined),
    cleanBenchmarkData: vi.fn(async () => undefined),
    runBenchmark: vi.fn(async (_configuration, progress) => {
      if (onRun === undefined) throw new Error("unexpected benchmark run");
      return await onRun(progress);
    }),
  };
}

describe("HizoFS benchmark client boundary", () => {
  it("rejects invalid configuration before invoking the Worker", async () => {
    const worker = remote();
    const client = TEST_ONLY.createBenchmarkClient({
      remote: worker as never,
      release: vi.fn(async () => undefined),
      terminate: vi.fn(),
    });

    await expect(client.runBenchmark({
      configuration: { preset: "invalid" } as never,
      onProgress: () => undefined,
    })).rejects.toThrow();
    expect(worker.runBenchmark).not.toHaveBeenCalled();
  });

  it("validates progress and delegates cancellation, cleanup, and disposal", async () => {
    const progressEvents: HizoFSBenchmarkProgress[] = [];
    const release = vi.fn(async () => undefined);
    const terminate = vi.fn();
    const worker = remote({
      onRun: async progress => {
        progress({
          progress: {
            backend: "hizofs",
            caseId: "small_files_write_existing",
            completedUnits: 1,
            iteration: 0,
            message: "Running small files",
            stage: "measuring",
            totalUnits: 2,
            workload: "small_files",
          },
        });
        return { reportType: "invalid" } as never;
      },
    });
    const client = TEST_ONLY.createBenchmarkClient({
      remote: worker as never,
      release,
      terminate,
    });

    await expect(client.runBenchmark({
      configuration: createHizoFSBenchmarkPresetConfiguration({ preset: "quick" }),
      onProgress: ({ progress }) => progressEvents.push(progress),
    })).rejects.toThrow();
    expect(progressEvents).toHaveLength(1);
    expect(progressEvents[0]).toMatchObject({
      backend: "hizofs",
      stage: "measuring",
      workload: "small_files",
    });

    await client.cancelCurrentOperation();
    await client.cleanBenchmarkData();
    await client.dispose();
    client.terminate();
    expect(worker.cancelCurrentOperation).toHaveBeenCalledOnce();
    expect(worker.cleanBenchmarkData).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(terminate).toHaveBeenCalledOnce();
  });

  it("rejects pending RPCs locally when the benchmark Worker is force-terminated", async () => {
    const pendingRun = Promise.withResolvers<HizoFSBenchmarkReport>();
    const pendingCancel = Promise.withResolvers<void>();
    const release = vi.fn(async () => undefined);
    const terminate = vi.fn();
    const worker: IHizoFSBenchmarkWorker = {
      cancelCurrentOperation: vi.fn(() => pendingCancel.promise),
      cleanBenchmarkData: vi.fn(async () => undefined),
      runBenchmark: vi.fn(() => pendingRun.promise),
    };
    const client = TEST_ONLY.createBenchmarkClient({
      remote: worker as never,
      release,
      terminate,
    });

    const run = client.runBenchmark({
      configuration: createHizoFSBenchmarkPresetConfiguration({ preset: "quick" }),
      onProgress: () => undefined,
    });
    const cancel = client.cancelCurrentOperation();
    client.terminate();

    await expect(run).rejects.toMatchObject({ name: "AbortError" });
    await expect(cancel).rejects.toMatchObject({ name: "AbortError" });
    expect(terminate).toHaveBeenCalledOnce();
    await client.dispose();
    expect(release).not.toHaveBeenCalled();
  });
});
