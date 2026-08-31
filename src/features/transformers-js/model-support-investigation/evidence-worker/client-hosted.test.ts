import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IModelSupportInvestigationEvidenceWorker } from "@/features/transformers-js/model-support-investigation/evidence-worker/types";

const mocks = vi.hoisted(() => ({
  release: vi.fn(),
  wrap: vi.fn(),
  terminate: vi.fn(),
}));

vi.mock("@/utils/worker-transport", () => ({
  releaseWorkerRemote: mocks.release,
  wrapWorkerRemote: mocks.wrap,
}));

class MockWorker {
  terminate = mocks.terminate;
}

vi.stubGlobal("Worker", MockWorker);

describe("createModelSupportInvestigationEvidenceWorkerClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it("exports Evidence in a dedicated Worker and terminates it after disposal", async () => {
    const archive = { blob: new Blob(["zip"]), fileName: "evidence.zip" };
    const remote: IModelSupportInvestigationEvidenceWorker = {
      createPartialEvidence: vi.fn(async () => archive),
    };
    mocks.wrap.mockReturnValue(remote);
    mocks.release.mockResolvedValue(undefined);

    const { createModelSupportInvestigationEvidenceWorkerClient } = await import("./client-hosted");
    const client = createModelSupportInvestigationEvidenceWorkerClient();
    const run = { runId: "run-1" } as Parameters<typeof client.createPartialEvidence>[0]["run"];
    const result = await client.createPartialEvidence({ run, recovery: undefined });

    expect(result).toBe(archive);
    expect(remote.createPartialEvidence).toHaveBeenCalledTimes(1);
    const request = vi.mocked(remote.createPartialEvidence).mock.calls[0]?.[0].request;
    expect(request).toBeInstanceOf(Blob);
    expect(JSON.parse(await request!.text())).toEqual({
      schemaVersion: 1,
      run: { runId: "run-1" },
    });
    await client.dispose();
    expect(mocks.release).toHaveBeenCalledWith({ remote });
    expect(mocks.terminate).toHaveBeenCalledTimes(1);
  });

  it("terminates a hung export at the deadline without trying to release the dead Worker", async () => {
    vi.useFakeTimers();
    const remote: IModelSupportInvestigationEvidenceWorker = {
      createPartialEvidence: vi.fn((): Promise<never> => new Promise<never>(() => undefined)),
    };
    mocks.wrap.mockReturnValue(remote);

    const {
      createModelSupportInvestigationEvidenceWorkerClient,
      ModelSupportInvestigationEvidenceExportTimeoutError,
    } = await import("./client-hosted");
    const client = createModelSupportInvestigationEvidenceWorkerClient({ timeoutMs: 50 });
    const run = { runId: "run-hung" } as Parameters<typeof client.createPartialEvidence>[0]["run"];
    const exportPromise = client.createPartialEvidence({ run, recovery: undefined });
    const exportExpectation = expect(exportPromise).rejects.toEqual(
      new ModelSupportInvestigationEvidenceExportTimeoutError({ timeoutMs: 50 }),
    );

    await vi.advanceTimersByTimeAsync(50);
    await exportExpectation;
    expect(mocks.terminate).toHaveBeenCalledTimes(1);
    expect(mocks.release).not.toHaveBeenCalled();

    await client.dispose();
    expect(mocks.terminate).toHaveBeenCalledTimes(1);
    expect(mocks.release).not.toHaveBeenCalled();
  });

  it("terminates an Evidence Worker that rejects and never awaits a release from it", async () => {
    const remote: IModelSupportInvestigationEvidenceWorker = {
      createPartialEvidence: vi.fn(async () => {
        throw new Error("worker export failed");
      }),
    };
    mocks.wrap.mockReturnValue(remote);

    const { createModelSupportInvestigationEvidenceWorkerClient } = await import("./client-hosted");
    const client = createModelSupportInvestigationEvidenceWorkerClient();
    const run = { runId: "run-failed" } as Parameters<typeof client.createPartialEvidence>[0]["run"];

    await expect(client.createPartialEvidence({ run, recovery: undefined })).rejects.toThrow("worker export failed");
    expect(mocks.terminate).toHaveBeenCalledTimes(1);
    expect(mocks.release).not.toHaveBeenCalled();
    await client.dispose();
    expect(mocks.terminate).toHaveBeenCalledTimes(1);
  });

  it("does not block disposal when the best-effort Comlink release never settles", async () => {
    const archive = { blob: new Blob(["zip"]), fileName: "evidence.zip" };
    const remote: IModelSupportInvestigationEvidenceWorker = {
      createPartialEvidence: vi.fn(async () => archive),
    };
    mocks.wrap.mockReturnValue(remote);
    mocks.release.mockReturnValue(new Promise<never>(() => undefined));

    const { createModelSupportInvestigationEvidenceWorkerClient } = await import("./client-hosted");
    const client = createModelSupportInvestigationEvidenceWorkerClient();
    const run = { runId: "run-release-hung" } as Parameters<typeof client.createPartialEvidence>[0]["run"];
    await client.createPartialEvidence({ run, recovery: undefined });

    await expect(client.dispose()).resolves.toBeUndefined();
    expect(mocks.release).toHaveBeenCalledTimes(1);
    expect(mocks.terminate).toHaveBeenCalledTimes(1);
  });

  it("never falls back to main-thread ZIP generation when Worker is unavailable", async () => {
    vi.stubGlobal("Worker", undefined);
    try {
      const { createModelSupportInvestigationEvidenceWorkerClient } = await import("./client-hosted");
      expect(() => createModelSupportInvestigationEvidenceWorkerClient()).toThrow(/requires a Worker/u);
    } finally {
      vi.stubGlobal("Worker", MockWorker);
    }
  });
});
