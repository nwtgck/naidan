import { z } from 'zod';

/**
 * Error codes for tool execution failures.
 */
export type ToolErrorCode = 'invalid_arguments' | 'execution_failed' | 'timeout' | 'other';

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
export type ToolExecutionResult =
  | { status: 'success'; content: string }
  | { status: 'error'; code: ToolErrorCode; message: string };

/**
 * Represents a tool call event during a chat generation.
 * This is kept in memory only and not persisted.
 */
export type ToolCallRecord = {
  id: string;
  toolName: string;
  args: unknown;
  timestamp: number;
} & (
  | { status: 'running' }
  | { status: 'success'; result: { content: string } }
  | { status: 'error'; error: { message: string } }
);

export interface Tool {
  name: string;
  description: string;
  parametersSchema: z.ZodTypeAny;

  /**
   * Execute the tool with the given arguments.
   * The arguments are guaranteed to be validated against the parametersSchema before execution.
   */
  execute(params: { args: unknown }): Promise<ToolExecutionResult>;
}
