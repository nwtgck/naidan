import {
  decodeStreamingNamespaceImportJournalCandidate,
  encodeStreamingNamespaceImportJournalCandidate,
} from "@/00-storage/service/hizofs/filesystem/bulk/streaming-namespace-import-checkpoint-codec";
import {
  StreamingNamespaceImportJournal,
  type StreamingNamespaceImportJournalBinding,
  type StreamingNamespaceImportJournalPort,
  type StreamingNamespaceImportJournalRecord,
} from "@/00-storage/service/hizofs/filesystem/bulk/streaming-namespace-import-journal";

export type HizoFSTransitionImportJournalBinding = StreamingNamespaceImportJournalBinding;
export type HizoFSTransitionImportJournalPort = StreamingNamespaceImportJournalPort;
export const HizoFSTransitionImportJournal = StreamingNamespaceImportJournal;

export type HizoFSTransitionImportCheckpointSnapshot = Readonly<{
  bytes: Uint8Array;
  generation: bigint;
  state: "active" | "sealed";
}>;

export interface HizoFSTransitionImportCheckpointStagingPort {
  clear({ expectedGeneration }: { expectedGeneration: bigint }): Promise<void>;
  load(): Promise<HizoFSTransitionImportCheckpointSnapshot | undefined>;
  stage({ expectedGeneration, snapshot }: {
    expectedGeneration: bigint | undefined;
    snapshot: HizoFSTransitionImportCheckpointSnapshot;
  }): Promise<void>;
}

function sameBinding({ left, right }: {
  left: HizoFSTransitionImportJournalBinding;
  right: HizoFSTransitionImportJournalBinding;
}): boolean {
  return left.operationIdentity === right.operationIdentity
    && left.sourceAuthorityIdentity === right.sourceAuthorityIdentity
    && left.sourceEndpointIdentity === right.sourceEndpointIdentity
    && left.targetAuthorityIdentity === right.targetAuthorityIdentity
    && left.targetEndpointIdentity === right.targetEndpointIdentity;
}

/**
 * Keeps the exact HizoFS checkpoint codec behind the public transition-import
 * boundary. Naidan composition owns only opaque authenticated bytes, while the
 * HizoFS owner alone reconstructs and validates private candidate state.
 */
export function createHizoFSTransitionImportJournalPort({ binding, stagingPort }: {
  binding: HizoFSTransitionImportJournalBinding;
  stagingPort: HizoFSTransitionImportCheckpointStagingPort;
}): HizoFSTransitionImportJournalPort {
  return {
    clear: async ({ binding: requestedBinding, expectedGeneration }) => {
      if (!sameBinding({ left: binding, right: requestedBinding })) {
        throw new TypeError("HizoFS transition checkpoint belongs to another binding");
      }
      await stagingPort.clear({ expectedGeneration });
    },
    load: async ({ operationIdentity }) => {
      if (operationIdentity !== binding.operationIdentity) {
        throw new TypeError("HizoFS transition checkpoint belongs to another operation");
      }
      const snapshot = await stagingPort.load();
      if (snapshot === undefined) return undefined;
      const candidate = decodeStreamingNamespaceImportJournalCandidate({ bytes: snapshot.bytes });
      if (candidate.type !== snapshot.state) {
        throw new TypeError("HizoFS transition checkpoint state disagrees with its envelope");
      }
      return {
        binding: structuredClone(binding),
        candidate,
        generation: snapshot.generation,
        schemaVersion: 1,
      };
    },
    publish: async ({ expectedGeneration, record }) => {
      if (!sameBinding({ left: binding, right: record.binding })) {
        throw new TypeError("HizoFS transition checkpoint belongs to another binding");
      }
      const snapshot: HizoFSTransitionImportCheckpointSnapshot = {
        bytes: encodeStreamingNamespaceImportJournalCandidate({ candidate: record.candidate }),
        generation: record.generation,
        state: record.candidate.type,
      };
      await stagingPort.stage({ expectedGeneration, snapshot });
    },
  };
}

export type HizoFSTransitionImportJournalRecord = StreamingNamespaceImportJournalRecord;

export const TEST_ONLY = {
  sameBinding,
};
