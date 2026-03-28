<script setup lang="ts">
import { ref, computed } from 'vue';
import { z } from 'zod';
import { ChevronDown, ChevronRight, WrapText } from 'lucide-vue-next';
import type { ToolExecutionResult } from '@/services/tools/types';

const props = defineProps<{
  args: string;
  result: ToolExecutionResult;
  liveOutput?: string;
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

const parsedArgs = computed((): ShellExecuteArgs | null => {
  try {
    const r = ShellExecuteArgsSchema.safeParse(JSON.parse(props.args));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
});

const formattedRawArgs = computed((): string => {
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
  if (r.status === 'success' && r.content.type === 'text') return r.content.text;
  if (r.status === 'error' && r.error.message.type === 'text') return r.error.message.text;
  return null;
});

const liveOutputText = computed((): string | null => {
  const status = props.result.status;
  switch (status) {
  case 'executing':
    return props.liveOutput && props.liveOutput.length > 0 ? props.liveOutput : null;
  case 'success':
  case 'error':
    return null;
  default: {
    const _ex: never = status;
    throw new Error(`Unhandled tool result status: ${_ex}`);
  }
  }
});


defineExpose({
  __testOnly: {
    // Export internal state and logic used only for testing here. Do not reference these in production logic.
  }
});
</script>

<template>
  <!-- Fallback to generic display if args do not match the shell_execute schema -->
  <template v-if="parsedArgs === null">
    <div>
      <div class="text-[9px] font-bold text-gray-400 uppercase tracking-tight mb-1">Arguments</div>
      <pre class="text-[10px] font-mono p-2 bg-black/5 dark:bg-black/20 rounded-lg overflow-x-auto custom-scrollbar">{{ formattedRawArgs }}</pre>
    </div>
    <div v-if="result.status === 'executing' && liveOutputText !== null">
      <pre class="text-[10px] font-mono p-2 rounded-lg bg-blue-500/5 text-gray-700 dark:text-gray-300 overflow-x-auto custom-scrollbar whitespace-pre-wrap">{{ liveOutputText }}</pre>
    </div>
    <div v-else-if="resultText !== null">
      <div class="text-[9px] font-bold text-gray-400 uppercase tracking-tight mb-1">
        {{ result.status === 'success' ? 'Result' : 'Error' }}
      </div>
      <div v-if="result.status === 'error'" class="text-[10px] font-mono p-2 rounded-lg break-words bg-red-500/5 text-red-600 dark:text-red-400">
        <div class="font-bold mb-1 uppercase text-[8px] tracking-widest opacity-70">Code: {{ result.error.code }}</div>
        <div class="whitespace-pre-wrap">{{ resultText }}</div>
      </div>
      <div v-else class="text-[10px] font-mono p-2 rounded-lg break-words bg-green-500/5 text-gray-700 dark:text-gray-300 whitespace-pre-wrap">
        {{ resultText }}
      </div>
    </div>
  </template>

  <template v-else>
    <!-- Shell script block (terminal style) -->
    <div class="relative group/cmd">
      <pre
        class="text-[10px] font-mono p-2 rounded-lg bg-black/5 dark:bg-black/20 text-gray-700 dark:text-gray-300 overflow-x-auto custom-scrollbar"
        :class="wrapCommand ? 'whitespace-pre-wrap' : 'whitespace-pre'"
      ><span class="text-blue-500/50 dark:text-blue-400/50 select-none">$ </span>{{ parsedArgs.shell_script }}</pre>
      <button
        class="absolute top-1 right-1 opacity-0 group-hover/cmd:opacity-100 transition-opacity p-0.5 rounded bg-black/5 dark:bg-white/5 hover:bg-black/10 dark:hover:bg-white/10 transition-colors"
        :class="wrapCommand ? 'text-blue-500/70 dark:text-blue-400/70' : 'text-gray-400 dark:text-gray-500'"
        :title="wrapCommand ? 'Disable wrap' : 'Enable wrap'"
        data-testid="shell-execute-wrap-toggle"
        @click.stop="wrapCommand = !wrapCommand"
      ><WrapText class="w-3 h-3" /></button>
    </div>

    <!-- Result -->
    <div v-if="result.status === 'executing' && liveOutputText !== null">
      <pre class="text-[10px] font-mono p-2 rounded-lg bg-blue-500/5 text-gray-700 dark:text-gray-300 overflow-x-auto custom-scrollbar whitespace-pre-wrap">{{ liveOutputText }}</pre>
    </div>
    <div v-else-if="resultText !== null">
      <div v-if="result.status === 'error'" class="text-[10px] font-mono p-2 rounded-lg break-words bg-red-500/5 text-red-600 dark:text-red-400">
        <div class="font-bold mb-1 uppercase text-[8px] tracking-widest opacity-70">Code: {{ result.error.code }}</div>
        <div class="whitespace-pre-wrap">{{ resultText }}</div>
      </div>
      <pre v-else class="text-[10px] font-mono p-2 rounded-lg bg-green-500/5 text-gray-700 dark:text-gray-300 overflow-x-auto custom-scrollbar whitespace-pre-wrap">{{ resultText }}</pre>
    </div>

    <!-- Raw JSON (lazy) -->
    <div>
      <button
        class="flex items-center gap-1 text-[9px] font-bold text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 uppercase tracking-tight transition-colors select-none"
        data-testid="shell-execute-raw-toggle"
        @click.stop="showRaw = !showRaw"
      >
        <component :is="showRaw ? ChevronDown : ChevronRight" class="w-3 h-3" />
        Raw JSON
      </button>
      <pre
        v-if="showRaw"
        class="mt-1 text-[10px] font-mono p-2 bg-black/5 dark:bg-black/20 rounded-lg overflow-x-auto custom-scrollbar"
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
