<script setup lang="ts">
import { lazyStrings } from '@/strings';
import { ref, computed } from 'vue';
import { z } from 'zod';
import { ChevronDownIcon, ChevronRightIcon, WrapTextIcon } from 'lucide-vue-next';
import type { ToolExecutionResult } from '@/01-models/tool';

const props = defineProps<{
  args: string,
  result: ToolExecutionResult | undefined,
  argumentState?: 'partial' | 'complete',
  liveOutput?: string,
}>();

// IMPORTANT: These schemas are intentionally local to this component and MUST NOT
// be exported or imported elsewhere. Tool call argument shapes can change in
// breaking ways across versions; coupling external code to this schema would
// silently break when the tool protocol is revised.
const ShellExecuteArgsSchema = z.object({
  shell_script: z.string(),
  stdout_limit: z.number().int().optional(),
  stderr_limit: z.number().int().optional(),
});

type ShellExecuteArgs = z.infer<typeof ShellExecuteArgsSchema>;

// This is only a presentation prefix reader, never a completed argument parser.
// Recognize shell_script when it is the first member; other shapes stay raw JSON.
// Tool schemas may change incompatibly, including their preferred display shape.
let partialInput = '';
let partialCursor = 0;
let partialScript = '';
let partialState: 'header' | 'string' | 'closed' | 'invalid' = 'header';

function readPartialScript({ input }: { input: string }): string | undefined {
  if (!input.startsWith(partialInput)) {
    partialCursor = 0;
    partialScript = '';
    partialState = 'header';
  }
  partialInput = input;
  switch (partialState) {
  case 'header': {
    const header = /^[ \t\r\n]*\{[ \t\r\n]*"shell_script"[ \t\r\n]*:[ \t\r\n]*"/.exec(input);
    if (!header) return undefined;
    partialCursor = header[0].length;
    partialState = 'string';
    break;
  }
  case 'string': break;
  // A draft preview does not certify later fields. Complete calls use the schema below.
  case 'closed': return partialScript;
  case 'invalid': return undefined;
  default: { const _ex: never = partialState; throw new Error(`Unhandled partial display state: ${_ex}`); }
  }
  while (partialCursor < input.length) {
    const character = input[partialCursor]!;
    if (character === '"') {
      partialState = 'closed';
      partialCursor++;
      return partialScript;
    }
    if (character.charCodeAt(0) < 0x20) {
      partialState = 'invalid';
      return undefined;
    }
    if (character === '\\') {
      const escape = input[partialCursor + 1];
      if (escape === undefined) break;
      const length = escape === 'u' ? 6 : 2;
      if (partialCursor + length > input.length) break;
      try {
        partialScript += JSON.parse('"' + input.slice(partialCursor, partialCursor + length) + '"');
      } catch {
        partialState = 'invalid';
        return undefined;
      }
      partialCursor += length;
    } else {
      partialScript += character;
      partialCursor++;
    }
  }
  return partialScript;
}

const parsedArgs = computed((): ShellExecuteArgs | null => {
  const argumentState = props.argumentState;
  switch (argumentState) {
  case 'partial': {
    const script = readPartialScript({ input: props.args });
    if (script !== undefined) return { shell_script: script };
    break;
  }
  case 'complete':
  case undefined: break;
  default: { const _ex: never = argumentState; throw new Error(`Unhandled argument display state: ${_ex}`); }
  }
  try {
    const r = ShellExecuteArgsSchema.safeParse(JSON.parse(props.args));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
});

const formattedRawArgs = computed((): string => {
  const argumentState = props.argumentState;
  switch (argumentState) {
  case 'partial': return props.args;
  case 'complete':
  case undefined: break;
  default: { const _ex: never = argumentState; throw new Error(`Unhandled argument display state: ${_ex}`); }
  }
  try {
    return JSON.stringify(JSON.parse(props.args), null, 2);
  } catch {
    return props.args;
  }
});

const showRaw = ref(false);
const wrapCommand = ref(true);

const resultText = computed((): string | null => {
  const r = props.result;
  if (r === undefined) return null;
  if (r.status === 'success' && r.content.type === 'text') return r.content.text;
  if (r.status === 'error' && r.error.message.type === 'text') return r.error.message.text;
  return null;
});

const liveOutputText = computed((): string | null => {
  const status = props.result?.status;
  switch (status) {
  case 'executing':
    return props.liveOutput && props.liveOutput.length > 0 ? props.liveOutput : null;
  case 'success':
  case 'error':
  case undefined:
    return null;
  default: {
    const _ex: never = status;
    throw new Error(`Unhandled tool result status: ${_ex}`);
  }
  }
});


defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
    },
  }) || {}),
});
</script>

<template>
  <!-- Fallback to generic display if args do not match the shell_execute schema -->
  <template v-if="parsedArgs === null">
    <div>
      <div tw-class="text-[9px] font-bold text-gray-400 uppercase tracking-tight mb-1">{{ lazyStrings.toolCall__arguments() }}</div>
      <pre class="custom-scrollbar" tw-class="text-[10px] font-mono p-2 bg-black/5 dark:bg-black/20 rounded-lg overflow-x-auto">{{ formattedRawArgs }}</pre>
    </div>
    <div v-if="result?.status === 'executing' && liveOutputText !== null">
      <pre class="custom-scrollbar" tw-class="text-[10px] font-mono p-2 rounded-lg bg-blue-500/5 text-gray-700 dark:text-gray-300 overflow-x-auto whitespace-pre-wrap">{{ liveOutputText }}</pre>
    </div>
    <div v-else-if="resultText !== null">
      <div tw-class="text-[9px] font-bold text-gray-400 uppercase tracking-tight mb-1">
        {{ result?.status === 'success' ? lazyStrings.toolCall__result() : lazyStrings.toolCall__error() }}
      </div>
      <div v-if="result?.status === 'error'" tw-class="text-[10px] font-mono p-2 rounded-lg break-words bg-red-500/5 text-red-600 dark:text-red-400">
        <div tw-class="font-bold mb-1 uppercase text-[8px] tracking-widest opacity-70">{{ lazyStrings.toolCall__code() }} {{ result.error.code }}</div>
        <div tw-class="whitespace-pre-wrap">{{ resultText }}</div>
      </div>
      <div v-else tw-class="text-[10px] font-mono p-2 rounded-lg break-words bg-green-500/5 text-gray-700 dark:text-gray-300 whitespace-pre-wrap">
        {{ resultText }}
      </div>
    </div>
  </template>

  <template v-else>
    <!-- Shell script block (terminal style) -->
    <div tw-class="relative group/cmd">
      <pre
        class="custom-scrollbar"
        :tw-class="['text-[10px] font-mono p-2 rounded-lg bg-black/5 dark:bg-black/20 text-gray-700 dark:text-gray-300 overflow-x-auto', wrapCommand ? 'whitespace-pre-wrap' : 'whitespace-pre']"
      ><span tw-class="text-blue-500/50 dark:text-blue-400/50 select-none">$ </span>{{ parsedArgs.shell_script }}</pre>
      <button
        :tw-class="['absolute top-1 right-1 opacity-0 group-hover/cmd:opacity-100 transition-opacity p-0.5 rounded bg-black/5 dark:bg-white/5 hover:bg-black/10 dark:hover:bg-white/10 transition-colors', wrapCommand ? 'text-blue-500/70 dark:text-blue-400/70' : 'text-gray-400 dark:text-gray-500']"
        :title="wrapCommand ? lazyStrings.toolCall__disable_wrap() : lazyStrings.toolCall__enable_wrap()"
        data-testid="shell-execute-wrap-toggle"
        @click.stop="wrapCommand = !wrapCommand"
      ><WrapTextIcon tw-class="w-3 h-3" /></button>
    </div>

    <!-- Result -->
    <div v-if="result?.status === 'executing' && liveOutputText !== null">
      <pre class="custom-scrollbar" tw-class="text-[10px] font-mono p-2 rounded-lg bg-blue-500/5 text-gray-700 dark:text-gray-300 overflow-x-auto whitespace-pre-wrap">{{ liveOutputText }}</pre>
    </div>
    <div v-else-if="resultText !== null">
      <div v-if="result?.status === 'error'" tw-class="text-[10px] font-mono p-2 rounded-lg break-words bg-red-500/5 text-red-600 dark:text-red-400">
        <div tw-class="font-bold mb-1 uppercase text-[8px] tracking-widest opacity-70">{{ lazyStrings.toolCall__code() }} {{ result.error.code }}</div>
        <div tw-class="whitespace-pre-wrap">{{ resultText }}</div>
      </div>
      <pre v-else class="custom-scrollbar" tw-class="text-[10px] font-mono p-2 rounded-lg bg-green-500/5 text-gray-700 dark:text-gray-300 overflow-x-auto whitespace-pre-wrap">{{ resultText }}</pre>
    </div>

    <!-- Raw JSON (lazy) -->
    <div>
      <button
        tw-class="flex items-center gap-1 text-[9px] font-bold text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 uppercase tracking-tight transition-colors select-none"
        data-testid="shell-execute-raw-toggle"
        @click.stop="showRaw = !showRaw"
      >
        <component :is="showRaw ? ChevronDownIcon : ChevronRightIcon" tw-class="w-3 h-3" />
        {{ lazyStrings.toolCall__raw_json() }}
      </button>
      <pre
        v-if="showRaw"
        class="custom-scrollbar" tw-class="mt-1 text-[10px] font-mono p-2 bg-black/5 dark:bg-black/20 rounded-lg overflow-x-auto"
        data-testid="shell-execute-raw-json"
      >{{ formattedRawArgs }}</pre>
    </div>
  </template>
</template>

<style scoped>
.custom-scrollbar::-webkit-scrollbar {
  height: 4px;
}
.custom-scrollbar::-webkit-scrollbar-track {
  background: transparent;
}
.custom-scrollbar::-webkit-scrollbar-thumb {
  background: rgba(156, 163, 175, 0.2);
  border-radius: 10px;
}
</style>
