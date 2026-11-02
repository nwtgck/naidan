import type { LocationQuery, LocationQueryRaw } from 'vue-router';
import { selectableProfiles } from '@/features/llama-cpp-browser/runtime/profile-policy';
import { measurementModeSchema } from '@/features/llama-cpp-browser/performance/types';
import { minimumChatContextTokens, maximumChatContextTokens, visionBf16StorageSchema } from '@/features/llama-cpp-browser/types';

/**
 * Diagnostics URL parameters are disposable, build-local developer controls,
 * NOT a stable public or persisted schema. Breaking changes, renames and removals
 * are allowed without migration. Unknown keys (including removed parameters)
 * MUST be ignored. Do not add URL versions or migration/compatibility logic,
 * now or in the future. Only this build's registered keys are meaningful.
 *
 * Missing keys use the current screen/runtime defaults. Loading, inventory
 * refreshes and capability probes must not rewrite the URL. Only explicit user
 * edits use router.replace(). This policy does not change archive protocols.
 *
 * Vue Router already decodes values. DTO schemas describe persisted structures;
 * this local codec additionally handles repeated keys, presence and scalar input.
 */
type Raw = LocationQuery[string] | undefined;
type Encoded = string | string[] | null;
type Codec<T> = {
  parse: ({ raw }: { raw: Raw }) => T | undefined,
  serialize: ({ value }: { value: T }) => Encoded,
};

function text({ maximum }: { maximum: number }): Codec<string> {
  return {
    parse: ({ raw }) => typeof raw === 'string' && raw.length <= maximum ? raw : undefined,
    serialize: ({ value }) => value,
  };
}

function integer({ minimum, maximum }: { minimum: number, maximum: number }): Codec<number> {
  return {
    parse: ({ raw }) => {
      if (typeof raw !== 'string' || !/^(0|[1-9]\d*)$/.test(raw)) {
        return undefined;
      }
      const value = Number(raw);
      return Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : undefined;
    },
    serialize: ({ value }) => String(value),
  };
}

function choice<const T extends string>({ values }: { values: readonly T[] }): Codec<T> {
  return {
    parse: ({ raw }) => values.find(value => value === raw),
    serialize: ({ value }) => value,
  };
}

const flag: Codec<boolean> = {
  parse: ({ raw }) => raw === '1' ? true : raw === '0' ? false : undefined,
  serialize: ({ value }) => value ? '1' : '0',
};
const presence: Codec<true> = {
  parse: ({ raw }) => raw === null ? true : undefined,
  serialize: () => null,
};
const models: Codec<string[]> = {
  parse: ({ raw }) => {
    if (raw === undefined || raw === null) {
      return undefined;
    }
    const values = Array.isArray(raw) ? raw : [raw];
    if (!values.some(value => typeof value === 'string')) {
      return undefined;
    }
    // Empty strings explicitly select zero models. Never trim real IDs.
    return [...new Set(values.filter((value): value is string => typeof value === 'string' && value !== ''))];
  },
  serialize: ({ value }) => value.length ? [...value] : '',
};

function parameter<T>({ key, codec }: { key: string, codec: Codec<T> }) {
  return { key, ...codec };
}

/** The single registry of ALL externally injectable keys, values and limits. */
export const diagnosticsQueryParameters = {
  modelIds: parameter({ key: 'model', codec: models }),
  allModels: parameter({ key: 'all-models', codec: presence }),
  modelFilter: parameter({ key: 'modelFilter', codec: text({ maximum: 200 }) }),
  workload: parameter({ key: 'workload', codec: choice({ values: ['text', 'vision'] }) }),
  mode: parameter({ key: 'mode', codec: choice({ values: measurementModeSchema.options }) }),
  repeats: parameter({ key: 'repeats', codec: integer({ minimum: 1, maximum: 5 }) }),
  maxTokens: parameter({ key: 'maxTokens', codec: integer({ minimum: 1, maximum: 512 }) }),
  timeoutMinutes: parameter({ key: 'timeoutMinutes', codec: integer({ minimum: 1, maximum: 60 }) }),
  placement: parameter({ key: 'placement', codec: flag }),
  profile: parameter({ key: 'profile', codec: choice({ values: selectableProfiles }) }),
  contextTokens: parameter({ key: 'contextTokens', codec: integer({ minimum: minimumChatContextTokens, maximum: maximumChatContextTokens }) }),
  visionBf16Storage: parameter({ key: 'visionBf16Storage', codec: choice({ values: visionBf16StorageSchema.options }) }),
  notes: parameter({ key: 'notes', codec: text({ maximum: 10000 }) }),
} as const;

type Registry = typeof diagnosticsQueryParameters;
export type DiagnosticsQueryConfig = { -readonly [K in keyof Registry]?: Exclude<ReturnType<Registry[K]['parse']>, undefined> };
const fields = Object.keys(diagnosticsQueryParameters) as (keyof Registry)[];

export function parseDiagnosticsQuery({ query }: { query: LocationQuery }): DiagnosticsQueryConfig {
  const config: DiagnosticsQueryConfig = {};
  function read<K extends keyof Registry>({ field }: { field: K }): void {
    // The registry relates each key to its own codec. This local assertion keeps
    // that relationship through Object.keys, without asserting external data.
    const codec = diagnosticsQueryParameters[field] as Codec<NonNullable<DiagnosticsQueryConfig[K]>> & { key: string };
    if (Object.hasOwn(query, codec.key)) {
      const value = codec.parse({ raw: query[codec.key] });
      if (value !== undefined) {
        config[field] = value;
      }
    }
  }
  for (const field of fields) {
    read({ field });
  }
  if (config.allModels) {
    delete config.modelIds;
  }
  return config;
}

export function serializeDiagnosticsQuery({ config }: { config: DiagnosticsQueryConfig }): LocationQueryRaw {
  const query: LocationQueryRaw = {};
  function write<K extends keyof Registry>({ field }: { field: K }): void {
    const value = config[field];
    if (value === undefined || (field === 'modelIds' && config.allModels)) {
      return;
    }
    const codec = diagnosticsQueryParameters[field] as Codec<NonNullable<DiagnosticsQueryConfig[K]>> & { key: string };
    query[codec.key] = codec.serialize({ value });
  }
  for (const field of fields) {
    write({ field });
  }
  return query;
}

/** Reject an invalid local edit without erasing the previous URL value. */
export function isDiagnosticsEditValid({ patch }: { patch: DiagnosticsQueryConfig }): boolean {
  const encoded = serializeDiagnosticsQuery({ config: patch });
  const parsed = parseDiagnosticsQuery({ query: encoded as LocationQuery });
  return fields.every(field => patch[field] === undefined || parsed[field] !== undefined);
}

export const TEST_ONLY = {
};
