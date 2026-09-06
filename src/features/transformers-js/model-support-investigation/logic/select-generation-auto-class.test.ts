import { describe, expect, it } from "vitest";
import type {
  ModelSupportInvestigationModelDeclarations,
  ModelSupportInvestigationRuntimeTarget,
} from "@/features/transformers-js/model-support-investigation/types";
import { selectGenerationAutoClass } from "@/features/transformers-js/model-support-investigation/logic/select-generation-auto-class";

const runtimeTarget = {
  normalizedModelId: "org/model",
  evidenceRevision: "a".repeat(40),
  loaderRevisionOption: null,
  source: "repository",
  revisionIdentity: "exact-resolved-revision",
  pipelineTag: "text-generation",
} as ModelSupportInvestigationRuntimeTarget;

function declarations({ supported }: { supported: string[] }): ModelSupportInvestigationModelDeclarations {
  return {
    classCapabilities: [
      "AutoModel",
      "AutoModelForCausalLM",
      "AutoModelForSeq2SeqLM",
      "AutoModelForVision2Seq",
      "AutoModelForImageTextToText",
      "AutoModelForAudioTextToText",
      "AutoModelForSpeechSeq2Seq",
    ].map(autoClass => ({
      autoClass,
      supports: supported.includes(autoClass),
      notEvaluatedReason: undefined,
    })),
  } as ModelSupportInvestigationModelDeclarations;
}

describe("selectGenerationAutoClass", () => {
  it("prefers the class matching the declared pipeline", () => {
    expect(selectGenerationAutoClass({
      runtimeTarget: { ...runtimeTarget, pipelineTag: "image-text-to-text" },
      declarations: declarations({ supported: ["AutoModelForCausalLM", "AutoModelForImageTextToText"] }),
    })).toBe("AutoModelForImageTextToText");
  });

  it("uses a deterministic generative fallback when the pipeline tag is absent", () => {
    expect(selectGenerationAutoClass({
      runtimeTarget: { ...runtimeTarget, pipelineTag: undefined },
      declarations: declarations({ supported: ["AutoModelForSeq2SeqLM", "AutoModelForCausalLM"] }),
    })).toBe("AutoModelForCausalLM");
  });

  it("does not select non-generative AutoModel support", () => {
    expect(selectGenerationAutoClass({
      runtimeTarget,
      declarations: declarations({ supported: ["AutoModel"] }),
    })).toBeUndefined();
  });
});
