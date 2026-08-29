export const Sidebar__delete_group_warning = ({ groupName, chatCount }: { groupName: string; chatCount: number }): string => (
  `确定要删除“${groupName}”吗？其中的 ${chatCount} 个聊天将被永久删除。`
);
