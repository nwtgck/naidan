import { describe, expect, it, vi } from "vitest";
import type {
  HizoFSHomeRecordInspectionRequest,
  HizoFSNamespacePathInspection,
  HizoFSPhysicalContainerInspection,
  HizoFSPhysicalRecordInspection,
  HizoFSPhysicalRecordInspectionRequest,
} from "@/00-storage/service/hizofs/inspection";
import {
  createHizoFSPhysicalInspectionWorker,
  type HizoFSPhysicalInspectionDriver,
} from "./physical-inspection";

const homeRequest: HizoFSHomeRecordInspectionRequest = {
  frameLength: 96,
  homeOffset: "64",
  homeSegmentId: "00000000000000000000000000000001",
  pageIsRoot: true,
  recordKind: 3,
};

const request: HizoFSPhysicalRecordInspectionRequest = {
  frameLength: 96,
  homeOffset: "64",
  homeSegmentId: "00000000000000000000000000000001",
  pageIsRoot: true,
  physicalOffset: "128",
  physicalSegmentId: "00000000000000000000000000000002",
  recordKind: 3,
};

const container = {
  physicalAnomalies: [],
  rootDirectoryShortcut: undefined,
  segments: [],
  superblockCopies: [],
  superblockSelection: undefined,
  unlockEnvelopeCopies: [],
  unlockSelection: { code: "credential_rejected", message: "rejected", state: "rejected" },
} satisfies HizoFSPhysicalContainerInspection;


const namespaceInspection = {
  authorityMode: "active",
  commitSequence: "1",
  directory: { entries: [], truncated: false },
  inode: {
    createdAt: undefined,
    fileSize: undefined,
    inodeKind: "directory",
    inodeNumber: "1",
    inodeRevision: "1",
    modifiedAt: undefined,
    symlinkTarget: undefined,
  },
  pageReads: [],
  pageReadsTruncated: false,
  pagesRead: 2,
  pathComponents: [],
} satisfies HizoFSNamespacePathInspection;

const record = {
  frameLength: 96,
  headerFlags: 0,
  homeOffset: "64",
  homeSegmentId: "00000000000000000000000000000001",
  payload: { byteLength: 8, kind: "file_data", state: "decoded" },
  physicalOffset: "128",
  physicalSegmentId: "00000000000000000000000000000002",
  plaintextByteLength: 8,
  plaintextPreviewBase64Url: "AA",
  plaintextPreviewByteLength: 1,
  plaintextPreviewTruncated: true,
  recordKind: 2,
  recordKindName: "file_data",
  sealedLength: 64,
} satisfies HizoFSPhysicalRecordInspection;

describe("HizoFS physical inspection worker", () => {
  it("forwards one-shot credentials without retaining them in worker state", async () => {
    const inspectContainer = vi.fn(async () => container);
    const inspectHomeRecord = vi.fn(async () => record);
    const inspectNamespacePath = vi.fn(async () => namespaceInspection);
    const inspectRecord = vi.fn(async () => record);
    const driver: HizoFSPhysicalInspectionDriver = { inspectContainer, inspectHomeRecord, inspectNamespacePath, inspectRecord };
    const worker = createHizoFSPhysicalInspectionWorker({ driver });

    await expect(worker.inspectContainer({ passphrase: "first-passphrase" })).resolves.toBe(container);
    await expect(worker.inspectHomeRecord({
      maximumPreviewBytes: 2,
      passphrase: "logical-passphrase",
      request: homeRequest,
    })).resolves.toBe(record);
    await expect(worker.inspectNamespacePath({
      maximumDirectoryEntries: 20,
      maximumPages: 40,
      passphrase: "namespace-passphrase",
      pathComponents: ["docs"],
    })).resolves.toBe(namespaceInspection);
    await expect(worker.inspectRecord({
      maximumPreviewBytes: 1,
      passphrase: "second-passphrase",
      request,
    })).resolves.toBe(record);

    expect(inspectContainer).toHaveBeenCalledWith({ passphrase: "first-passphrase" });
    expect(inspectHomeRecord).toHaveBeenCalledWith({
      maximumPreviewBytes: 2,
      passphrase: "logical-passphrase",
      request: homeRequest,
    });
    expect(inspectNamespacePath).toHaveBeenCalledWith({
      maximumDirectoryEntries: 20,
      maximumPages: 40,
      passphrase: "namespace-passphrase",
      pathComponents: ["docs"],
    });
    expect(inspectRecord).toHaveBeenCalledWith({
      maximumPreviewBytes: 1,
      passphrase: "second-passphrase",
      request,
    });
    expect(JSON.stringify(worker)).not.toContain("passphrase");
  });
});
