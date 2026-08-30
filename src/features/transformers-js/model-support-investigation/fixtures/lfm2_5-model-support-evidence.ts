/* eslint-disable local-rules-multiline-template-literals/prefer-multiline-template-literals -- Preserve exact escaped Evidence strings from the recorded package. */
/**
 * Browser/model-free fixture extracted from a real Model Support Investigation run.
 *
 * Source: model-support-investigation-hf.co-LiquidAI-LFM2.5-2.6B-ONNX-
 * c9d52c8f-a1df-4924-9c72-61867bae543f.zip
 *
 * Repository/template facts and deterministic Production observations are copied verbatim
 * from the Evidence package. Tests must not infer newer Investigation implementation behavior
 * from fields that were unavailable/not-run in that package.
 */
const LFM2_5_MODEL_SUPPORT_EVIDENCE = {
  "source": {
    "modelId": "hf.co/LiquidAI/LFM2.5-2.6B-ONNX",
    "runId": "c9d52c8f-a1df-4924-9c72-61867bae543f",
    "resolvedRevision": "66826372fd4fa166f53be0371c9315745c07cace"
  },
  "repositoryDeclarations": {
    "modelType": "lfm2",
    "maxPositionEmbeddings": 128000,
    "architectures": [
      "Lfm2ForCausalLM"
    ],
    "bosTokenId": 124894,
    "eosTokenId": 124900,
    "padTokenId": 124893,
    "classCapabilities": [
      {
        "autoClass": "AutoModel",
        "supports": true
      },
      {
        "autoClass": "AutoModelForAudioTextToText",
        "supports": false
      },
      {
        "autoClass": "AutoModelForCausalLM",
        "supports": true
      },
      {
        "autoClass": "AutoModelForImageTextToText",
        "supports": false
      },
      {
        "autoClass": "AutoModelForSeq2SeqLM",
        "supports": false
      },
      {
        "autoClass": "AutoModelForSpeechSeq2Seq",
        "supports": false
      },
      {
        "autoClass": "AutoModelForVision2Seq",
        "supports": false
      }
    ]
  },
  "tokenizerConfig": {
    "bosToken": "<|startoftext|>",
    "eosToken": "<|im_end|>",
    "padToken": "<|pad|>",
    "chatTemplate": "{{- bos_token -}}\n{%- set preserve_thinking = preserve_thinking | default(false) -%}\n\n{%- macro format_arg_value(arg_value) -%}\n    {%- if arg_value is string -%}\n        {{- \"'\" + (arg_value | replace(\"\\\\\", \"\\\\\\\\\") | replace(\"'\", \"\\\\'\") | replace(\"\\n\", \"\\\\n\") | replace(\"\\r\", \"\\\\r\")) + \"'\" -}}\n    {%- elif arg_value is mapping or arg_value is iterable -%}\n        {{- arg_value | tojson -}}\n    {%- else -%}\n        {{- arg_value | string -}}\n    {%- endif -%}\n{%- endmacro -%}\n\n{%- macro parse_content(content) -%}\n    {%- if content is string -%}\n        {{- content -}}\n    {%- elif content is mapping -%}\n        {{- content | tojson -}}\n    {%- elif content is iterable -%}\n        {%- set _ns = namespace(result=\"\") -%}\n        {%- for item in content -%}\n            {%- if item is string -%}\n                {%- set _ns.result = _ns.result + item -%}\n            {%- elif item is mapping and item.get(\"type\") == \"image\" -%}\n                {%- set _ns.result = _ns.result + \"<image>\" -%}\n            {%- elif item is mapping and item.get(\"type\") == \"text\" -%}\n                {%- set _ns.result = _ns.result + ((item.get(\"text\") or \"\") | string) -%}\n            {%- else -%}\n                {%- set _ns.result = _ns.result + (item | tojson) -%}\n            {%- endif -%}\n        {%- endfor -%}\n        {{- _ns.result -}}\n    {%- endif -%}\n{%- endmacro -%}\n\n{%- macro render_tool_calls(tool_calls) -%}\n    {%- set tool_calls_ns = namespace(tool_calls=[]) -%}\n    {%- for tool_call in tool_calls -%}\n        {%- set func = tool_call[\"function\"] if \"function\" in tool_call else tool_call -%}\n        {%- set func_name = func[\"name\"] -%}\n        {%- set func_args = func.get(\"arguments\") -%}\n        {%- set args_ns = namespace(arg_strings=[]) -%}\n        {%- if func_args is mapping -%}\n            {%- for arg_name, arg_value in func_args.items() -%}\n                {%- set args_ns.arg_strings = args_ns.arg_strings + [arg_name + \"=\" + format_arg_value(arg_value)] -%}\n            {%- endfor -%}\n        {%- elif func_args is string and (func_args | trim) not in [\"\", \"{}\", \"null\"] -%}\n            {{- raise_exception(\"Tool call arguments must be a mapping, got a JSON-encoded string: parse arguments with json.loads() before applying the chat template\") -}}\n        {%- endif -%}\n        {%- set tool_calls_ns.tool_calls = tool_calls_ns.tool_calls + [func_name + \"(\" + (args_ns.arg_strings | join(\", \")) + \")\"] -%}\n    {%- endfor -%}\n    {{- \"<|tool_call_start|>[\" + (tool_calls_ns.tool_calls | join(\", \")) + \"]<|tool_call_end|>\" -}}\n{%- endmacro -%}\n\n{%- set ns = namespace(system_prompt=\"\", last_user_index=-1) -%}\n{%- if messages and messages[0][\"role\"] == \"system\" -%}\n    {%- if messages[0].get(\"content\") -%}\n        {%- set ns.system_prompt = parse_content(messages[0][\"content\"]) -%}\n    {%- endif -%}\n    {%- set messages = messages[1:] -%}\n{%- endif -%}\n{%- if tools -%}\n    {%- set ns.system_prompt = ns.system_prompt + (\"\\n\" if ns.system_prompt else \"\") + \"List of tools: [\" -%}\n    {%- for tool in tools -%}\n        {%- if tool is not string -%}\n            {%- set tool = tool | tojson -%}\n        {%- endif -%}\n        {%- set ns.system_prompt = ns.system_prompt + tool -%}\n        {%- if not loop.last -%}\n            {%- set ns.system_prompt = ns.system_prompt + \", \" -%}\n        {%- endif -%}\n    {%- endfor -%}\n    {%- set ns.system_prompt = ns.system_prompt + \"]\" -%}\n{%- endif -%}\n{%- if ns.system_prompt -%}\n    {{- \"<|im_start|>system\\n\" + ns.system_prompt + \"<|im_end|>\\n\" -}}\n{%- endif -%}\n{%- for message in messages -%}\n    {%- if message[\"role\"] == \"user\" -%}\n        {%- set ns.last_user_index = loop.index0 -%}\n    {%- endif -%}\n{%- endfor -%}\n{%- for message in messages -%}\n    {{- \"<|im_start|>\" + message.role + \"\\n\" -}}\n    {%- if message.role == \"assistant\" -%}\n        \n        {%- set keep_thinking = preserve_thinking or loop.index0 > ns.last_user_index -%}\n        {%- set thinking = message.thinking or message.reasoning or message.reasoning_content -%}\n        {%- set thinking = thinking if thinking is string else \"\" -%}\n        {%- if thinking and keep_thinking -%}\n            {{- \"<think>\" + thinking + \"</think>\" -}}\n        {%- endif -%}\n        {%- set _cfm_tag = \"CONTINUE_FINAL_MESSAGE_TAG \" -%}\n        {%- set _has_cfm = false -%}\n        {%- set content = \"\" -%}\n        {%- if message.get(\"content\") -%}\n            {%- set content = parse_content(message.content) -%}\n        {%- endif -%}\n        {%- if not keep_thinking and \"</think>\" in content -%}\n            {%- set content = content.split(\"</think>\")[-1] | trim -%}\n        {%- endif -%}\n        {%- if content.endswith(_cfm_tag) -%}\n            {%- set _has_cfm = true -%}\n            {%- set _trunc_len = (content | length) - (_cfm_tag | length) -%}\n            {%- set content = content[:_trunc_len] -%}\n        {%- endif -%}\n        {{- content -}}\n        {%- if message.tool_calls -%}\n            {{- render_tool_calls(message.tool_calls) -}}\n        {%- endif -%}\n        {%- if _has_cfm -%}\n            {{- _cfm_tag -}}\n        {%- endif -%}\n        {{- \"<|im_end|>\\n\" -}}\n        \n    {%- else %}\n        {%- if message.get(\"content\") -%}\n            {{- parse_content(message[\"content\"]) -}}\n        {%- endif -%}\n        {{- \"<|im_end|>\\n\" -}}\n    {%- endif %}\n{%- endfor -%}\n{%- if add_generation_prompt -%}\n    {{- \"<|im_start|>assistant\\n<think>\" -}}\n{%- endif -%}\n"
  },
  "templateBehavior": {
    "cases": [
      {
        "caseId": "user-generation",
        "status": "passed",
        "messages": [
          {
            "role": "user",
            "content": "Template probe user message."
          }
        ],
        "addGenerationPrompt": true,
        "selectedTemplate": "{{- bos_token -}}\n{%- set preserve_thinking = preserve_thinking | default(false) -%}\n\n{%- macro format_arg_value(arg_value) -%}\n    {%- if arg_value is string -%}\n        {{- \"'\" + (arg_value | replace(\"\\\\\", \"\\\\\\\\\") | replace(\"'\", \"\\\\'\") | replace(\"\\n\", \"\\\\n\") | replace(\"\\r\", \"\\\\r\")) + \"'\" -}}\n    {%- elif arg_value is mapping or arg_value is iterable -%}\n        {{- arg_value | tojson -}}\n    {%- else -%}\n        {{- arg_value | string -}}\n    {%- endif -%}\n{%- endmacro -%}\n\n{%- macro parse_content(content) -%}\n    {%- if content is string -%}\n        {{- content -}}\n    {%- elif content is mapping -%}\n        {{- content | tojson -}}\n    {%- elif content is iterable -%}\n        {%- set _ns = namespace(result=\"\") -%}\n        {%- for item in content -%}\n            {%- if item is string -%}\n                {%- set _ns.result = _ns.result + item -%}\n            {%- elif item is mapping and item.get(\"type\") == \"image\" -%}\n                {%- set _ns.result = _ns.result + \"<image>\" -%}\n            {%- elif item is mapping and item.get(\"type\") == \"text\" -%}\n                {%- set _ns.result = _ns.result + ((item.get(\"text\") or \"\") | string) -%}\n            {%- else -%}\n                {%- set _ns.result = _ns.result + (item | tojson) -%}\n            {%- endif -%}\n        {%- endfor -%}\n        {{- _ns.result -}}\n    {%- endif -%}\n{%- endmacro -%}\n\n{%- macro render_tool_calls(tool_calls) -%}\n    {%- set tool_calls_ns = namespace(tool_calls=[]) -%}\n    {%- for tool_call in tool_calls -%}\n        {%- set func = tool_call[\"function\"] if \"function\" in tool_call else tool_call -%}\n        {%- set func_name = func[\"name\"] -%}\n        {%- set func_args = func.get(\"arguments\") -%}\n        {%- set args_ns = namespace(arg_strings=[]) -%}\n        {%- if func_args is mapping -%}\n            {%- for arg_name, arg_value in func_args.items() -%}\n                {%- set args_ns.arg_strings = args_ns.arg_strings + [arg_name + \"=\" + format_arg_value(arg_value)] -%}\n            {%- endfor -%}\n        {%- elif func_args is string and (func_args | trim) not in [\"\", \"{}\", \"null\"] -%}\n            {{- raise_exception(\"Tool call arguments must be a mapping, got a JSON-encoded string: parse arguments with json.loads() before applying the chat template\") -}}\n        {%- endif -%}\n        {%- set tool_calls_ns.tool_calls = tool_calls_ns.tool_calls + [func_name + \"(\" + (args_ns.arg_strings | join(\", \")) + \")\"] -%}\n    {%- endfor -%}\n    {{- \"<|tool_call_start|>[\" + (tool_calls_ns.tool_calls | join(\", \")) + \"]<|tool_call_end|>\" -}}\n{%- endmacro -%}\n\n{%- set ns = namespace(system_prompt=\"\", last_user_index=-1) -%}\n{%- if messages and messages[0][\"role\"] == \"system\" -%}\n    {%- if messages[0].get(\"content\") -%}\n        {%- set ns.system_prompt = parse_content(messages[0][\"content\"]) -%}\n    {%- endif -%}\n    {%- set messages = messages[1:] -%}\n{%- endif -%}\n{%- if tools -%}\n    {%- set ns.system_prompt = ns.system_prompt + (\"\\n\" if ns.system_prompt else \"\") + \"List of tools: [\" -%}\n    {%- for tool in tools -%}\n        {%- if tool is not string -%}\n            {%- set tool = tool | tojson -%}\n        {%- endif -%}\n        {%- set ns.system_prompt = ns.system_prompt + tool -%}\n        {%- if not loop.last -%}\n            {%- set ns.system_prompt = ns.system_prompt + \", \" -%}\n        {%- endif -%}\n    {%- endfor -%}\n    {%- set ns.system_prompt = ns.system_prompt + \"]\" -%}\n{%- endif -%}\n{%- if ns.system_prompt -%}\n    {{- \"<|im_start|>system\\n\" + ns.system_prompt + \"<|im_end|>\\n\" -}}\n{%- endif -%}\n{%- for message in messages -%}\n    {%- if message[\"role\"] == \"user\" -%}\n        {%- set ns.last_user_index = loop.index0 -%}\n    {%- endif -%}\n{%- endfor -%}\n{%- for message in messages -%}\n    {{- \"<|im_start|>\" + message.role + \"\\n\" -}}\n    {%- if message.role == \"assistant\" -%}\n        \n        {%- set keep_thinking = preserve_thinking or loop.index0 > ns.last_user_index -%}\n        {%- set thinking = message.thinking or message.reasoning or message.reasoning_content -%}\n        {%- set thinking = thinking if thinking is string else \"\" -%}\n        {%- if thinking and keep_thinking -%}\n            {{- \"<think>\" + thinking + \"</think>\" -}}\n        {%- endif -%}\n        {%- set _cfm_tag = \"CONTINUE_FINAL_MESSAGE_TAG \" -%}\n        {%- set _has_cfm = false -%}\n        {%- set content = \"\" -%}\n        {%- if message.get(\"content\") -%}\n            {%- set content = parse_content(message.content) -%}\n        {%- endif -%}\n        {%- if not keep_thinking and \"</think>\" in content -%}\n            {%- set content = content.split(\"</think>\")[-1] | trim -%}\n        {%- endif -%}\n        {%- if content.endswith(_cfm_tag) -%}\n            {%- set _has_cfm = true -%}\n            {%- set _trunc_len = (content | length) - (_cfm_tag | length) -%}\n            {%- set content = content[:_trunc_len] -%}\n        {%- endif -%}\n        {{- content -}}\n        {%- if message.tool_calls -%}\n            {{- render_tool_calls(message.tool_calls) -}}\n        {%- endif -%}\n        {%- if _has_cfm -%}\n            {{- _cfm_tag -}}\n        {%- endif -%}\n        {{- \"<|im_end|>\\n\" -}}\n        \n    {%- else %}\n        {%- if message.get(\"content\") -%}\n            {{- parse_content(message[\"content\"]) -}}\n        {%- endif -%}\n        {{- \"<|im_end|>\\n\" -}}\n    {%- endif %}\n{%- endfor -%}\n{%- if add_generation_prompt -%}\n    {{- \"<|im_start|>assistant\\n<think>\" -}}\n{%- endif -%}\n",
        "renderedText": "<|startoftext|><|im_start|>user\nTemplate probe user message.<|im_end|>\n<|im_start|>assistant\n<think>",
        "inputIds": [
          124894,
          124899,
          5922,
          207,
          23108,
          22355,
          4695,
          5781,
          22,
          124900,
          207,
          124899,
          63514,
          207,
          124901
        ]
      },
      {
        "caseId": "system-user-generation",
        "status": "passed",
        "messages": [
          {
            "role": "system",
            "content": "Template probe system instruction."
          },
          {
            "role": "user",
            "content": "Template probe user message."
          }
        ],
        "addGenerationPrompt": true,
        "selectedTemplate": "{{- bos_token -}}\n{%- set preserve_thinking = preserve_thinking | default(false) -%}\n\n{%- macro format_arg_value(arg_value) -%}\n    {%- if arg_value is string -%}\n        {{- \"'\" + (arg_value | replace(\"\\\\\", \"\\\\\\\\\") | replace(\"'\", \"\\\\'\") | replace(\"\\n\", \"\\\\n\") | replace(\"\\r\", \"\\\\r\")) + \"'\" -}}\n    {%- elif arg_value is mapping or arg_value is iterable -%}\n        {{- arg_value | tojson -}}\n    {%- else -%}\n        {{- arg_value | string -}}\n    {%- endif -%}\n{%- endmacro -%}\n\n{%- macro parse_content(content) -%}\n    {%- if content is string -%}\n        {{- content -}}\n    {%- elif content is mapping -%}\n        {{- content | tojson -}}\n    {%- elif content is iterable -%}\n        {%- set _ns = namespace(result=\"\") -%}\n        {%- for item in content -%}\n            {%- if item is string -%}\n                {%- set _ns.result = _ns.result + item -%}\n            {%- elif item is mapping and item.get(\"type\") == \"image\" -%}\n                {%- set _ns.result = _ns.result + \"<image>\" -%}\n            {%- elif item is mapping and item.get(\"type\") == \"text\" -%}\n                {%- set _ns.result = _ns.result + ((item.get(\"text\") or \"\") | string) -%}\n            {%- else -%}\n                {%- set _ns.result = _ns.result + (item | tojson) -%}\n            {%- endif -%}\n        {%- endfor -%}\n        {{- _ns.result -}}\n    {%- endif -%}\n{%- endmacro -%}\n\n{%- macro render_tool_calls(tool_calls) -%}\n    {%- set tool_calls_ns = namespace(tool_calls=[]) -%}\n    {%- for tool_call in tool_calls -%}\n        {%- set func = tool_call[\"function\"] if \"function\" in tool_call else tool_call -%}\n        {%- set func_name = func[\"name\"] -%}\n        {%- set func_args = func.get(\"arguments\") -%}\n        {%- set args_ns = namespace(arg_strings=[]) -%}\n        {%- if func_args is mapping -%}\n            {%- for arg_name, arg_value in func_args.items() -%}\n                {%- set args_ns.arg_strings = args_ns.arg_strings + [arg_name + \"=\" + format_arg_value(arg_value)] -%}\n            {%- endfor -%}\n        {%- elif func_args is string and (func_args | trim) not in [\"\", \"{}\", \"null\"] -%}\n            {{- raise_exception(\"Tool call arguments must be a mapping, got a JSON-encoded string: parse arguments with json.loads() before applying the chat template\") -}}\n        {%- endif -%}\n        {%- set tool_calls_ns.tool_calls = tool_calls_ns.tool_calls + [func_name + \"(\" + (args_ns.arg_strings | join(\", \")) + \")\"] -%}\n    {%- endfor -%}\n    {{- \"<|tool_call_start|>[\" + (tool_calls_ns.tool_calls | join(\", \")) + \"]<|tool_call_end|>\" -}}\n{%- endmacro -%}\n\n{%- set ns = namespace(system_prompt=\"\", last_user_index=-1) -%}\n{%- if messages and messages[0][\"role\"] == \"system\" -%}\n    {%- if messages[0].get(\"content\") -%}\n        {%- set ns.system_prompt = parse_content(messages[0][\"content\"]) -%}\n    {%- endif -%}\n    {%- set messages = messages[1:] -%}\n{%- endif -%}\n{%- if tools -%}\n    {%- set ns.system_prompt = ns.system_prompt + (\"\\n\" if ns.system_prompt else \"\") + \"List of tools: [\" -%}\n    {%- for tool in tools -%}\n        {%- if tool is not string -%}\n            {%- set tool = tool | tojson -%}\n        {%- endif -%}\n        {%- set ns.system_prompt = ns.system_prompt + tool -%}\n        {%- if not loop.last -%}\n            {%- set ns.system_prompt = ns.system_prompt + \", \" -%}\n        {%- endif -%}\n    {%- endfor -%}\n    {%- set ns.system_prompt = ns.system_prompt + \"]\" -%}\n{%- endif -%}\n{%- if ns.system_prompt -%}\n    {{- \"<|im_start|>system\\n\" + ns.system_prompt + \"<|im_end|>\\n\" -}}\n{%- endif -%}\n{%- for message in messages -%}\n    {%- if message[\"role\"] == \"user\" -%}\n        {%- set ns.last_user_index = loop.index0 -%}\n    {%- endif -%}\n{%- endfor -%}\n{%- for message in messages -%}\n    {{- \"<|im_start|>\" + message.role + \"\\n\" -}}\n    {%- if message.role == \"assistant\" -%}\n        \n        {%- set keep_thinking = preserve_thinking or loop.index0 > ns.last_user_index -%}\n        {%- set thinking = message.thinking or message.reasoning or message.reasoning_content -%}\n        {%- set thinking = thinking if thinking is string else \"\" -%}\n        {%- if thinking and keep_thinking -%}\n            {{- \"<think>\" + thinking + \"</think>\" -}}\n        {%- endif -%}\n        {%- set _cfm_tag = \"CONTINUE_FINAL_MESSAGE_TAG \" -%}\n        {%- set _has_cfm = false -%}\n        {%- set content = \"\" -%}\n        {%- if message.get(\"content\") -%}\n            {%- set content = parse_content(message.content) -%}\n        {%- endif -%}\n        {%- if not keep_thinking and \"</think>\" in content -%}\n            {%- set content = content.split(\"</think>\")[-1] | trim -%}\n        {%- endif -%}\n        {%- if content.endswith(_cfm_tag) -%}\n            {%- set _has_cfm = true -%}\n            {%- set _trunc_len = (content | length) - (_cfm_tag | length) -%}\n            {%- set content = content[:_trunc_len] -%}\n        {%- endif -%}\n        {{- content -}}\n        {%- if message.tool_calls -%}\n            {{- render_tool_calls(message.tool_calls) -}}\n        {%- endif -%}\n        {%- if _has_cfm -%}\n            {{- _cfm_tag -}}\n        {%- endif -%}\n        {{- \"<|im_end|>\\n\" -}}\n        \n    {%- else %}\n        {%- if message.get(\"content\") -%}\n            {{- parse_content(message[\"content\"]) -}}\n        {%- endif -%}\n        {{- \"<|im_end|>\\n\" -}}\n    {%- endif %}\n{%- endfor -%}\n{%- if add_generation_prompt -%}\n    {{- \"<|im_start|>assistant\\n<think>\" -}}\n{%- endif -%}\n",
        "renderedText": "<|startoftext|><|im_start|>system\nTemplate probe system instruction.<|im_end|>\n<|im_start|>user\nTemplate probe user message.<|im_end|>\n<|im_start|>assistant\n<think>",
        "inputIds": [
          124894,
          124899,
          23630,
          207,
          23108,
          22355,
          1177,
          10996,
          22,
          124900,
          207,
          124899,
          5922,
          207,
          23108,
          22355,
          4695,
          5781,
          22,
          124900,
          207,
          124899,
          63514,
          207,
          124901
        ]
      },
      {
        "caseId": "multi-turn-generation",
        "status": "passed",
        "messages": [
          {
            "role": "user",
            "content": "Template probe first user message."
          },
          {
            "role": "assistant",
            "content": "Template probe assistant response."
          },
          {
            "role": "user",
            "content": "Template probe second user message."
          }
        ],
        "addGenerationPrompt": true,
        "selectedTemplate": "{{- bos_token -}}\n{%- set preserve_thinking = preserve_thinking | default(false) -%}\n\n{%- macro format_arg_value(arg_value) -%}\n    {%- if arg_value is string -%}\n        {{- \"'\" + (arg_value | replace(\"\\\\\", \"\\\\\\\\\") | replace(\"'\", \"\\\\'\") | replace(\"\\n\", \"\\\\n\") | replace(\"\\r\", \"\\\\r\")) + \"'\" -}}\n    {%- elif arg_value is mapping or arg_value is iterable -%}\n        {{- arg_value | tojson -}}\n    {%- else -%}\n        {{- arg_value | string -}}\n    {%- endif -%}\n{%- endmacro -%}\n\n{%- macro parse_content(content) -%}\n    {%- if content is string -%}\n        {{- content -}}\n    {%- elif content is mapping -%}\n        {{- content | tojson -}}\n    {%- elif content is iterable -%}\n        {%- set _ns = namespace(result=\"\") -%}\n        {%- for item in content -%}\n            {%- if item is string -%}\n                {%- set _ns.result = _ns.result + item -%}\n            {%- elif item is mapping and item.get(\"type\") == \"image\" -%}\n                {%- set _ns.result = _ns.result + \"<image>\" -%}\n            {%- elif item is mapping and item.get(\"type\") == \"text\" -%}\n                {%- set _ns.result = _ns.result + ((item.get(\"text\") or \"\") | string) -%}\n            {%- else -%}\n                {%- set _ns.result = _ns.result + (item | tojson) -%}\n            {%- endif -%}\n        {%- endfor -%}\n        {{- _ns.result -}}\n    {%- endif -%}\n{%- endmacro -%}\n\n{%- macro render_tool_calls(tool_calls) -%}\n    {%- set tool_calls_ns = namespace(tool_calls=[]) -%}\n    {%- for tool_call in tool_calls -%}\n        {%- set func = tool_call[\"function\"] if \"function\" in tool_call else tool_call -%}\n        {%- set func_name = func[\"name\"] -%}\n        {%- set func_args = func.get(\"arguments\") -%}\n        {%- set args_ns = namespace(arg_strings=[]) -%}\n        {%- if func_args is mapping -%}\n            {%- for arg_name, arg_value in func_args.items() -%}\n                {%- set args_ns.arg_strings = args_ns.arg_strings + [arg_name + \"=\" + format_arg_value(arg_value)] -%}\n            {%- endfor -%}\n        {%- elif func_args is string and (func_args | trim) not in [\"\", \"{}\", \"null\"] -%}\n            {{- raise_exception(\"Tool call arguments must be a mapping, got a JSON-encoded string: parse arguments with json.loads() before applying the chat template\") -}}\n        {%- endif -%}\n        {%- set tool_calls_ns.tool_calls = tool_calls_ns.tool_calls + [func_name + \"(\" + (args_ns.arg_strings | join(\", \")) + \")\"] -%}\n    {%- endfor -%}\n    {{- \"<|tool_call_start|>[\" + (tool_calls_ns.tool_calls | join(\", \")) + \"]<|tool_call_end|>\" -}}\n{%- endmacro -%}\n\n{%- set ns = namespace(system_prompt=\"\", last_user_index=-1) -%}\n{%- if messages and messages[0][\"role\"] == \"system\" -%}\n    {%- if messages[0].get(\"content\") -%}\n        {%- set ns.system_prompt = parse_content(messages[0][\"content\"]) -%}\n    {%- endif -%}\n    {%- set messages = messages[1:] -%}\n{%- endif -%}\n{%- if tools -%}\n    {%- set ns.system_prompt = ns.system_prompt + (\"\\n\" if ns.system_prompt else \"\") + \"List of tools: [\" -%}\n    {%- for tool in tools -%}\n        {%- if tool is not string -%}\n            {%- set tool = tool | tojson -%}\n        {%- endif -%}\n        {%- set ns.system_prompt = ns.system_prompt + tool -%}\n        {%- if not loop.last -%}\n            {%- set ns.system_prompt = ns.system_prompt + \", \" -%}\n        {%- endif -%}\n    {%- endfor -%}\n    {%- set ns.system_prompt = ns.system_prompt + \"]\" -%}\n{%- endif -%}\n{%- if ns.system_prompt -%}\n    {{- \"<|im_start|>system\\n\" + ns.system_prompt + \"<|im_end|>\\n\" -}}\n{%- endif -%}\n{%- for message in messages -%}\n    {%- if message[\"role\"] == \"user\" -%}\n        {%- set ns.last_user_index = loop.index0 -%}\n    {%- endif -%}\n{%- endfor -%}\n{%- for message in messages -%}\n    {{- \"<|im_start|>\" + message.role + \"\\n\" -}}\n    {%- if message.role == \"assistant\" -%}\n        \n        {%- set keep_thinking = preserve_thinking or loop.index0 > ns.last_user_index -%}\n        {%- set thinking = message.thinking or message.reasoning or message.reasoning_content -%}\n        {%- set thinking = thinking if thinking is string else \"\" -%}\n        {%- if thinking and keep_thinking -%}\n            {{- \"<think>\" + thinking + \"</think>\" -}}\n        {%- endif -%}\n        {%- set _cfm_tag = \"CONTINUE_FINAL_MESSAGE_TAG \" -%}\n        {%- set _has_cfm = false -%}\n        {%- set content = \"\" -%}\n        {%- if message.get(\"content\") -%}\n            {%- set content = parse_content(message.content) -%}\n        {%- endif -%}\n        {%- if not keep_thinking and \"</think>\" in content -%}\n            {%- set content = content.split(\"</think>\")[-1] | trim -%}\n        {%- endif -%}\n        {%- if content.endswith(_cfm_tag) -%}\n            {%- set _has_cfm = true -%}\n            {%- set _trunc_len = (content | length) - (_cfm_tag | length) -%}\n            {%- set content = content[:_trunc_len] -%}\n        {%- endif -%}\n        {{- content -}}\n        {%- if message.tool_calls -%}\n            {{- render_tool_calls(message.tool_calls) -}}\n        {%- endif -%}\n        {%- if _has_cfm -%}\n            {{- _cfm_tag -}}\n        {%- endif -%}\n        {{- \"<|im_end|>\\n\" -}}\n        \n    {%- else %}\n        {%- if message.get(\"content\") -%}\n            {{- parse_content(message[\"content\"]) -}}\n        {%- endif -%}\n        {{- \"<|im_end|>\\n\" -}}\n    {%- endif %}\n{%- endfor -%}\n{%- if add_generation_prompt -%}\n    {{- \"<|im_start|>assistant\\n<think>\" -}}\n{%- endif -%}\n",
        "renderedText": "<|startoftext|><|im_start|>user\nTemplate probe first user message.<|im_end|>\n<|im_start|>assistant\nTemplate probe assistant response.<|im_end|>\n<|im_start|>user\nTemplate probe second user message.<|im_end|>\n<|im_start|>assistant\n<think>",
        "inputIds": [
          124894,
          124899,
          5922,
          207,
          23108,
          22355,
          1008,
          4695,
          5781,
          22,
          124900,
          207,
          124899,
          63514,
          207,
          23108,
          22355,
          16200,
          3715,
          22,
          124900,
          207,
          124899,
          5922,
          207,
          23108,
          22355,
          1840,
          4695,
          5781,
          22,
          124900,
          207,
          124899,
          63514,
          207,
          124901
        ]
      },
      {
        "caseId": "tools-generation",
        "status": "passed",
        "messages": [
          {
            "role": "user",
            "content": "Use the weather tool for Tokyo."
          }
        ],
        "addGenerationPrompt": true,
        "selectedTemplate": "{{- bos_token -}}\n{%- set preserve_thinking = preserve_thinking | default(false) -%}\n\n{%- macro format_arg_value(arg_value) -%}\n    {%- if arg_value is string -%}\n        {{- \"'\" + (arg_value | replace(\"\\\\\", \"\\\\\\\\\") | replace(\"'\", \"\\\\'\") | replace(\"\\n\", \"\\\\n\") | replace(\"\\r\", \"\\\\r\")) + \"'\" -}}\n    {%- elif arg_value is mapping or arg_value is iterable -%}\n        {{- arg_value | tojson -}}\n    {%- else -%}\n        {{- arg_value | string -}}\n    {%- endif -%}\n{%- endmacro -%}\n\n{%- macro parse_content(content) -%}\n    {%- if content is string -%}\n        {{- content -}}\n    {%- elif content is mapping -%}\n        {{- content | tojson -}}\n    {%- elif content is iterable -%}\n        {%- set _ns = namespace(result=\"\") -%}\n        {%- for item in content -%}\n            {%- if item is string -%}\n                {%- set _ns.result = _ns.result + item -%}\n            {%- elif item is mapping and item.get(\"type\") == \"image\" -%}\n                {%- set _ns.result = _ns.result + \"<image>\" -%}\n            {%- elif item is mapping and item.get(\"type\") == \"text\" -%}\n                {%- set _ns.result = _ns.result + ((item.get(\"text\") or \"\") | string) -%}\n            {%- else -%}\n                {%- set _ns.result = _ns.result + (item | tojson) -%}\n            {%- endif -%}\n        {%- endfor -%}\n        {{- _ns.result -}}\n    {%- endif -%}\n{%- endmacro -%}\n\n{%- macro render_tool_calls(tool_calls) -%}\n    {%- set tool_calls_ns = namespace(tool_calls=[]) -%}\n    {%- for tool_call in tool_calls -%}\n        {%- set func = tool_call[\"function\"] if \"function\" in tool_call else tool_call -%}\n        {%- set func_name = func[\"name\"] -%}\n        {%- set func_args = func.get(\"arguments\") -%}\n        {%- set args_ns = namespace(arg_strings=[]) -%}\n        {%- if func_args is mapping -%}\n            {%- for arg_name, arg_value in func_args.items() -%}\n                {%- set args_ns.arg_strings = args_ns.arg_strings + [arg_name + \"=\" + format_arg_value(arg_value)] -%}\n            {%- endfor -%}\n        {%- elif func_args is string and (func_args | trim) not in [\"\", \"{}\", \"null\"] -%}\n            {{- raise_exception(\"Tool call arguments must be a mapping, got a JSON-encoded string: parse arguments with json.loads() before applying the chat template\") -}}\n        {%- endif -%}\n        {%- set tool_calls_ns.tool_calls = tool_calls_ns.tool_calls + [func_name + \"(\" + (args_ns.arg_strings | join(\", \")) + \")\"] -%}\n    {%- endfor -%}\n    {{- \"<|tool_call_start|>[\" + (tool_calls_ns.tool_calls | join(\", \")) + \"]<|tool_call_end|>\" -}}\n{%- endmacro -%}\n\n{%- set ns = namespace(system_prompt=\"\", last_user_index=-1) -%}\n{%- if messages and messages[0][\"role\"] == \"system\" -%}\n    {%- if messages[0].get(\"content\") -%}\n        {%- set ns.system_prompt = parse_content(messages[0][\"content\"]) -%}\n    {%- endif -%}\n    {%- set messages = messages[1:] -%}\n{%- endif -%}\n{%- if tools -%}\n    {%- set ns.system_prompt = ns.system_prompt + (\"\\n\" if ns.system_prompt else \"\") + \"List of tools: [\" -%}\n    {%- for tool in tools -%}\n        {%- if tool is not string -%}\n            {%- set tool = tool | tojson -%}\n        {%- endif -%}\n        {%- set ns.system_prompt = ns.system_prompt + tool -%}\n        {%- if not loop.last -%}\n            {%- set ns.system_prompt = ns.system_prompt + \", \" -%}\n        {%- endif -%}\n    {%- endfor -%}\n    {%- set ns.system_prompt = ns.system_prompt + \"]\" -%}\n{%- endif -%}\n{%- if ns.system_prompt -%}\n    {{- \"<|im_start|>system\\n\" + ns.system_prompt + \"<|im_end|>\\n\" -}}\n{%- endif -%}\n{%- for message in messages -%}\n    {%- if message[\"role\"] == \"user\" -%}\n        {%- set ns.last_user_index = loop.index0 -%}\n    {%- endif -%}\n{%- endfor -%}\n{%- for message in messages -%}\n    {{- \"<|im_start|>\" + message.role + \"\\n\" -}}\n    {%- if message.role == \"assistant\" -%}\n        \n        {%- set keep_thinking = preserve_thinking or loop.index0 > ns.last_user_index -%}\n        {%- set thinking = message.thinking or message.reasoning or message.reasoning_content -%}\n        {%- set thinking = thinking if thinking is string else \"\" -%}\n        {%- if thinking and keep_thinking -%}\n            {{- \"<think>\" + thinking + \"</think>\" -}}\n        {%- endif -%}\n        {%- set _cfm_tag = \"CONTINUE_FINAL_MESSAGE_TAG \" -%}\n        {%- set _has_cfm = false -%}\n        {%- set content = \"\" -%}\n        {%- if message.get(\"content\") -%}\n            {%- set content = parse_content(message.content) -%}\n        {%- endif -%}\n        {%- if not keep_thinking and \"</think>\" in content -%}\n            {%- set content = content.split(\"</think>\")[-1] | trim -%}\n        {%- endif -%}\n        {%- if content.endswith(_cfm_tag) -%}\n            {%- set _has_cfm = true -%}\n            {%- set _trunc_len = (content | length) - (_cfm_tag | length) -%}\n            {%- set content = content[:_trunc_len] -%}\n        {%- endif -%}\n        {{- content -}}\n        {%- if message.tool_calls -%}\n            {{- render_tool_calls(message.tool_calls) -}}\n        {%- endif -%}\n        {%- if _has_cfm -%}\n            {{- _cfm_tag -}}\n        {%- endif -%}\n        {{- \"<|im_end|>\\n\" -}}\n        \n    {%- else %}\n        {%- if message.get(\"content\") -%}\n            {{- parse_content(message[\"content\"]) -}}\n        {%- endif -%}\n        {{- \"<|im_end|>\\n\" -}}\n    {%- endif %}\n{%- endfor -%}\n{%- if add_generation_prompt -%}\n    {{- \"<|im_start|>assistant\\n<think>\" -}}\n{%- endif -%}\n",
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
        "renderedText": "<|startoftext|><|im_start|>system\nList of tools: [{\"type\": \"function\", \"function\": {\"name\": \"lookup_weather\", \"description\": \"Return deterministic weather fixture data.\", \"parameters\": {\"type\": \"object\", \"properties\": {\"city\": {\"type\": \"string\"}}, \"required\": [\"city\"]}}}]<|im_end|>\n<|im_start|>user\nUse the weather tool for Tokyo.<|im_end|>\n<|im_start|>assistant\n<think>",
        "inputIds": [
          124894,
          124899,
          23630,
          207,
          3120,
          302,
          5985,
          34,
          66155,
          5882,
          6380,
          496,
          5545,
          1377,
          496,
          5545,
          6380,
          36579,
          2554,
          6380,
          496,
          30252,
          1056,
          71,
          51492,
          1377,
          496,
          19021,
          6380,
          496,
          17319,
          89936,
          7420,
          51639,
          1317,
          50007,
          496,
          29701,
          6380,
          36579,
          5882,
          6380,
          496,
          7022,
          1377,
          496,
          38805,
          6380,
          36579,
          47749,
          6380,
          36579,
          5882,
          6380,
          496,
          3987,
          87961,
          496,
          34503,
          6380,
          34564,
          47749,
          88075,
          19851,
          124900,
          207,
          124899,
          5922,
          207,
          14374,
          278,
          7420,
          6189,
          374,
          18943,
          22,
          124900,
          207,
          124899,
          63514,
          207,
          124901
        ]
      },
      {
        "caseId": "assistant-tool-call-history",
        "status": "failed",
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
        "addGenerationPrompt": false,
        "selectedTemplate": "{{- bos_token -}}\n{%- set preserve_thinking = preserve_thinking | default(false) -%}\n\n{%- macro format_arg_value(arg_value) -%}\n    {%- if arg_value is string -%}\n        {{- \"'\" + (arg_value | replace(\"\\\\\", \"\\\\\\\\\") | replace(\"'\", \"\\\\'\") | replace(\"\\n\", \"\\\\n\") | replace(\"\\r\", \"\\\\r\")) + \"'\" -}}\n    {%- elif arg_value is mapping or arg_value is iterable -%}\n        {{- arg_value | tojson -}}\n    {%- else -%}\n        {{- arg_value | string -}}\n    {%- endif -%}\n{%- endmacro -%}\n\n{%- macro parse_content(content) -%}\n    {%- if content is string -%}\n        {{- content -}}\n    {%- elif content is mapping -%}\n        {{- content | tojson -}}\n    {%- elif content is iterable -%}\n        {%- set _ns = namespace(result=\"\") -%}\n        {%- for item in content -%}\n            {%- if item is string -%}\n                {%- set _ns.result = _ns.result + item -%}\n            {%- elif item is mapping and item.get(\"type\") == \"image\" -%}\n                {%- set _ns.result = _ns.result + \"<image>\" -%}\n            {%- elif item is mapping and item.get(\"type\") == \"text\" -%}\n                {%- set _ns.result = _ns.result + ((item.get(\"text\") or \"\") | string) -%}\n            {%- else -%}\n                {%- set _ns.result = _ns.result + (item | tojson) -%}\n            {%- endif -%}\n        {%- endfor -%}\n        {{- _ns.result -}}\n    {%- endif -%}\n{%- endmacro -%}\n\n{%- macro render_tool_calls(tool_calls) -%}\n    {%- set tool_calls_ns = namespace(tool_calls=[]) -%}\n    {%- for tool_call in tool_calls -%}\n        {%- set func = tool_call[\"function\"] if \"function\" in tool_call else tool_call -%}\n        {%- set func_name = func[\"name\"] -%}\n        {%- set func_args = func.get(\"arguments\") -%}\n        {%- set args_ns = namespace(arg_strings=[]) -%}\n        {%- if func_args is mapping -%}\n            {%- for arg_name, arg_value in func_args.items() -%}\n                {%- set args_ns.arg_strings = args_ns.arg_strings + [arg_name + \"=\" + format_arg_value(arg_value)] -%}\n            {%- endfor -%}\n        {%- elif func_args is string and (func_args | trim) not in [\"\", \"{}\", \"null\"] -%}\n            {{- raise_exception(\"Tool call arguments must be a mapping, got a JSON-encoded string: parse arguments with json.loads() before applying the chat template\") -}}\n        {%- endif -%}\n        {%- set tool_calls_ns.tool_calls = tool_calls_ns.tool_calls + [func_name + \"(\" + (args_ns.arg_strings | join(\", \")) + \")\"] -%}\n    {%- endfor -%}\n    {{- \"<|tool_call_start|>[\" + (tool_calls_ns.tool_calls | join(\", \")) + \"]<|tool_call_end|>\" -}}\n{%- endmacro -%}\n\n{%- set ns = namespace(system_prompt=\"\", last_user_index=-1) -%}\n{%- if messages and messages[0][\"role\"] == \"system\" -%}\n    {%- if messages[0].get(\"content\") -%}\n        {%- set ns.system_prompt = parse_content(messages[0][\"content\"]) -%}\n    {%- endif -%}\n    {%- set messages = messages[1:] -%}\n{%- endif -%}\n{%- if tools -%}\n    {%- set ns.system_prompt = ns.system_prompt + (\"\\n\" if ns.system_prompt else \"\") + \"List of tools: [\" -%}\n    {%- for tool in tools -%}\n        {%- if tool is not string -%}\n            {%- set tool = tool | tojson -%}\n        {%- endif -%}\n        {%- set ns.system_prompt = ns.system_prompt + tool -%}\n        {%- if not loop.last -%}\n            {%- set ns.system_prompt = ns.system_prompt + \", \" -%}\n        {%- endif -%}\n    {%- endfor -%}\n    {%- set ns.system_prompt = ns.system_prompt + \"]\" -%}\n{%- endif -%}\n{%- if ns.system_prompt -%}\n    {{- \"<|im_start|>system\\n\" + ns.system_prompt + \"<|im_end|>\\n\" -}}\n{%- endif -%}\n{%- for message in messages -%}\n    {%- if message[\"role\"] == \"user\" -%}\n        {%- set ns.last_user_index = loop.index0 -%}\n    {%- endif -%}\n{%- endfor -%}\n{%- for message in messages -%}\n    {{- \"<|im_start|>\" + message.role + \"\\n\" -}}\n    {%- if message.role == \"assistant\" -%}\n        \n        {%- set keep_thinking = preserve_thinking or loop.index0 > ns.last_user_index -%}\n        {%- set thinking = message.thinking or message.reasoning or message.reasoning_content -%}\n        {%- set thinking = thinking if thinking is string else \"\" -%}\n        {%- if thinking and keep_thinking -%}\n            {{- \"<think>\" + thinking + \"</think>\" -}}\n        {%- endif -%}\n        {%- set _cfm_tag = \"CONTINUE_FINAL_MESSAGE_TAG \" -%}\n        {%- set _has_cfm = false -%}\n        {%- set content = \"\" -%}\n        {%- if message.get(\"content\") -%}\n            {%- set content = parse_content(message.content) -%}\n        {%- endif -%}\n        {%- if not keep_thinking and \"</think>\" in content -%}\n            {%- set content = content.split(\"</think>\")[-1] | trim -%}\n        {%- endif -%}\n        {%- if content.endswith(_cfm_tag) -%}\n            {%- set _has_cfm = true -%}\n            {%- set _trunc_len = (content | length) - (_cfm_tag | length) -%}\n            {%- set content = content[:_trunc_len] -%}\n        {%- endif -%}\n        {{- content -}}\n        {%- if message.tool_calls -%}\n            {{- render_tool_calls(message.tool_calls) -}}\n        {%- endif -%}\n        {%- if _has_cfm -%}\n            {{- _cfm_tag -}}\n        {%- endif -%}\n        {{- \"<|im_end|>\\n\" -}}\n        \n    {%- else %}\n        {%- if message.get(\"content\") -%}\n            {{- parse_content(message[\"content\"]) -}}\n        {%- endif -%}\n        {{- \"<|im_end|>\\n\" -}}\n    {%- endif %}\n{%- endfor -%}\n{%- if add_generation_prompt -%}\n    {{- \"<|im_start|>assistant\\n<think>\" -}}\n{%- endif -%}\n",
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
        "failureStage": "render",
        "errorMessage": "Tool call arguments must be a mapping, got a JSON-encoded string: parse arguments with json.loads() before applying the chat template"
      },
      {
        "caseId": "tool-result-continuation",
        "status": "failed",
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
        "addGenerationPrompt": true,
        "selectedTemplate": "{{- bos_token -}}\n{%- set preserve_thinking = preserve_thinking | default(false) -%}\n\n{%- macro format_arg_value(arg_value) -%}\n    {%- if arg_value is string -%}\n        {{- \"'\" + (arg_value | replace(\"\\\\\", \"\\\\\\\\\") | replace(\"'\", \"\\\\'\") | replace(\"\\n\", \"\\\\n\") | replace(\"\\r\", \"\\\\r\")) + \"'\" -}}\n    {%- elif arg_value is mapping or arg_value is iterable -%}\n        {{- arg_value | tojson -}}\n    {%- else -%}\n        {{- arg_value | string -}}\n    {%- endif -%}\n{%- endmacro -%}\n\n{%- macro parse_content(content) -%}\n    {%- if content is string -%}\n        {{- content -}}\n    {%- elif content is mapping -%}\n        {{- content | tojson -}}\n    {%- elif content is iterable -%}\n        {%- set _ns = namespace(result=\"\") -%}\n        {%- for item in content -%}\n            {%- if item is string -%}\n                {%- set _ns.result = _ns.result + item -%}\n            {%- elif item is mapping and item.get(\"type\") == \"image\" -%}\n                {%- set _ns.result = _ns.result + \"<image>\" -%}\n            {%- elif item is mapping and item.get(\"type\") == \"text\" -%}\n                {%- set _ns.result = _ns.result + ((item.get(\"text\") or \"\") | string) -%}\n            {%- else -%}\n                {%- set _ns.result = _ns.result + (item | tojson) -%}\n            {%- endif -%}\n        {%- endfor -%}\n        {{- _ns.result -}}\n    {%- endif -%}\n{%- endmacro -%}\n\n{%- macro render_tool_calls(tool_calls) -%}\n    {%- set tool_calls_ns = namespace(tool_calls=[]) -%}\n    {%- for tool_call in tool_calls -%}\n        {%- set func = tool_call[\"function\"] if \"function\" in tool_call else tool_call -%}\n        {%- set func_name = func[\"name\"] -%}\n        {%- set func_args = func.get(\"arguments\") -%}\n        {%- set args_ns = namespace(arg_strings=[]) -%}\n        {%- if func_args is mapping -%}\n            {%- for arg_name, arg_value in func_args.items() -%}\n                {%- set args_ns.arg_strings = args_ns.arg_strings + [arg_name + \"=\" + format_arg_value(arg_value)] -%}\n            {%- endfor -%}\n        {%- elif func_args is string and (func_args | trim) not in [\"\", \"{}\", \"null\"] -%}\n            {{- raise_exception(\"Tool call arguments must be a mapping, got a JSON-encoded string: parse arguments with json.loads() before applying the chat template\") -}}\n        {%- endif -%}\n        {%- set tool_calls_ns.tool_calls = tool_calls_ns.tool_calls + [func_name + \"(\" + (args_ns.arg_strings | join(\", \")) + \")\"] -%}\n    {%- endfor -%}\n    {{- \"<|tool_call_start|>[\" + (tool_calls_ns.tool_calls | join(\", \")) + \"]<|tool_call_end|>\" -}}\n{%- endmacro -%}\n\n{%- set ns = namespace(system_prompt=\"\", last_user_index=-1) -%}\n{%- if messages and messages[0][\"role\"] == \"system\" -%}\n    {%- if messages[0].get(\"content\") -%}\n        {%- set ns.system_prompt = parse_content(messages[0][\"content\"]) -%}\n    {%- endif -%}\n    {%- set messages = messages[1:] -%}\n{%- endif -%}\n{%- if tools -%}\n    {%- set ns.system_prompt = ns.system_prompt + (\"\\n\" if ns.system_prompt else \"\") + \"List of tools: [\" -%}\n    {%- for tool in tools -%}\n        {%- if tool is not string -%}\n            {%- set tool = tool | tojson -%}\n        {%- endif -%}\n        {%- set ns.system_prompt = ns.system_prompt + tool -%}\n        {%- if not loop.last -%}\n            {%- set ns.system_prompt = ns.system_prompt + \", \" -%}\n        {%- endif -%}\n    {%- endfor -%}\n    {%- set ns.system_prompt = ns.system_prompt + \"]\" -%}\n{%- endif -%}\n{%- if ns.system_prompt -%}\n    {{- \"<|im_start|>system\\n\" + ns.system_prompt + \"<|im_end|>\\n\" -}}\n{%- endif -%}\n{%- for message in messages -%}\n    {%- if message[\"role\"] == \"user\" -%}\n        {%- set ns.last_user_index = loop.index0 -%}\n    {%- endif -%}\n{%- endfor -%}\n{%- for message in messages -%}\n    {{- \"<|im_start|>\" + message.role + \"\\n\" -}}\n    {%- if message.role == \"assistant\" -%}\n        \n        {%- set keep_thinking = preserve_thinking or loop.index0 > ns.last_user_index -%}\n        {%- set thinking = message.thinking or message.reasoning or message.reasoning_content -%}\n        {%- set thinking = thinking if thinking is string else \"\" -%}\n        {%- if thinking and keep_thinking -%}\n            {{- \"<think>\" + thinking + \"</think>\" -}}\n        {%- endif -%}\n        {%- set _cfm_tag = \"CONTINUE_FINAL_MESSAGE_TAG \" -%}\n        {%- set _has_cfm = false -%}\n        {%- set content = \"\" -%}\n        {%- if message.get(\"content\") -%}\n            {%- set content = parse_content(message.content) -%}\n        {%- endif -%}\n        {%- if not keep_thinking and \"</think>\" in content -%}\n            {%- set content = content.split(\"</think>\")[-1] | trim -%}\n        {%- endif -%}\n        {%- if content.endswith(_cfm_tag) -%}\n            {%- set _has_cfm = true -%}\n            {%- set _trunc_len = (content | length) - (_cfm_tag | length) -%}\n            {%- set content = content[:_trunc_len] -%}\n        {%- endif -%}\n        {{- content -}}\n        {%- if message.tool_calls -%}\n            {{- render_tool_calls(message.tool_calls) -}}\n        {%- endif -%}\n        {%- if _has_cfm -%}\n            {{- _cfm_tag -}}\n        {%- endif -%}\n        {{- \"<|im_end|>\\n\" -}}\n        \n    {%- else %}\n        {%- if message.get(\"content\") -%}\n            {{- parse_content(message[\"content\"]) -}}\n        {%- endif -%}\n        {{- \"<|im_end|>\\n\" -}}\n    {%- endif %}\n{%- endfor -%}\n{%- if add_generation_prompt -%}\n    {{- \"<|im_start|>assistant\\n<think>\" -}}\n{%- endif -%}\n",
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
        "failureStage": "render",
        "errorMessage": "Tool call arguments must be a mapping, got a JSON-encoded string: parse arguments with json.loads() before applying the chat template"
      }
    ]
  },
  "productionLane": {
    "route": {
      "autoClass": "AutoModelForCausalLM",
      "processor": "tokenizer",
      "strategy": "standard",
      "modelType": "lfm2"
    },
    "firstTurn": {
      "messages": [
        {
          "role": "user",
          "content": "Template probe user message."
        }
      ],
      "inputKeys": [
        "attention_mask",
        "input_ids"
      ],
      "inputTensors": [
        {
          "name": "attention_mask",
          "dtype": "int64",
          "dims": [
            1,
            15
          ],
          "location": "cpu"
        },
        {
          "name": "input_ids",
          "dtype": "int64",
          "dims": [
            1,
            15
          ],
          "location": "cpu"
        }
      ],
      "inputTokenIds": [
        124894,
        124899,
        5922,
        207,
        23108,
        22355,
        4695,
        5781,
        22,
        124900,
        207,
        124899,
        63514,
        207,
        124901
      ],
      "pastKeyValuesProvided": false,
      "inputPastKeyValuesSummary": {
        "kind": "nullish",
        "valueType": "null",
        "ownKeyCount": 0,
        "ownKeys": [],
        "truncated": false
      },
      "outputPastKeyValuesSummary": {
        "kind": "object",
        "valueType": "object",
        "constructorName": "_DynamicCache",
        "ownKeyCount": 38,
        "ownKeys": [
          "past_conv.0",
          "past_conv.1",
          "past_key_values.2.key",
          "past_key_values.2.value",
          "past_conv.3",
          "past_conv.4",
          "past_key_values.5.key",
          "past_key_values.5.value",
          "past_conv.6",
          "past_conv.7",
          "past_conv.8",
          "past_key_values.9.key",
          "past_key_values.9.value",
          "past_conv.10",
          "past_conv.11",
          "past_conv.12",
          "past_key_values.13.key",
          "past_key_values.13.value",
          "past_conv.14",
          "past_conv.15",
          "past_conv.16",
          "past_key_values.17.key",
          "past_key_values.17.value",
          "past_conv.18",
          "past_conv.19",
          "past_conv.20",
          "past_key_values.21.key",
          "past_key_values.21.value",
          "past_conv.22",
          "past_conv.23",
          "past_key_values.24.key",
          "past_key_values.24.value"
        ],
        "truncated": true
      },
      "generatedSequenceTokenIds": [
        124894,
        124899,
        5922,
        207,
        23108,
        22355,
        4695,
        5781,
        22,
        124900,
        207,
        124899,
        63514,
        207,
        124901,
        597,
        4695,
        10966,
        622,
        310,
        496,
        23108,
        22355,
        4695,
        5781,
        2426,
        969,
        355,
        267,
        5018,
        54644
      ],
      "generatedTokenIds": [
        597,
        4695,
        10966,
        622,
        310,
        496,
        23108,
        22355,
        4695,
        5781,
        2426,
        969,
        355,
        267,
        5018,
        54644
      ],
      "generatedText": "The user wants me to \"Template probe user message.\" This is a bit ambiguous",
      "streamChunks": [
        "The ",
        "user ",
        "wants ",
        "me ",
        "to ",
        "\"Template ",
        "probe ",
        "user ",
        "message.\" ",
        "This ",
        "is ",
        "a ",
        "bit ",
        "ambiguous"
      ],
      "toolCalls": [],
      "effectiveGenerationConfig": {
        "maxNewTokens": 16,
        "temperature": 0,
        "topP": 1,
        "doSample": false
      }
    },
    "continuity": {
      "status": "passed",
      "assistantMessage": {
        "role": "assistant",
        "content": "The user wants me to \"Template probe user message.\" This is a bit ambiguous"
      },
      "followUpMessage": {
        "role": "user",
        "content": "Continue with one short sentence."
      },
      "secondTurn": {
        "messages": [
          {
            "role": "user",
            "content": "Template probe user message."
          },
          {
            "role": "assistant",
            "content": "The user wants me to \"Template probe user message.\" This is a bit ambiguous"
          },
          {
            "role": "user",
            "content": "Continue with one short sentence."
          }
        ],
        "inputKeys": [
          "attention_mask",
          "input_ids"
        ],
        "inputTensors": [
          {
            "name": "attention_mask",
            "dtype": "int64",
            "dims": [
              1,
              47
            ],
            "location": "cpu"
          },
          {
            "name": "input_ids",
            "dtype": "int64",
            "dims": [
              1,
              47
            ],
            "location": "cpu"
          }
        ],
        "inputTokenIds": [
          124894,
          124899,
          5922,
          207,
          23108,
          22355,
          4695,
          5781,
          22,
          124900,
          207,
          124899,
          63514,
          207,
          597,
          4695,
          10966,
          622,
          310,
          496,
          23108,
          22355,
          4695,
          5781,
          2426,
          969,
          355,
          267,
          5018,
          54644,
          124900,
          207,
          124899,
          5922,
          207,
          48186,
          415,
          734,
          2789,
          12683,
          22,
          124900,
          207,
          124899,
          63514,
          207,
          124901
        ],
        "pastKeyValuesProvided": false,
        "inputPastKeyValuesSummary": {
          "kind": "nullish",
          "valueType": "null",
          "ownKeyCount": 0,
          "ownKeys": [],
          "truncated": false
        },
        "outputPastKeyValuesSummary": {
          "kind": "object",
          "valueType": "object",
          "constructorName": "_DynamicCache",
          "ownKeyCount": 38,
          "ownKeys": [
            "past_conv.0",
            "past_conv.1",
            "past_key_values.2.key",
            "past_key_values.2.value",
            "past_conv.3",
            "past_conv.4",
            "past_key_values.5.key",
            "past_key_values.5.value",
            "past_conv.6",
            "past_conv.7",
            "past_conv.8",
            "past_key_values.9.key",
            "past_key_values.9.value",
            "past_conv.10",
            "past_conv.11",
            "past_conv.12",
            "past_key_values.13.key",
            "past_key_values.13.value",
            "past_conv.14",
            "past_conv.15",
            "past_conv.16",
            "past_key_values.17.key",
            "past_key_values.17.value",
            "past_conv.18",
            "past_conv.19",
            "past_conv.20",
            "past_key_values.21.key",
            "past_key_values.21.value",
            "past_conv.22",
            "past_conv.23",
            "past_key_values.24.key",
            "past_key_values.24.value"
          ],
          "truncated": true
        },
        "generatedSequenceTokenIds": [
          124894,
          124899,
          5922,
          207,
          23108,
          22355,
          4695,
          5781,
          22,
          124900,
          207,
          124899,
          63514,
          207,
          597,
          4695,
          10966,
          622,
          310,
          496,
          23108,
          22355,
          4695,
          5781,
          2426,
          969,
          355,
          267,
          5018,
          54644,
          124900,
          207,
          124899,
          5922,
          207,
          48186,
          415,
          734,
          2789,
          12683,
          22,
          124900,
          207,
          124899,
          63514,
          207,
          124901,
          597,
          4695,
          10966,
          622,
          310,
          4951,
          415,
          734,
          2789,
          12683,
          22,
          1715,
          7096,
          5250,
          374,
          267
        ],
        "generatedTokenIds": [
          597,
          4695,
          10966,
          622,
          310,
          4951,
          415,
          734,
          2789,
          12683,
          22,
          1715,
          7096,
          5250,
          374,
          267
        ],
        "generatedText": "The user wants me to continue with one short sentence. They previously asked for a",
        "streamChunks": [
          "The ",
          "user ",
          "wants ",
          "me ",
          "to ",
          "continue ",
          "with ",
          "one ",
          "short ",
          "sentence. ",
          "They ",
          "previously ",
          "asked ",
          "for ",
          "a"
        ],
        "toolCalls": [],
        "effectiveGenerationConfig": {
          "maxNewTokens": 16,
          "temperature": 0,
          "topP": 1,
          "doSample": false
        }
      },
      "prefixComparison": {
        "mode": "full-input-prefix",
        "expectedPrefixTokenIds": [
          124894,
          124899,
          5922,
          207,
          23108,
          22355,
          4695,
          5781,
          22,
          124900,
          207,
          124899,
          63514,
          207,
          124901,
          597,
          4695,
          10966,
          622,
          310,
          496,
          23108,
          22355,
          4695,
          5781,
          2426,
          969,
          355,
          267,
          5018,
          54644
        ],
        "secondInputTokenIds": [
          124894,
          124899,
          5922,
          207,
          23108,
          22355,
          4695,
          5781,
          22,
          124900,
          207,
          124899,
          63514,
          207,
          597,
          4695,
          10966,
          622,
          310,
          496,
          23108,
          22355,
          4695,
          5781,
          2426,
          969,
          355,
          267,
          5018,
          54644,
          124900,
          207,
          124899,
          5922,
          207,
          48186,
          415,
          734,
          2789,
          12683,
          22,
          124900,
          207,
          124899,
          63514,
          207,
          124901
        ],
        "exactPrefixMatch": false,
        "firstMismatchIndex": 14
      }
    }
  },
  "laneComparison": {
    "scenarioCaseId": "user-generation",
    "referenceAttemptId": "eaee073f-7ece-49aa-9ed6-d9410956a66e",
    "exactInputMatch": true,
    "referenceInputTokenIds": [
      124894,
      124899,
      5922,
      207,
      23108,
      22355,
      4695,
      5781,
      22,
      124900,
      207,
      124899,
      63514,
      207,
      124901
    ],
    "productionInputTokenIds": [
      124894,
      124899,
      5922,
      207,
      23108,
      22355,
      4695,
      5781,
      22,
      124900,
      207,
      124899,
      63514,
      207,
      124901
    ],
    "referenceGeneratedTokenIds": [
      597
    ],
    "productionGeneratedTokenIds": [
      597,
      4695,
      10966,
      622,
      310,
      496,
      23108,
      22355,
      4695,
      5781,
      2426,
      969,
      355,
      267,
      5018,
      54644
    ],
    "productionRoute": {
      "autoClass": "AutoModelForCausalLM",
      "processor": "tokenizer",
      "strategy": "standard",
      "modelType": "lfm2"
    }
  }
} as const;

// Export internal fixture state used only for browser/model-free Evidence replay tests.
export const TEST_ONLY = {
  LFM2_5_MODEL_SUPPORT_EVIDENCE,
};
