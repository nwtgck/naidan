import { parseModelGraphDefinitions, type ModelGraphDefinition } from './definition';
import { expandModelGraphDefinition } from './expand';
import { graphTensorBytes } from './tensor-layout';
import type { GraphMetadataValue } from './expressions';
import type { ModelGraphInventory, ModelGraphTensorInfo } from './compile';

/** Test-only, scoped authoring of the supplied model; never a production model dispatcher. */
export function ricursiveDeclarationFixture(): ModelGraphDefinition {
  return parseModelGraphDefinitions({
    input: JSON.stringify({
      "format": "naidan.model-graph/experimental-3",
      "name": "Ricursive Ripple-65B Preview (unverified GGUF declaration)",
      "applicability": {
        "architecture": "ricursive",
        "metadata": [
          {
            "key": "ricursive.block_count",
            "value": 80,
          },
          {
            "key": "ricursive.embedding_length",
            "value": 5120,
          },
          {
            "key": "ricursive.attention.head_count",
            "value": 80,
          },
          {
            "key": "ricursive.attention.head_count_kv",
            "value": 8,
          }
        ],
      },
      "requiredCapabilities": [
        "tensor-graph/v1",
        "decoder-kv-linear/v1",
        "rotary-normal-neox/v1",
        "tensor-operators/v2",
        "scoped-declarations/v1"
      ],
      "parameters": [],
      "weights": [
        {
          "id": "embedding",
          "tensor": "token_embd.weight",
          "shape": [
            5120,
            100352
          ],
          "types": [
            "F32",
            "F16",
            "BF16",
            "Q4_0",
            "Q4_1",
            "Q5_0",
            "Q5_1",
            "Q8_0",
            "Q2_K",
            "Q3_K",
            "Q4_K",
            "Q5_K",
            "Q6_K",
            "IQ2_XXS",
            "IQ2_XS",
            "IQ3_XXS",
            "IQ1_S",
            "IQ4_NL",
            "IQ3_S",
            "IQ2_S",
            "IQ4_XS",
            "IQ1_M"
          ],
        },
        {
          "id": "outNormWeight",
          "tensor": "output_norm.weight",
          "shape": [
            5120
          ],
          "types": [
            "F32",
            "F16",
            "BF16"
          ],
        },
        {
          "id": "lmHead",
          "tensor": "output.weight",
          "shape": [
            5120,
            100352
          ],
          "types": [
            "F32",
            "F16",
            "BF16",
            "Q4_0",
            "Q4_1",
            "Q5_0",
            "Q5_1",
            "Q8_0",
            "Q2_K",
            "Q3_K",
            "Q4_K",
            "Q5_K",
            "Q6_K",
            "IQ2_XXS",
            "IQ2_XS",
            "IQ3_XXS",
            "IQ1_S",
            "IQ4_NL",
            "IQ3_S",
            "IQ2_S",
            "IQ4_XS",
            "IQ1_M"
          ],
        }
      ],
      "state": {
        "profile": "decoder-state/v2",
        "slots": [],
        "tensors": [],
        "updates": [],
      },
      "graph": {
        "nodes": [
          {
            "id": "tokensEmbedded",
            "op": "embedding",
            "weight": {
              "local": "embedding",
            },
          },
          {
            "id": "initialHidden",
            "op": "scale",
            "input": {
              "local": "tokensEmbedded",
            },
            "value": {
              "metadata": "ricursive.embedding_scale",
            },
          },
          {
            "id": "allLayers",
            "op": "repeat",
            "index": "layer",
            "count": 80,
            "capture": {
              "initialHidden": {
                "local": "initialHidden",
              },
            },
            "carry": {
              "hidden": {
                "initial": {
                  "local": "initialHidden",
                },
                "next": {
                  "local": "h",
                },
              },
            },
            "body": {
              "weights": [
                {
                  "id": "attnNorm",
                  "tensor": {
                    "concat": [
                      "blk.",
                      {
                        "decimal": {
                          "iteration": "layer",
                        },
                      },
                      ".attn_norm.weight"
                    ],
                  },
                  "shape": [
                    5120
                  ],
                  "types": [
                    "F32",
                    "F16",
                    "BF16"
                  ],
                },
                {
                  "id": "qW",
                  "tensor": {
                    "concat": [
                      "blk.",
                      {
                        "decimal": {
                          "iteration": "layer",
                        },
                      },
                      ".attn_q.weight"
                    ],
                  },
                  "shape": [
                    5120,
                    10240
                  ],
                  "types": [
                    "F32",
                    "F16",
                    "BF16",
                    "Q4_0",
                    "Q4_1",
                    "Q5_0",
                    "Q5_1",
                    "Q8_0",
                    "Q2_K",
                    "Q3_K",
                    "Q4_K",
                    "Q5_K",
                    "Q6_K",
                    "IQ2_XXS",
                    "IQ2_XS",
                    "IQ3_XXS",
                    "IQ1_S",
                    "IQ4_NL",
                    "IQ3_S",
                    "IQ2_S",
                    "IQ4_XS",
                    "IQ1_M"
                  ],
                },
                {
                  "id": "kW",
                  "tensor": {
                    "concat": [
                      "blk.",
                      {
                        "decimal": {
                          "iteration": "layer",
                        },
                      },
                      ".attn_k.weight"
                    ],
                  },
                  "shape": [
                    5120,
                    1024
                  ],
                  "types": [
                    "F32",
                    "F16",
                    "BF16",
                    "Q4_0",
                    "Q4_1",
                    "Q5_0",
                    "Q5_1",
                    "Q8_0",
                    "Q2_K",
                    "Q3_K",
                    "Q4_K",
                    "Q5_K",
                    "Q6_K",
                    "IQ2_XXS",
                    "IQ2_XS",
                    "IQ3_XXS",
                    "IQ1_S",
                    "IQ4_NL",
                    "IQ3_S",
                    "IQ2_S",
                    "IQ4_XS",
                    "IQ1_M"
                  ],
                },
                {
                  "id": "vW",
                  "tensor": {
                    "concat": [
                      "blk.",
                      {
                        "decimal": {
                          "iteration": "layer",
                        },
                      },
                      ".attn_v.weight"
                    ],
                  },
                  "shape": [
                    5120,
                    1024
                  ],
                  "types": [
                    "F32",
                    "F16",
                    "BF16",
                    "Q4_0",
                    "Q4_1",
                    "Q5_0",
                    "Q5_1",
                    "Q8_0",
                    "Q2_K",
                    "Q3_K",
                    "Q4_K",
                    "Q5_K",
                    "Q6_K",
                    "IQ2_XXS",
                    "IQ2_XS",
                    "IQ3_XXS",
                    "IQ1_S",
                    "IQ4_NL",
                    "IQ3_S",
                    "IQ2_S",
                    "IQ4_XS",
                    "IQ1_M"
                  ],
                },
                {
                  "id": "oW",
                  "tensor": {
                    "concat": [
                      "blk.",
                      {
                        "decimal": {
                          "iteration": "layer",
                        },
                      },
                      ".attn_output.weight"
                    ],
                  },
                  "shape": [
                    10240,
                    5120
                  ],
                  "types": [
                    "F32",
                    "F16",
                    "BF16",
                    "Q4_0",
                    "Q4_1",
                    "Q5_0",
                    "Q5_1",
                    "Q8_0",
                    "Q2_K",
                    "Q3_K",
                    "Q4_K",
                    "Q5_K",
                    "Q6_K",
                    "IQ2_XXS",
                    "IQ2_XS",
                    "IQ3_XXS",
                    "IQ1_S",
                    "IQ4_NL",
                    "IQ3_S",
                    "IQ2_S",
                    "IQ4_XS",
                    "IQ1_M"
                  ],
                },
                {
                  "id": "qNormW",
                  "tensor": {
                    "concat": [
                      "blk.",
                      {
                        "decimal": {
                          "iteration": "layer",
                        },
                      },
                      ".attn_q_norm.weight"
                    ],
                  },
                  "shape": [
                    128
                  ],
                  "types": [
                    "F32",
                    "F16",
                    "BF16"
                  ],
                },
                {
                  "id": "kNormW",
                  "tensor": {
                    "concat": [
                      "blk.",
                      {
                        "decimal": {
                          "iteration": "layer",
                        },
                      },
                      ".attn_k_norm.weight"
                    ],
                  },
                  "shape": [
                    128
                  ],
                  "types": [
                    "F32",
                    "F16",
                    "BF16"
                  ],
                },
                {
                  "id": "attnGateW",
                  "tensor": {
                    "concat": [
                      "blk.",
                      {
                        "decimal": {
                          "iteration": "layer",
                        },
                      },
                      ".attn_gate.weight"
                    ],
                  },
                  "shape": [
                    5120,
                    10240
                  ],
                  "types": [
                    "F32",
                    "F16",
                    "BF16",
                    "Q4_0",
                    "Q4_1",
                    "Q5_0",
                    "Q5_1",
                    "Q8_0",
                    "Q2_K",
                    "Q3_K",
                    "Q4_K",
                    "Q5_K",
                    "Q6_K",
                    "IQ2_XXS",
                    "IQ2_XS",
                    "IQ3_XXS",
                    "IQ1_S",
                    "IQ4_NL",
                    "IQ3_S",
                    "IQ2_S",
                    "IQ4_XS",
                    "IQ1_M"
                  ],
                },
                {
                  "id": "vresW",
                  "tensor": {
                    "concat": [
                      "blk.",
                      {
                        "decimal": {
                          "iteration": "layer",
                        },
                      },
                      ".attn_vres_lambda.weight"
                    ],
                  },
                  "shape": [
                    1
                  ],
                  "types": [
                    "F32",
                    "F16",
                    "BF16"
                  ],
                },
                {
                  "id": "postAttnW",
                  "tensor": {
                    "concat": [
                      "blk.",
                      {
                        "decimal": {
                          "iteration": "layer",
                        },
                      },
                      ".post_attention_norm.weight"
                    ],
                  },
                  "shape": [
                    5120
                  ],
                  "types": [
                    "F32",
                    "F16",
                    "BF16"
                  ],
                },
                {
                  "id": "ffnNormW",
                  "tensor": {
                    "concat": [
                      "blk.",
                      {
                        "decimal": {
                          "iteration": "layer",
                        },
                      },
                      ".ffn_norm.weight"
                    ],
                  },
                  "shape": [
                    5120
                  ],
                  "types": [
                    "F32",
                    "F16",
                    "BF16"
                  ],
                },
                {
                  "id": "ffnGateW",
                  "tensor": {
                    "concat": [
                      "blk.",
                      {
                        "decimal": {
                          "iteration": "layer",
                        },
                      },
                      ".ffn_gate.weight"
                    ],
                  },
                  "shape": [
                    5120,
                    40960
                  ],
                  "types": [
                    "F32",
                    "F16",
                    "BF16",
                    "Q4_0",
                    "Q4_1",
                    "Q5_0",
                    "Q5_1",
                    "Q8_0",
                    "Q2_K",
                    "Q3_K",
                    "Q4_K",
                    "Q5_K",
                    "Q6_K",
                    "IQ2_XXS",
                    "IQ2_XS",
                    "IQ3_XXS",
                    "IQ1_S",
                    "IQ4_NL",
                    "IQ3_S",
                    "IQ2_S",
                    "IQ4_XS",
                    "IQ1_M"
                  ],
                },
                {
                  "id": "ffnUpW",
                  "tensor": {
                    "concat": [
                      "blk.",
                      {
                        "decimal": {
                          "iteration": "layer",
                        },
                      },
                      ".ffn_up.weight"
                    ],
                  },
                  "shape": [
                    5120,
                    40960
                  ],
                  "types": [
                    "F32",
                    "F16",
                    "BF16",
                    "Q4_0",
                    "Q4_1",
                    "Q5_0",
                    "Q5_1",
                    "Q8_0",
                    "Q2_K",
                    "Q3_K",
                    "Q4_K",
                    "Q5_K",
                    "Q6_K",
                    "IQ2_XXS",
                    "IQ2_XS",
                    "IQ3_XXS",
                    "IQ1_S",
                    "IQ4_NL",
                    "IQ3_S",
                    "IQ2_S",
                    "IQ4_XS",
                    "IQ1_M"
                  ],
                },
                {
                  "id": "ffnDownW",
                  "tensor": {
                    "concat": [
                      "blk.",
                      {
                        "decimal": {
                          "iteration": "layer",
                        },
                      },
                      ".ffn_down.weight"
                    ],
                  },
                  "shape": [
                    40960,
                    5120
                  ],
                  "types": [
                    "F32",
                    "F16",
                    "BF16",
                    "Q4_0",
                    "Q4_1",
                    "Q5_0",
                    "Q5_1",
                    "Q8_0",
                    "Q2_K",
                    "Q3_K",
                    "Q4_K",
                    "Q5_K",
                    "Q6_K",
                    "IQ2_XXS",
                    "IQ2_XS",
                    "IQ3_XXS",
                    "IQ1_S",
                    "IQ4_NL",
                    "IQ3_S",
                    "IQ2_S",
                    "IQ4_XS",
                    "IQ1_M"
                  ],
                },
                {
                  "id": "postFfnW",
                  "tensor": {
                    "concat": [
                      "blk.",
                      {
                        "decimal": {
                          "iteration": "layer",
                        },
                      },
                      ".post_ffw_norm.weight"
                    ],
                  },
                  "shape": [
                    5120
                  ],
                  "types": [
                    "F32",
                    "F16",
                    "BF16"
                  ],
                }
              ],
              "slots": [
                {
                  "id": "kv",
                  "headSize": 128,
                  "heads": 8,
                  "precision": "F16",
                }
              ],
              "tensors": [],
              "updates": [],
              "nodes": [
                {
                  "id": "an",
                  "op": "normalizeRms",
                  "input": {
                    "carry": "hidden",
                  },
                  "epsilon": {
                    "metadata": "ricursive.attention.layer_norm_rms_epsilon",
                  },
                },
                {
                  "id": "anW32",
                  "op": "tensor",
                  "operator": "cast",
                  "inputs": [
                    {
                      "local": "attnNorm",
                    }
                  ],
                  "attributes": {
                    "type": "F32",
                  },
                },
                {
                  "id": "ai",
                  "op": "multiply",
                  "left": {
                    "local": "an",
                  },
                  "right": {
                    "local": "anW32",
                  },
                },
                {
                  "id": "q",
                  "op": "linear",
                  "weight": {
                    "local": "qW",
                  },
                  "input": {
                    "local": "ai",
                  },
                },
                {
                  "id": "k",
                  "op": "linear",
                  "weight": {
                    "local": "kW",
                  },
                  "input": {
                    "local": "ai",
                  },
                },
                {
                  "id": "vresW32",
                  "op": "tensor",
                  "operator": "cast",
                  "inputs": [
                    {
                      "local": "vresW",
                    }
                  ],
                  "attributes": {
                    "type": "F32",
                  },
                },
                {
                  "id": "mix",
                  "op": "sigmoid",
                  "input": {
                    "local": "vresW32",
                  },
                },
                {
                  "id": "delta",
                  "op": "subtract",
                  "left": {
                    "local": "ai",
                  },
                  "right": {
                    "capture": "initialHidden",
                  },
                },
                {
                  "id": "mixdelta",
                  "op": "multiply",
                  "left": {
                    "local": "delta",
                  },
                  "right": {
                    "local": "mix",
                  },
                },
                {
                  "id": "vinput",
                  "op": "add",
                  "left": {
                    "capture": "initialHidden",
                  },
                  "right": {
                    "local": "mixdelta",
                  },
                },
                {
                  "id": "v",
                  "op": "linear",
                  "weight": {
                    "local": "vW",
                  },
                  "input": {
                    "local": "vinput",
                  },
                },
                {
                  "id": "q3",
                  "op": "reshape",
                  "input": {
                    "local": "q",
                  },
                  "shape": [
                    128,
                    80,
                    {
                      "inputTokens": true,
                    }
                  ],
                },
                {
                  "id": "k3",
                  "op": "reshape",
                  "input": {
                    "local": "k",
                  },
                  "shape": [
                    128,
                    8,
                    {
                      "inputTokens": true,
                    }
                  ],
                },
                {
                  "id": "v3",
                  "op": "reshape",
                  "input": {
                    "local": "v",
                  },
                  "shape": [
                    128,
                    8,
                    {
                      "inputTokens": true,
                    }
                  ],
                },
                {
                  "id": "qn",
                  "op": "normalizeRms",
                  "input": {
                    "local": "q3",
                  },
                  "epsilon": {
                    "metadata": "ricursive.attention.layer_norm_rms_epsilon",
                  },
                },
                {
                  "id": "kn",
                  "op": "normalizeRms",
                  "input": {
                    "local": "k3",
                  },
                  "epsilon": {
                    "metadata": "ricursive.attention.layer_norm_rms_epsilon",
                  },
                },
                {
                  "id": "qnW32",
                  "op": "tensor",
                  "operator": "cast",
                  "inputs": [
                    {
                      "local": "qNormW",
                    }
                  ],
                  "attributes": {
                    "type": "F32",
                  },
                },
                {
                  "id": "knW32",
                  "op": "tensor",
                  "operator": "cast",
                  "inputs": [
                    {
                      "local": "kNormW",
                    }
                  ],
                  "attributes": {
                    "type": "F32",
                  },
                },
                {
                  "id": "qnorm",
                  "op": "multiply",
                  "left": {
                    "local": "qn",
                  },
                  "right": {
                    "local": "qnW32",
                  },
                },
                {
                  "id": "knorm",
                  "op": "multiply",
                  "left": {
                    "local": "kn",
                  },
                  "right": {
                    "local": "knW32",
                  },
                },
                {
                  "id": "attentionChoice",
                  "op": "choose",
                  "condition": {
                    "metadata": "ricursive.attention.sliding_window_pattern",
                    "index": {
                      "iteration": "layer",
                    },
                    "equals": true,
                  },
                  "capture": {
                    "qnorm": {
                      "local": "qnorm",
                    },
                    "knorm": {
                      "local": "knorm",
                    },
                    "v3": {
                      "local": "v3",
                    },
                    "kv": {
                      "local": "kv",
                    },
                  },
                  "then": {
                    "weights": [],
                    "slots": [],
                    "tensors": [],
                    "updates": [],
                    "nodes": [
                      {
                        "id": "qr",
                        "op": "rotaryEmbedding",
                        "input": {
                          "capture": "qnorm",
                        },
                        "dimensions": 128,
                        "mode": "neox",
                        "frequencyBase": {
                          "metadata": "ricursive.rope.freq_base",
                        },
                        "frequencyScale": 1,
                      },
                      {
                        "id": "kr",
                        "op": "rotaryEmbedding",
                        "input": {
                          "capture": "knorm",
                        },
                        "dimensions": 128,
                        "mode": "neox",
                        "frequencyBase": {
                          "metadata": "ricursive.rope.freq_base",
                        },
                        "frequencyScale": 1,
                      },
                      {
                        "id": "attention",
                        "op": "attentionCached",
                        "query": {
                          "local": "qr",
                        },
                        "key": {
                          "local": "kr",
                        },
                        "value": {
                          "capture": "v3",
                        },
                        "slot": {
                          "capture": "kv",
                        },
                        "window": 1024,
                        "scale": "inverseSqrtHead",
                      }
                    ],
                    "outputs": {
                      "attention": {
                        "local": "attention",
                      },
                    },
                  },
                  "otherwise": {
                    "weights": [],
                    "slots": [],
                    "tensors": [],
                    "updates": [],
                    "nodes": [
                      {
                        "id": "attention",
                        "op": "attentionCached",
                        "query": {
                          "capture": "qnorm",
                        },
                        "key": {
                          "capture": "knorm",
                        },
                        "value": {
                          "capture": "v3",
                        },
                        "slot": {
                          "capture": "kv",
                        },
                        "window": 0,
                        "scale": "inverseSqrtHead",
                      }
                    ],
                    "outputs": {
                      "attention": {
                        "local": "attention",
                      },
                    },
                  },
                },
                {
                  "id": "ag",
                  "op": "linear",
                  "weight": {
                    "local": "attnGateW",
                  },
                  "input": {
                    "local": "ai",
                  },
                },
                {
                  "id": "agSig",
                  "op": "sigmoid",
                  "input": {
                    "local": "ag",
                  },
                },
                {
                  "id": "attnGated",
                  "op": "multiply",
                  "left": {
                    "output": {
                      "block": "attentionChoice",
                      "port": "attention",
                    },
                  },
                  "right": {
                    "local": "agSig",
                  },
                },
                {
                  "id": "attnProj",
                  "op": "linear",
                  "weight": {
                    "local": "oW",
                  },
                  "input": {
                    "local": "attnGated",
                  },
                },
                {
                  "id": "attnPost",
                  "op": "normalizeRms",
                  "input": {
                    "local": "attnProj",
                  },
                  "epsilon": {
                    "metadata": "ricursive.attention.layer_norm_rms_epsilon",
                  },
                },
                {
                  "id": "attnPostW32",
                  "op": "tensor",
                  "operator": "cast",
                  "inputs": [
                    {
                      "local": "postAttnW",
                    }
                  ],
                  "attributes": {
                    "type": "F32",
                  },
                },
                {
                  "id": "attnPostScaled",
                  "op": "multiply",
                  "left": {
                    "local": "attnPost",
                  },
                  "right": {
                    "local": "attnPostW32",
                  },
                },
                {
                  "id": "resid",
                  "op": "add",
                  "left": {
                    "carry": "hidden",
                  },
                  "right": {
                    "local": "attnPostScaled",
                  },
                },
                {
                  "id": "fn",
                  "op": "normalizeRms",
                  "input": {
                    "local": "resid",
                  },
                  "epsilon": {
                    "metadata": "ricursive.attention.layer_norm_rms_epsilon",
                  },
                },
                {
                  "id": "fnW32",
                  "op": "tensor",
                  "operator": "cast",
                  "inputs": [
                    {
                      "local": "ffnNormW",
                    }
                  ],
                  "attributes": {
                    "type": "F32",
                  },
                },
                {
                  "id": "ffnInput",
                  "op": "multiply",
                  "left": {
                    "local": "fn",
                  },
                  "right": {
                    "local": "fnW32",
                  },
                },
                {
                  "id": "ffnGate",
                  "op": "linear",
                  "weight": {
                    "local": "ffnGateW",
                  },
                  "input": {
                    "local": "ffnInput",
                  },
                },
                {
                  "id": "ffnUp",
                  "op": "linear",
                  "weight": {
                    "local": "ffnUpW",
                  },
                  "input": {
                    "local": "ffnInput",
                  },
                },
                {
                  "id": "swiglu",
                  "op": "tensor",
                  "operator": "swigluClamped",
                  "inputs": [
                    {
                      "local": "ffnGate",
                    },
                    {
                      "local": "ffnUp",
                    }
                  ],
                  "attributes": {
                    "limit": {
                      "metadata": "ricursive.swiglu_clamp",
                      "index": {
                        "iteration": "layer",
                      },
                    },
                  },
                },
                {
                  "id": "ffnDown",
                  "op": "linear",
                  "weight": {
                    "local": "ffnDownW",
                  },
                  "input": {
                    "local": "swiglu",
                  },
                },
                {
                  "id": "ffnPost",
                  "op": "normalizeRms",
                  "input": {
                    "local": "ffnDown",
                  },
                  "epsilon": {
                    "metadata": "ricursive.attention.layer_norm_rms_epsilon",
                  },
                },
                {
                  "id": "ffnPostW32",
                  "op": "tensor",
                  "operator": "cast",
                  "inputs": [
                    {
                      "local": "postFfnW",
                    }
                  ],
                  "attributes": {
                    "type": "F32",
                  },
                },
                {
                  "id": "ffnPostScaled",
                  "op": "multiply",
                  "left": {
                    "local": "ffnPost",
                  },
                  "right": {
                    "local": "ffnPostW32",
                  },
                },
                {
                  "id": "h",
                  "op": "add",
                  "left": {
                    "local": "resid",
                  },
                  "right": {
                    "local": "ffnPostScaled",
                  },
                }
              ],
            },
            "outputs": {
              "hidden": {
                "carry": "hidden",
              },
            },
          },
          {
            "id": "outputNormalized",
            "op": "normalizeRms",
            "input": {
              "output": {
                "block": "allLayers",
                "port": "hidden",
              },
            },
            "epsilon": {
              "metadata": "ricursive.attention.layer_norm_rms_epsilon",
            },
          },
          {
            "id": "outputNormW32",
            "op": "tensor",
            "operator": "cast",
            "inputs": [
              {
                "local": "outNormWeight",
              }
            ],
            "attributes": {
              "type": "F32",
            },
          },
          {
            "id": "outputScaled",
            "op": "multiply",
            "left": {
              "local": "outputNormalized",
            },
            "right": {
              "local": "outputNormW32",
            },
          },
          {
            "id": "logits",
            "op": "linear",
            "weight": {
              "local": "lmHead",
            },
            "input": {
              "local": "outputScaled",
            },
          }
        ],
      },
      "outputs": {
        "logits": {
          "local": "logits",
        },
      },
      "annotations": "Scoped experimental-3 declaration. Explicit concat/decimal form GGUF names; capture/carry and output ports connect values. Preserves the scalar/array metadata semantics and equations of the supplied example. Fixed Ripple-65B dimensions; real 65B/WebGPU execution is unverified.",
    }),
  })[0]!.definition;
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
