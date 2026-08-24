import JSZip from "jszip";
import { z } from "zod";

const manifestEntrySchema = z.object({
  path: z.string().min(1),
  byteLength: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/u),
});

const manifestSchema = z.object({
  schemaVersion: z.literal(1),
  runId: z.string().min(1),
  generatedAt: z.string().min(1),
  files: z.array(manifestEntrySchema),
});

const packageAssessmentSchema = z.object({
  schemaVersion: z.literal(1),
  status: z.enum([
    "valid-partial",
    "valid-insufficient",
    "valid-interrupted",
    "invalid",
  ]),
});

async function sha256Hex({ bytes }: { bytes: Uint8Array }): Promise<string> {
  const digestInput = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(digestInput).set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", digestInput);
  return [...new Uint8Array(digest)]
    .map(value => value.toString(16).padStart(2, "0"))
    .join("");
}

function sameOrderedStrings({ left, right }: { left: string[], right: string[] }): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export interface VerifiedEvidenceArchive {
  runId: string,
  fileCount: number,
  packageStatus: "valid-partial" | "valid-insufficient" | "valid-interrupted",
}

export async function verifyGeneratedEvidenceArchive({ blob }: {
  blob: Blob,
}): Promise<VerifiedEvidenceArchive> {
  const archive = await JSZip.loadAsync(blob);
  const manifestFile = archive.file("manifest.json");
  if (manifestFile === null) throw new Error("Evidence archive is missing manifest.json");
  const manifest = manifestSchema.parse(JSON.parse(await manifestFile.async("text")) as unknown);
  const assessmentFile = archive.file("package-assessment.json");
  if (assessmentFile === null) throw new Error("Evidence archive is missing package-assessment.json");
  const assessment = packageAssessmentSchema.parse(JSON.parse(await assessmentFile.async("text")) as unknown);
  const packageStatus = (() => {
    switch (assessment.status) {
    case "valid-partial":
    case "valid-insufficient":
    case "valid-interrupted":
      return assessment.status;
    case "invalid":
      throw new Error("Evidence archive package assessment is invalid");
    default: {
      const exhaustiveStatus: never = assessment.status;
      return exhaustiveStatus;
    }
    }
  })();

  const manifestPaths = manifest.files.map(entry => entry.path);
  const uniqueManifestPaths = [...new Set(manifestPaths)];
  if (uniqueManifestPaths.length !== manifestPaths.length) {
    throw new Error("Evidence archive manifest contains duplicate paths");
  }
  const archivePaths = Object.entries(archive.files)
    .filter(([path, file]) => path !== "manifest.json" && !file.dir)
    .map(([path]) => path)
    .sort((left, right) => left.localeCompare(right));
  const sortedManifestPaths = [...manifestPaths].sort((left, right) => left.localeCompare(right));
  if (!sameOrderedStrings({ left: sortedManifestPaths, right: archivePaths })) {
    throw new Error("Evidence archive manifest paths do not match archive files");
  }

  for (const entry of manifest.files) {
    const file = archive.file(entry.path);
    if (file === null) throw new Error(`Evidence archive is missing manifest path: ${entry.path}`);
    const bytes = await file.async("uint8array");
    if (bytes.byteLength !== entry.byteLength) {
      throw new Error(`Evidence archive byte length mismatch: ${entry.path}`);
    }
    const actualSha256 = await sha256Hex({ bytes });
    if (actualSha256 !== entry.sha256) {
      throw new Error(`Evidence archive SHA-256 mismatch: ${entry.path}`);
    }
  }

  return {
    runId: manifest.runId,
    fileCount: manifest.files.length,
    packageStatus,
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  manifestSchema,
  packageAssessmentSchema,
  sameOrderedStrings,
};
