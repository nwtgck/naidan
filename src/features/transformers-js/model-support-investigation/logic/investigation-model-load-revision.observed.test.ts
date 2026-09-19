import { afterEach, describe, expect, it, vi } from "vitest";
import { investigationModelLoadRevision } from "./investigation-model-load-revision";
import { urlToPath } from "@/features/transformers-js/utils";
import { createOpfsModelCache } from "@/features/transformers-js/runtime/opfs-model-cache";

const MODEL_ID = "onnx-community/Qwen3.5-2B-ONNX";
const REQUESTED_REVISION = "main" as const;
const RESOLVED_REVISION = "b1fc7ca3afafcb8e4b13d29715a6b9ea5af1d1cb";
const EMBED_TOKENS_PATH = "onnx/embed_tokens_q4f16.onnx_data";
const EMBED_TOKENS_BYTES = 294_010_880;

afterEach(() => {
  vi.unstubAllGlobals();
});

function observedMainCacheRoot(): FileSystemDirectoryHandle {
  const leafPath = [
    "models",
    "huggingface.co",
    "onnx-community",
    "Qwen3.5-2B-ONNX",
    "resolve",
    REQUESTED_REVISION,
    "onnx",
  ];
  const fileName = "embed_tokens_q4f16.onnx_data";

  const directoryAt = ({ depth }: { depth: number }): FileSystemDirectoryHandle => ({
    kind: "directory",
    name: depth === 0 ? "root" : leafPath[depth - 1]!,
    async getDirectoryHandle(name: string) {
      if (name !== leafPath[depth]) throw new DOMException("Not found", "NotFoundError");
      return directoryAt({ depth: depth + 1 });
    },
    async getFileHandle(name: string) {
      if (depth !== leafPath.length) throw new DOMException("Not found", "NotFoundError");
      if (name === `.${fileName}.complete`) {
        return { kind: "file", name } as FileSystemFileHandle;
      }
      if (name !== fileName) throw new DOMException("Not found", "NotFoundError");
      return {
        kind: "file",
        name,
        async getFile() {
          return {
            size: EMBED_TOKENS_BYTES,
            stream: () => new ReadableStream<Uint8Array>({
              start(controller) {
                controller.close();
              },
            }),
          } as File;
        },
      } as FileSystemFileHandle;
    },
  }) as FileSystemDirectoryHandle;

  return directoryAt({ depth: 0 });
}

// Reduced from model-support-investigation-hf.co-onnx-community-Qwen3.5-2B-ONNX-
// 8030862f-c8ad-4cb1-a13a-b935be13cfd7.zip. Before investigation the full
// 294 MB file existed under resolve/main with a completion marker. The old MSI
// load path requested the resolved commit SHA, creating a second OPFS path and
// downloading the same repository file again.
describe("observed Qwen3.5 normal-Chat cache reuse", () => {
  it("keeps resolved SHA evidence separate from the Transformers.js load revision", () => {
    expect(investigationModelLoadRevision({ requestedRevision: REQUESTED_REVISION })).toBeUndefined();
    expect(RESOLVED_REVISION).not.toBe(REQUESTED_REVISION);
    expect(EMBED_TOKENS_BYTES).toBe(294_010_880);
  });

  it("shows why resolved-SHA loading cannot hit the already-complete normal Chat cache path", () => {
    const mainUrl = `https://huggingface.co/${MODEL_ID}/resolve/${REQUESTED_REVISION}/${EMBED_TOKENS_PATH}`;
    const resolvedUrl = `https://huggingface.co/${MODEL_ID}/resolve/${RESOLVED_REVISION}/${EMBED_TOKENS_PATH}`;

    expect(urlToPath({ url: mainUrl })).toBe(
      `models/huggingface.co/${MODEL_ID}/resolve/main/${EMBED_TOKENS_PATH}`,
    );
    expect(urlToPath({ url: resolvedUrl })).toBe(
      `models/huggingface.co/${MODEL_ID}/resolve/${RESOLVED_REVISION}/${EMBED_TOKENS_PATH}`,
    );
    expect(urlToPath({ url: resolvedUrl })).not.toBe(urlToPath({ url: mainUrl }));
  });
  it("replays the observed OPFS cache identity: main hits while the resolved SHA misses", async () => {
    vi.stubGlobal("navigator", {
      storage: { getDirectory: vi.fn(async () => observedMainCacheRoot()) },
    });
    const cache = createOpfsModelCache();
    const mainUrl = `https://huggingface.co/${MODEL_ID}/resolve/${REQUESTED_REVISION}/${EMBED_TOKENS_PATH}`;
    const resolvedUrl = `https://huggingface.co/${MODEL_ID}/resolve/${RESOLVED_REVISION}/${EMBED_TOKENS_PATH}`;

    const mainResponse = await cache.match(mainUrl);
    expect(mainResponse?.headers.get("X-Cache-Hit")).toBe("OPFS");
    expect(mainResponse?.headers.get("Content-Length")).toBe(String(EMBED_TOKENS_BYTES));
    await expect(cache.match(resolvedUrl)).resolves.toBeUndefined();
  });

});
