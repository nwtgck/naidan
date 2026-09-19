import { describe, expect, it, vi } from "vitest";
import { createHostedTransformersModelFetch } from "@/features/transformers-js/runtime/model-fetch";

describe("createHostedTransformersModelFetch", () => {
  it("blocks local user-model network requests before the runtime fetch", async () => {
    const runtimeFetch = vi.fn<typeof fetch>();
    const modelFetch = createHostedTransformersModelFetch({ runtimeFetch });

    const response = await modelFetch("https://naidan.example/models/user/local-model/config.json");

    expect(response.status).toBe(404);
    expect(response.statusText).toContain("Local Only");
    expect(runtimeFetch).not.toHaveBeenCalled();
  });

  it("converts an HTML SPA fallback for a model artifact into a 404", async () => {
    const runtimeFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response("<!doctype html>", {
      status: 200,
      headers: { "Content-Type": "text/html" },
    }));
    const modelFetch = createHostedTransformersModelFetch({ runtimeFetch });

    const response = await modelFetch("https://huggingface.co/org/model/resolve/main/tokenizer.json?download=true");

    expect(response.status).toBe(404);
    expect(response.statusText).toBe("Not Found");
  });

  it("converts HTML for extension-agnostic Hugging Face resolved tokenizer assets into a 404", async () => {
    const runtimeFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response("<!doctype html>", {
      status: 200,
      headers: { "Content-Type": "text/html" },
    }));
    const modelFetch = createHostedTransformersModelFetch({ runtimeFetch });

    const response = await modelFetch("https://huggingface.co/org/model/resolve/revision/merges.txt");

    expect(response.status).toBe(404);
    expect(response.statusText).toBe("Not Found");
  });

  it("preserves normal model responses and non-model HTML", async () => {
    const jsonResponse = new Response("{}", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
    const htmlResponse = new Response("<html>docs</html>", {
      status: 200,
      headers: { "Content-Type": "text/html" },
    });
    const runtimeFetch = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse)
      .mockResolvedValueOnce(htmlResponse);
    const modelFetch = createHostedTransformersModelFetch({ runtimeFetch });

    await expect(modelFetch("https://huggingface.co/org/model/resolve/main/config.json")).resolves.toBe(jsonResponse);
    await expect(modelFetch("https://naidan.example/docs.html")).resolves.toBe(htmlResponse);
  });

});
