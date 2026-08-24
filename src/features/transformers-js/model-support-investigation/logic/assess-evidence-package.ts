import type {
  ModelSupportInvestigationEvidencePackageAssessment,
  ModelSupportInvestigationEvidenceReadinessReport,
  ModelSupportInvestigationRecovery,
  ModelSupportInvestigationRun,
  ModelSupportInvestigationSupportBoundaryAssessment,
} from "@/features/transformers-js/model-support-investigation/types";

export const MODEL_SUPPORT_EVIDENCE_REQUIRED_CORE_FILES = [
  "SUMMARY.md",
  "READINESS.md",
  "PACKAGE.md",
  "readiness.json",
  "questions.json",
  "support-boundaries.json",
  "package-assessment.json",
  "run.json",
  "errors.json",
  "events.jsonl",
  "manifest.json",
] as const;

function sortedUnique({ values }: { values: Iterable<string> }): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

export function assessEvidencePackage({
  run,
  recovery,
  readiness,
  supportBoundaries,
  filePaths,
}: {
  run: ModelSupportInvestigationRun,
  recovery: ModelSupportInvestigationRecovery | undefined,
  readiness: ModelSupportInvestigationEvidenceReadinessReport,
  supportBoundaries: ModelSupportInvestigationSupportBoundaryAssessment[],
  filePaths: string[],
}): ModelSupportInvestigationEvidencePackageAssessment {
  const availablePaths = new Set(filePaths);
  const referencedEvidencePaths = sortedUnique({
    values: [
      ...readiness.domains.flatMap(domain => domain.questions.flatMap(question => question.evidencePaths)),
      ...supportBoundaries.flatMap(assessment => [
        ...assessment.evidencePaths,
        ...assessment.contradictoryEvidencePaths,
      ]),
    ],
  });
  const missingRequiredCoreFiles = MODEL_SUPPORT_EVIDENCE_REQUIRED_CORE_FILES
    .filter(path => !availablePaths.has(path));
  const missingReferencedEvidencePaths = referencedEvidencePaths
    .filter(path => !availablePaths.has(path));
  const readyDomainIds = readiness.domains
    .filter(domain => domain.status === "implementation-ready")
    .map(domain => domain.domainId);
  const insufficientDomainIds = readiness.domains
    .filter(domain => domain.status === "insufficient")
    .map(domain => domain.domainId);
  const notObservedDomainIds = readiness.domains
    .filter(domain => domain.status === "not-observed")
    .map(domain => domain.domainId);
  const partialDomainIds = readiness.domains
    .filter(domain => domain.status === "partial")
    .map(domain => domain.domainId);
  const unresolvedAssessmentIds = supportBoundaries
    .filter(assessment => assessment.boundary === "unresolved" || assessment.basis === "unresolved")
    .map(assessment => assessment.assessmentId);
  const structurallyValid = missingRequiredCoreFiles.length === 0
    && missingReferencedEvidencePaths.length === 0;
  const status = (() => {
    if (!structurallyValid) return "invalid" as const;
    const recoveryStatus = recovery?.status;
    switch (recoveryStatus) {
    case "interrupted":
      return "valid-interrupted" as const;
    case "running":
    case "completed":
    case undefined:
      break;
    default: {
      const exhaustiveRecoveryStatus: never = recoveryStatus;
      return exhaustiveRecoveryStatus;
    }
    }
    switch (readiness.overall) {
    case "insufficient":
      return "valid-insufficient" as const;
    case "partial":
      return "valid-partial" as const;
    default: {
      const exhaustiveReadinessOverall: never = readiness.overall;
      return exhaustiveReadinessOverall;
    }
    }
  })();

  return {
    schemaVersion: 1,
    status,
    runId: run.runId,
    runStatus: run.status,
    recoveryStatus: recovery?.status ?? "not-recorded",
    readinessOverall: readiness.overall,
    availableFileCount: availablePaths.size,
    requiredCoreFiles: [...MODEL_SUPPORT_EVIDENCE_REQUIRED_CORE_FILES],
    missingRequiredCoreFiles,
    referencedEvidencePathCount: referencedEvidencePaths.length,
    missingReferencedEvidencePaths,
    readyDomainIds,
    partialDomainIds,
    insufficientDomainIds,
    notObservedDomainIds,
    unresolvedAssessmentIds,
    limitations: [
      "Package validity checks structure, manifest inputs, and evidence-path references; it does not turn bounded samples into whole-file provenance.",
      "A valid package may remain partial or insufficient when capability evidence is unavailable, contradictory, interrupted, or outside the observed environment.",
      "External Hosted browser and GPU behavior is represented only by evidence actually collected in the run.",
    ],
  };
}

export function renderEvidencePackageAssessmentMarkdown({
  assessment,
}: {
  assessment: ModelSupportInvestigationEvidencePackageAssessment,
}): string {
  const list = ({ values }: { values: string[] }): string => (
    values.length === 0 ? "none" : values.join(", ")
  );
  return `# Evidence Package Assessment

- Package status: ${assessment.status}
- Run status: ${assessment.runStatus}
- Recovery status: ${assessment.recoveryStatus}
- Evidence readiness: ${assessment.readinessOverall}
- Planned package files including manifest: ${assessment.availableFileCount}
- Missing required core files: ${list({ values: assessment.missingRequiredCoreFiles })}
- Missing referenced evidence paths: ${list({ values: assessment.missingReferencedEvidencePaths })}
- Implementation-ready domains: ${list({ values: assessment.readyDomainIds })}
- Partial domains: ${list({ values: assessment.partialDomainIds })}
- Insufficient domains: ${list({ values: assessment.insufficientDomainIds })}
- Not-observed domains: ${list({ values: assessment.notObservedDomainIds })}
- Unresolved assessments: ${list({ values: assessment.unresolvedAssessmentIds })}

## Limitations

${assessment.limitations.map(value => `- ${value}`).join("\n")}
`;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  sortedUnique,
};
