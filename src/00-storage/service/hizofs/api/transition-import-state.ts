import type {
  StreamingNamespaceImportRuntimeCandidate,
  StreamingNamespaceImportRuntimeStatePort,
} from "@/00-storage/service/hizofs/filesystem/bulk/streaming-namespace-import-runtime-state";

export type HizoFSTransitionImportCandidate = StreamingNamespaceImportRuntimeCandidate;
export type HizoFSTransitionImportStatePort = StreamingNamespaceImportRuntimeStatePort;

export const TEST_ONLY = {
};
