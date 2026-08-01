import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHizoFSPhysicalInspectionWorkerForOpfsPath } from "./opfs-physical-inspection";

const mocks = vi.hoisted(() => ({
  createDriver: vi.fn(),
  createPort: vi.fn(),
  createWorker: vi.fn(),
}));

vi.mock("@/00-storage/service/hizofs/authenticated-store/inspection-port", () => ({
  createAuthenticatedHizoFSInspectionPort: mocks.createPort,
}));

vi.mock("./physical-inspection", () => ({
  createHizoFSPhysicalInspectionDriver: mocks.createDriver,
  createHizoFSPhysicalInspectionWorker: mocks.createWorker,
}));

function directoryHandle({ children = {} }: {
  children?: Readonly<Record<string, FileSystemDirectoryHandle>>;
} = {}): FileSystemDirectoryHandle {
  return {
    getDirectoryHandle: vi.fn(async (name: string) => {
      const child = children[name];
      if (child === undefined) throw new DOMException("missing", "NotFoundError");
      return child;
    }),
  } as unknown as FileSystemDirectoryHandle;
}

describe("OPFS physical inspection worker factory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("opens an existing path without creating entries and composes the narrow worker", async () => {
    const container = directoryHandle();
    const parent = directoryHandle({ children: { "container.hizofs": container } });
    const root = directoryHandle({ children: { storage: parent } });
    const physical = { kind: "inspection-port" };
    const driver = { kind: "driver" };
    const worker = { kind: "worker" };
    mocks.createPort.mockReturnValueOnce(physical);
    mocks.createDriver.mockReturnValueOnce(driver);
    mocks.createWorker.mockReturnValueOnce(worker);

    await expect(createHizoFSPhysicalInspectionWorkerForOpfsPath({
      nativeOpfsRoot: root,
      physicalPath: ["storage", "container.hizofs"],
    })).resolves.toBe(worker);

    expect(root.getDirectoryHandle).toHaveBeenCalledWith("storage");
    expect(parent.getDirectoryHandle).toHaveBeenCalledWith("container.hizofs");
    expect(mocks.createPort).toHaveBeenCalledWith({ backend: expect.anything() });
    expect(mocks.createDriver).toHaveBeenCalledWith({ physical });
    expect(mocks.createWorker).toHaveBeenCalledWith({ driver });
  });

  it("accepts a bounded non-BMP physical path component", async () => {
    const container = directoryHandle();
    const root = directoryHandle({ children: { "container-😀.hizofs": container } });
    mocks.createPort.mockReturnValueOnce({});
    mocks.createDriver.mockReturnValueOnce({});
    mocks.createWorker.mockReturnValueOnce({});

    await expect(createHizoFSPhysicalInspectionWorkerForOpfsPath({
      nativeOpfsRoot: root,
      physicalPath: ["container-😀.hizofs"],
    })).resolves.toEqual({});
    expect(root.getDirectoryHandle).toHaveBeenCalledWith("container-😀.hizofs");
  });

  it("validates the complete path before performing any OPFS lookup", async () => {
    const root = directoryHandle({ children: { valid: directoryHandle() } });
    await expect(createHizoFSPhysicalInspectionWorkerForOpfsPath({
      nativeOpfsRoot: root,
      physicalPath: ["valid", ".."],
    })).rejects.toThrow("invalid OPFS physical path component");
    expect(root.getDirectoryHandle).not.toHaveBeenCalled();
  });

  const invalidPhysicalPaths: readonly (readonly string[])[] = [
    [],
    [""],
    [".."],
    ["a/b"],
    ["\uD800"],
  ];

  it.each(invalidPhysicalPaths.map(physicalPath => [physicalPath] as const))(
    "rejects an invalid physical path before creating a backend: %j",
    async (physicalPath) => {
      await expect(createHizoFSPhysicalInspectionWorkerForOpfsPath({
        nativeOpfsRoot: directoryHandle(),
        physicalPath,
      })).rejects.toThrow();
      expect(mocks.createPort).not.toHaveBeenCalled();
    },
  );
});
