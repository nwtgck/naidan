import {
  createInodeNumber,
  createSubvolumeId,
  createTimestampMilliseconds,
  UINT64_MAXIMUM,
} from "@/00-storage/service/hizofs/00-format";
import {
  OrdinaryEntryCreatePlanError,
  prepareOrdinaryEntryCreatePlan,
  type OrdinaryEntryCreateRequest,
} from "@/00-storage/service/hizofs/filesystem/namespace/ordinary-entry-create-plan";
import { describe, expect, it } from "vitest";

const parentDirectoryInodeNumber = createInodeNumber({ value: 4n });
const nextInodeNumber = createInodeNumber({ value: 9n });
const operationTimestamp = createTimestampMilliseconds({ value: 1_700_000_000_000n });

function prepare({
  destinationExists = false,
  knownInodeNumbers = [parentDirectoryInodeNumber, createInodeNumber({ value: 8n })],
  next = nextInodeNumber,
  parentAccess = "read_write",
  request,
}: {
  destinationExists?: boolean;
  knownInodeNumbers?: readonly ReturnType<typeof createInodeNumber>[];
  next?: ReturnType<typeof createInodeNumber>;
  parentAccess?: "read" | "read_write";
  request: OrdinaryEntryCreateRequest;
}) {
  return prepareOrdinaryEntryCreatePlan({
    knownInodeNumbers,
    nextInodeNumber: next,
    operationTimestamp,
    request,
    target: {
      destinationExists,
      entryName: "entry",
      parentAccess,
      parentDirectoryInodeNumber,
      parentSubvolumeId: createSubvolumeId({ value: 1n }),
    },
  });
}

describe("prepareOrdinaryEntryCreatePlan", () => {
  it("creates an empty inline file and advances the allocator", () => {
    const plan = prepare({ request: { type: "file" } });
    expect(plan.directoryEntry).toEqual({
      inodeKind: "file",
      inodeNumber: 9n,
      name: "entry",
      targetType: "inode",
    });
    expect(plan.inode).toMatchObject({
      content: { type: "inline" },
      fileSize: 0n,
      inodeKind: "file",
      inodeNumber: 9n,
      inodeRevision: 1n,
    });
    expect(plan.nextInodeNumber).toBe(10n);
  });

  it("creates an empty inline directory", () => {
    const plan = prepare({ request: { type: "directory" } });
    expect(plan.inode).toMatchObject({
      content: { entries: [], type: "inline" },
      inodeKind: "directory",
      inodeNumber: 9n,
    });
  });

  it("creates a symlink through the authoritative target codec", () => {
    const plan = prepare({ request: { target: "../target", type: "symlink" } });
    expect(plan.inode).toMatchObject({
      inodeKind: "symlink",
      inodeNumber: 9n,
      target: "../target",
    });
  });

  it.each([
    ["parent_read_only", () => prepare({ parentAccess: "read", request: { type: "file" } })],
    ["destination_exists", () => prepare({ destinationExists: true, request: { type: "file" } })],
    ["allocator_exhausted", () => prepare({ next: createInodeNumber({ value: UINT64_MAXIMUM }), request: { type: "file" } })],
    ["allocator_regression", () => prepare({ next: createInodeNumber({ value: 8n }), request: { type: "file" } })],
  ] as const)("rejects %s", (code, operation) => {
    expect(operation).toThrowError(OrdinaryEntryCreatePlanError);
    try {
      operation();
    } catch (error) {
      expect((error as OrdinaryEntryCreatePlanError).code).toBe(code);
    }
  });

  it("rejects an invalid filename through the authoritative directory codec", () => {
    expect(() => prepareOrdinaryEntryCreatePlan({
      knownInodeNumbers: [parentDirectoryInodeNumber],
      nextInodeNumber,
      operationTimestamp,
      request: { type: "file" },
      target: {
        destinationExists: false,
        entryName: "a/b",
        parentAccess: "read_write",
        parentDirectoryInodeNumber,
        parentSubvolumeId: createSubvolumeId({ value: 1n }),
      },
    })).toThrow();
  });
});
