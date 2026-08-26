import { describe, expect, it } from "vitest";
import { correlateSessionFiles } from "@/features/transformers-js/model-support-investigation/logic/correlate-session-files";
import type { ModelSupportInvestigationPlannedFile } from "@/features/transformers-js/model-support-investigation/types";

function file(path: string, kind: ModelSupportInvestigationPlannedFile["kind"]): ModelSupportInvestigationPlannedFile {
  return { path, kind } as ModelSupportInvestigationPlannedFile;
}

describe("correlateSessionFiles", () => {
  it("records an exact unique basename match and its exact external-data files", () => {
    expect(correlateSessionFiles({
      sessions: [{ name: "model", inputNames: [], outputNames: [] }],
      files: [file("onnx/model.onnx", "core-onnx"), file("onnx/model.onnx_data", "external-data"), file("onnx/model.onnx_data_1", "external-data")],
    })).toEqual([{
      sessionName: "model",
      status: "exact",
      matchBasis: "exact-session-name-to-core-onnx-basename",
      coreFilePaths: ["onnx/model.onnx"],
      externalDataPaths: ["onnx/model.onnx_data", "onnx/model.onnx_data_1"],
    }]);
  });

  it("does not infer a dtype-suffixed filename match", () => {
    expect(correlateSessionFiles({
      sessions: [{ name: "model", inputNames: [], outputNames: [] }],
      files: [file("onnx/model_q4.onnx", "core-onnx")],
    })[0]).toMatchObject({ status: "unmatched", coreFilePaths: [] });
  });

  it("keeps duplicate exact basenames ambiguous", () => {
    expect(correlateSessionFiles({
      sessions: [{ name: "model", inputNames: [], outputNames: [] }],
      files: [file("a/model.onnx", "core-onnx"), file("b/model.onnx", "core-onnx")],
    })[0]).toMatchObject({ status: "ambiguous", coreFilePaths: ["a/model.onnx", "b/model.onnx"] });
  });
});
