import { describe, expect, it, vi } from "vitest";
import type {
  ModelSupportInvestigationAutoClassName,
  ModelSupportInvestigationRepository,
} from "@/features/transformers-js/model-support-investigation/types";
import {
  inspectModelDeclarations,
  type ModelSupportInvestigationAutoClasses,
} from "./inspect-model-declarations";

function repository(): ModelSupportInvestigationRepository {
  return {
    requestedModelId: "hf.co/org/model",
    normalizedModelId: "org/model",
    requestedRevision: "main",
    resolvedRevision: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    apiUrl: "https://huggingface.co/api/models/org/model/revision/main?blobs=true",
    responseUrl: "https://huggingface.co/api/models/org/model/revision/main?blobs=true",
    fileCount: 3,
    files: [
      { path: "config.json", size: 100, blobId: undefined, lfsOid: undefined },
      { path: "tokenizer_config.json", size: 100, blobId: undefined, lfsOid: undefined },
      { path: "model.onnx", size: 100, blobId: undefined, lfsOid: undefined },
    ],
    pipelineTag: "text-generation",
    libraryName: "transformers",
    metadata: {},
  };
}

function autoClasses(): ModelSupportInvestigationAutoClasses {
  const names: ModelSupportInvestigationAutoClassName[] = [
    "AutoModel",
    "AutoModelForAudioTextToText",
    "AutoModelForCausalLM",
    "AutoModelForImageTextToText",
    "AutoModelForSeq2SeqLM",
    "AutoModelForSpeechSeq2Seq",
    "AutoModelForVision2Seq",
  ];
  return Object.fromEntries(names.map(name => [name, {
    supports: (modelType: string) => name === "AutoModelForCausalLM" && modelType === "new_chat_model",
  }])) as ModelSupportInvestigationAutoClasses;
}

describe("inspectModelDeclarations", () => {
  it("fetches only lightweight declarations from the resolved commit and records public class support", async () => {
    const repositoryFetch = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = String(input);
      const value = url.endsWith("/config.json")
        ? {
          model_type: "new_chat_model",
          architectures: ["NewChatForCausalLM"],
          auto_map: { AutoModelForCausalLM: "modeling.NewChatForCausalLM" },
          "transformers.js_config": { dtype: "q4" },
        }
        : { chat_template: "{{ messages }}" };
      return new Response(JSON.stringify(value), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const result = await inspectModelDeclarations({
      repository: repository(),
      repositoryFetch,
      autoClasses: autoClasses(),
    });

    expect(repositoryFetch).toHaveBeenCalledTimes(2);
    expect(repositoryFetch.mock.calls[0]?.[0]).toContain(
      "/resolve/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/config.json",
    );
    expect(result).toMatchObject({
      modelType: "new_chat_model",
      architectures: ["NewChatForCausalLM"],
      autoMap: { AutoModelForCausalLM: "modeling.NewChatForCausalLM" },
      transformersJsConfig: { dtype: "q4" },
    });
    expect(result.classCapabilities.find(entry => entry.autoClass === "AutoModelForCausalLM")).toMatchObject({
      supports: true,
      notEvaluatedReason: undefined,
    });
    expect(result.files.map(file => file.path)).toEqual(["config.json", "tokenizer_config.json"]);
  });

  it("does not evaluate class support when config.model_type is missing", async () => {
    const repositoryFetch = vi.fn<typeof fetch>().mockImplementation(async () => new Response("{}", { status: 200 }));
    const result = await inspectModelDeclarations({
      repository: repository(),
      repositoryFetch,
      autoClasses: autoClasses(),
    });

    expect(result.modelType).toBeUndefined();
    expect(result.classCapabilities.every(entry => entry.supports === undefined)).toBe(true);
  });

  it("rejects a repository manifest without config.json", async () => {
    const value = repository();
    value.files = [];
    await expect(inspectModelDeclarations({
      repository: value,
      repositoryFetch: vi.fn(),
      autoClasses: autoClasses(),
    })).rejects.toThrow("does not contain config.json");
  });

  it("rejects config.json when the validated JSON value is not an object", async () => {
    const repositoryFetch = vi.fn<typeof fetch>().mockImplementation(async (input) => new Response(
      String(input).endsWith("/config.json") ? "[]" : "{}",
      { status: 200 },
    ));

    await expect(inspectModelDeclarations({
      repository: repository(),
      repositoryFetch,
      autoClasses: autoClasses(),
    })).rejects.toThrow("config.json is not a JSON object");
  });
});
