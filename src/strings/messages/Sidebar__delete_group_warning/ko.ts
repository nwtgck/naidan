export const Sidebar__delete_group_warning = ({ groupName, chatCount }: { groupName: string; chatCount: number }): string => (
  `"${groupName}" 그룹을 삭제하시겠습니까? 그룹 안의 채팅 ${chatCount}개가 모두 영구적으로 삭제됩니다.`
);
