function requestUrl({ input }: { input: RequestInfo | URL }): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function pathWithoutQueryOrHash({ url }: { url: string }): string {
  return url.split(/[?#]/u, 1)[0] ?? url;
}

function isLocalUserModelRequest({ url }: { url: string }): boolean {
  return /(^|\/)models\/(?:user|local)\//u.test(url) || /^(?:user|local)\//u.test(url);
}

function isHuggingFaceResolvedArtifactRequest({ url }: { url: string }): boolean {
  try {
    const parsed = new URL(url);
    const isHuggingFace = parsed.hostname === "huggingface.co" || parsed.hostname.endsWith(".huggingface.co");
    return isHuggingFace && parsed.pathname.includes("/resolve/");
  } catch {
    return false;
  }
}

function isModelArtifactRequest({ url }: { url: string }): boolean {
  const path = pathWithoutQueryOrHash({ url });
  return isHuggingFaceResolvedArtifactRequest({ url })
    || path.includes("/models/")
    || path.endsWith(".json")
    || path.endsWith(".onnx")
    || path.endsWith(".bin")
    || path.endsWith(".wasm");
}

export function createHostedTransformersModelFetch({
  runtimeFetch,
}: {
  runtimeFetch: typeof fetch,
}): typeof fetch {
  return async (input, init) => {
    const url = requestUrl({ input });

    if (isLocalUserModelRequest({ url })) {
      console.debug(`[transformers-worker] Blocking fetch for local model: ${url}`);
      return new Response(null, { status: 404, statusText: "Not Found (Local Only)" });
    }

    const response = await runtimeFetch(input, init);
    if (response.status !== 200) return response;

    const contentType = response.headers.get("content-type");
    if (contentType?.includes("text/html") !== true) return response;
    if (!isModelArtifactRequest({ url }) || pathWithoutQueryOrHash({ url }).endsWith(".html")) return response;

    console.warn(`[transformers-worker] Intercepted HTML response for ${url}. Treating as 404.`);
    return new Response(null, { status: 404, statusText: "Not Found" });
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
