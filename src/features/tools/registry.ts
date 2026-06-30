import type { Tool } from '@/01-models/tool';
import { CalculatorTool } from './calculator';
import { WikipediaGetPageTool, WikipediaSearchTool } from './wikipedia';

export const ALL_TOOLS: Tool[] = [
  new CalculatorTool(),
  new WikipediaSearchTool(),
  new WikipediaGetPageTool(),
];

export function getToolByName({ name }: { name: string }): Tool | undefined {
  return ALL_TOOLS.find((t) => t.name === name);
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
