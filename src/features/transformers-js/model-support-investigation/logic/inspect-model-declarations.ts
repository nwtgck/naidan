import type {
  ModelSupportInvestigationAutoClassName,
  ModelSupportInvestigationClassCapability,
  ModelSupportInvestigationModelDeclarations,
  ModelSupportInvestigationRepository,
} from "@/features/transformers-js/model-support-investigation/types";
import {
  investigationJsonObjectSchema,
  parseInvestigationJson,
} from "@/features/transformers-js/model-support-investigation/logic/json-value-schema";

const MAX_DECLARATION_BYTES = 2 * 1024 * 1024;
const DECLARATION_PATHS = [
  "config.json",
  "tokenizer_config.json",
  "processor_config.json",
  "preprocessor_config.json",
  "generation_config.json",
  "chat_template.json",
] as const;

type AutoClassLike = Pick<
  typeof import("@huggingface/transformers").AutoModel,
  "supports"
>;

export type ModelSupportInvestigationAutoClasses = Record<
  ModelSupportInvestigationAutoClassName,
  AutoClassLike
>;

function optionalJsonObject({ value }: { value: unknown }): Record<string, unknown> | undefined {
  const result = investigationJsonObjectSchema.safeParse(value);
  return result.success ? result.data : undefined;
}

function resolvedFileUrl({ repository, path }: {
  repository: ModelSupportInvestigationRepository,
  path: string,
}): string {
  const encodedModelId = repository.normalizedModelId
    .split("/")
    .map(part => encodeURIComponent(part))
    .join("/");
  const encodedPath = path
    .split("/")
    .map(part => encodeURIComponent(part))
    .join("/");
  return `https://huggingface.co/${encodedModelId}/resolve/${repository.resolvedRevision}/${encodedPath}`;
}

async function fetchJsonDeclaration({
  repository,
  path,
  repositoryFetch,
}: {
  repository: ModelSupportInvestigationRepository,
  path: string,
  repositoryFetch: typeof fetch,
}): Promise<ModelSupportInvestigationModelDeclarations["files"][number]> {
  const url = resolvedFileUrl({ repository, path });
  const response = await repositoryFetch(url, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`Hugging Face declaration request failed for ${path}: ${response.status} ${response.statusText}`);
  }

  const contentLengthHeader = response.headers.get("content-length");
  const contentLength = contentLengthHeader === null ? undefined : Number(contentLengthHeader);
  if (contentLength !== undefined && Number.isFinite(contentLength) && contentLength > MAX_DECLARATION_BYTES) {
    throw new Error(`Hugging Face declaration ${path} exceeds the ${MAX_DECLARATION_BYTES}-byte limit`);
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_DECLARATION_BYTES) {
    throw new Error(`Hugging Face declaration ${path} exceeds the ${MAX_DECLARATION_BYTES}-byte limit`);
  }

  let value: unknown;
  try {
    value = parseInvestigationJson({
      value: JSON.parse(new TextDecoder().decode(bytes)),
      label: `Hugging Face declaration ${path}`,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Hugging Face declaration ${path} is not valid JSON: ${detail}`);
  }

  return {
    path,
    url,
    responseUrl: response.url || url,
    byteLength: bytes.byteLength,
    contentType: response.headers.get("content-type") ?? undefined,
    value,
  };
}

function classCapabilities({
  modelType,
  autoClasses,
}: {
  modelType: string | undefined,
  autoClasses: ModelSupportInvestigationAutoClasses,
}): ModelSupportInvestigationClassCapability[] {
  return (Object.keys(autoClasses) as ModelSupportInvestigationAutoClassName[])
    .sort((a, b) => a.localeCompare(b))
    .map((autoClass) => {
      if (modelType === undefined) {
        return {
          autoClass,
          supports: undefined,
          notEvaluatedReason: "config.model_type is missing",
        };
      }
      return {
        autoClass,
        supports: autoClasses[autoClass].supports(modelType),
        notEvaluatedReason: undefined,
      };
    });
}

export async function inspectModelDeclarations({
  repository,
  repositoryFetch,
  autoClasses,
}: {
  repository: ModelSupportInvestigationRepository,
  repositoryFetch: typeof fetch,
  autoClasses: ModelSupportInvestigationAutoClasses,
}): Promise<ModelSupportInvestigationModelDeclarations> {
  const repositoryPaths = new Set(repository.files.map(file => file.path));
  if (!repositoryPaths.has("config.json")) {
    throw new Error("Hugging Face repository manifest does not contain config.json");
  }

  const paths = DECLARATION_PATHS.filter(path => repositoryPaths.has(path));
  const files = [];
  for (const path of paths) {
    files.push(await fetchJsonDeclaration({ repository, path, repositoryFetch }));
  }

  const configFile = files.find(file => file.path === "config.json");
  const config = optionalJsonObject({ value: configFile?.value });
  if (config === undefined) {
    throw new Error("Hugging Face config.json is not a JSON object");
  }

  const modelType = typeof config.model_type === "string" ? config.model_type : undefined;
  const architectures = Array.isArray(config.architectures)
    ? config.architectures.filter((value): value is string => typeof value === "string")
    : [];

  return {
    normalizedModelId: repository.normalizedModelId,
    resolvedRevision: repository.resolvedRevision,
    files,
    config,
    modelType,
    architectures,
    autoMap: optionalJsonObject({ value: config.auto_map }),
    transformersJsConfig: optionalJsonObject({ value: config["transformers.js_config"] }),
    classCapabilities: classCapabilities({ modelType, autoClasses }),
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
