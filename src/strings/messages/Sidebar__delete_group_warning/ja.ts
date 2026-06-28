export const Sidebar__delete_group_warning = ({ groupName, chatCount }: { groupName: string; chatCount: number }): string => (
  `「${groupName}」を削除しますか？中にある${chatCount}件のチャットはすべて完全に削除されます。`
);
