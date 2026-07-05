/* eslint-disable local-rules-named-args/require-named-args -- These declarations mirror the browser Prompt API's positional Web IDL signatures. */

export type PromptApiAvailability =
  | 'available'
  | 'downloadable'
  | 'downloading'
  | 'unavailable';

export type PromptApiInputMode = 'text' | 'image';

export type PromptApiMessageRole = 'system' | 'user' | 'assistant';

export type PromptApiTextMessageContent = {
  type: 'text',
  value: string,
};

export type PromptApiImageMessageContent = {
  type: 'image',
  value: Blob,
};

export type PromptApiMessageContent =
  | PromptApiTextMessageContent
  | PromptApiImageMessageContent;

export type PromptApiMessage = {
  role: PromptApiMessageRole,
  content: string | PromptApiMessageContent[],
};

export type PromptApiPrompt = string | PromptApiMessage[];

export type PromptApiExpectedInput = {
  type: 'text' | 'image',
  languages?: string[],
};

export type PromptApiExpectedOutput = {
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
  expectedInputs?: PromptApiExpectedInput[],
  expectedOutputs?: PromptApiExpectedOutput[],
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
    input: PromptApiPrompt,
    options?: PromptApiPromptOptions,
  ): ReadableStream<string>,
  destroy(): void,
}

export interface PromptApiLanguageModelStatic {
  availability(options?: PromptApiCreateCoreOptions): Promise<unknown>,
  create(options?: PromptApiCreateOptions): Promise<unknown>,
}
