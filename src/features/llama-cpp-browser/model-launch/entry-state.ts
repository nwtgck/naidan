import { shallowReadonly, shallowRef } from 'vue';
import type { DownloadDestination } from '@/01-models/download';
import type { ModelLaunchTarget } from '@/01-models/llama-cpp-browser-model-launch';
import type { ModelLaunchProblem } from './target';
import type { ModelLaunchDefaultSnapshot } from './defaults';

export type ModelLaunchStartRequest = {
  input: string,
  requestedVariant: string | undefined,
  multimodal: 'auto' | 'on' | 'off',
  destination: DownloadDestination,
  source: 'model-url' | 'home' | 'catalog' | 'hugging-face',
};
export type ModelLaunchFileChoice = { path: string, label: string, size: number };
export type ModelLaunchDestinationAuthorization = { destination: DownloadDestination, expectedRoot: FileSystemDirectoryHandle | undefined };
export type AuthorizeModelLaunchDestination = ({ destination }: { destination: DownloadDestination }) => Promise<ModelLaunchDestinationAuthorization>;
export type ModelLaunchCommandContext = { owner: symbol, isCurrent(): boolean, defaults: Promise<ModelLaunchDefaultSnapshot | undefined>, applyTarget?: ({ target }: { target: ModelLaunchTarget }) => void };
export type ModelLaunchEntryState =
  | { status: 'idle' }
  | { status: 'checking', operation: symbol, input: string, phase: 'metadata' | 'opening-chat' }
  | { status: 'needs-selection', operation: symbol, input: string, mainChoices: readonly ModelLaunchFileChoice[], companionChoices: readonly ModelLaunchFileChoice[], selectedMainPath: string | undefined, selectedCompanionPath: string | undefined, companionRequirement: 'required' | 'optional' | 'none' }
  | { status: 'failed', operation: symbol, input: string, problem: ModelLaunchProblem | 'failed' };

export type ModelLaunchCommand =
  | { kind: 'start', operation: symbol, request: ModelLaunchStartRequest, authorization: Promise<ModelLaunchDestinationAuthorization> | undefined, context: ModelLaunchCommandContext | undefined }
  | { kind: 'confirm', operation: symbol, mainFilePath: string, companionFilePath: string | undefined, multimodal?: 'on' | 'off', authorization: Promise<ModelLaunchDestinationAuthorization> | undefined }
  | { kind: 'retry', operation: symbol }
  | { kind: 'retire', operation: symbol };
const entryState = shallowRef<ModelLaunchEntryState>({ status: 'idle' });
const command = shallowRef<ModelLaunchCommand>();
let currentRequest: { operation: symbol, request: ModelLaunchStartRequest, context: ModelLaunchCommandContext | undefined } | undefined;
let captureEntryContext: (() => ModelLaunchCommandContext) | undefined;
export const modelLaunchEntryState = shallowReadonly(entryState);
export const modelLaunchCommand = shallowReadonly(command);
export const MODEL_LAUNCH_QUERY = 'llama-cpp-browser-model';

/** App setup owns this lightweight capture hook before the runtime chunk loads. */
export function registerModelLaunchEntryContext({ capture }: { capture: () => ModelLaunchCommandContext }): () => void {
  captureEntryContext = capture;
  return () => {
    if (captureEntryContext === capture) {
      captureEntryContext = undefined;
    }
  };
}

/** This bridge carries explicit UI actions without importing the coordinator. */
export function startModelLaunch({ request, authorizeDestination }: { request: ModelLaunchStartRequest, authorizeDestination?: AuthorizeModelLaunchDestination }): symbol {
  if (entryState.value.status === 'checking' && currentRequest?.context?.isCurrent() !== false) {
    return entryState.value.operation;
  }
  const operation = Symbol('model-launch');
  const captured = structuredClone(request);
  const context = captureEntryContext?.();
  currentRequest = { operation, request: captured, context };
  const authorization = authorizeDestination?.({ destination: captured.destination });
  // Permission rejection is displayed by the command owner after activation.
  void authorization?.catch(() => {});
  entryState.value = { status: 'checking', operation, input: captured.input, phase: 'metadata' };
  command.value = { kind: 'start', operation, request: captured, authorization, context };
  return operation;
}

export function confirmModelLaunchSelection({ operation, mainFilePath, companionFilePath, multimodal, authorizeDestination }: { operation: symbol, mainFilePath: string, companionFilePath: string | undefined, multimodal?: 'on' | 'off', authorizeDestination?: AuthorizeModelLaunchDestination }): void {
  if (entryState.value.status !== 'needs-selection' || entryState.value.operation !== operation) {
    return;
  }
  const destination = currentRequest?.operation === operation ? currentRequest.request.destination : undefined;
  const authorization = destination === undefined ? undefined : authorizeDestination?.({ destination });
  void authorization?.catch(() => {});
  command.value = { kind: 'confirm', operation, mainFilePath, companionFilePath, multimodal, authorization };
}

export function retireModelLaunch({ operation }: { operation: symbol }): void {
  if (currentRequest?.operation !== operation) {
    return;
  }
  if (entryState.value.status !== 'idle' && entryState.value.operation === operation) {
    entryState.value = { status: 'idle' };
  }
  command.value = { kind: 'retire', operation };
}

export function setModelLaunchEntryState({ state }: { state: ModelLaunchEntryState }): void {
  entryState.value = state;
}

export function retryModelLaunch(): void {
  const state = entryState.value;
  switch (state.status) {
  case 'failed': command.value = { kind: 'retry', operation: state.operation };
    break;
  case 'idle': case 'checking': case 'needs-selection': break;
  default: {
    const exhaustive: never = state;
    throw new Error(String(exhaustive));
  }
  }
}

export const TEST_ONLY = {
  reset: () => {
    entryState.value = { status: 'idle' };
    command.value = undefined;
    currentRequest = undefined;
    captureEntryContext = undefined;
  },
};
