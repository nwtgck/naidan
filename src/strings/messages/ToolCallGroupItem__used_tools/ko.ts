export const ToolCallGroupItem__used_tools = ({ toolNames, remainingCount }: { toolNames: readonly string[]; remainingCount: number }): string => {
  const displayedNames = toolNames.join(', ');
  return remainingCount > 0 ? `${displayedNames} 및 ${remainingCount}개 도구를 더 사용함` : `${displayedNames} 사용함`;
};
