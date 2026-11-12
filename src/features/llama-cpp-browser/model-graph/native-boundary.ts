import type { Core } from '@/features/llama-cpp-browser/runtime/core';
import type { ModelGraphNativeExports } from './native-exports';

// Generated from bicore bridge/model-graph.h and its exact scalar ABI schema.
// This extension deliberately does not change the base core ABI or schema hash.
export const modelGraphNativeSchemaHash = '4046d30fdeaf4c5d2c4f33e2f8c2d245fe9cdb4f210722104723573f77119ec8';
export const modelGraphNativeExports = [
  '_lcb_model_graph_architecture_known', '_lcb_model_graph_last_error', '_lcb_model_graph_sample',
  '_lcb_model_graph_sampler_workspace_free', '_lcb_model_graph_sampler_workspace_new', '_lcb_model_graph_schema_hash',
  '_lcb_model_graph_version', '_lcb_model_graph_vocab_free', '_lcb_model_graph_vocab_get', '_lcb_model_graph_vocab_new',
] as const satisfies readonly (keyof ModelGraphNativeExports)[];

export function bindModelGraphBoundary({ core }: { core: Core }) {
  core.assertIdle();
  for (const name of modelGraphNativeExports) {
    if (typeof Reflect.get(core.module, name) !== 'function') {
      throw new Error('This bicore build does not include the model-graph-v1 native extension. Install a matching rebuilt runtime; the selected graph will not fall back to a native architecture.');
    }
  }
  const native = core.module as typeof core.module & ModelGraphNativeExports;
  const cString = ({ pointer, limit }: { pointer: bigint, limit: number }): string => {
    if (typeof pointer !== 'bigint' || pointer <= 0n || pointer > BigInt(core.module.HEAPU8.length)) {
      throw new Error('Invalid model graph native string');
    }
    const bytes = core.bytes({ pointer, length: Math.min(limit, core.module.HEAPU8.length - Number(pointer)) });
    const end = bytes.indexOf(0);
    if (end < 0) {
      throw new Error('Unterminated model graph native string');
    }
    return new TextDecoder().decode(bytes.subarray(0, end));
  };
  if (native._lcb_model_graph_version() !== 1 || cString({ pointer: native._lcb_model_graph_schema_hash(), limit: 65 }) !== modelGraphNativeSchemaHash) {
    throw new Error('Model graph native extension schema mismatch');
  }
  const error = (): Error => new Error(cString({ pointer: native._lcb_model_graph_last_error(), limit: 4096 }) || 'Model graph native operation failed');
  const owned = ({ pointer }: { pointer: bigint }): bigint => {
    if (typeof pointer !== 'bigint' || pointer <= 0n) {
      throw error();
    }
    return pointer;
  };
  return {
    architectureKnown({ name }: { name: string }): boolean {
      core.assertIdle();
      if (!/^[A-Za-z0-9_.-]{1,128}$/.test(name)) {
        throw new Error('Invalid model architecture name');
      }
      const text = core.utf8({ text: name });
      try {
        const result = native._lcb_model_graph_architecture_known(text);
        if (result !== 0 && result !== 1) {
          throw error();
        }
        return result === 1;
      } finally {
        core.free({ pointer: text });
      }
    },
    async createVocabulary({ metadata }: { metadata: Uint8Array }) {
      core.assertIdle();
      if (metadata.length < 24 || metadata.length > 129 * 1024 * 1024) {
        throw new Error('Invalid vocabulary metadata length');
      }
      let data = 0n, params = 0n, gguf = 0n, owner = 0n;
      try {
        data = core.alloc({ bytes: metadata.length });
        params = core.allocRecord({ name: 'gguf_init_params' });
        core.bytes({ pointer: data, length: metadata.length }).set(metadata);
        core.setField({ name: 'gguf_init_params', pointer: params, field: 'no_alloc', value: 1 });
        core.setField({ name: 'gguf_init_params', pointer: params, field: 'ctx', value: 0n });
        gguf = await core.api.gguf_init_from_buffer(data, BigInt(metadata.length), params);
        if (!gguf) {
          throw new Error('Native tokenizer metadata could not be read');
        }
        core.assertIdle();
        owner = owned({ pointer: native._lcb_model_graph_vocab_new(gguf) });
        const vocab = owned({ pointer: native._lcb_model_graph_vocab_get(owner) });
        let closed = false;
        return {
          owner,
          vocab,
          close(): void {
            if (closed) {
              return;
            }
            core.assertIdle();
            closed = true;
            try {
              core.chat.releaseVocabulary({ assertIdle: core.assertIdle, owner });
            } finally {
              native._lcb_model_graph_vocab_free(owner);
            }
          },
        };
      } catch (failure) {
        if (owner) {
          native._lcb_model_graph_vocab_free(owner);
        }
        throw failure;
      } finally {
        try {
          if (gguf) {
            await core.api.gguf_free(gguf);
          }
        } finally {
          if (params) {
            core.free({ pointer: params });
          }
          if (data) {
            core.free({ pointer: data });
          }
        }
      }
    },
    createSamplerWorkspace({ vocabularySize }: { vocabularySize: number }) {
      core.assertIdle();
      if (!Number.isInteger(vocabularySize) || vocabularySize < 1 || vocabularySize > 1048576) {
        throw new Error('Invalid sampling vocabulary size');
      }
      const workspace = owned({ pointer: native._lcb_model_graph_sampler_workspace_new(vocabularySize) });
      let closed = false;
      return {
        sample({ sampler, logits }: { sampler: bigint, logits: bigint }): number {
          core.assertIdle();
          if (closed || !sampler || !logits) {
            throw new Error('Invalid registered graph sampler state');
          }
          core.bytes({ pointer: logits, length: vocabularySize * 4 });
          const token = native._lcb_model_graph_sample(workspace, sampler, logits, vocabularySize);
          if (!Number.isInteger(token) || token < 0 || token >= vocabularySize) {
            throw error();
          }
          return token;
        },
        close(): void {
          if (closed) {
            return;
          }
          core.assertIdle();
          closed = true;
          native._lcb_model_graph_sampler_workspace_free(workspace);
        },
      };
    },
  };
}

export const TEST_ONLY = {
};
