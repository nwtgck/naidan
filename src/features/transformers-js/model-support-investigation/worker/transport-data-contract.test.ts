import { describe, expect, it } from "vitest";
import type {
  ModelSupportInvestigationCandidateFilePlan,
  ModelSupportInvestigationEvent,
  ModelSupportInvestigationLoadAttempt,
  ModelSupportInvestigationLoadAttemptEvent,
  ModelSupportInvestigationModelDeclarations,
  ModelSupportInvestigationRepository,
  ModelSupportInvestigationRun,
  ModelSupportInvestigationTemplateBehavior,
} from "@/features/transformers-js/model-support-investigation/types";
import type {
  ModelLoadResult,
  ProgressInfo,
  TransformersJsPrefetchResult,
  TransformersJsProductionInvestigationObservation,
  TransformersJsProductionInvestigationScenario,
  WorkerToolDefinition,
} from "@/features/transformers-js/types";
import type { ChatMessage, LmParameters, ToolCall } from "@/01-models/types";

type PreviousDepth = [never, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

type FunctionPath<T, Prefix extends string = "", Depth extends number = 12> =
  Depth extends 0
    ? never
    : T extends (...args: never[]) => unknown
      ? Prefix
      : T extends readonly (infer Item)[]
        ? FunctionPath<Item, `${Prefix}[]`, PreviousDepth[Depth]>
        : T extends object
          ? {
              [Key in keyof T & string]: FunctionPath<
                T[Key],
                Prefix extends "" ? Key : `${Prefix}.${Key}`,
                PreviousDepth[Depth]
              >
            }[keyof T & string]
          : never;

type AssertNever<T extends never> = T;

type WorkerTransportData =
  | ModelSupportInvestigationRepository
  | ModelSupportInvestigationModelDeclarations
  | ModelSupportInvestigationTemplateBehavior
  | ModelSupportInvestigationCandidateFilePlan
  | ModelSupportInvestigationRun
  | ModelSupportInvestigationLoadAttempt
  | ModelSupportInvestigationEvent
  | ModelSupportInvestigationLoadAttemptEvent
  | TransformersJsProductionInvestigationScenario
  | TransformersJsProductionInvestigationObservation
  | ProgressInfo
  | ModelLoadResult
  | TransformersJsPrefetchResult
  | ChatMessage
  | LmParameters
  | ToolCall
  | WorkerToolDefinition;

const workerTransportFunctionPaths: AssertNever<FunctionPath<WorkerTransportData>>[] = [];
const functionPathProbe: FunctionPath<{
  nested: {
    callback: ({ value }: { value: string }) => void,
  },
}> = "nested.callback";

describe("Model Support Investigation Worker transport data", () => {
  it("keeps transported DTOs free of functions and callable class instances", () => {
    expect(workerTransportFunctionPaths).toEqual([]);
    expect(functionPathProbe).toBe("nested.callback");
  });
});
