import { describe, expect, it } from "vitest";
import type {
  ModelSupportInvestigationEvidenceReadinessReport,
  ModelSupportInvestigationRecovery,
  ModelSupportInvestigationRun,
} from "@/features/transformers-js/model-support-investigation/types";
import {
  assessEvidencePackage,
  MODEL_SUPPORT_EVIDENCE_REQUIRED_CORE_FILES,
  renderEvidencePackageAssessmentMarkdown,
} from "@/features/transformers-js/model-support-investigation/logic/assess-evidence-package";

function run(): ModelSupportInvestigationRun {
  return {
    runId: "run-1",
    status: "passed",
  } as ModelSupportInvestigationRun;
}

function readiness({ overall = "partial", evidencePaths = ["run.json"] }: {
  overall?: ModelSupportInvestigationEvidenceReadinessReport["overall"],
  evidencePaths?: string[],
} = {}): ModelSupportInvestigationEvidenceReadinessReport {
  return {
    schemaVersion: 1,
    overall,
    domains: [{
      domainId: "runtime-assets",
      status: overall === "insufficient" ? "insufficient" : "partial",
      summary: "fixture",
      questions: [{
        questionId: "runtime",
        status: "answered",
        answer: "fixture",
        evidencePaths,
      }],
    }],
  };
}

function coreFiles(): string[] {
  return [...MODEL_SUPPORT_EVIDENCE_REQUIRED_CORE_FILES];
}

describe("assessEvidencePackage", () => {
  it("marks a self-consistent package valid-partial without claiming implementation readiness", () => {
    const assessment = assessEvidencePackage({
      run: run(),
      recovery: undefined,
      readiness: readiness(),
      supportBoundaries: [],
      filePaths: coreFiles(),
    });

    expect(assessment).toMatchObject({
      status: "valid-partial",
      missingRequiredCoreFiles: [],
      missingReferencedEvidencePaths: [],
      partialDomainIds: ["runtime-assets"],
    });
    expect(renderEvidencePackageAssessmentMarkdown({ assessment })).toContain("Package status: valid-partial");
  });

  it("marks missing question evidence paths invalid", () => {
    const assessment = assessEvidencePackage({
      run: run(),
      recovery: undefined,
      readiness: readiness({ evidencePaths: ["missing/evidence.json"] }),
      supportBoundaries: [],
      filePaths: coreFiles(),
    });

    expect(assessment).toMatchObject({
      status: "invalid",
      missingReferencedEvidencePaths: ["missing/evidence.json"],
    });
  });

  it("separates interrupted and insufficient packages from structural invalidity", () => {
    const recovery = {
      status: "interrupted",
    } as ModelSupportInvestigationRecovery;
    const interrupted = assessEvidencePackage({
      run: run(),
      recovery,
      readiness: readiness(),
      supportBoundaries: [],
      filePaths: coreFiles(),
    });
    const insufficient = assessEvidencePackage({
      run: run(),
      recovery: undefined,
      readiness: readiness({ overall: "insufficient" }),
      supportBoundaries: [],
      filePaths: coreFiles(),
    });

    expect(interrupted.status).toBe("valid-interrupted");
    expect(insufficient.status).toBe("valid-insufficient");
  });
});
