export const Sidebar__delete_group_warning = ({ groupName, chatCount }: { groupName: string; chatCount: number }): string => (
  `Are you sure you want to delete "${groupName}"? This will permanently delete all ${chatCount} chats inside it.`
);
