import type { BranchingCopy, ReplicaChromeCopy } from '../../site/messages';
import { defineDocsIslandSpec } from '../spec';

export type BranchingPayload = { copy: BranchingCopy; chrome: ReplicaChromeCopy };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasTextFields({ value, fields }: { value: unknown; fields: readonly string[] }): boolean {
  return isRecord(value) && fields.every(field => typeof value[field] === 'string');
}

function isTextTuple({ value, length }: { value: unknown; length: number }): boolean {
  return Array.isArray(value) && value.length === length && value.every(item => typeof item === 'string');
}

const copyTextFields = ['label', 'prompt', 'editedPrompt', 'editedReply', 'chatTitle', 'forkTitle', 'reset', 'note'] as const satisfies readonly (keyof BranchingCopy)[];
const controlTextFields = ['steps', 'replay', 'previousVersion', 'nextVersion', 'editor', 'originalChat', 'forkedChat'] as const satisfies readonly (keyof BranchingCopy['controls'])[];
const uiTextFields = ['you', 'assistant', 'edit', 'resend', 'regenerate', 'moreActions', 'fork', 'copy', 'copyRaw', 'copyLink', 'compareVersions', 'sendAndBranch', 'cancel', 'clear', 'tools', 'advancedEditor', 'moreTools', 'readAloud', 'inputPlaceholder', 'send', 'attach'] as const satisfies readonly (keyof BranchingCopy['ui'])[];
const chromeTextFields = ['newChat', 'search', 'chatGroup', 'otherChat', 'settings'] as const satisfies readonly (keyof ReplicaChromeCopy)[];

// Authored strings remain TypeScript-checked. This small serialization boundary
// checks the fields the island dereferences before it can touch the static DOM.
export function parseBranchingPayload({ serialized }: { serialized: string }): BranchingPayload {
  const value: unknown = JSON.parse(serialized);
  if (!isRecord(value) || !isRecord(value.copy) || !isRecord(value.chrome)) {
    throw new Error('Invalid branching demonstration props');
  }
  const { copy, chrome } = value;
  if (!hasTextFields({ value: copy, fields: copyTextFields })
    || !hasTextFields({ value: copy.controls, fields: controlTextFields })
    || !hasTextFields({ value: copy.ui, fields: uiTextFields })
    || !hasTextFields({ value: chrome, fields: chromeTextFields })
    || !isTextTuple({ value: copy.replies, length: 2 })
    || !isTextTuple({ value: copy.choices, length: 2 })
    || !Array.isArray(copy.methods) || copy.methods.length !== 4
    || !copy.methods.every(method => hasTextFields({ value: method, fields: ['title', 'body'] }))
    || !Array.isArray(copy.stages) || copy.stages.length !== 4
    || !copy.stages.every(stage => isTextTuple({ value: stage, length: 4 }))) {
    throw new Error('Invalid branching demonstration props');
  }
  return { copy: copy as BranchingCopy, chrome: chrome as ReplicaChromeCopy };
}

export const branchingSpec = defineDocsIslandSpec<BranchingPayload>({
  id: 'branching',
  parse: parseBranchingPayload,
  start: 'interactive',
});
