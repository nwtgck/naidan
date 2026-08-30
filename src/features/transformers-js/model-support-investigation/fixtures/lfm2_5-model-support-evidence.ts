/* eslint-disable local-rules-multiline-template-literals/prefer-multiline-template-literals -- Preserve exact escaped Evidence strings from the recorded package. */
/**
 * Browser/model-free fixture extracted from a real Model Support Investigation run.
 *
 * Source facts are limited to repository/template evidence from the recorded model revision.
 * Production-lane observations from that run are intentionally not copied here because the
 * Investigation implementation was being developed in parallel.
 */
const LFM2_5_MODEL_SUPPORT_EVIDENCE = {
  "source": {
    "modelId": "hf.co/LiquidAI/LFM2.5-2.6B-ONNX",
    "runId": "c9d52c8f-a1df-4924-9c72-61867bae543f",
    "resolvedRevision": "66826372fd4fa166f53be0371c9315745c07cace"
  },
  "tokenizerConfig": {
    "bosToken": "<|startoftext|>",
    "eosToken": "<|im_end|>",
    "padToken": "<|pad|>",
    "chatTemplate": "{{- bos_token -}}\n{%- set preserve_thinking = preserve_thinking | default(false) -%}\n\n{%- macro format_arg_value(arg_value) -%}\n    {%- if arg_value is string -%}\n        {{- \"'\" + (arg_value | replace(\"\\\\\", \"\\\\\\\\\") | replace(\"'\", \"\\\\'\") | replace(\"\\n\", \"\\\\n\") | replace(\"\\r\", \"\\\\r\")) + \"'\" -}}\n    {%- elif arg_value is mapping or arg_value is iterable -%}\n        {{- arg_value | tojson -}}\n    {%- else -%}\n        {{- arg_value | string -}}\n    {%- endif -%}\n{%- endmacro -%}\n\n{%- macro parse_content(content) -%}\n    {%- if content is string -%}\n        {{- content -}}\n    {%- elif content is mapping -%}\n        {{- content | tojson -}}\n    {%- elif content is iterable -%}\n        {%- set _ns = namespace(result=\"\") -%}\n        {%- for item in content -%}\n            {%- if item is string -%}\n                {%- set _ns.result = _ns.result + item -%}\n            {%- elif item is mapping and item.get(\"type\") == \"image\" -%}\n                {%- set _ns.result = _ns.result + \"<image>\" -%}\n            {%- elif item is mapping and item.get(\"type\") == \"text\" -%}\n                {%- set _ns.result = _ns.result + ((item.get(\"text\") or \"\") | string) -%}\n            {%- else -%}\n                {%- set _ns.result = _ns.result + (item | tojson) -%}\n            {%- endif -%}\n        {%- endfor -%}\n        {{- _ns.result -}}\n    {%- endif -%}\n{%- endmacro -%}\n\n{%- macro render_tool_calls(tool_calls) -%}\n    {%- set tool_calls_ns = namespace(tool_calls=[]) -%}\n    {%- for tool_call in tool_calls -%}\n        {%- set func = tool_call[\"function\"] if \"function\" in tool_call else tool_call -%}\n        {%- set func_name = func[\"name\"] -%}\n        {%- set func_args = func.get(\"arguments\") -%}\n        {%- set args_ns = namespace(arg_strings=[]) -%}\n        {%- if func_args is mapping -%}\n            {%- for arg_name, arg_value in func_args.items() -%}\n                {%- set args_ns.arg_strings = args_ns.arg_strings + [arg_name + \"=\" + format_arg_value(arg_value)] -%}\n            {%- endfor -%}\n        {%- elif func_args is string and (func_args | trim) not in [\"\", \"{}\", \"null\"] -%}\n            {{- raise_exception(\"Tool call arguments must be a mapping, got a JSON-encoded string: parse arguments with json.loads() before applying the chat template\") -}}\n        {%- endif -%}\n        {%- set tool_calls_ns.tool_calls = tool_calls_ns.tool_calls + [func_name + \"(\" + (args_ns.arg_strings | join(\", \")) + \")\"] -%}\n    {%- endfor -%}\n    {{- \"<|tool_call_start|>[\" + (tool_calls_ns.tool_calls | join(\", \")) + \"]<|tool_call_end|>\" -}}\n{%- endmacro -%}\n\n{%- set ns = namespace(system_prompt=\"\", last_user_index=-1) -%}\n{%- if messages and messages[0][\"role\"] == \"system\" -%}\n    {%- if messages[0].get(\"content\") -%}\n        {%- set ns.system_prompt = parse_content(messages[0][\"content\"]) -%}\n    {%- endif -%}\n    {%- set messages = messages[1:] -%}\n{%- endif -%}\n{%- if tools -%}\n    {%- set ns.system_prompt = ns.system_prompt + (\"\\n\" if ns.system_prompt else \"\") + \"List of tools: [\" -%}\n    {%- for tool in tools -%}\n        {%- if tool is not string -%}\n            {%- set tool = tool | tojson -%}\n        {%- endif -%}\n        {%- set ns.system_prompt = ns.system_prompt + tool -%}\n        {%- if not loop.last -%}\n            {%- set ns.system_prompt = ns.system_prompt + \", \" -%}\n        {%- endif -%}\n    {%- endfor -%}\n    {%- set ns.system_prompt = ns.system_prompt + \"]\" -%}\n{%- endif -%}\n{%- if ns.system_prompt -%}\n    {{- \"<|im_start|>system\\n\" + ns.system_prompt + \"<|im_end|>\\n\" -}}\n{%- endif -%}\n{%- for message in messages -%}\n    {%- if message[\"role\"] == \"user\" -%}\n        {%- set ns.last_user_index = loop.index0 -%}\n    {%- endif -%}\n{%- endfor -%}\n{%- for message in messages -%}\n    {{- \"<|im_start|>\" + message.role + \"\\n\" -}}\n    {%- if message.role == \"assistant\" -%}\n        \n        {%- set keep_thinking = preserve_thinking or loop.index0 > ns.last_user_index -%}\n        {%- set thinking = message.thinking or message.reasoning or message.reasoning_content -%}\n        {%- set thinking = thinking if thinking is string else \"\" -%}\n        {%- if thinking and keep_thinking -%}\n            {{- \"<think>\" + thinking + \"</think>\" -}}\n        {%- endif -%}\n        {%- set _cfm_tag = \"CONTINUE_FINAL_MESSAGE_TAG \" -%}\n        {%- set _has_cfm = false -%}\n        {%- set content = \"\" -%}\n        {%- if message.get(\"content\") -%}\n            {%- set content = parse_content(message.content) -%}\n        {%- endif -%}\n        {%- if not keep_thinking and \"</think>\" in content -%}\n            {%- set content = content.split(\"</think>\")[-1] | trim -%}\n        {%- endif -%}\n        {%- if content.endswith(_cfm_tag) -%}\n            {%- set _has_cfm = true -%}\n            {%- set _trunc_len = (content | length) - (_cfm_tag | length) -%}\n            {%- set content = content[:_trunc_len] -%}\n        {%- endif -%}\n        {{- content -}}\n        {%- if message.tool_calls -%}\n            {{- render_tool_calls(message.tool_calls) -}}\n        {%- endif -%}\n        {%- if _has_cfm -%}\n            {{- _cfm_tag -}}\n        {%- endif -%}\n        {{- \"<|im_end|>\\n\" -}}\n        \n    {%- else %}\n        {%- if message.get(\"content\") -%}\n            {{- parse_content(message[\"content\"]) -}}\n        {%- endif -%}\n        {{- \"<|im_end|>\\n\" -}}\n    {%- endif %}\n{%- endfor -%}\n{%- if add_generation_prompt -%}\n    {{- \"<|im_start|>assistant\\n<think>\" -}}\n{%- endif -%}\n"
  },
  "userGeneration": {
    "messages": [
      {
        "role": "user",
        "content": "Template probe user message."
      }
    ],
    "renderedText": "<|startoftext|><|im_start|>user\nTemplate probe user message.<|im_end|>\n<|im_start|>assistant\n<think>"
  },
  "toolsGeneration": {
    "messages": [
      {
        "role": "user",
        "content": "Use the weather tool for Tokyo."
      }
    ],
    "tools": [
      {
        "type": "function",
        "function": {
          "name": "lookup_weather",
          "description": "Return deterministic weather fixture data.",
          "parameters": {
            "type": "object",
            "properties": {
              "city": {
                "type": "string"
              }
            },
            "required": [
              "city"
            ]
          }
        }
      }
    ],
    "renderedText": "<|startoftext|><|im_start|>system\nList of tools: [{\"type\": \"function\", \"function\": {\"name\": \"lookup_weather\", \"description\": \"Return deterministic weather fixture data.\", \"parameters\": {\"type\": \"object\", \"properties\": {\"city\": {\"type\": \"string\"}}, \"required\": [\"city\"]}}}]<|im_end|>\n<|im_start|>user\nUse the weather tool for Tokyo.<|im_end|>\n<|im_start|>assistant\n<think>"
  },
  "assistantToolCallHistory": {
    "messages": [
      {
        "role": "user",
        "content": "Use the weather tool for Tokyo."
      },
      {
        "role": "assistant",
        "content": "",
        "tool_calls": [
          {
            "id": "call_template_probe_1",
            "type": "function",
            "function": {
              "name": "lookup_weather",
              "arguments": "{\"city\":\"Tokyo\"}"
            }
          }
        ]
      }
    ],
    "tools": [
      {
        "type": "function",
        "function": {
          "name": "lookup_weather",
          "description": "Return deterministic weather fixture data.",
          "parameters": {
            "type": "object",
            "properties": {
              "city": {
                "type": "string"
              }
            },
            "required": [
              "city"
            ]
          }
        }
      }
    ],
    "errorMessage": "Tool call arguments must be a mapping, got a JSON-encoded string: parse arguments with json.loads() before applying the chat template"
  },
  "toolResultContinuation": {
    "messages": [
      {
        "role": "user",
        "content": "Use the weather tool for Tokyo."
      },
      {
        "role": "assistant",
        "content": "",
        "tool_calls": [
          {
            "id": "call_template_probe_1",
            "type": "function",
            "function": {
              "name": "lookup_weather",
              "arguments": "{\"city\":\"Tokyo\"}"
            }
          }
        ]
      },
      {
        "role": "tool",
        "tool_call_id": "call_template_probe_1",
        "content": "{\"temperatureC\":20,\"condition\":\"clear\"}"
      }
    ],
    "tools": [
      {
        "type": "function",
        "function": {
          "name": "lookup_weather",
          "description": "Return deterministic weather fixture data.",
          "parameters": {
            "type": "object",
            "properties": {
              "city": {
                "type": "string"
              }
            },
            "required": [
              "city"
            ]
          }
        }
      }
    ],
    "errorMessage": "Tool call arguments must be a mapping, got a JSON-encoded string: parse arguments with json.loads() before applying the chat template"
  }
} as const;

// Export internal fixture state used only for browser/model-free Evidence replay tests.
export const TEST_ONLY = {
  LFM2_5_MODEL_SUPPORT_EVIDENCE,
};
