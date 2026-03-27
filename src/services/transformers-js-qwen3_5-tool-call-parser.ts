import type { ToolCall } from '@/models/types';

const TOOL_CALL_OPEN = '<tool_call>';
const TOOL_CALL_CLOSE = '</tool_call>';

function buildToolCall({ name, parameters }: {
  name: string;
  parameters: Record<string, unknown>;
}): ToolCall {
  return {
    id: `call_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    type: 'function',
    function: {
      name,
      arguments: JSON.stringify(parameters),
    },
  };
}

function tryParseQwen3_5ToolCall({ content }: {
  content: string;
}): ToolCall | null {
  const trimmed = content.trim();
  const jsonToolCall = tryParseJsonToolCall({ content: trimmed });
  if (jsonToolCall) return jsonToolCall;

  const functionMatch = trimmed.match(/^<function=([^\n>]+)>\s*([\s\S]*?)\s*<\/function>$/);
  if (!functionMatch) return null;

  const [, name, body] = functionMatch;
  if (!name || body === undefined) return null;
  const parameters: Record<string, unknown> = {};
  const parameterPattern = /<parameter=([^\n>]+)>\s*([\s\S]*?)\s*<\/parameter>/g;

  let match: RegExpExecArray | null;
  while ((match = parameterPattern.exec(body)) !== null) {
    const [, parameterName, rawValue] = match;
    if (!parameterName || rawValue === undefined) continue;
    const value = rawValue.trim();

    if (value === '') {
      parameters[parameterName] = '';
      continue;
    }

    if (value === 'true') {
      parameters[parameterName] = true;
      continue;
    }
    if (value === 'false') {
      parameters[parameterName] = false;
      continue;
    }
    if (value === 'null') {
      parameters[parameterName] = null;
      continue;
    }

    const numericValue = Number(value);
    if (!Number.isNaN(numericValue) && `${numericValue}` === value) {
      parameters[parameterName] = numericValue;
      continue;
    }

    parameters[parameterName] = value;
  }

  return buildToolCall({ name, parameters });
}

function tryParseJsonToolCall({ content }: { content: string }): ToolCall | null {
  try {
    const parsed = JSON.parse(content) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const parsedRecord = parsed as Record<string, unknown>;

    const name = typeof parsedRecord['name'] === 'string' ? parsedRecord['name'] : null;
    const argumentsValue = parsedRecord['arguments'];
    if (!name || !argumentsValue || typeof argumentsValue !== 'object' || Array.isArray(argumentsValue)) {
      return null;
    }

    return buildToolCall({
      name,
      parameters: argumentsValue as Record<string, unknown>,
    });
  } catch {
    return null;
  }
}

export class Qwen3_5ToolCallParser {
  private readonly onText: (text: string) => void;
  private pending = '';
  private parsedToolCalls: ToolCall[] = [];

  constructor({ onText }: { onText: (text: string) => void }) {
    this.onText = onText;
  }

  feed({ output }: { output: string }): void {
    this.pending += output;
    this.process();
  }

  flush(): void {
    if (this.pending.length > 0) {
      this.onText(this.pending);
    }
    this.pending = '';
  }

  drainToolCalls(): ToolCall[] {
    const result = this.parsedToolCalls;
    this.parsedToolCalls = [];
    return result;
  }

  private process(): void {
    while (true) {
      const startIdx = this.pending.indexOf(TOOL_CALL_OPEN);
      if (startIdx === -1) {
        if (this.pending.length > 0) {
          this.onText(this.pending);
          this.pending = '';
        }
        return;
      }

      if (startIdx > 0) {
        this.onText(this.pending.slice(0, startIdx));
        this.pending = this.pending.slice(startIdx);
      }

      const endIdx = this.pending.indexOf(TOOL_CALL_CLOSE, TOOL_CALL_OPEN.length);
      if (endIdx === -1) return;

      const inner = this.pending.slice(TOOL_CALL_OPEN.length, endIdx);
      this.pending = this.pending.slice(endIdx + TOOL_CALL_CLOSE.length);

      const parsed = tryParseQwen3_5ToolCall({ content: inner });
      if (parsed) {
        this.parsedToolCalls.push(parsed);
      } else {
        this.onText(`${TOOL_CALL_OPEN}${inner}${TOOL_CALL_CLOSE}`);
      }
    }
  }
}
