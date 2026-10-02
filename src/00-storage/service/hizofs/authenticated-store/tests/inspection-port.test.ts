import { describe, expect, it, vi } from "vitest";
import { createAuthenticatedHizoFSInspectionPort } from "@/00-storage/service/hizofs/authenticated-store/inspection-port";
import type {
  HizoFSReadableBackend,
  PhysicalDirectoryCursorPage,
  PhysicalEntry,
} from "@/00-storage/service/hizofs/physical-store/backend";
import { canonicalContainerDirectory } from "@/00-storage/service/hizofs/physical-store/paths";

const directory = canonicalContainerDirectory({ value: "segments/metadata" });
const entry = ({ name }: { name: string }): PhysicalEntry => ({ kind: "directory", name });

function fixture() {
  const backend: HizoFSReadableBackend = {
    getFileSize: vi.fn(),
    list: vi.fn(async () => [entry({ name: "legacy" })]),
    readExact: vi.fn(),
    readExactWithFileSize: vi.fn(),
    readFileBounded: vi.fn(),
  };
  const cursor = {
    close: vi.fn(async () => undefined),
    read: vi.fn<({ maximumEntries }: { maximumEntries: number }) => Promise<PhysicalDirectoryCursorPage>>(),
  };
  const openDirectoryCursor = vi.fn(async function (this: HizoFSReadableBackend) {
    expect(this).toBe(backend);
    return cursor;
  });
  return { backend, cursor, openDirectoryCursor };
}

describe("authenticated inspection directory listing", () => {
  it("continues short pages, sorts successful entries, and closes once", async () => {
    const { backend, cursor, openDirectoryCursor } = fixture();
    Object.assign(backend, { openDirectoryCursor });
    cursor.read
      .mockResolvedValueOnce({ done: false, entries: [entry({ name: "b" })] })
      .mockResolvedValueOnce({ done: false, entries: [entry({ name: "a" })] })
      .mockResolvedValueOnce({ done: true, entries: [] });

    await expect(createAuthenticatedHizoFSInspectionPort({ backend }).list({ directory, maximumEntries: 2 }))
      .resolves.toEqual([entry({ name: "a" }), entry({ name: "b" })]);
    expect(openDirectoryCursor).toHaveBeenCalledExactlyOnceWith({ directory });
    expect(cursor.read.mock.calls).toEqual([[{ maximumEntries: 3 }], [{ maximumEntries: 2 }], [{ maximumEntries: 1 }]]);
    expect(cursor.close).toHaveBeenCalledOnce();
    expect(backend.list).not.toHaveBeenCalled();
  });

  it.each([false, true])("stops at the overflow sentinel even when its page is done=%s", async (done) => {
    const { backend, cursor, openDirectoryCursor } = fixture();
    Object.assign(backend, { openDirectoryCursor });
    cursor.read
      .mockResolvedValueOnce({ done: false, entries: [entry({ name: "b" }), entry({ name: "a" })] })
      .mockResolvedValueOnce({ done, entries: [entry({ name: "c" })] });

    await expect(createAuthenticatedHizoFSInspectionPort({ backend }).list({ directory, maximumEntries: 2 }))
      .resolves.toHaveLength(3);
    expect(cursor.read.mock.calls).toEqual([[{ maximumEntries: 3 }], [{ maximumEntries: 1 }]]);
    expect(cursor.close).toHaveBeenCalledOnce();
    expect(backend.list).not.toHaveBeenCalled();
  });

  it.each([2, Number.MAX_SAFE_INTEGER])("accepts an empty completed page with safe bound %s", async (maximumEntries) => {
    const { backend, cursor, openDirectoryCursor } = fixture();
    Object.assign(backend, { openDirectoryCursor });
    cursor.read.mockResolvedValueOnce({ done: true, entries: [] });
    await expect(createAuthenticatedHizoFSInspectionPort({ backend }).list({ directory, maximumEntries }))
      .resolves.toEqual([]);
    expect(cursor.read).toHaveBeenCalledExactlyOnceWith({
      maximumEntries: maximumEntries === Number.MAX_SAFE_INTEGER ? maximumEntries : maximumEntries + 1,
    });
    expect(cursor.close).toHaveBeenCalledOnce();
  });

  it.each([
    { done: false, entries: [], message: "did not advance" },
    { done: true, entries: [entry({ name: "a" }), entry({ name: "b" }), entry({ name: "c" }), entry({ name: "d" })], message: "exceeded the requested entry bound" },
  ])("rejects a cursor page that $message and closes it", async ({ done, entries, message }) => {
    const { backend, cursor, openDirectoryCursor } = fixture();
    Object.assign(backend, { openDirectoryCursor });
    cursor.read.mockResolvedValueOnce({ done, entries });
    await expect(createAuthenticatedHizoFSInspectionPort({ backend }).list({ directory, maximumEntries: 2 }))
      .rejects.toThrow(message);
    expect(cursor.read).toHaveBeenCalledOnce();
    expect(cursor.close).toHaveBeenCalledOnce();
  });

  it("does not close a cursor when open itself fails", async () => {
    const { backend, cursor, openDirectoryCursor } = fixture();
    Object.assign(backend, { openDirectoryCursor });
    openDirectoryCursor.mockRejectedValueOnce(undefined);
    await expect(createAuthenticatedHizoFSInspectionPort({ backend }).list({ directory, maximumEntries: 2 }))
      .rejects.toBeUndefined();
    expect(cursor.read).not.toHaveBeenCalled();
    expect(cursor.close).not.toHaveBeenCalled();
  });

  it("retains an undefined read failure after successful close", async () => {
    const { backend, cursor, openDirectoryCursor } = fixture();
    Object.assign(backend, { openDirectoryCursor });
    cursor.read.mockRejectedValueOnce(undefined);
    await expect(createAuthenticatedHizoFSInspectionPort({ backend }).list({ directory, maximumEntries: 2 }))
      .rejects.toBeUndefined();
    expect(cursor.close).toHaveBeenCalledOnce();
  });

  it.each([
    { entries: [] },
    { entries: [entry({ name: "a" }), entry({ name: "b" }), entry({ name: "c" })] },
  ])("propagates close failure after success or overflow: %j", async ({ entries }) => {
    const { backend, cursor, openDirectoryCursor } = fixture();
    Object.assign(backend, { openDirectoryCursor });
    cursor.read.mockResolvedValueOnce({ done: true, entries });
    cursor.close.mockRejectedValueOnce(undefined);
    await expect(createAuthenticatedHizoFSInspectionPort({ backend }).list({ directory, maximumEntries: 2 }))
      .rejects.toBeUndefined();
    expect(cursor.close).toHaveBeenCalledOnce();
  });

  it.each([
    { primary: undefined, cleanup: new Error("close failed") },
    { primary: new Error("read failed"), cleanup: undefined },
  ])("keeps read and close failures in operation order: %j", async ({ primary, cleanup }) => {
    const { backend, cursor, openDirectoryCursor } = fixture();
    Object.assign(backend, { openDirectoryCursor });
    cursor.read.mockRejectedValueOnce(primary);
    cursor.close.mockRejectedValueOnce(cleanup);
    const result = createAuthenticatedHizoFSInspectionPort({ backend }).list({ directory, maximumEntries: 2 });
    await expect(result).rejects.toBeInstanceOf(AggregateError);
    await expect(result).rejects.toMatchObject({ errors: [primary, cleanup] });
    expect(cursor.close).toHaveBeenCalledOnce();
  });

  it("preserves the legacy list fallback, including its ordering and excess entries", async () => {
    const { backend } = fixture();
    const entries = [entry({ name: "c" }), entry({ name: "b" }), entry({ name: "a" })];
    vi.mocked(backend.list).mockResolvedValueOnce(entries);
    await expect(createAuthenticatedHizoFSInspectionPort({ backend }).list({ directory, maximumEntries: 2 }))
      .resolves.toBe(entries);
    expect(backend.list).toHaveBeenCalledExactlyOnceWith({ directory });
  });

  it("rejects an invalid bound before acquiring a cursor", async () => {
    const { backend, openDirectoryCursor } = fixture();
    Object.assign(backend, { openDirectoryCursor });
    await expect(createAuthenticatedHizoFSInspectionPort({ backend }).list({ directory, maximumEntries: 0 }))
      .rejects.toThrow("maximumEntries must be a positive safe integer");
    expect(openDirectoryCursor).not.toHaveBeenCalled();
    expect(backend.list).not.toHaveBeenCalled();
  });
});
