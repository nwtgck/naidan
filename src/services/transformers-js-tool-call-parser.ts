import type { ToolCall } from '@/models/types';

const TOOL_CALL_OPEN = '<tool_call>';
const TOOL_CALL_CLOSE = '</tool_call>';

/**
 * Returns the length of the longest suffix of `text` that is a prefix of `pattern`.
 * Used to hold back text that might be the beginning of a tag boundary.
 */
function longestSuffixMatchingPrefix(text: string, pattern: string): number {
  const maxLen = Math.min(pattern.length - 1, text.length);
  for (let len = maxLen; len > 0; len--) {
    if (pattern.startsWith(text.slice(text.length - len))) return len;
  }
  return 0;
}

/**
 * Streaming parser for <tool_call>...</tool_call> blocks emitted by transformers.js models.
 *
 * Text outside the tags is streamed immediately via `onText`.
 * Content inside the tags is buffered and parsed as JSON once the closing tag arrives.
 * Call `flush()` after the last token to emit any remaining non-tool-call text.
 * Call `drainToolCalls()` to retrieve all tool calls collected during the session.
 */
export class ToolCallStreamParser {
  private readonly onText: (text: string) => void;

  private pending = '';
  private buffer = '';
  private inToolCall = false;
  private parsedToolCalls: ToolCall[] = [];

  constructor({ onText }: { onText: (text: string) => void }) {
    this.onText = onText;
  }

  feed({ output }: { output: string }): void {
    this.pending += output;
    this.process();
  }

  /**
   * Flushes any remaining buffered text after generation completes.
   * Must be called once after the final token.
   */
  flush(): void {
    if (!this.inToolCall && this.pending.length > 0) {
      this.onText(this.pending);
    } else if (this.inToolCall) {
      // Preserve malformed output instead of dropping assistant-visible text.
      this.onText(`${TOOL_CALL_OPEN}${this.buffer}${this.pending}`);
    }
    this.pending = '';
    this.buffer = '';
    this.inToolCall = false;
  }

  /**
   * Returns all tool calls parsed so far and clears the internal list.
   */
  drainToolCalls(): ToolCall[] {
    const result = this.parsedToolCalls;
    this.parsedToolCalls = [];
    return result;
  }

  private process(): void {
    while (this.pending.length > 0) {
      if (!this.inToolCall) {
        const startIdx = this.pending.indexOf(TOOL_CALL_OPEN);
        if (startIdx === -1) {
          // No opening tag — stream everything except a potential partial tag at the tail
          const holdBack = longestSuffixMatchingPrefix(this.pending, TOOL_CALL_OPEN);
          const safe = this.pending.length - holdBack;
          if (safe > 0) this.onText(this.pending.slice(0, safe));
          this.pending = this.pending.slice(safe);
          break;
        }
        // Stream text before the opening tag, then enter tool call mode
        if (startIdx > 0) this.onText(this.pending.slice(0, startIdx));
        this.pending = this.pending.slice(startIdx + TOOL_CALL_OPEN.length);
        this.inToolCall = true;
        this.buffer = '';
      } else {
        const endIdx = this.pending.indexOf(TOOL_CALL_CLOSE);
        if (endIdx === -1) {
          // No closing tag yet — hold back potential partial close tag at the tail
          const holdBack = longestSuffixMatchingPrefix(this.pending, TOOL_CALL_CLOSE);
          this.buffer += this.pending.slice(0, this.pending.length - holdBack);
          this.pending = this.pending.slice(this.pending.length - holdBack);
          break;
        }
        // Closing tag found — parse the accumulated tool call JSON
        this.buffer += this.pending.slice(0, endIdx);
        this.pending = this.pending.slice(endIdx + TOOL_CALL_CLOSE.length);
        this.inToolCall = false;
        this.parseBuffered();
        this.buffer = '';
        // Continue loop — there may be more text or additional tool calls after this one
      }
    }
  }

  private parseBuffered(): void {
    try {
      const parsed = JSON.parse(this.buffer.trim()) as { name: string; arguments: Record<string, unknown> };
      this.parsedToolCalls.push({
        id: `call_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
        type: 'function',
        function: {
          name: parsed.name,
          arguments: JSON.stringify(parsed.arguments),
        },
      });
    } catch (e) {
      console.warn('[ToolCallStreamParser] Failed to parse tool call JSON:', e);
      this.onText(`${TOOL_CALL_OPEN}${this.buffer}${TOOL_CALL_CLOSE}`);
    }
  }
}
