// Synthetic ABI 3 declarations for the public vision storage contract.
export const visionBf16Metadata = {
  "constants": [
    "MTMD_VISION_BF16_STORAGE_INVALID",
    "MTMD_VISION_BF16_STORAGE_LEGACY_EXPAND",
    "MTMD_VISION_BF16_STORAGE_RETAIN_CHECKED"
  ],
  "records": [
    {
      "name": "mtmd_context_params",
    }
  ],
  "functions": [
    {
      "name": "mtmd_context_vision_bf16_storage",
      "export": "_mtmd_context_vision_bf16_storage",
      "returnType": "enum mtmd_vision_bf16_storage",
      "returnKind": "signed",
      "parameters": [
        {
          "name": "context",
          "cType": "const struct mtmd_context *",
          "kind": "pointer",
        }
      ],
    },
    {
      "name": "mtmd_init_from_file_with_vision_bf16_storage",
      "export": "_bicore_mtmd_init_from_file_with_vision_bf16_storage",
      "returnType": "struct mtmd_context *",
      "returnKind": "pointer",
      "parameters": [
        {
          "name": "path",
          "cType": "const char *",
          "kind": "pointer",
        },
        {
          "name": "text_model",
          "cType": "const struct llama_model *",
          "kind": "pointer",
        },
        {
          "name": "params",
          "cType": "const struct mtmd_context_params",
          "kind": "record",
        },
        {
          "name": "storage",
          "cType": "int32_t",
          "kind": "signed",
        }
      ],
    },
    {
      "name": "mtmd_vision_bf16_storage_version",
      "export": "_mtmd_vision_bf16_storage_version",
      "returnType": "uint32_t",
      "returnKind": "unsigned",
      "parameters": [],
    }
  ],
} as const;

export const TEST_ONLY = {
};
