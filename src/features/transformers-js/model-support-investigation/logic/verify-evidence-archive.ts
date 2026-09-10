import { z } from "zod";
import { openEvidenceArchive, type EvidenceArchiveReader } from './evidence-archive';
import { PRODUCTION_PROVIDER_CAPTURE_EVIDENCE_PATH, productionProviderCaptureReferenceSchema, readProductionProviderCaptureEvidence } from './production-provider-capture-evidence';
import { PRODUCTION_PROVIDER_NATIVE_EVIDENCE_PATH, productionProviderNativeCaptureReferenceSchema, verifyProductionProviderNativeEvidence } from './production-provider-native-evidence';
import { PRODUCTION_PROVIDER_INVESTIGATION_SUMMARY_EVIDENCE_PATH, productionProviderInvestigationSummaryReferenceSchema, readProductionProviderInvestigationSummaryEvidence } from './production-provider-investigation-summary';
import { ordinaryProviderRuntimeCompletionSchema, providerLoadRuntimeCompletion } from './provider-load-runtime-completion';
import { downloadRuntimeAcceptanceIdentity, downloadRuntimeAcceptanceIdentityInputSchema } from '@/features/transformers-js/download-verification/evidence/runtime-acceptance-identity';
import { productionLoadReceiptSchema } from '@/features/transformers-js/runtime/production-load-receipt';

const providerAcceptanceDocumentSchema = z.object({
  schemaVersion: z.literal(1), status: z.enum(['accepted', 'failed', 'exhausted']), source: z.literal('ordinary-provider-load'),
  repositoryResolvedRevision: z.string(), cacheRevision: z.string().nullable(), loaderRevisionOption: z.string().nullable(),
  revisionIdentity: z.enum(['exact-resolved-revision', 'legacy-main-unverified', 'unverified']).nullable(),
  selectedCandidate: productionLoadReceiptSchema.shape.candidate.nullable(), receipt: productionLoadReceiptSchema.nullable(), cacheReuse: z.null(),
  error: z.object({ name: z.string(), message: z.string() }).strict().nullable(),
}).strict();

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
  const archive = await openEvidenceArchive({ blob });
  try {
    return await verifyGeneratedEvidenceFiles({ archive: archive.reader });
  } finally {
    await archive.close();
  }
}

/** Validate a file set before encoding, or a completed archive through one reader. */
export async function verifyGeneratedEvidenceFiles({ archive }: {
  archive: EvidenceArchiveReader,
}): Promise<VerifiedEvidenceArchive> {
  const manifestFile = await archive.read({ path: "manifest.json" });
  if (manifestFile === undefined) throw new Error("Evidence archive is missing manifest.json");
  const manifest = manifestSchema.parse(JSON.parse(await manifestFile.text()) as unknown);
  const assessmentFile = await archive.read({ path: "package-assessment.json" });
  if (assessmentFile === undefined) throw new Error("Evidence archive is missing package-assessment.json");
  const assessment = packageAssessmentSchema.parse(JSON.parse(await assessmentFile.text()) as unknown);
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
  const archivePaths = archive.paths
    .filter(path => path !== "manifest.json")
    .sort((left, right) => left.localeCompare(right));
  const sortedManifestPaths = [...manifestPaths].sort((left, right) => left.localeCompare(right));
  if (!sameOrderedStrings({ left: sortedManifestPaths, right: archivePaths })) {
    throw new Error("Evidence archive manifest paths do not match archive files");
  }

  for (const entry of manifest.files) {
    const file = await archive.read({ path: entry.path });
    if (file === undefined) throw new Error(`Evidence archive is missing manifest path: ${entry.path}`);
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.byteLength !== entry.byteLength) {
      throw new Error(`Evidence archive byte length mismatch: ${entry.path}`);
    }
    const actualSha256 = await sha256Hex({ bytes });
    if (actualSha256 !== entry.sha256) {
      throw new Error(`Evidence archive SHA-256 mismatch: ${entry.path}`);
    }
  }

  const nativePaths = archivePaths.filter(path => path.startsWith('generation-native/'));
  const providerFile = await archive.read({ path: PRODUCTION_PROVIDER_CAPTURE_EVIDENCE_PATH });
  // This is an identity/reference projection, not a second schema for the whole
  // MSI run. Both dangling references and unowned documents must be rejected.
  const runFile = await archive.read({ path: 'run.json' });
  const run = runFile === undefined ? undefined : z.object({
    runId: z.string().min(1), modelId: z.string().min(1),
    productionProviderCapture: productionProviderCaptureReferenceSchema.optional(),
    productionProviderNativeCapture: productionProviderNativeCaptureReferenceSchema.optional(),
    productionProviderInvestigation: productionProviderInvestigationSummaryReferenceSchema.optional(),
    downloadEvidence: z.unknown().optional(),
  }).parse(JSON.parse(await runFile.text()) as unknown);
  const summaryFile = await archive.read({ path: PRODUCTION_PROVIDER_INVESTIGATION_SUMMARY_EVIDENCE_PATH });
  if (summaryFile !== undefined || run?.productionProviderInvestigation !== undefined) {
    if (run === undefined || run.productionProviderInvestigation === undefined || summaryFile === undefined) throw new Error('Evidence archive is missing its Production investigation summary owner');
    if (run.runId !== manifest.runId) throw new Error('Evidence archive Production investigation summary run mismatch');
    readProductionProviderInvestigationSummaryEvidence({ json: await summaryFile.text(), runId: run.runId, modelId: run.modelId });
  }
  if (providerFile !== undefined || nativePaths.length > 0 || run?.productionProviderCapture !== undefined || run?.productionProviderNativeCapture !== undefined) {
    if (run === undefined || run.productionProviderCapture === undefined || providerFile === undefined) throw new Error('Evidence archive is missing its Production capture owner');
    if (run.runId !== manifest.runId) throw new Error('Evidence archive Production capture run mismatch');
    const provider = readProductionProviderCaptureEvidence({ json: await providerFile.text(), runId: run.runId, modelId: run.modelId });
    if (nativePaths.length > 0 || run.productionProviderNativeCapture !== undefined) {
      const indexPath = PRODUCTION_PROVIDER_NATIVE_EVIDENCE_PATH;
      const nativeFile = await archive.read({ path: indexPath });
      if (nativeFile === undefined || run.productionProviderNativeCapture === undefined) throw new Error('Evidence archive is missing its native capture index or run reference');
      const manifestByPath = new Map(manifest.files.map(entry => [entry.path, entry]));
      const { referencedPaths } = await verifyProductionProviderNativeEvidence({
        json: await nativeFile.text(), provider,
        async readBinary({ reference }) {
          const entry = manifestByPath.get(reference.path);
          if (entry === undefined || entry.byteLength !== reference.byteLength || entry.sha256 !== reference.sha256) {
            throw new Error('Evidence archive native reference does not match its manifest');
          }
          const file = await archive.read({ path: reference.path });
          if (file === undefined) throw new Error('Evidence archive native reference is missing');
          // The outer manifest has already verified these exact ZIP bytes.
          return new Uint8Array(await file.arrayBuffer());
        },
      });
      const expectedNativePaths = [indexPath, ...referencedPaths].sort((left, right) => left.localeCompare(right));
      if (!sameOrderedStrings({ left: expectedNativePaths, right: nativePaths })) {
        throw new Error('Evidence archive contains unreferenced native entries');
      }
    }
  }

  const download = z.object({ mode: z.string(), runtimeCompletion: z.object({ source: z.string() }).passthrough().optional() }).optional().parse(run?.downloadEvidence);
  const acceptanceFile = await archive.read({ path: 'download-lane/cache-acceptance.json' });
  const acceptanceDocument: unknown = acceptanceFile === undefined ? undefined : JSON.parse(await acceptanceFile.text());
  const acceptanceSource = z.object({ source: z.string().optional() }).optional().parse(acceptanceDocument)?.source;
  if (acceptanceSource === 'ordinary-provider-load' && download?.runtimeCompletion?.source !== 'ordinary-provider-load') {
    throw new Error('Provider Load acceptance document does not match its run owner');
  }
  if (download?.runtimeCompletion?.source === 'ordinary-provider-load') {
    if (run === undefined || summaryFile === undefined || download.mode !== 'runtime-complete') throw new Error('Provider Load acceptance is missing its investigation owner');
    const projection = downloadRuntimeAcceptanceIdentityInputSchema.parse(run.downloadEvidence);
    const actual = ordinaryProviderRuntimeCompletionSchema.parse(download.runtimeCompletion);
    const provider = providerFile === undefined ? undefined : readProductionProviderCaptureEvidence({ json: await providerFile.text(), runId: run.runId, modelId: run.modelId });
    const summary = readProductionProviderInvestigationSummaryEvidence({ json: await summaryFile.text(), runId: run.runId, modelId: run.modelId });
    const nativeFile = await archive.read({ path: PRODUCTION_PROVIDER_NATIVE_EVIDENCE_PATH });
    const expected = ordinaryProviderRuntimeCompletionSchema.parse(providerLoadRuntimeCompletion({
      repositoryResolvedRevision: projection.run.resolvedRevision, provider, summary, nativeJson: await nativeFile?.text(),
    }));
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('Provider Load acceptance does not match its captured Load owner');
    if (acceptanceFile === undefined) throw new Error('Provider Load acceptance document is missing');
    const expectedDocument = {
      schemaVersion: 1, status: actual.status, source: actual.source, repositoryResolvedRevision: actual.repositoryResolvedRevision,
      cacheRevision: actual.cacheRevision, loaderRevisionOption: actual.loaderRevisionOption,
      revisionIdentity: downloadRuntimeAcceptanceIdentity({ evidence: projection }) ?? null,
      selectedCandidate: actual.selectedCandidate ?? null, receipt: actual.receipt ?? null, cacheReuse: null, error: actual.error ?? null,
    };
    // Object order is not evidence. Parsing into the expected shape also refuses
    // extra acceptance fields that could silently claim unobserved independent work.
    if (JSON.stringify(providerAcceptanceDocumentSchema.parse(acceptanceDocument)) !== JSON.stringify(providerAcceptanceDocumentSchema.parse(expectedDocument))) throw new Error('Provider Load acceptance document does not match its run');
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
