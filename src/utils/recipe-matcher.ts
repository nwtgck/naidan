import type { RecipeModel } from '../models/recipe';

export interface MatchResult {
  modelId?: string;
  error?: string;
}

/**
 * Matches a list of recipe model patterns against available model IDs.
 * Returns the first matching model ID and any error encountered.
 */
export function matchRecipeModels(
  recipeModels: RecipeModel[],
  availableModelIds: readonly string[]
): MatchResult {
  for (const recipeModel of recipeModels) {
    switch (recipeModel.kind) {
    case 'regex':
      try {
        const regex = new RegExp(recipeModel.pattern, recipeModel.flags.join(''));
        const match = availableModelIds.find((id) => regex.test(id));
        if (match) {
          return { modelId: match };
        }
      } catch (e) {
        return { error: `Invalid regex: ${recipeModel.pattern}. ${e instanceof Error ? e.message : String(e)}` };
      }
      break;
    default: {
      const _ex: never = recipeModel.kind;
      return { error: `Unknown model kind: ${String(_ex)}` };
    }
    }
  }
  return {};
}

export interface MultiMatchResult {
  matches: string[];
  errors: string[];
}

/**
 * Checks all recipe patterns and returns all matching model IDs and errors.
 */
export function getAllMatchingModels(
  recipeModels: RecipeModel[],
  availableModelIds: readonly string[]
): MultiMatchResult {
  const matches = new Set<string>();
  const errors: string[] = [];

  for (const recipeModel of recipeModels) {
    switch (recipeModel.kind) {
    case 'regex':
      try {
        const regex = new RegExp(recipeModel.pattern, recipeModel.flags.join(''));
        availableModelIds.forEach((id) => {
          if (regex.test(id)) {
            matches.add(id);
          }
        });
      } catch (e) {
        errors.push(`Invalid regex: ${recipeModel.pattern}. ${e instanceof Error ? e.message : String(e)}`);
      }
      break;
    default: {
      const _ex: never = recipeModel.kind;
      errors.push(`Unknown model kind: ${String(_ex)}`);
    }
    }
  }

  return {
    matches: Array.from(matches),
    errors,
  };
}

/**
 * Generates sensible default regex patterns for a given model ID.
 * Returns an array of patterns from most specific to most general.
 */
export function generateDefaultModelPatterns(modelId: string): string[] {
  if (!modelId) return [];

  const patterns: string[] = [];

  // Helper to escape regex special chars
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // 1. Exact match (wrapped in anchors)
  patterns.push(`^${escape(modelId)}$`);

  // 2. Base name (strip author/repo path)
  let current = modelId;
  if (current.includes('/')) {
    current = current.split('/').pop() || current;
    patterns.push(`^${escape(current)}$`);
  }

  // 3. Strip common Ollama/version tags (e.g., :latest, :8b, :4b)
  if (current.includes(':')) {
    const withoutTag = current.replace(/:[a-zA-Z0-9._-]+$/i, '');
    if (withoutTag !== current) {
      patterns.push(`^${escape(withoutTag)}$`);
      patterns.push(`^${escape(withoutTag)}:.*`); // Match same model with any tag
      patterns.push(`^${escape(withoutTag)}.*`);   // More flexible prefix match
      current = withoutTag;
    }
  }

  // 4. Strip common file extensions and quantization suffixes
  const suffixes = [
    /\.(gguf|bin)$/i,
    /-GGUF$/i,
    /\.Q[0-9]_[A-Z0-9_]+$/i,
    /-(I)?Q[0-9]_[A-Z0-9_]+$/i,
    /-[0-9]+bpw-[a-z0-9-]+/i,
  ];

  let stripped = current;
  for (const regex of suffixes) {
    stripped = stripped.replace(regex, '');
  }

  if (stripped !== current) {
    patterns.push(`^${escape(stripped)}$`);
    patterns.push(`^${escape(stripped)}[.-].*`); // Match with separator like '-' or '.'
    patterns.push(`^${escape(stripped)}.*`);
  }

  // Final fallback: anchored prefix match
  const lastPattern = `^${escape(stripped)}.*`;
  if (!patterns.includes(lastPattern)) {
    patterns.push(lastPattern);
  }

  // Unique patterns only
  return Array.from(new Set(patterns));
}
