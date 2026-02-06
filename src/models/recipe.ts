import { z } from 'zod';

/**
 * Recipe-specific LM parameters schema.
 * Copied from LmParametersSchemaDto to ensure recipes remain independent of DTO changes.
 */
export const RecipeLmParametersSchema = z.object({
  temperature: z.number().optional(),
  topP: z.number().optional(),
  maxCompletionTokens: z.number().optional(),
  presencePenalty: z.number().optional(),
  frequencyPenalty: z.number().optional(),
  stop: z.array(z.string()).optional(),
});

/**
 * Recipe-specific system prompt schema.
 * Copied from SystemPromptSchemaDto to ensure recipes remain independent of DTO changes.
 */
export const RecipeSystemPromptSchema = z.discriminatedUnion('behavior', [
  z.object({
    behavior: z.literal('override'),
    content: z.string().nullable(),
  }),
  z.object({
    behavior: z.literal('append'),
    content: z.string(),
  }),
]);

/**
 * Regex flags (JavaScript RegExp compatible).
 */
const RegexFlagSchema = z.enum(['i']);

/**
 * Model matching criteria.
 */
export const RecipeModelSchema = z.object({
  type: z.literal('regex'),
  pattern: z.string(),
  flags: z.array(RegexFlagSchema),
});

/**
 * Chat group recipe definition.
 */
export const ChatGroupRecipeSchema = z.object({
  type: z.literal('chat_group_recipe'),
  
  name: z.string(),
  description: z.string().optional(),
  
  // Settings (subset of ChatGroup settings)
  // Endpoint info is environment-dependent and thus excluded.
  systemPrompt: RecipeSystemPromptSchema.optional(),
  lmParameters: RecipeLmParametersSchema.optional(),
  
  // Model selection logic (required)
  // Empty array means "no preference (use default model)".
  models: z.array(RecipeModelSchema),
});

/**
 * Recipe schema (Union).
 * Allows for future expansion with different recipe types.
 */
export const RecipeSchema = z.union([
  ChatGroupRecipeSchema,
]);

export type Recipe = z.infer<typeof RecipeSchema>;
export type ChatGroupRecipe = z.infer<typeof ChatGroupRecipeSchema>;
export type RecipeModel = z.infer<typeof RecipeModelSchema>;
export type RecipeLmParameters = z.infer<typeof RecipeLmParametersSchema>;
export type RecipeSystemPrompt = z.infer<typeof RecipeSystemPromptSchema>;
