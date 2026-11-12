import { parseModelGraphDefinitions, type ModelGraphDefinition } from './definition';

/** Test-only, scoped authoring of the supplied model; never a production model dispatcher. */
export function reviewedRicursiveDeclarationFixture(): ModelGraphDefinition {
  return parseModelGraphDefinitions({
    input: JSON.stringify({
      "format": "naidan.model-graph/experimental-3",
      "name": "Ricursive Ripple-65B Preview (explicit scalar/array metadata)",
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
          },
          {
            "key": "ricursive.attention.sliding_window",
            "value": 1024,
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
      "outputs": {
        "logits": {
          "local": "logits",
        },
      },
      "annotations": "Scoped experimental-3 declaration. Explicit concat/decimal form GGUF names; capture/carry and output ports connect values. Preserves the scalar/array metadata semantics and equations of the supplied example. Fixed Ripple-65B dimensions; real 65B/WebGPU execution is unverified.",
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
            "id": "embeddingScale",
            "op": "choose",
            "condition": {
              "compare": "equal",
              "left": {
                "metadata": "ricursive.embedding_scale",
                "fallback": 0,
              },
              "right": 0,
            },
            "capture": {
              "tokensEmbedded": {
                "local": "tokensEmbedded",
              },
            },
            "then": {
              "weights": [],
              "slots": [],
              "tensors": [],
              "updates": [],
              "nodes": [
                {
                  "id": "initialHidden",
                  "input": {
                    "capture": "tokensEmbedded",
                  },
                  "op": "contiguous",
                }
              ],
              "outputs": {
                "initialHidden": {
                  "local": "initialHidden",
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
                  "id": "initialHidden",
                  "input": {
                    "capture": "tokensEmbedded",
                  },
                  "op": "scale",
                  "value": {
                    "metadata": "ricursive.embedding_scale",
                    "fallback": 0,
                  },
                }
              ],
              "outputs": {
                "initialHidden": {
                  "local": "initialHidden",
                },
              },
            },
          },
          {
            "id": "allLayers",
            "op": "repeat",
            "index": "layer",
            "count": 80,
            "capture": {
              "initialHidden": {
                "output": {
                  "block": "embeddingScale",
                  "port": "initialHidden",
                },
              },
            },
            "carry": {
              "hidden": {
                "initial": {
                  "output": {
                    "block": "embeddingScale",
                    "port": "initialHidden",
                  },
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
                  "input": {
                    "carry": "hidden",
                  },
                  "op": "normalizeRms",
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
                  "left": {
                    "local": "an",
                  },
                  "right": {
                    "local": "anW32",
                  },
                  "op": "multiply",
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
                  "input": {
                    "local": "vresW32",
                  },
                  "op": "sigmoid",
                },
                {
                  "id": "delta",
                  "left": {
                    "local": "ai",
                  },
                  "right": {
                    "capture": "initialHidden",
                  },
                  "op": "subtract",
                },
                {
                  "id": "mixdelta",
                  "left": {
                    "local": "delta",
                  },
                  "right": {
                    "local": "mix",
                  },
                  "op": "multiply",
                },
                {
                  "id": "vinput",
                  "left": {
                    "capture": "initialHidden",
                  },
                  "right": {
                    "local": "mixdelta",
                  },
                  "op": "add",
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
                  "input": {
                    "local": "q",
                  },
                  "op": "reshape",
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
                  "input": {
                    "local": "k",
                  },
                  "op": "reshape",
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
                  "input": {
                    "local": "v",
                  },
                  "op": "reshape",
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
                  "input": {
                    "local": "q3",
                  },
                  "op": "normalizeRms",
                  "epsilon": {
                    "metadata": "ricursive.attention.layer_norm_rms_epsilon",
                  },
                },
                {
                  "id": "kn",
                  "input": {
                    "local": "k3",
                  },
                  "op": "normalizeRms",
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
                  "left": {
                    "local": "qn",
                  },
                  "right": {
                    "local": "qnW32",
                  },
                  "op": "multiply",
                },
                {
                  "id": "knorm",
                  "left": {
                    "local": "kn",
                  },
                  "right": {
                    "local": "knW32",
                  },
                  "op": "multiply",
                },
                {
                  "id": "attentionChoice",
                  "op": "choose",
                  "condition": {
                    "metadata": "ricursive.attention.sliding_window_pattern",
                    "index": {
                      "iteration": "layer",
                    },
                    "length": {
                      "metadata": "ricursive.block_count",
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
                        "input": {
                          "capture": "qnorm",
                        },
                        "op": "rotaryEmbedding",
                        "dimensions": 128,
                        "mode": "neox",
                        "frequencyBase": {
                          "metadata": "ricursive.rope.freq_base_swa",
                          "fallback": {
                            "metadata": "ricursive.rope.freq_base",
                          },
                        },
                        "frequencyScale": 1,
                      },
                      {
                        "id": "kr",
                        "input": {
                          "capture": "knorm",
                        },
                        "op": "rotaryEmbedding",
                        "dimensions": 128,
                        "mode": "neox",
                        "frequencyBase": {
                          "metadata": "ricursive.rope.freq_base_swa",
                          "fallback": {
                            "metadata": "ricursive.rope.freq_base",
                          },
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
                  "input": {
                    "local": "ag",
                  },
                  "op": "sigmoid",
                },
                {
                  "id": "attnGated",
                  "left": {
                    "output": {
                      "block": "attentionChoice",
                      "port": "attention",
                    },
                  },
                  "right": {
                    "local": "agSig",
                  },
                  "op": "multiply",
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
                  "input": {
                    "local": "attnProj",
                  },
                  "op": "normalizeRms",
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
                  "left": {
                    "local": "attnPost",
                  },
                  "right": {
                    "local": "attnPostW32",
                  },
                  "op": "multiply",
                },
                {
                  "id": "resid",
                  "left": {
                    "carry": "hidden",
                  },
                  "right": {
                    "local": "attnPostScaled",
                  },
                  "op": "add",
                },
                {
                  "id": "fn",
                  "input": {
                    "local": "resid",
                  },
                  "op": "normalizeRms",
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
                  "left": {
                    "local": "fn",
                  },
                  "right": {
                    "local": "fnW32",
                  },
                  "op": "multiply",
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
                  "id": "ffnActivation",
                  "op": "choose",
                  "condition": {
                    "compare": "equal",
                    "left": {
                      "metadata": "ricursive.swiglu_clamp",
                      "index": {
                        "iteration": "layer",
                      },
                      "length": {
                        "metadata": "ricursive.block_count",
                      },
                      "scalar": "broadcast",
                      "fallback": 0,
                    },
                    "right": 0,
                  },
                  "capture": {
                    "ffnGate": {
                      "local": "ffnGate",
                    },
                    "ffnUp": {
                      "local": "ffnUp",
                    },
                  },
                  "then": {
                    "weights": [],
                    "slots": [],
                    "tensors": [],
                    "updates": [],
                    "nodes": [
                      {
                        "id": "ffnSilu",
                        "input": {
                          "capture": "ffnGate",
                        },
                        "op": "silu",
                      },
                      {
                        "id": "swiglu",
                        "left": {
                          "local": "ffnSilu",
                        },
                        "right": {
                          "capture": "ffnUp",
                        },
                        "op": "multiply",
                      }
                    ],
                    "outputs": {
                      "swiglu": {
                        "local": "swiglu",
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
                        "id": "swiglu",
                        "op": "tensor",
                        "operator": "swigluClamped",
                        "inputs": [
                          {
                            "capture": "ffnGate",
                          },
                          {
                            "capture": "ffnUp",
                          }
                        ],
                        "attributes": {
                          "limit": {
                            "metadata": "ricursive.swiglu_clamp",
                            "index": {
                              "iteration": "layer",
                            },
                            "length": {
                              "metadata": "ricursive.block_count",
                            },
                            "scalar": "broadcast",
                            "fallback": 0,
                          },
                        },
                      }
                    ],
                    "outputs": {
                      "swiglu": {
                        "local": "swiglu",
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
                    "output": {
                      "block": "ffnActivation",
                      "port": "swiglu",
                    },
                  },
                },
                {
                  "id": "ffnPost",
                  "input": {
                    "local": "ffnDown",
                  },
                  "op": "normalizeRms",
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
                  "left": {
                    "local": "ffnPost",
                  },
                  "right": {
                    "local": "ffnPostW32",
                  },
                  "op": "multiply",
                },
                {
                  "id": "h",
                  "left": {
                    "local": "resid",
                  },
                  "right": {
                    "local": "ffnPostScaled",
                  },
                  "op": "add",
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
            "input": {
              "output": {
                "block": "allLayers",
                "port": "hidden",
              },
            },
            "op": "normalizeRms",
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
            "left": {
              "local": "outputNormalized",
            },
            "right": {
              "local": "outputNormW32",
            },
            "op": "multiply",
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
    }),
  })[0]!.definition;
}

export const TEST_ONLY = {
};
