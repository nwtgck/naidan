export const Sidebar__delete_group_warning = ({ groupName, chatCount }: { groupName: string; chatCount: number }): string => (
  `¿Seguro que quieres eliminar "${groupName}"? Se ${chatCount === 1 ? 'eliminará permanentemente el único chat que contiene' : `eliminarán permanentemente los ${chatCount} chats que contiene`}.`
);
