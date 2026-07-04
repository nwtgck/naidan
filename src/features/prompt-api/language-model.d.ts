/* eslint-disable local-rules-named-args/require-named-args -- These declarations mirror the browser Prompt API's positional Web IDL signatures. */

export type PromptApiAvailability =
  | 'available'
  | 'downloadable'
  | 'downloading'
  | 'unavailable';

export type PromptApiMessageRole = 'system' | 'user' | 'assistant';

export type PromptApiMessage = {
  role: PromptApiMessageRole,
  content: string,
};

export type PromptApiExpected = {
  type: 'text',
  languages?: string[],
};

export interface PromptApiCreateMonitor extends EventTarget {
  addEventListener(
    type: 'downloadprogress',
    listener: (event: ProgressEvent) => void,
  ): void,
}

export type PromptApiCreateCoreOptions = {
  expectedInputs?: PromptApiExpected[],
  expectedOutputs?: PromptApiExpected[],
};

export type PromptApiCreateOptions = PromptApiCreateCoreOptions & {
  signal?: AbortSignal,
  monitor?: (monitor: PromptApiCreateMonitor) => void,
  initialPrompts?: PromptApiMessage[],
};

export type PromptApiPromptOptions = {
  signal?: AbortSignal,
};

export interface PromptApiSession {
  promptStreaming(
    input: string | PromptApiMessage[],
    options?: PromptApiPromptOptions,
  ): ReadableStream<string>,
  destroy(): void,
}

export interface PromptApiLanguageModelStatic {
  availability(options?: PromptApiCreateCoreOptions): Promise<unknown>,
  create(options?: PromptApiCreateOptions): Promise<unknown>,
}
