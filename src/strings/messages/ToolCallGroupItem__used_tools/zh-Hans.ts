export const ToolCallGroupItem__used_tools = ({ toolNames, remainingCount }: { toolNames: readonly string[]; remainingCount: number }): string => {
  const displayedNames = toolNames.join(', ');
  return remainingCount > 0 ? `已使用 ${displayedNames}，以及另外 ${remainingCount} 个` : `已使用 ${displayedNames}`;
};
