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
}: {
  payload: string,
  sha256Override?: string,
  packageStatus?: "valid-partial" | "invalid",
}): Promise<Blob> {
  const zip = new JSZip();
  zip.file("payload.txt", payload);
  zip.file("package-assessment.json", JSON.stringify({ schemaVersion: 1, status: packageStatus }));
  const entries = await Promise.all(["package-assessment.json", "payload.txt"].map(async path => {
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
