import type { AssistantMessageNode, ToolCall } from './types';
import type { ChatGenerationResult } from './lm';
import type { ToolCallId } from './ids';
import { exactObject } from '@/utils/exact-object';

/** Mutable content for exactly one new assistant, independent of transport or UI. */
export function createAssistantGeneration({ node }: { node: AssistantMessageNode }) {
  if (node.parts.length !== 0 || node.interruption !== undefined) {
    throw new Error('Generation requires a new assistant without existing content or interruption.');
  }
  type Part = AssistantMessageNode['parts'][number];
  const parts = new Map<string, Part>();
  const positions = new Map<Part, number>();
  const indices = new Set<number>();
  const calls = new Set<ToolCallId>();
  const closed = new Set<Part>();
  let phase: 'generating' | 'finished' = 'generating';

  function requireGenerating() {
    switch (phase) {
    case 'generating': return;
    case 'finished': throw new Error('The generation is already finished.');
    default: {
      const _ex: never = phase;
      throw new Error(`Unhandled generation phase: ${_ex}`);
    }
    }
  }

  function reservePosition({ partId, index }: { partId: string, index: number }): number {
    requireGenerating();
    if (parts.has(partId)) throw new Error('Duplicate generated part ID.');
    if (!Number.isSafeInteger(index) || index < 0 || indices.has(index)) {
      throw new Error('Invalid or duplicate generated part position.');
    }
    const insertion = node.parts.findIndex(part => {
      const position = positions.get(part);
      if (position === undefined) throw new Error('Generated content was changed outside its owner.');
      return position > index;
    });
    indices.add(index);
    return insertion === -1 ? node.parts.length : insertion;
  }

  function findTextPart({ partId }: { partId: string }) {
    requireGenerating();
    const part = parts.get(partId);
    if (!part) throw new Error('Unknown generated part.');
    if (!node.parts.includes(part)) throw new Error('Generated content was removed outside its owner.');
    switch (part.type) {
    case 'text':
    case 'reasoning': return part;
    case 'tool_call': throw new Error('Tool calls do not accept text deltas.');
    default: {
      const _ex: never = part;
      throw new Error(`Unhandled generated part: ${_ex}`);
    }
    }
  }

  function insertPart({ partId, index, part }: { partId: string, index: number, part: Part }): void {
    const insertion = reservePosition({ partId, index });
    node.parts.splice(insertion, 0, part);
    // Retain the node's own view of the inserted object, including a caller's
    // reactive wrapper. Logical positions and stream IDs stay local to this run.
    const owned = node.parts[insertion];
    if (!owned) throw new Error('Generated content was removed outside its owner.');
    parts.set(partId, owned);
    positions.set(owned, index);
  }

  return {
    beginPart({ partId, index, type }: { partId: string, index: number, type: 'text' | 'reasoning' }): void {
      insertPart({ partId, index, part: { type, text: '', completeness: 'partial' } });
    },
    appendText({ partId, text }: { partId: string, text: string }): void {
      const part = findTextPart({ partId });
      if (closed.has(part)) throw new Error('A closed part cannot receive another delta.');
      part.text += text;
    },
    closePart({ partId, completeness }: { partId: string, completeness: 'complete' | 'partial' }): void {
      const part = findTextPart({ partId });
      if (closed.has(part)) throw new Error('The part was already closed.');
      switch (completeness) {
      case 'complete':
      case 'partial':
        part.completeness = completeness;
        closed.add(part);
        return;
      default: {
        const _ex: never = completeness;
        throw new Error(`Unhandled completeness: ${_ex}`);
      }
      }
    },
    addToolCall({ partId, index, toolCall }: { partId: string, index: number, toolCall: ToolCall }): void {
      if (calls.has(toolCall.id)) throw new Error('Duplicate generated tool call ID.');
      const { id, type, function: fn, ...unhandled } = toolCall;
      unhandled satisfies Record<PropertyKey, never>;
      const { name, arguments: argumentsText, ...unhandledFunction } = fn;
      unhandledFunction satisfies Record<PropertyKey, never>;
      const copy = exactObject<ToolCall>()({ id, type, function: { name, arguments: argumentsText } });
      insertPart({ partId, index, part: { type: 'tool_call', toolCall: copy } });
      calls.add(id);
    },
    finish({ result }: { result: ChatGenerationResult }): void {
      requireGenerating();
      switch (result.type) {
      case 'finished': {
        for (const part of node.parts) {
          switch (part.type) {
          case 'text':
          case 'reasoning':
            if (!closed.has(part) || part.completeness !== 'complete') {
              throw new Error('A successful generation cannot leave a partial part.');
            }
            break;
          case 'tool_call': break;
          default: {
            const _ex: never = part;
            throw new Error(`Unhandled generated part: ${_ex}`);
          }
          }
        }
        switch (result.next) {
        case 'user':
          if (calls.size !== 0) throw new Error('Tool calls require results before the next user turn.');
          break;
        case 'tool_results':
          if (calls.size === 0) throw new Error('Tool results were requested without a completed call.');
          break;
        default: {
          const _ex: never = result.next;
          throw new Error(`Unhandled next generation step: ${_ex}`);
        }
        }
        break;
      }
      case 'interrupted':
      case 'error': break;
      default: {
        const _ex: never = result;
        throw new Error(`Unhandled generation result: ${_ex}`);
      }
      }
      phase = 'finished';
    },
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
export const TEST_ONLY = {
};
