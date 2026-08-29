export const Sidebar__delete_group_warning = ({ groupName, chatCount }: { groupName: string; chatCount: number }): string => (
  `Möchtest du „${groupName}“ wirklich löschen? Dadurch ${chatCount === 1 ? 'wird der enthaltene Chat' : `werden alle ${chatCount} enthaltenen Chats`} dauerhaft gelöscht.`
);
