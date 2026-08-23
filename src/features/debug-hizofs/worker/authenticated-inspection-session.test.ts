import { describe, expect, it, vi } from "vitest";
import { bindHizoFSPhysicalInspectionWorkerPassphrase } from "./authenticated-inspection-session";
import type { HizoFSPhysicalInspectionWorker } from "./physical-inspection";

describe("HizoFS authenticated inspection session", () => {
  it("keeps the passphrase outside the UI-facing session shape", async () => {
    const inspectContainer = vi.fn(async () => ({ marker: "container" }));
    const inspectNamespacePath = vi.fn(async () => ({ marker: "namespace" }));
    const inspectHomeRecord = vi.fn(async () => ({ marker: "home" }));
    const inspectRecord = vi.fn(async () => ({ marker: "record" }));
    const inspectRecordFrame = vi.fn(async () => ({ marker: "frame" }));
    const worker = {
      inspectContainer,
      inspectHomeRecord,
      inspectNamespacePath,
      inspectRecord,
      inspectRecordFrame,
    } as unknown as HizoFSPhysicalInspectionWorker;

    const session = bindHizoFSPhysicalInspectionWorkerPassphrase({
      passphrase: "temporary secret",
      worker,
    });

    expect(Object.keys(session).sort()).toEqual([
      "inspectContainer",
      "inspectHomeRecord",
      "inspectNamespacePath",
      "inspectRecord",
      "inspectRecordFrame",
    ]);
    await session.inspectContainer();
    await session.inspectNamespacePath({ pathComponents: ["docs"] });
    await session.inspectRecordFrame({ request: {} as never });

    expect(inspectContainer).toHaveBeenCalledWith({ passphrase: "temporary secret" });
    expect(inspectNamespacePath).toHaveBeenCalledWith({
      maximumDirectoryEntries: undefined,
      maximumPages: undefined,
      passphrase: "temporary secret",
      pathComponents: ["docs"],
    });
    expect(inspectRecordFrame).toHaveBeenCalledWith({
      passphrase: "temporary secret",
      request: {},
    });
  });
});
