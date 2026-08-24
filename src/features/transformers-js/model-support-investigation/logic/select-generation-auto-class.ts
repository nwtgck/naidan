import type {
  ModelSupportInvestigationGenerationAutoClassName,
  ModelSupportInvestigationModelDeclarations,
  ModelSupportInvestigationRepository,
} from "@/features/transformers-js/model-support-investigation/types";

const DEFAULT_PRIORITY = [
  "AutoModelForCausalLM",
  "AutoModelForImageTextToText",
  "AutoModelForSeq2SeqLM",
  "AutoModelForVision2Seq",
  "AutoModelForAudioTextToText",
  "AutoModelForSpeechSeq2Seq",
] as const satisfies readonly ModelSupportInvestigationGenerationAutoClassName[];

const PIPELINE_PRIORITY: Readonly<Record<string, readonly ModelSupportInvestigationGenerationAutoClassName[]>> = {
  "text-generation": ["AutoModelForCausalLM"],
  "text2text-generation": ["AutoModelForSeq2SeqLM"],
  "image-text-to-text": ["AutoModelForImageTextToText", "AutoModelForVision2Seq"],
  "automatic-speech-recognition": ["AutoModelForSpeechSeq2Seq", "AutoModelForAudioTextToText"],
};

export function selectGenerationAutoClass({ repository, declarations }: {
  repository: ModelSupportInvestigationRepository,
  declarations: ModelSupportInvestigationModelDeclarations,
}): ModelSupportInvestigationGenerationAutoClassName | undefined {
  const supported = new Set(declarations.classCapabilities
    .filter(capability => capability.supports === true)
    .map(capability => capability.autoClass));
  const priority = [
    ...(repository.pipelineTag === undefined ? [] : (PIPELINE_PRIORITY[repository.pipelineTag] ?? [])),
    ...DEFAULT_PRIORITY,
  ];
  return priority.find(autoClass => supported.has(autoClass));
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  DEFAULT_PRIORITY,
  PIPELINE_PRIORITY,
};
