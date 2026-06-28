export const ToolCallGroupItem__used_tools = ({ toolNames, remainingCount }: { toolNames: readonly string[]; remainingCount: number }): string => {
  const displayedNames = toolNames.join('、');
  return remainingCount > 0 ? `${displayedNames} ほか${remainingCount}件を使用` : `${displayedNames}を使用`;
};
