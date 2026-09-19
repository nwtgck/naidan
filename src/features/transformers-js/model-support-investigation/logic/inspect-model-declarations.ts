import type {
  ModelSupportInvestigationAutoClassName,
  ModelSupportInvestigationClassCapability,
  ModelSupportInvestigationJsonObject,
  ModelSupportInvestigationJsonValue,
  ModelSupportInvestigationCacheInventory,
  ModelSupportInvestigationModelDeclarations,
  ModelSupportInvestigationRepository,
  ModelSupportInvestigationRuntimeTarget,
} from "@/features/transformers-js/model-support-investigation/types";
import {
  investigationJsonObjectSchema,
  parseInvestigationJson,
} from "@/features/transformers-js/model-support-investigation/logic/json-value-schema";
import { serializeInvestigationError } from "@/features/transformers-js/model-support-investigation/logic/serialize-investigation-error";

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

function optionalJsonObject({ value }: { value: unknown }): ModelSupportInvestigationJsonObject | undefined {
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

  const responseUrl = response.url || url;
  const contentType = response.headers.get("content-type") ?? undefined;
  if (contentType?.toLowerCase().includes("text/html") === true) {
    throw new Error(`Hugging Face declaration ${path} resolved to HTML instead of JSON: ${responseUrl}`);
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_DECLARATION_BYTES) {
    throw new Error(`Hugging Face declaration ${path} exceeds the ${MAX_DECLARATION_BYTES}-byte limit`);
  }
  const text = new TextDecoder().decode(bytes);
  const trimmed = text.trimStart().toLowerCase();
  if (trimmed.startsWith("<!doctype html") || trimmed.startsWith("<html")) {
    throw new Error(`Hugging Face declaration ${path} returned HTML-like content instead of JSON: ${responseUrl}`);
  }

  let value: ModelSupportInvestigationJsonValue;
  try {
    value = parseInvestigationJson({
      value: JSON.parse(text),
      label: `Hugging Face declaration ${path}`,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Hugging Face declaration ${path} is not valid JSON at ${responseUrl}: ${detail}`, { cause: error });
  }

  return {
    path,
    url,
    responseUrl,
    byteLength: bytes.byteLength,
    contentType,
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

function buildModelDeclarations({
  normalizedModelId,
  resolvedRevision,
  files,
  fileFailures,
  autoClasses,
}: {
  normalizedModelId: string,
  resolvedRevision: string,
  files: ModelSupportInvestigationModelDeclarations["files"],
  fileFailures: ModelSupportInvestigationModelDeclarations["fileFailures"],
  autoClasses: ModelSupportInvestigationAutoClasses,
}): ModelSupportInvestigationModelDeclarations {
  const configFile = files.find(file => file.path === "config.json");
  const config = optionalJsonObject({ value: configFile?.value });
  if (config === undefined) {
    throw new Error("config.json is not a JSON object");
  }
  const modelType = typeof config.model_type === "string" ? config.model_type : undefined;
  const architectures = Array.isArray(config.architectures)
    ? config.architectures.filter((value): value is string => typeof value === "string")
    : [];
  return {
    normalizedModelId,
    resolvedRevision,
    files,
    fileFailures,
    config,
    modelType,
    architectures,
    autoMap: optionalJsonObject({ value: config.auto_map }),
    transformersJsConfig: optionalJsonObject({ value: config["transformers.js_config"] }),
    classCapabilities: classCapabilities({ modelType, autoClasses }),
  };
}

function cachedDeclarationUrl({ runtimeTarget, path }: {
  runtimeTarget: ModelSupportInvestigationRuntimeTarget,
  path: string,
}): string {
  const model = runtimeTarget.normalizedModelId.split("/").map(part => encodeURIComponent(part)).join("/");
  const file = path.split("/").map(part => encodeURIComponent(part)).join("/");
  return `opfs://models/huggingface.co/${model}/resolve/${encodeURIComponent(runtimeTarget.evidenceRevision)}/${file}`;
}

function completedCachedDeclarationPaths({
  runtimeTarget,
  cache,
}: {
  runtimeTarget: ModelSupportInvestigationRuntimeTarget,
  cache: ModelSupportInvestigationCacheInventory,
}): Set<string> {
  return new Set(cache.files
    .filter(file => (
      file.cacheRevision === runtimeTarget.evidenceRevision
      && file.repositoryPath !== undefined
      && file.size > 0
      && file.hasCompletionMarker
    ))
    .map(file => file.repositoryPath as string));
}

async function readCachedJsonDeclaration({
  runtimeTarget,
  path,
  readCachedFile,
}: {
  runtimeTarget: ModelSupportInvestigationRuntimeTarget,
  path: string,
  readCachedFile: ({ repositoryPath }: { repositoryPath: string }) => Promise<Uint8Array | undefined>,
}): Promise<ModelSupportInvestigationModelDeclarations["files"][number]> {
  const url = cachedDeclarationUrl({ runtimeTarget, path });
  const bytes = await readCachedFile({ repositoryPath: path });
  if (bytes === undefined || bytes.byteLength === 0) {
    throw new Error(`Completed local declaration ${path} could not be read from OPFS`);
  }
  if (bytes.byteLength > MAX_DECLARATION_BYTES) {
    throw new Error(`Local declaration ${path} exceeds the ${MAX_DECLARATION_BYTES}-byte limit`);
  }
  const text = new TextDecoder().decode(bytes);
  const trimmed = text.trimStart().toLowerCase();
  if (trimmed.startsWith("<!doctype html") || trimmed.startsWith("<html")) {
    throw new Error(`Local declaration ${path} contains HTML-like content instead of JSON`);
  }
  let value: ModelSupportInvestigationJsonValue;
  try {
    value = parseInvestigationJson({
      value: JSON.parse(text),
      label: `Local cached declaration ${path}`,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Local declaration ${path} is not valid JSON: ${detail}`, { cause: error });
  }
  return {
    path,
    url,
    responseUrl: url,
    byteLength: bytes.byteLength,
    contentType: "application/json",
    value,
  };
}

export async function inspectCachedModelDeclarations({
  runtimeTarget,
  cache,
  readCachedFile,
  autoClasses,
}: {
  runtimeTarget: ModelSupportInvestigationRuntimeTarget,
  cache: ModelSupportInvestigationCacheInventory,
  readCachedFile: ({ repositoryPath }: { repositoryPath: string }) => Promise<Uint8Array | undefined>,
  autoClasses: ModelSupportInvestigationAutoClasses,
}): Promise<ModelSupportInvestigationModelDeclarations> {
  switch (runtimeTarget.source) {
  case "local-cache":
    break;
  case "repository":
    throw new Error("Cached model declaration inspection requires a local-cache RuntimeTarget");
  default: {
    const _ex: never = runtimeTarget.source;
    return _ex;
  }
  }
  if (cache.normalizedModelId !== runtimeTarget.normalizedModelId) {
    throw new Error("RuntimeTarget and local cache model IDs do not match");
  }
  const completedPaths = completedCachedDeclarationPaths({ runtimeTarget, cache });
  if (!completedPaths.has("config.json")) {
    throw new Error(`Completed local config.json is unavailable at revision ${runtimeTarget.evidenceRevision}`);
  }
  const files = [await readCachedJsonDeclaration({ runtimeTarget, path: "config.json", readCachedFile })];
  const fileFailures: ModelSupportInvestigationModelDeclarations["fileFailures"] = [];
  for (const path of DECLARATION_PATHS) {
    if (path === "config.json" || !completedPaths.has(path)) continue;
    try {
      files.push(await readCachedJsonDeclaration({ runtimeTarget, path, readCachedFile }));
    } catch (error) {
      fileFailures.push({
        path,
        url: cachedDeclarationUrl({ runtimeTarget, path }),
        error: serializeInvestigationError({ error }),
      });
    }
  }
  return buildModelDeclarations({
    normalizedModelId: runtimeTarget.normalizedModelId,
    resolvedRevision: runtimeTarget.evidenceRevision,
    files,
    fileFailures,
    autoClasses,
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

  const configFile = await fetchJsonDeclaration({
    repository,
    path: "config.json",
    repositoryFetch,
  });
  const files = [configFile];
  const fileFailures: ModelSupportInvestigationModelDeclarations["fileFailures"] = [];
  const optionalPaths = DECLARATION_PATHS.filter(path => path !== "config.json" && repositoryPaths.has(path));
  for (const path of optionalPaths) {
    try {
      files.push(await fetchJsonDeclaration({ repository, path, repositoryFetch }));
    } catch (error) {
      fileFailures.push({
        path,
        url: resolvedFileUrl({ repository, path }),
        error: serializeInvestigationError({ error }),
      });
    }
  }

  return buildModelDeclarations({
    normalizedModelId: repository.normalizedModelId,
    resolvedRevision: repository.resolvedRevision,
    files,
    fileFailures,
    autoClasses,
  });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
