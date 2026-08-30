import type {
  ModelSupportInvestigationCacheFile,
  ModelSupportInvestigationCacheInventory,
  ModelSupportInvestigationCandidateDevice,
  ModelSupportInvestigationCandidateDtype,
  ModelSupportInvestigationCandidateFilePlan,
  ModelSupportInvestigationCandidateId,
  ModelSupportInvestigationModelDeclarations,
  ModelSupportInvestigationModelFilePlan,
  ModelSupportInvestigationPlannedFile,
  ModelSupportInvestigationPlannedFileCacheMatch,
  ModelSupportInvestigationRepository,
  ModelSupportInvestigationRepositoryFile,
} from "@/features/transformers-js/model-support-investigation/types";
import { serializeInvestigationError } from "@/features/transformers-js/model-support-investigation/logic/serialize-investigation-error";

const CANDIDATES = [
  { candidateId: "webgpu-q4f16", device: "webgpu", dtype: "q4f16" },
  { candidateId: "webgpu-q4", device: "webgpu", dtype: "q4" },
  { candidateId: "wasm-q4", device: "wasm", dtype: "q4" },
] as const satisfies readonly {
  candidateId: ModelSupportInvestigationCandidateId,
  device: ModelSupportInvestigationCandidateDevice,
  dtype: ModelSupportInvestigationCandidateDtype,
}[];

export type ModelSupportInvestigationGetModelFiles = ({ modelId, device, dtype }: {
  modelId: string,
  device: ModelSupportInvestigationCandidateDevice,
  dtype: ModelSupportInvestigationCandidateDtype,
}) => Promise<string[]>;

function fileKind({ path }: { path: string }): ModelSupportInvestigationPlannedFile["kind"] {
  if (path === "config.json") return "config";
  if (path.endsWith(".onnx")) return "core-onnx";
  if (/\.onnx_data(?:_\d+)?$/u.test(path)) return "external-data";
  return "optional-config";
}

function fileRequirement({ kind }: {
  kind: ModelSupportInvestigationPlannedFile["kind"],
}): ModelSupportInvestigationPlannedFile["requirement"] {
  switch (kind) {
  case "config":
  case "core-onnx":
  case "external-data":
    return "required";
  case "optional-config":
    return "optional";
  default: {
    const _ex: never = kind;
    return _ex;
  }
  }
}

function repositoryObservation({ file }: {
  file: ModelSupportInvestigationRepositoryFile | undefined,
}): Pick<
  ModelSupportInvestigationPlannedFile,
  "repositoryObservation" | "repositorySize" | "repositoryBlobId" | "repositoryLfsOid"
> {
  if (file === undefined) {
    return {
      repositoryObservation: "missing",
      repositorySize: undefined,
      repositoryBlobId: undefined,
      repositoryLfsOid: undefined,
    };
  }
  return {
    repositoryObservation: file.size === 0 ? "zero-byte" : "present",
    repositorySize: file.size,
    repositoryBlobId: file.blobId,
    repositoryLfsOid: file.lfsOid,
  };
}

function cacheObservation({ file }: {
  file: ModelSupportInvestigationCacheFile,
}): ModelSupportInvestigationPlannedFileCacheMatch["observation"] {
  if (file.size === 0) return "zero-byte-observed-revision-unknown";
  return file.hasCompletionMarker
    ? "complete-marker-observed-revision-unknown"
    : "incomplete-observed-revision-unknown";
}

function cacheMatches({ cache, repositoryPath }: {
  cache: ModelSupportInvestigationCacheInventory | undefined,
  repositoryPath: string,
}): ModelSupportInvestigationPlannedFileCacheMatch[] {
  if (cache === undefined) return [];
  return cache.files
    .filter(file => file.repositoryPath === repositoryPath)
    .map(file => ({
      path: file.path,
      size: file.size,
      hasCompletionMarker: file.hasCompletionMarker,
      observation: cacheObservation({ file }),
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

function plannedFile({
  path,
  repositoryFiles,
  cache,
}: {
  path: string,
  repositoryFiles: ReadonlyMap<string, ModelSupportInvestigationRepositoryFile>,
  cache: ModelSupportInvestigationCacheInventory | undefined,
}): ModelSupportInvestigationPlannedFile {
  const kind = fileKind({ path });
  return {
    path,
    kind,
    requirement: fileRequirement({ kind }),
    ...repositoryObservation({ file: repositoryFiles.get(path) }),
    cacheMatches: cacheMatches({ cache, repositoryPath: path }),
  };
}

function plannedCandidate({
  candidateId,
  device,
  dtype,
  registryPaths,
  repositoryFiles,
  cache,
}: {
  candidateId: ModelSupportInvestigationCandidateId,
  device: ModelSupportInvestigationCandidateDevice,
  dtype: ModelSupportInvestigationCandidateDtype,
  registryPaths: string[],
  repositoryFiles: ReadonlyMap<string, ModelSupportInvestigationRepositoryFile>,
  cache: ModelSupportInvestigationCacheInventory | undefined,
}): ModelSupportInvestigationCandidateFilePlan {
  const pathCounts = new Map<string, number>();
  for (const path of registryPaths) pathCounts.set(path, (pathCounts.get(path) ?? 0) + 1);
  const duplicatePaths = [...pathCounts]
    .filter(([, count]) => count > 1)
    .map(([path]) => path)
    .sort((a, b) => a.localeCompare(b));
  const files = [...pathCounts.keys()]
    .sort((a, b) => a.localeCompare(b))
    .map(path => plannedFile({ path, repositoryFiles, cache }));
  const requiredFiles = files.filter(file => file.requirement === "required");
  const optionalFiles = files.filter(file => file.requirement === "optional");
  const missingRequiredFiles = requiredFiles.filter(file => file.repositoryObservation === "missing");
  const zeroByteRequiredFiles = requiredFiles.filter(file => file.repositoryObservation === "zero-byte");
  const ineligibleReasons = [
    ...missingRequiredFiles.map(file => `missing required repository file: ${file.path}`),
    ...zeroByteRequiredFiles.map(file => `zero-byte required repository file: ${file.path}`),
  ];

  return {
    candidateId,
    device,
    dtype,
    registryStatus: "planned",
    registryError: undefined,
    registryReturnedFileCount: registryPaths.length,
    duplicatePaths,
    files,
    requiredFileCount: requiredFiles.length,
    optionalFileCount: optionalFiles.length,
    missingRequiredFileCount: missingRequiredFiles.length,
    zeroByteRequiredFileCount: zeroByteRequiredFiles.length,
    missingOptionalFileCount: optionalFiles.filter(file => file.repositoryObservation === "missing").length,
    cacheObservedRequiredFileCount: requiredFiles.filter(file => file.cacheMatches.length > 0).length,
    cacheCompleteMarkerRequiredFileCount: requiredFiles.filter(file => (
      file.cacheMatches.some(match => match.observation === "complete-marker-observed-revision-unknown")
    )).length,
    eligibility: ineligibleReasons.length === 0 ? "eligible" : "ineligible",
    ineligibleReasons,
  };
}

function failedCandidate({ candidateId, device, dtype, error }: {
  candidateId: ModelSupportInvestigationCandidateId,
  device: ModelSupportInvestigationCandidateDevice,
  dtype: ModelSupportInvestigationCandidateDtype,
  error: unknown,
}): ModelSupportInvestigationCandidateFilePlan {
  const registryError = serializeInvestigationError({ error });
  return {
    candidateId,
    device,
    dtype,
    registryStatus: "failed",
    registryError,
    registryReturnedFileCount: 0,
    duplicatePaths: [],
    files: [],
    requiredFileCount: 0,
    optionalFileCount: 0,
    missingRequiredFileCount: 0,
    zeroByteRequiredFileCount: 0,
    missingOptionalFileCount: 0,
    cacheObservedRequiredFileCount: 0,
    cacheCompleteMarkerRequiredFileCount: 0,
    eligibility: "registry-failed",
    ineligibleReasons: [`ModelRegistry.get_model_files failed: ${registryError.name}: ${registryError.message}`],
  };
}

export async function inspectModelFilePlan({
  repository,
  declarations,
  cache,
  getModelFiles,
}: {
  repository: ModelSupportInvestigationRepository,
  declarations: ModelSupportInvestigationModelDeclarations,
  cache: ModelSupportInvestigationCacheInventory | undefined,
  getModelFiles: ModelSupportInvestigationGetModelFiles,
}): Promise<ModelSupportInvestigationModelFilePlan> {
  if (repository.normalizedModelId !== declarations.normalizedModelId) {
    throw new Error("Repository and declaration model IDs do not match");
  }
  if (repository.resolvedRevision !== declarations.resolvedRevision) {
    throw new Error("Repository and declaration revisions do not match");
  }

  const repositoryFiles = new Map(repository.files.map(file => [file.path, file]));
  const candidates: ModelSupportInvestigationCandidateFilePlan[] = [];
  for (const candidate of CANDIDATES) {
    try {
      const registryPaths = await getModelFiles({
        modelId: repository.normalizedModelId,
        device: candidate.device,
        dtype: candidate.dtype,
      });
      candidates.push(plannedCandidate({
        ...candidate,
        registryPaths,
        repositoryFiles,
        cache,
      }));
    } catch (error) {
      candidates.push(failedCandidate({ ...candidate, error }));
    }
  }

  return {
    normalizedModelId: repository.normalizedModelId,
    resolvedRevision: repository.resolvedRevision,
    modelType: declarations.modelType,
    registrySource: "ModelRegistry.get_model_files",
    cacheRevisionProvenance: cache?.revisionProvenance ?? "not-observed",
    cacheRevisionProvenanceReason: cache?.revisionProvenanceReason
      ?? "OPFS cache inspection did not complete, so no cache revision provenance was observed",
    candidates,
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  fileKind,
};
