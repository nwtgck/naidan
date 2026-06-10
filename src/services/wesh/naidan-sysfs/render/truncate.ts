export const NAIDAN_SYSFS_TOOL_RESULT_TEXT_LIMIT = 4000

export function truncateNaidanSysfsTextForMarkdown({ text }: { text: string }): string {
  return text.length > NAIDAN_SYSFS_TOOL_RESULT_TEXT_LIMIT
    ? `${text.slice(0, NAIDAN_SYSFS_TOOL_RESULT_TEXT_LIMIT)} [truncated]`
    : text
}

export function truncateNaidanSysfsTextForJson({ text }: { text: string }): string {
  return text.length > NAIDAN_SYSFS_TOOL_RESULT_TEXT_LIMIT
    ? `${text.slice(0, NAIDAN_SYSFS_TOOL_RESULT_TEXT_LIMIT)}\n[truncated]`
    : text
}
