// @vitest-environment node
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { verifyGeneratedEvidenceArchive } from "./verify-evidence-archive";

async function sha256Hex({ bytes }: { bytes: Uint8Array }): Promise<string> {
  const input = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(input).set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", input);
  return [...new Uint8Array(digest)]
    .map(value => value.toString(16).padStart(2, "0"))
    .join("");
}

async function createArchive({
  payload,
  sha256Override,
  packageStatus = "valid-partial",
  additionalFiles,
}: {
  payload: string,
  sha256Override?: string,
  packageStatus?: "valid-partial" | "invalid",
  additionalFiles?: ReadonlyMap<string, string>,
}): Promise<Blob> {
  const zip = new JSZip();
  zip.file("payload.txt", payload);
  zip.file("package-assessment.json", JSON.stringify({ schemaVersion: 1, status: packageStatus }));
  for (const [path, content] of additionalFiles ?? []) zip.file(path, content);
  const entries = await Promise.all(Object.entries(zip.files).filter(([, file]) => !file.dir).map(async ([path]) => {
    const bytes = await zip.file(path)!.async("uint8array");
    return {
      path,
      byteLength: bytes.byteLength,
      sha256: path === "payload.txt" && sha256Override !== undefined
        ? sha256Override
        : await sha256Hex({ bytes }),
    };
  }));
  zip.file("manifest.json", JSON.stringify({
    schemaVersion: 1,
    runId: "run-1",
    generatedAt: "2026-08-06T00:00:00.000Z",
    files: entries,
  }));
  return zip.generateAsync({ type: "blob" });
}

describe("verifyGeneratedEvidenceArchive", () => {
  it.each(['absent', 'probe-only', 'other-acceptance-source'] as const)('rejects an unowned Provider acceptance document after rebuilding every manifest digest: %s', owner => {
    const additionalFiles = new Map<string, string>([['download-lane/cache-acceptance.json', JSON.stringify({
      schemaVersion: 1, status: 'accepted', source: 'ordinary-provider-load', repositoryResolvedRevision: 'a'.repeat(40),
      cacheRevision: 'a'.repeat(40), loaderRevisionOption: 'a'.repeat(40), revisionIdentity: 'exact-resolved-revision',
      selectedCandidate: { device: 'wasm', dtype: 'q4' }, cacheReuse: null, error: null,
      receipt: {
        format: 'production-offline-load-receipt-v1', modelId: 'fixture/model', loaderRevisionOption: { status: 'provided', value: 'a'.repeat(40) },
        autoClass: 'AutoModelForCausalLM', processor: 'tokenizer', candidate: { device: 'wasm', dtype: 'q4' },
        plannedRequiredPaths: ['config.json', 'onnx/model_q4.onnx'], cacheLookup: { source: 'read-only-opfs-scoped-match', revision: 'a'.repeat(40), hitPaths: ['config.json', 'onnx/model_q4.onnx'] },
        completion: 'model-session-and-tokenizer-processor-ready', resourceHealth: 'healthy-after-close', accessBoundary: 'production-offline-read-only',
        limitations: { wholeFileProvenance: 'not-verified', allPlannedBodiesConsumed: 'not-certified' },
      },
    })]]);
    switch (owner) {
    case 'absent': break;
    case 'probe-only': additionalFiles.set('run.json', JSON.stringify({ runId: 'run-1', modelId: 'fixture/model', downloadEvidence: { mode: 'probe-only' } })); break;
    case 'other-acceptance-source': additionalFiles.set('run.json', JSON.stringify({ runId: 'run-1', modelId: 'fixture/model', downloadEvidence: { mode: 'runtime-complete', runtimeCompletion: { source: 'reused-production-cache' } } })); break;
    default: { const exhaustive: never = owner; throw new Error('Unknown acceptance owner fixture: ' + exhaustive); }
    }
    return expect(createArchive({ payload: 'Unowned acceptance document', additionalFiles }).then(blob => verifyGeneratedEvidenceArchive({ blob })))
      .rejects.toThrow('Provider Load acceptance document does not match its run owner');
  });

  it("verifies archive paths, sizes, hashes, and package status", async () => {
    const result = await verifyGeneratedEvidenceArchive({
      blob: await createArchive({ payload: "evidence" }),
    });

    expect(result).toEqual({
      runId: "run-1",
      fileCount: 2,
      packageStatus: "valid-partial",
    });
  });

  it("rejects a manifest hash mismatch", async () => {
    await expect(verifyGeneratedEvidenceArchive({
      blob: await createArchive({ payload: "evidence", sha256Override: "0".repeat(64) }),
    })).rejects.toThrow("SHA-256 mismatch: payload.txt");
  });

  it("rejects an invalid package assessment", async () => {
    await expect(verifyGeneratedEvidenceArchive({
      blob: await createArchive({ payload: "evidence", packageStatus: "invalid" }),
    })).rejects.toThrow("package assessment is invalid");
  });
});
