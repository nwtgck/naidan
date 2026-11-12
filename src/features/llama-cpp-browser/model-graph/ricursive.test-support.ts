import { parseModelGraphDefinitions, type ModelGraphDefinition } from './definition';
import { expandModelGraphDefinition } from './expand';
import { graphTensorBytes } from './tensor-layout';
import type { GraphMetadataValue } from './expressions';
import type { ModelGraphInventory, ModelGraphTensorInfo } from './compile';

/** Exact user-supplied Ripple-65B declaration (2026-11-12). This is test data,
 * not a built-in architecture and not a claim of real-model numerical validation. */
export function ricursiveDeclarationFixture(): ModelGraphDefinition {
  const input = `\
{
  "format": "naidan.model-graph/experimental-2",
  "name": "Ricursive Ripple-65B Preview (unverified GGUF declaration)",
  "applicability": {
    "architecture": "ricursive",
    "metadata": [
      {"key":"ricursive.block_count","value":80},
      {"key":"ricursive.embedding_length","value":5120},
      {"key":"ricursive.attention.head_count","value":80},
      {"key":"ricursive.attention.head_count_kv","value":8}
    ]
  },
  "requiredCapabilities": [
    "tensor-graph/v1",
    "decoder-kv-linear/v1",
    "rotary-normal-neox/v1",
    "tensor-operators/v2",
    "declaration-expansion/v1"
  ],
  "parameters": [],
  "weights": [
    {"id":"embedding","tensor":"token_embd.weight","shape":[5120,100352],"types":["F32","F16","BF16","Q4_0","Q4_1","Q5_0","Q5_1","Q8_0","Q2_K","Q3_K","Q4_K","Q5_K","Q6_K","IQ2_XXS","IQ2_XS","IQ3_XXS","IQ1_S","IQ4_NL","IQ3_S","IQ2_S","IQ4_XS","IQ1_M"]},
    {"id":"outNormWeight","tensor":"output_norm.weight","shape":[5120],"types":["F32","F16","BF16"]},
    {"id":"lmHead","tensor":"output.weight","shape":[5120,100352],"types":["F32","F16","BF16","Q4_0","Q4_1","Q5_0","Q5_1","Q8_0","Q2_K","Q3_K","Q4_K","Q5_K","Q6_K","IQ2_XXS","IQ2_XS","IQ3_XXS","IQ1_S","IQ4_NL","IQ3_S","IQ2_S","IQ4_XS","IQ1_M"]}
  ],
  "state": {
    "profile": "decoder-state/v2",
    "slots": [],
    "tensors": [],
    "updates": []
  },
  "graph": {
    "nodes": [
      {"id":"tokensEmbedded","op":"embedding","weight":"embedding"},
      {"id":"h.-1","op":"scale","input":"tokensEmbedded","value":{"metadata":"ricursive.embedding_scale"}},
      {
        "id": "allLayers",
        "op": "repeat",
        "index": "layer",
        "count": 80,
        "weights": [
          {"id":"attnNorm.\${layer}","tensor":"blk.\${layer}.attn_norm.weight","shape":[5120],"types":["F32","F16","BF16"]},
          {"id":"qW.\${layer}","tensor":"blk.\${layer}.attn_q.weight","shape":[5120,10240],"types":["F32","F16","BF16","Q4_0","Q4_1","Q5_0","Q5_1","Q8_0","Q2_K","Q3_K","Q4_K","Q5_K","Q6_K","IQ2_XXS","IQ2_XS","IQ3_XXS","IQ1_S","IQ4_NL","IQ3_S","IQ2_S","IQ4_XS","IQ1_M"]},
          {"id":"kW.\${layer}","tensor":"blk.\${layer}.attn_k.weight","shape":[5120,1024],"types":["F32","F16","BF16","Q4_0","Q4_1","Q5_0","Q5_1","Q8_0","Q2_K","Q3_K","Q4_K","Q5_K","Q6_K","IQ2_XXS","IQ2_XS","IQ3_XXS","IQ1_S","IQ4_NL","IQ3_S","IQ2_S","IQ4_XS","IQ1_M"]},
          {"id":"vW.\${layer}","tensor":"blk.\${layer}.attn_v.weight","shape":[5120,1024],"types":["F32","F16","BF16","Q4_0","Q4_1","Q5_0","Q5_1","Q8_0","Q2_K","Q3_K","Q4_K","Q5_K","Q6_K","IQ2_XXS","IQ2_XS","IQ3_XXS","IQ1_S","IQ4_NL","IQ3_S","IQ2_S","IQ4_XS","IQ1_M"]},
          {"id":"oW.\${layer}","tensor":"blk.\${layer}.attn_output.weight","shape":[10240,5120],"types":["F32","F16","BF16","Q4_0","Q4_1","Q5_0","Q5_1","Q8_0","Q2_K","Q3_K","Q4_K","Q5_K","Q6_K","IQ2_XXS","IQ2_XS","IQ3_XXS","IQ1_S","IQ4_NL","IQ3_S","IQ2_S","IQ4_XS","IQ1_M"]},
          {"id":"qNormW.\${layer}","tensor":"blk.\${layer}.attn_q_norm.weight","shape":[128],"types":["F32","F16","BF16"]},
          {"id":"kNormW.\${layer}","tensor":"blk.\${layer}.attn_k_norm.weight","shape":[128],"types":["F32","F16","BF16"]},
          {"id":"attnGateW.\${layer}","tensor":"blk.\${layer}.attn_gate.weight","shape":[5120,10240],"types":["F32","F16","BF16","Q4_0","Q4_1","Q5_0","Q5_1","Q8_0","Q2_K","Q3_K","Q4_K","Q5_K","Q6_K","IQ2_XXS","IQ2_XS","IQ3_XXS","IQ1_S","IQ4_NL","IQ3_S","IQ2_S","IQ4_XS","IQ1_M"]},
          {"id":"vresW.\${layer}","tensor":"blk.\${layer}.attn_vres_lambda.weight","shape":[1],"types":["F32","F16","BF16"]},
          {"id":"postAttnW.\${layer}","tensor":"blk.\${layer}.post_attention_norm.weight","shape":[5120],"types":["F32","F16","BF16"]},
          {"id":"ffnNormW.\${layer}","tensor":"blk.\${layer}.ffn_norm.weight","shape":[5120],"types":["F32","F16","BF16"]},
          {"id":"ffnGateW.\${layer}","tensor":"blk.\${layer}.ffn_gate.weight","shape":[5120,40960],"types":["F32","F16","BF16","Q4_0","Q4_1","Q5_0","Q5_1","Q8_0","Q2_K","Q3_K","Q4_K","Q5_K","Q6_K","IQ2_XXS","IQ2_XS","IQ3_XXS","IQ1_S","IQ4_NL","IQ3_S","IQ2_S","IQ4_XS","IQ1_M"]},
          {"id":"ffnUpW.\${layer}","tensor":"blk.\${layer}.ffn_up.weight","shape":[5120,40960],"types":["F32","F16","BF16","Q4_0","Q4_1","Q5_0","Q5_1","Q8_0","Q2_K","Q3_K","Q4_K","Q5_K","Q6_K","IQ2_XXS","IQ2_XS","IQ3_XXS","IQ1_S","IQ4_NL","IQ3_S","IQ2_S","IQ4_XS","IQ1_M"]},
          {"id":"ffnDownW.\${layer}","tensor":"blk.\${layer}.ffn_down.weight","shape":[40960,5120],"types":["F32","F16","BF16","Q4_0","Q4_1","Q5_0","Q5_1","Q8_0","Q2_K","Q3_K","Q4_K","Q5_K","Q6_K","IQ2_XXS","IQ2_XS","IQ3_XXS","IQ1_S","IQ4_NL","IQ3_S","IQ2_S","IQ4_XS","IQ1_M"]},
          {"id":"postFfnW.\${layer}","tensor":"blk.\${layer}.post_ffw_norm.weight","shape":[5120],"types":["F32","F16","BF16"]}
        ],
        "slots": [
          {"id":"kv.\${layer}","headSize":128,"heads":8,"precision":"F16"}
        ],
        "tensors": [],
        "updates": [],
        "nodes": [
          {"id":"an.\${layer}","op":"normalizeRms","input":"h.\${layer-1}","epsilon":{"metadata":"ricursive.attention.layer_norm_rms_epsilon"}},
          {"id":"anW32.\${layer}","op":"tensor","operator":"cast","inputs":["attnNorm.\${layer}"],"attributes":{"type":"F32"}},
          {"id":"ai.\${layer}","op":"multiply","left":"an.\${layer}","right":"anW32.\${layer}"},
          {"id":"q.\${layer}","op":"linear","weight":"qW.\${layer}","input":"ai.\${layer}"},
          {"id":"k.\${layer}","op":"linear","weight":"kW.\${layer}","input":"ai.\${layer}"},
          {"id":"vresW32.\${layer}","op":"tensor","operator":"cast","inputs":["vresW.\${layer}"],"attributes":{"type":"F32"}},
          {"id":"mix.\${layer}","op":"sigmoid","input":"vresW32.\${layer}"},
          {"id":"delta.\${layer}","op":"subtract","left":"ai.\${layer}","right":"h.-1"},
          {"id":"mixdelta.\${layer}","op":"multiply","left":"delta.\${layer}","right":"mix.\${layer}"},
          {"id":"vinput.\${layer}","op":"add","left":"h.-1","right":"mixdelta.\${layer}"},
          {"id":"v.\${layer}","op":"linear","weight":"vW.\${layer}","input":"vinput.\${layer}"},
          {"id":"q3.\${layer}","op":"reshape","input":"q.\${layer}","shape":[128,80,{"inputTokens":true}]},
          {"id":"k3.\${layer}","op":"reshape","input":"k.\${layer}","shape":[128,8,{"inputTokens":true}]},
          {"id":"v3.\${layer}","op":"reshape","input":"v.\${layer}","shape":[128,8,{"inputTokens":true}]},
          {"id":"qn.\${layer}","op":"normalizeRms","input":"q3.\${layer}","epsilon":{"metadata":"ricursive.attention.layer_norm_rms_epsilon"}},
          {"id":"kn.\${layer}","op":"normalizeRms","input":"k3.\${layer}","epsilon":{"metadata":"ricursive.attention.layer_norm_rms_epsilon"}},
          {"id":"qnW32.\${layer}","op":"tensor","operator":"cast","inputs":["qNormW.\${layer}"],"attributes":{"type":"F32"}},
          {"id":"knW32.\${layer}","op":"tensor","operator":"cast","inputs":["kNormW.\${layer}"],"attributes":{"type":"F32"}},
          {"id":"qnorm.\${layer}","op":"multiply","left":"qn.\${layer}","right":"qnW32.\${layer}"},
          {"id":"knorm.\${layer}","op":"multiply","left":"kn.\${layer}","right":"knW32.\${layer}"},
          {
            "id": "attentionChoice.\${layer}",
            "op": "choose",
            "condition": {"metadata":"ricursive.attention.sliding_window_pattern","index":{"variable":"layer"},"equals":true},
            "then": [
              {"id":"qr.\${layer}","op":"rotaryEmbedding","input":"qnorm.\${layer}","dimensions":128,"mode":"neox","frequencyBase":{"metadata":"ricursive.rope.freq_base"},"frequencyScale":1},
              {"id":"kr.\${layer}","op":"rotaryEmbedding","input":"knorm.\${layer}","dimensions":128,"mode":"neox","frequencyBase":{"metadata":"ricursive.rope.freq_base"},"frequencyScale":1},
              {"id":"attention.\${layer}","op":"attentionCached","query":"qr.\${layer}","key":"kr.\${layer}","value":"v3.\${layer}","slot":"kv.\${layer}","window":1024,"scale":"inverseSqrtHead"}
            ],
            "otherwise": [
              {"id":"attention.\${layer}","op":"attentionCached","query":"qnorm.\${layer}","key":"knorm.\${layer}","value":"v3.\${layer}","slot":"kv.\${layer}","window":0,"scale":"inverseSqrtHead"}
            ]
          },
          {"id":"ag.\${layer}","op":"linear","weight":"attnGateW.\${layer}","input":"ai.\${layer}"},
          {"id":"agSig.\${layer}","op":"sigmoid","input":"ag.\${layer}"},
          {"id":"attnGated.\${layer}","op":"multiply","left":"attention.\${layer}","right":"agSig.\${layer}"},
          {"id":"attnProj.\${layer}","op":"linear","weight":"oW.\${layer}","input":"attnGated.\${layer}"},
          {"id":"attnPost.\${layer}","op":"normalizeRms","input":"attnProj.\${layer}","epsilon":{"metadata":"ricursive.attention.layer_norm_rms_epsilon"}},
          {"id":"attnPostW32.\${layer}","op":"tensor","operator":"cast","inputs":["postAttnW.\${layer}"],"attributes":{"type":"F32"}},
          {"id":"attnPostScaled.\${layer}","op":"multiply","left":"attnPost.\${layer}","right":"attnPostW32.\${layer}"},
          {"id":"resid.\${layer}","op":"add","left":"h.\${layer-1}","right":"attnPostScaled.\${layer}"},
          {"id":"fn.\${layer}","op":"normalizeRms","input":"resid.\${layer}","epsilon":{"metadata":"ricursive.attention.layer_norm_rms_epsilon"}},
          {"id":"fnW32.\${layer}","op":"tensor","operator":"cast","inputs":["ffnNormW.\${layer}"],"attributes":{"type":"F32"}},
          {"id":"ffnInput.\${layer}","op":"multiply","left":"fn.\${layer}","right":"fnW32.\${layer}"},
          {"id":"ffnGate.\${layer}","op":"linear","weight":"ffnGateW.\${layer}","input":"ffnInput.\${layer}"},
          {"id":"ffnUp.\${layer}","op":"linear","weight":"ffnUpW.\${layer}","input":"ffnInput.\${layer}"},
          {"id":"swiglu.\${layer}","op":"tensor","operator":"swigluClamped","inputs":["ffnGate.\${layer}","ffnUp.\${layer}"],"attributes":{"limit":{"metadata":"ricursive.swiglu_clamp","index":{"variable":"layer"}}}},
          {"id":"ffnDown.\${layer}","op":"linear","weight":"ffnDownW.\${layer}","input":"swiglu.\${layer}"},
          {"id":"ffnPost.\${layer}","op":"normalizeRms","input":"ffnDown.\${layer}","epsilon":{"metadata":"ricursive.attention.layer_norm_rms_epsilon"}},
          {"id":"ffnPostW32.\${layer}","op":"tensor","operator":"cast","inputs":["postFfnW.\${layer}"],"attributes":{"type":"F32"}},
          {"id":"ffnPostScaled.\${layer}","op":"multiply","left":"ffnPost.\${layer}","right":"ffnPostW32.\${layer}"},
          {"id":"h.\${layer}","op":"add","left":"resid.\${layer}","right":"ffnPostScaled.\${layer}"}
        ]
      },
      {"id":"outputNormalized","op":"normalizeRms","input":"h.79","epsilon":{"metadata":"ricursive.attention.layer_norm_rms_epsilon"}},
      {"id":"outputNormW32","op":"tensor","operator":"cast","inputs":["outNormWeight"],"attributes":{"type":"F32"}},
      {"id":"outputScaled","op":"multiply","left":"outputNormalized","right":"outputNormW32"},
      {"id":"logits","op":"linear","weight":"lmHead","input":"outputScaled"}
    ]
  },
  "outputs": {"logits":"logits"},
  "annotations": "Unverified structural declaration for Ripple-65B. Requires real-GGUF tensor/metadata verification, numerical comparison and matching bicore extension. Do not approve for production."
}`;
  return parseModelGraphDefinitions({ input })[0]!.definition;
}

/** Only metadata and tensor descriptors: never allocates the model's weights. */
export function ricursiveInventoryFixture({ definition }: { definition: ModelGraphDefinition }): ModelGraphInventory {
  const metadata = new Map<string, GraphMetadataValue>([
    ['ricursive.block_count', 80], ['ricursive.embedding_length', 5120],
    ['ricursive.attention.head_count', 80], ['ricursive.attention.head_count_kv', 8],
    ['ricursive.attention.sliding_window', 1024],
    ['ricursive.embedding_scale', Math.sqrt(5120)],
    ['ricursive.attention.layer_norm_rms_epsilon', 1e-6],
    ['ricursive.rope.freq_base', 10000],
    ['ricursive.attention.sliding_window_pattern', Array.from({ length: 80 }, (_value, index) => index % 5 !== 4)],
  ]);
  const inventory: ModelGraphInventory = { architecture: 'ricursive', vocabularySize: 100352, metadata: new Map<string, GraphMetadataValue>([...metadata, ['ricursive.swiglu_clamp', Array.from({ length: 80 }, () => 20)]]), tensors: new Map() };
  const expanded = expandModelGraphDefinition({ definition, inventory });
  const tensors = new Map<string, ModelGraphTensorInfo>();
  for (const weight of expanded.weights) {
    const shape = weight.shape.map(value => {
      if (typeof value !== 'number') {
        throw new Error('Unexpected symbolic fixture weight');
      }
      return value;
    });
    const type = weight.types.includes('Q4_K') ? 'Q4_K' : 'F32';
    tensors.set(weight.tensor, { name: weight.tensor, shape, type, bytes: graphTensorBytes({ shape, type }) });
  }
  return { ...inventory, tensors };
}

export const TEST_ONLY = {
};
