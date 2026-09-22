import type { MessageNode } from './types';

/** Project visible text for UI-oriented operations; never feed this back into stored parts. */
export function getMessageText({ message }: { message: MessageNode }): string {
  return message.parts.flatMap(part => {
    switch (part.type) {
    case 'text': return [part.text];
    case 'reasoning':
    case 'attachment':
    case 'tool_call':
    case 'tool_result': return [];
    default: { const _ex: never = part; throw new Error(`Unhandled message part: ${_ex}`); }
    }
  }).join('');
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
export const TEST_ONLY = {
};
