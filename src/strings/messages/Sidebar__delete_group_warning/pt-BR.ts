export const Sidebar__delete_group_warning = ({ groupName, chatCount }: { groupName: string; chatCount: number }): string => (
  `Tem certeza de que deseja excluir "${groupName}"? Isso excluirá permanentemente ${chatCount === 1 ? 'a única conversa contida nele' : `as ${chatCount} conversas contidas nele`}.`
);
