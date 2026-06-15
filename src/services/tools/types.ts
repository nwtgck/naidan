import { z } from 'zod';
import type { ToolApprovalContext } from '@/services/approval';
import type { BinaryObjectId, ToolCallId } from '@/models/ids';
import type { NaidanSysfsAccessScope } from '@/services/wesh/types';

/**
 * Error codes for tool execution failures.
 */
export type ToolExecutionErrorCode = 'invalid_arguments' | 'execution_failed' | 'timeout' | 'other';

/**
 * Naidan-internal tool config key.
 *
 * This is the stable identifier Naidan uses for persisted settings and runtime
 * configuration. It identifies the Naidan-side implementation/capability, not
 * the name exposed to the LLM.
 *
 * For example, Wesh is a Naidan implementation detail, so its persisted key is
 * `builtin.wesh`. The LLM should not see `wesh` because that name does not
 * explain what the tool does. The LLM-facing tool name is `shell_execute`,
 * which describes the capability in model terms.
 *
 * Do not send this key to the LLM and do not show it as a user-facing tool
 * name. Users should normally see this only in persisted JSON, exports, or
 * debug/developer views.
 */
export type BuiltinToolKey =
  | 'builtin.calculator'
  | 'builtin.wikipedia'
  | 'builtin.wesh';

/**
 * LLM-visible tool/function name.
 *
 * This is the name sent to model APIs and stored in historical tool calls.
 * It should describe the capability in terms the model can understand.
 *
 * Do not use this as Naidan's persisted tool config identifier. A single
 * Naidan tool key may map to one or more LLM-facing names, and the names do
 * not have to match the Naidan implementation identity.
 */
export type LlmToolName =
  | 'calculator'
  | 'wikipedia_search'
  | 'wikipedia_get_page'
  | 'shell_execute';

export type CalculatorToolConfig = {
  key: 'builtin.calculator';
};

export type WikipediaToolConfig = {
  key: 'builtin.wikipedia';
};

export type WeshToolConfig = {
  key: 'builtin.wesh';
  naidanSysfs: {
    /**
     * Scope of Naidan chat data Wesh can access through /sys/fs/naidan.
     *
     * This persisted config intentionally excludes low-level binary object
     * access because that access level is not currently user-selectable and
     * should remain an implementation default.
     */
    accessScope: NaidanSysfsAccessScope;
  };
};

export type ToolConfig =
  | CalculatorToolConfig
  | WikipediaToolConfig
  | WeshToolConfig;

/**
 * Result of a tool execution.
 */
export type TextOrBinaryObject =
  | { type: 'text'; text: string }
  | { type: 'binary_object'; id: BinaryObjectId };

export type ToolExecutionEvent =
  | { type: 'started' }
  | { type: 'output'; stream: 'stdout' | 'stderr'; text: string }
  | { type: 'exit'; exitCode: number };

/**
 * Result of a tool execution.
 *
 * - 'success': The tool executed its logic and produced a result for the LLM.
 * - 'error': The tool encountered a logical error (e.g., invalid input, calculation failure)
 *            that SHOULD be communicated back to the LLM so it can respond to the user.
 *
 * Exception Handling:
 * - Tools should THROW an Error only for unexpected system/infrastructure failures
 *   (e.g., missing dependencies, internal bugs).
 * - Logical failures that the LLM can recover from or explain should be returned as { status: 'error' }.
 */
export type ToolExecutionResult = { toolCallId: ToolCallId } & (
  | { status: 'executing' }
  | { status: 'success'; content: TextOrBinaryObject }
  | { status: 'error'; error: { code: ToolExecutionErrorCode; message: TextOrBinaryObject } }
);

/**
 * Represents a tool call event during a chat generation.
 * This is kept in memory only and not persisted.
 */
export type ToolCallRecord = {
  id: ToolCallId;
  toolName: string;
  args: unknown;
  timestamp: number;
} & (
  | { status: 'executing' }
  | { status: 'success'; result: { content: TextOrBinaryObject } }
  | { status: 'error'; error: { message: TextOrBinaryObject } }
);

export interface Tool {
  /**
   * LLM-visible function/tool name.
   * This is not a stable persisted Naidan tool config key.
   */
  name: string;
  description: string;
  parametersSchema: z.ZodObject<z.ZodRawShape>;
  dispose?(): Promise<void>;

  /**
   * Execute the tool with the given arguments.
   * The arguments are guaranteed to be validated against the parametersSchema before execution.
   */
  execute({ args, signal, onEvent, approvalContext }: {
    args: unknown;
    signal?: AbortSignal;
    onEvent?: ({ event }: { event: ToolExecutionEvent }) => void | Promise<void>;
    approvalContext?: ToolApprovalContext;
  }): Promise<
    | { status: 'success'; content: string }
    | { status: 'error'; code: ToolExecutionErrorCode; message: string }
  >;
}
