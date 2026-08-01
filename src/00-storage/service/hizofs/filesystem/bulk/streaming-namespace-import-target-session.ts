import {
  createTimestampMilliseconds,
  type InodeTimestamps,
} from "@/00-storage/service/hizofs/00-format";
import {
  StreamingNamespaceImport,
  type SealedStreamingNamespaceImport,
  type StreamingNamespaceImportCheckpoint,
  validateSealedStreamingNamespaceImport,
} from "@/00-storage/service/hizofs/filesystem/bulk/streaming-namespace-import";
import {
  type StreamingNamespaceImportRuntimeCandidate,
  type StreamingNamespaceImportRuntimeStatePort,
} from "@/00-storage/service/hizofs/filesystem/bulk/streaming-namespace-import-runtime-state";
import type {
  TransitionNamespaceMetadata,
  TransitionNamespaceTargetPort,
} from "@/00-storage/service/naidan-persistence-control/transition/namespace-copy";

export type StreamingNamespaceImportTargetSessionErrorCode =
  | "already_closed"
  | "candidate_already_sealed"
  | "candidate_not_sealed"
  | "root_metadata_conflict"
  | "root_metadata_required";

export class StreamingNamespaceImportTargetSessionError extends Error {
  readonly code: StreamingNamespaceImportTargetSessionErrorCode;

  constructor({ code, message }: { code: StreamingNamespaceImportTargetSessionErrorCode; message: string }) {
    super(message);
    this.code = code;
    this.name = "StreamingNamespaceImportTargetSessionError";
  }
}

type StreamingNamespaceImportActor = Pick<StreamingNamespaceImport,
  | "checkpoint"
  | "ensureDirectory"
  | "finalize"
  | "finalizeFile"
  | "writeFileChunk"
  | "writeSymlink"
>;

type StreamingNamespaceImportTargetSessionState = "active" | "awaiting_root" | "closed" | "sealed" | "sealing";

function cloneMetadata({ metadata }: { metadata: TransitionNamespaceMetadata }): TransitionNamespaceMetadata {
  return { createdAt: metadata.createdAt, modifiedAt: metadata.modifiedAt };
}

function sameMetadata({ left, right }: {
  left: TransitionNamespaceMetadata;
  right: TransitionNamespaceMetadata;
}): boolean {
  return left.createdAt === right.createdAt && left.modifiedAt === right.modifiedAt;
}

function metadataFromTimestamps({ value }: { value: InodeTimestamps }): TransitionNamespaceMetadata {
  return {
    createdAt: value.createdAt === null ? undefined : BigInt(value.createdAt),
    modifiedAt: value.modifiedAt === null ? undefined : BigInt(value.modifiedAt),
  };
}

function rootMetadataFromCheckpoint({ checkpoint }: {
  checkpoint: StreamingNamespaceImportCheckpoint;
}): TransitionNamespaceMetadata {
  const root = checkpoint.directories[0];
  if (root === undefined || root.path.length !== 0) {
    throw new TypeError("transition import checkpoint lost its root directory metadata");
  }
  return metadataFromTimestamps({ value: root.directory.timestamps });
}

/**
 * Owns one bounded target slice and stages either an active checkpoint or a
 * sealed private root in invocation-scoped typed state. The root metadata
 * handshake creates the private importer only after the source supplied exact
 * timestamps, so no target can synthesize or silently discard root metadata.
 */
export class StreamingNamespaceImportTargetSession {
  readonly #createImport: ({ rootMetadata }: {
    rootMetadata: TransitionNamespaceMetadata;
  }) => StreamingNamespaceImportActor;
  readonly #operationIdentity: string;
  readonly #runtimeStatePort: StreamingNamespaceImportRuntimeStatePort;
  #actor: StreamingNamespaceImportActor | undefined;
  #rootMetadata: TransitionNamespaceMetadata | undefined;
  #sealed: SealedStreamingNamespaceImport | undefined;
  #state: StreamingNamespaceImportTargetSessionState;

  private constructor({ actor, createImport, operationIdentity, rootMetadata, runtimeStatePort, sealed }: {
    actor: StreamingNamespaceImportActor | undefined;
    createImport: ({ rootMetadata }: {
      rootMetadata: TransitionNamespaceMetadata;
    }) => StreamingNamespaceImportActor;
    operationIdentity: string;
    rootMetadata: TransitionNamespaceMetadata | undefined;
    runtimeStatePort: StreamingNamespaceImportRuntimeStatePort;
    sealed: SealedStreamingNamespaceImport | undefined;
  }) {
    this.#actor = actor;
    this.#createImport = createImport;
    this.#operationIdentity = operationIdentity;
    this.#rootMetadata = rootMetadata === undefined ? undefined : cloneMetadata({ metadata: rootMetadata });
    this.#runtimeStatePort = runtimeStatePort;
    this.#sealed = sealed;
    this.#state = sealed !== undefined ? "sealed" : actor === undefined ? "awaiting_root" : "active";
  }

  static async open({ createImport, operationIdentity, restoreImport, runtimeStatePort }: {
    createImport: ({ rootMetadata }: {
      rootMetadata: TransitionNamespaceMetadata;
    }) => StreamingNamespaceImportActor;
    operationIdentity: string;
    restoreImport: ({ checkpoint }: {
      checkpoint: StreamingNamespaceImportCheckpoint;
    }) => StreamingNamespaceImportActor;
    runtimeStatePort: StreamingNamespaceImportRuntimeStatePort;
  }): Promise<StreamingNamespaceImportTargetSession> {
    const candidate = await runtimeStatePort.loadCandidate({ operationIdentity });
    switch (candidate?.type) {
    case undefined:
      return new StreamingNamespaceImportTargetSession({
        actor: undefined,
        createImport,
        operationIdentity,
        rootMetadata: undefined,
        runtimeStatePort,
        sealed: undefined,
      });
    case "active":
      return new StreamingNamespaceImportTargetSession({
        actor: restoreImport({ checkpoint: candidate.checkpoint }),
        createImport,
        operationIdentity,
        rootMetadata: rootMetadataFromCheckpoint({ checkpoint: candidate.checkpoint }),
        runtimeStatePort,
        sealed: undefined,
      });
    case "sealed":
      validateSealedStreamingNamespaceImport({ sealed: candidate.sealed });
      return new StreamingNamespaceImportTargetSession({
        actor: undefined,
        createImport,
        operationIdentity,
        rootMetadata: undefined,
        runtimeStatePort,
        sealed: candidate.sealed,
      });
    default: return candidate satisfies never;
    }
  }

  #requireActiveActor(): StreamingNamespaceImportActor {
    switch (this.#state) {
    case "active": {
      const actor = this.#actor;
      if (actor === undefined) throw new Error("active transition import session lost its importer");
      return actor;
    }
    case "awaiting_root":
      throw new StreamingNamespaceImportTargetSessionError({
        code: "root_metadata_required",
        message: "transition import target requires root directory metadata before namespace content",
      });
    case "closed":
      throw new StreamingNamespaceImportTargetSessionError({
        code: "already_closed",
        message: "transition import target session is already closed",
      });
    case "sealed":
    case "sealing":
      throw new StreamingNamespaceImportTargetSessionError({
        code: "candidate_already_sealed",
        message: "sealed transition import target rejects further namespace writes",
      });
    default: return this.#state satisfies never;
    }
  }

  readonly target: TransitionNamespaceTargetPort = {
    setRootMetadata: async ({ metadata }) => {
      switch (this.#state) {
      case "awaiting_root": {
        const rootMetadata = cloneMetadata({ metadata });
        const actor = this.#createImport({ rootMetadata });
        this.#actor = actor;
        this.#rootMetadata = rootMetadata;
        this.#state = "active";
        return;
      }
      case "active": {
        const rootMetadata = this.#rootMetadata;
        if (rootMetadata === undefined) throw new Error("active transition import session lost root metadata");
        if (!sameMetadata({ left: rootMetadata, right: metadata })) {
          throw new StreamingNamespaceImportTargetSessionError({
            code: "root_metadata_conflict",
            message: "transition import root directory metadata changed after target initialization",
          });
        }
        return;
      }
      case "closed":
        throw new StreamingNamespaceImportTargetSessionError({
          code: "already_closed",
          message: "transition import target session is already closed",
        });
      case "sealed":
      case "sealing":
        throw new StreamingNamespaceImportTargetSessionError({
          code: "candidate_already_sealed",
          message: "sealed transition import target rejects root metadata changes",
        });
      default: return this.#state satisfies never;
      }
    },
    completeNamespace: async () => {
      switch (this.#state) {
      case "sealed": return;
      case "awaiting_root": throw new StreamingNamespaceImportTargetSessionError({
        code: "root_metadata_required",
        message: "transition import target cannot seal before receiving root directory metadata",
      });
      case "closed": throw new StreamingNamespaceImportTargetSessionError({
        code: "already_closed",
        message: "transition import target session is already closed",
      });
      case "active": {
        const sealed = await this.#requireActiveActor().finalize();
        validateSealedStreamingNamespaceImport({ sealed });
        this.#sealed = sealed;
        this.#actor = undefined;
        this.#state = "sealing";
        break;
      }
      case "sealing": break;
      default: return this.#state satisfies never;
      }
      await this.#saveSealedCandidate();
      this.#state = "sealed";
    },
    ensureDirectory: async ({ metadata, path }) => {
      await this.#requireActiveActor().ensureDirectory({
        path,
        timestamps: timestamps({ metadata }),
      });
    },
    finalizeFile: async ({ metadata, path, size }) => {
      await this.#requireActiveActor().finalizeFile({
        path,
        size,
        timestamps: timestamps({ metadata }),
      });
    },
    writeFileChunk: async ({ bytes, offset, path }) => {
      await this.#requireActiveActor().writeFileChunk({ bytes, offset, path });
    },
    writeSymlink: async ({ metadata, path, target }) => {
      await this.#requireActiveActor().writeSymlink({
        path,
        target,
        timestamps: timestamps({ metadata }),
      });
    },
  };

  async #saveSealedCandidate(): Promise<void> {
    const sealed = this.#sealed;
    if (sealed === undefined) throw new Error("sealing transition import session lost its private root");
    const candidate: StreamingNamespaceImportRuntimeCandidate = {
      sealed,
      type: "sealed",
    };
    await this.#runtimeStatePort.stageCandidate({
      candidate,
      operationIdentity: this.#operationIdentity,
    });
  }

  async close(): Promise<void> {
    switch (this.#state) {
    case "closed": return;
    case "awaiting_root":
      this.#state = "closed";
      return;
    case "sealed":
      this.#state = "closed";
      return;
    case "sealing":
      await this.#saveSealedCandidate();
      this.#state = "closed";
      return;
    case "active": {
      const actor = this.#requireActiveActor();
      const candidate: StreamingNamespaceImportRuntimeCandidate = {
        checkpoint: await actor.checkpoint(),
        type: "active",
      };
      await this.#runtimeStatePort.stageCandidate({
        candidate,
        operationIdentity: this.#operationIdentity,
      });
      this.#actor = undefined;
      this.#state = "closed";
      return;
    }
    default: return this.#state satisfies never;
    }
  }

  sealedCandidate(): SealedStreamingNamespaceImport {
    if (this.#sealed === undefined) {
      throw new StreamingNamespaceImportTargetSessionError({
        code: "candidate_not_sealed",
        message: "transition import target has not sealed its private namespace",
      });
    }
    return structuredClone(this.#sealed);
  }
}

function timestamps({ metadata }: {
  metadata: TransitionNamespaceMetadata;
}): InodeTimestamps {
  return {
    createdAt: metadata.createdAt === undefined ? null : createTimestampMilliseconds({ value: metadata.createdAt }),
    modifiedAt: metadata.modifiedAt === undefined ? null : createTimestampMilliseconds({ value: metadata.modifiedAt }),
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  metadataFromTimestamps,
  rootMetadataFromCheckpoint,
  sameMetadata,
  timestamps,
};
