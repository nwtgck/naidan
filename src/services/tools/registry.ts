import type { Tool } from './types';
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
