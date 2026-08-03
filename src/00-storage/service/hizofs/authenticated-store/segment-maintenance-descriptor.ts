import {
  assertSegmentPathBinding,
  parseSegmentFilename,
  segmentIdToRelativePath,
  type FileSystemId,
  type SegmentClass,
  type SegmentId,
} from "@/00-storage/service/hizofs/00-format";
import type { FileSystemRootKey } from "@/00-storage/service/hizofs/01-crypto";
import type {
  HizoFSReadableBackend,
  PhysicalEntry,
} from "@/00-storage/service/hizofs/physical-store/backend";
import {
  canonicalContainerPath,
  parentContainerDirectory,
  type CanonicalContainerDirectory,
} from "@/00-storage/service/hizofs/physical-store/paths";
import { createCandidateFrameOrdinalAuthority } from "@/00-storage/service/hizofs/authenticated-store/candidate-frame-ordinal-authority";
import {
  readAuthenticatedSegmentIndex,
  type AuthenticatedSegmentIndex,
} from "./segment-footer-store";
import type { AuthenticatedStoreDiagnosticsPort } from "@/00-storage/service/hizofs/authenticated-store/diagnostics-hooks";

export type AuthenticatedSegmentMaintenanceOwnership =
  | "abandoned_unsealed"
  | "footer_unusable"
  | "sealed";

export type AuthenticatedSegmentMaintenanceDescriptor = Readonly<{
  frameCount: number;
  frameOrdinalAuthority: ReturnType<typeof createCandidateFrameOrdinalAuthority>;
  ownership: AuthenticatedSegmentMaintenanceOwnership;
  segmentId: SegmentId;
  totalFrameBytes: number;
}>;

export type AuthenticatedSegmentMaintenanceDescriptorResult =
  | Readonly<{
    descriptor: AuthenticatedSegmentMaintenanceDescriptor;
    type: "eligible";
  }>
  | Readonly<{
    reason: "complete_unsealed" | "empty_artifact";
    type: "excluded";
  }>;

export type AuthenticatedSegmentMaintenanceDescriptorErrorCode =
  | "invalid_authenticated_summary"
  | "invalid_physical_entry"
  | "invalid_segment_path";

export class AuthenticatedSegmentMaintenanceDescriptorError extends Error {
  readonly code: AuthenticatedSegmentMaintenanceDescriptorErrorCode;

  constructor({ cause, code, message }: {
    cause?: unknown;
    code: AuthenticatedSegmentMaintenanceDescriptorErrorCode;
    message: string;
  }) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "AuthenticatedSegmentMaintenanceDescriptorError";
    this.code = code;
  }
}

function detachedSegmentId({ segmentId }: { segmentId: SegmentId }): SegmentId {
  return Uint8Array.from(segmentId) as SegmentId;
}

export function parseBoundSegmentMaintenanceSegmentId({ directory, entry, segmentClass }: {
  directory: CanonicalContainerDirectory;
  entry: PhysicalEntry;
  segmentClass: SegmentClass;
}): SegmentId {
  switch (entry.kind) {
  case "directory":
    throw new AuthenticatedSegmentMaintenanceDescriptorError({
      code: "invalid_physical_entry",
      message: "segment shard contains a non-file entry",
    });
  case "file":
    break;
  default: {
    const _ex: never = entry;
    throw new Error(`Unhandled physical entry kind: ${((_ex satisfies never) as { readonly kind: string }).kind}`);
  }
  }
  try {
    const segmentId = parseSegmentFilename({ value: entry.name });
    const relativePath = canonicalContainerPath({ value: `${directory}/${entry.name}` });
    assertSegmentPathBinding({ id: segmentId, relativePath, segmentClass });
    if (parentContainerDirectory({ path: relativePath }) !== directory) {
      throw new TypeError("segment file is not a direct child of the scanned shard directory");
    }
    if (relativePath !== segmentIdToRelativePath({ id: segmentId, segmentClass })) {
      throw new TypeError("segment path is not the canonical class and shard binding");
    }
    return segmentId;
  } catch (cause: unknown) {
    throw new AuthenticatedSegmentMaintenanceDescriptorError({
      cause,
      code: "invalid_segment_path",
      message: "physical Segment entry does not match its canonical class, shard, and filename binding",
    });
  }
}

function summarizeDescriptor({ index, segmentId }: {
  index: AuthenticatedSegmentIndex;
  segmentId: SegmentId;
}): AuthenticatedSegmentMaintenanceDescriptorResult {
  switch (index.state) {
  case "complete_unsealed":
    return Object.freeze({ reason: "complete_unsealed", type: "excluded" });
  case "abandoned_unsealed":
  case "footer_unusable":
  case "sealed": {
    if (index.frames.length === 0) {
      return Object.freeze({ reason: "empty_artifact", type: "excluded" });
    }
    let totalFrameBytes = 0;
    for (const frame of index.frames) {
      totalFrameBytes += frame.header.frameLength;
      if (!Number.isSafeInteger(totalFrameBytes) || totalFrameBytes <= 0) {
        throw new AuthenticatedSegmentMaintenanceDescriptorError({
          code: "invalid_authenticated_summary",
          message: "authenticated Segment frame bytes exceed the bounded maintenance summary",
        });
      }
    }
    return Object.freeze({
      descriptor: Object.freeze({
        frameCount: index.frames.length,
        frameOrdinalAuthority: createCandidateFrameOrdinalAuthority({
          frames: index.frames.map(frame => ({
            frameLength: frame.header.frameLength,
            physicalOffset: frame.physicalOffset,
            recordKind: frame.header.recordKind,
          })),
          segmentId,
        }),
        ownership: index.state,
        segmentId: detachedSegmentId({ segmentId }),
        totalFrameBytes,
      }),
      type: "eligible",
    });
  }
  default:
    return index.state satisfies never;
  }
}

async function readAuthenticatedSegmentMaintenanceDescriptorWithReader({
  backend,
  diagnostics,
  directory,
  entry,
  fileSystemId,
  readSegmentIndex,
  rootKey,
  segmentClass,
}: {
  backend: HizoFSReadableBackend;
  diagnostics?: AuthenticatedStoreDiagnosticsPort;
  directory: CanonicalContainerDirectory;
  entry: PhysicalEntry;
  fileSystemId: FileSystemId;
  readSegmentIndex: typeof readAuthenticatedSegmentIndex;
  rootKey: FileSystemRootKey;
  segmentClass: SegmentClass;
}): Promise<AuthenticatedSegmentMaintenanceDescriptorResult> {
  const segmentId = parseBoundSegmentMaintenanceSegmentId({ directory, entry, segmentClass });
  const index = await readSegmentIndex({
    backend,
    diagnostics,
    fileSystemId,
    physicalSegmentId: segmentId,
    rootKey,
    segmentClass,
  });
  return summarizeDescriptor({ index, segmentId });
}

export async function readAuthenticatedSegmentMaintenanceDescriptor({
  backend,
  diagnostics,
  directory,
  entry,
  fileSystemId,
  rootKey,
  segmentClass,
}: Omit<Parameters<typeof readAuthenticatedSegmentMaintenanceDescriptorWithReader>[0], "readSegmentIndex">): Promise<AuthenticatedSegmentMaintenanceDescriptorResult> {
  return await readAuthenticatedSegmentMaintenanceDescriptorWithReader({
    backend,
    diagnostics,
    directory,
    entry,
    fileSystemId,
    readSegmentIndex: readAuthenticatedSegmentIndex,
    rootKey,
    segmentClass,
  });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  readAuthenticatedSegmentMaintenanceDescriptorWithReader,
};
