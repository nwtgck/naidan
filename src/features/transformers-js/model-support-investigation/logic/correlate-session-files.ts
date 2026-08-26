import type {
  ModelSupportInvestigationPlannedFile,
  ModelSupportInvestigationSessionFileCorrelation,
  ModelSupportInvestigationSessionMetadata,
} from "@/features/transformers-js/model-support-investigation/types";

function basename({ path }: { path: string }): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function coreStem({ path }: { path: string }): string | undefined {
  const name = basename({ path });
  return name.endsWith(".onnx") ? name.slice(0, -".onnx".length) : undefined;
}

function relatedExternalDataPaths({
  corePath,
  files,
}: {
  corePath: string,
  files: ModelSupportInvestigationPlannedFile[],
}): string[] {
  const prefix = `${corePath}_data`;
  return files
    .filter((file) => {
      switch (file.kind) {
      case "external-data":
        if (file.path === prefix) return true;
        if (!file.path.startsWith(prefix)) return false;
        return /^_[0-9]+$/u.test(file.path.slice(prefix.length));
      case "config":
      case "core-onnx":
      case "optional-config":
        return false;
      default: {
        const _ex: never = file.kind;
        throw new Error(`Unhandled planned file kind: ${_ex}`);
      }
      }
    })
    .map(file => file.path)
    .sort((a, b) => a.localeCompare(b));
}

export function correlateSessionFiles({
  sessions,
  files,
}: {
  sessions: ModelSupportInvestigationSessionMetadata[],
  files: ModelSupportInvestigationPlannedFile[],
}): ModelSupportInvestigationSessionFileCorrelation[] {
  const coreFiles = files.filter(file => file.kind === "core-onnx");
  return sessions.map((session): ModelSupportInvestigationSessionFileCorrelation => {
    const coreFilePaths = coreFiles
      .filter(file => coreStem({ path: file.path }) === session.name)
      .map(file => file.path)
      .sort((a, b) => a.localeCompare(b));
    if (coreFilePaths.length !== 1) {
      return {
        sessionName: session.name,
        status: coreFilePaths.length === 0 ? "unmatched" : "ambiguous",
        matchBasis: "exact-session-name-to-core-onnx-basename",
        coreFilePaths,
        externalDataPaths: [],
      };
    }
    return {
      sessionName: session.name,
      status: "exact",
      matchBasis: "exact-session-name-to-core-onnx-basename",
      coreFilePaths,
      externalDataPaths: relatedExternalDataPaths({ corePath: coreFilePaths[0]!, files }),
    };
  }).sort((a, b) => a.sessionName.localeCompare(b.sessionName));
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
