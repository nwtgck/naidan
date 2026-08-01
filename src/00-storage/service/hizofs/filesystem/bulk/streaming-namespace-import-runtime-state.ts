import type {
  SealedStreamingNamespaceImport,
  StreamingNamespaceImportCheckpoint,
} from "@/00-storage/service/hizofs/filesystem/bulk/streaming-namespace-import";

export type StreamingNamespaceImportRuntimeCandidate =
  | Readonly<{
      checkpoint: StreamingNamespaceImportCheckpoint;
      type: "active";
    }>
  | Readonly<{
      sealed: SealedStreamingNamespaceImport;
      type: "sealed";
    }>;

/**
 * Invocation-scoped typed state for one private transition import.
 *
 * Implementations return committed snapshots and stage the candidate produced
 * by the current target slice. They must not persist, encode, version, or
 * recover this state after the owning runtime is lost.
 */
export interface StreamingNamespaceImportRuntimeStatePort {
  loadCandidate({ operationIdentity }: {
    operationIdentity: string;
  }): Promise<StreamingNamespaceImportRuntimeCandidate | undefined>;
  stageCandidate({ candidate, operationIdentity }: {
    candidate: StreamingNamespaceImportRuntimeCandidate;
    operationIdentity: string;
  }): Promise<void>;
}

export const TEST_ONLY = {
};
