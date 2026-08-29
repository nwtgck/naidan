export const ToolCallGroupItem__used_tools = ({ toolNames, remainingCount }: { toolNames: readonly string[]; remainingCount: number }): string => {
  const displayedNames = toolNames.join(', ');
  return remainingCount > 0 ? `Se usaron ${displayedNames} y ${remainingCount} más` : `Se usaron ${displayedNames}`;
};
