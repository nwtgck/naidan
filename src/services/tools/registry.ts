import type { Tool } from './types';
import { CalculatorTool } from './calculator';

export const ALL_TOOLS: Tool[] = [
  new CalculatorTool(),
];

export function getToolByName({ name }: { name: string }): Tool | undefined {
  return ALL_TOOLS.find((t) => t.name === name);
}
