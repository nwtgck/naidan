import { describe, expect, it } from "vitest";
import type { ModelSupportInvestigationCacheInventory } from "@/features/transformers-js/model-support-investigation/types";
import {
  runtimeTargetFromLocalCache,
  runtimeTargetFromRepository,
  selectLocalCacheRevision,
} from "@/features/transformers-js/model-support-investigation/logic/runtime-target";

function cache({ revisions }: { revisions: string[] }): ModelSupportInvestigationCacheInventory {
  return {
    normalizedModelId: "org/model",
    rootPath: "models/huggingface.co/org/model",
    exists: true,
    revisionProvenance: "unknown",
    revisionProvenanceReason: "fixture",
    totalBytes: revisions.length * 32,
    fileCount: revisions.length,
    completionMarkerCount: revisions.length,
    incompleteFileCount: 0,
    orphanCompletionMarkerCount: 0,
    orphanCompletionMarkerPaths: [],
    zeroByteFileCount: 0,
    weightFileCount: 0,
    allFilesHaveCompletionMarkers: true,
    files: revisions.map((revision, index) => ({
      path: `resolve/${revision}/config.json`,
      repositoryPath: "config.json",
      cacheRevision: revision,
      size: 32,
      lastModified: index,
      hasCompletionMarker: true,
      isWeightFile: false,
    })),
  };
}

describe("runtime target", () => {
  it("prefers one immutable local revision over legacy main", () => {
    const revision = "a".repeat(40);
    expect(selectLocalCacheRevision({ cache: cache({ revisions: ["main", revision] }) })).toEqual({
      status: "selected",
      revision,
      revisionIdentity: "local-immutable-revision",
      loaderRevisionOption: revision,
    });
    expect(runtimeTargetFromLocalCache({ cache: cache({ revisions: ["main", revision] }) })).toMatchObject({
      normalizedModelId: "org/model",
      evidenceRevision: revision,
      loaderRevisionOption: revision,
      source: "local-cache",
      revisionIdentity: "local-immutable-revision",
    });
  });

  it("uses legacy main only when there is no immutable revision", () => {
    expect(selectLocalCacheRevision({ cache: cache({ revisions: ["main"] }) })).toEqual({
      status: "selected",
      revision: "main",
      revisionIdentity: "legacy-main-unverified",
      loaderRevisionOption: null,
    });
  });

  it("does not guess between multiple immutable revisions", () => {
    const left = "a".repeat(40);
    const right = "b".repeat(40);
    expect(selectLocalCacheRevision({ cache: cache({ revisions: [left, right, "main"] }) })).toMatchObject({
      status: "ambiguous",
      revisions: [left, right],
    });
    expect(runtimeTargetFromLocalCache({ cache: cache({ revisions: [left, right, "main"] }) })).toBeUndefined();
  });

  it("keeps repository evidence revision separate from the normal main loader path", () => {
    const revision = "c".repeat(40);
    expect(runtimeTargetFromRepository({
      repository: {
        requestedModelId: "hf.co/org/model",
        normalizedModelId: "org/model",
        requestedRevision: "main",
        resolvedRevision: revision,
        apiUrl: "https://huggingface.co/api/models/org/model/revision/main?blobs=true",
        responseUrl: "https://huggingface.co/api/models/org/model/revision/main?blobs=true",
        fileCount: 0,
        files: [],
        pipelineTag: "text-generation",
        libraryName: "transformers",
        metadata: {},
      },
    })).toEqual({
      normalizedModelId: "org/model",
      evidenceRevision: revision,
      loaderRevisionOption: null,
      source: "repository",
      revisionIdentity: "exact-resolved-revision",
      pipelineTag: "text-generation",
    });
  });
});
