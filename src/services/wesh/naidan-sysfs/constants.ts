import { NAIDAN_SYSFS_MOUNT_PATH } from '@/services/wesh/types';
import packageJson from '../../../../package.json';

export const NAIDAN_SYSFS_VERSION_TEXT = `${packageJson.version}\n`;

export const NAIDAN_SYSFS_ROOT_PATH = NAIDAN_SYSFS_MOUNT_PATH;

// High-level sysfs layout reference.
// Keep this aligned with the sysfs naidan design prompt and implementation plan.
//
// /sys/fs/naidan/
//   version
//   current-chat -> /sys/fs/naidan/chats/<chat-id>
//   current-chat-group -> /sys/fs/naidan/chat-groups/<chat-group-id>
//   binary-objects/
//     by-id/
//       <binary-object-id>/
//         metadata.json
//         metadata.md
//         data
//   chats/
//     <chat-id>/
//       metadata.md
//       metadata.json
//       content-md/
//         <index>-<role>-<message-id>.md
//       content-json/
//         <index>-<role>-<message-id>.json
//       branches/
//         current-md -> /sys/fs/naidan/chats/<chat-id>/branches/leaves-md/<leaf-id>
//         current-json -> /sys/fs/naidan/chats/<chat-id>/branches/leaves-json/<leaf-id>
//         tree-md/
//         tree-json/
//         leaves-md/
//           <leaf-id>/
//             metadata.md
//             content
//         leaves-json/
//           <leaf-id>/
//             metadata.json
//             content
//   chat-groups/
//     <chat-group-id>/
//       metadata.md
//       metadata.json
//       chats/
//         <index>-chat-<chat-id> -> /sys/fs/naidan/chats/<chat-id>
//   hierarchy/
//     <index>-chat-group-<chat-group-id> -> /sys/fs/naidan/chat-groups/<chat-group-id>
//     <index>-chat-<chat-id> -> /sys/fs/naidan/chats/<chat-id>

export const NAIDAN_SYSFS_VERSION_FILE_NAME = 'version';
export const NAIDAN_SYSFS_CURRENT_CHAT_SYMLINK_NAME = 'current-chat';
export const NAIDAN_SYSFS_CURRENT_CHAT_GROUP_SYMLINK_NAME = 'current-chat-group';
export const NAIDAN_SYSFS_CHATS_DIRECTORY_NAME = 'chats';
export const NAIDAN_SYSFS_CHAT_GROUPS_DIRECTORY_NAME = 'chat-groups';
export const NAIDAN_SYSFS_HIERARCHY_DIRECTORY_NAME = 'hierarchy';
export const NAIDAN_SYSFS_BINARY_OBJECTS_DIRECTORY_NAME = 'binary-objects';
export const NAIDAN_SYSFS_BINARY_OBJECTS_BY_ID_DIRECTORY_NAME = 'by-id';
export const NAIDAN_SYSFS_BINARY_OBJECT_DATA_FILE_NAME = 'data';
export const NAIDAN_SYSFS_METADATA_MARKDOWN_FILE_NAME = 'metadata.md';
export const NAIDAN_SYSFS_METADATA_JSON_FILE_NAME = 'metadata.json';
export const NAIDAN_SYSFS_CONTENT_MARKDOWN_DIRECTORY_NAME = 'content-md';
export const NAIDAN_SYSFS_CONTENT_JSON_DIRECTORY_NAME = 'content-json';
export const NAIDAN_SYSFS_BRANCHES_DIRECTORY_NAME = 'branches';
export const NAIDAN_SYSFS_BRANCH_CURRENT_MARKDOWN_SYMLINK_NAME = 'current-md';
export const NAIDAN_SYSFS_BRANCH_CURRENT_JSON_SYMLINK_NAME = 'current-json';
export const NAIDAN_SYSFS_BRANCH_TREE_MARKDOWN_DIRECTORY_NAME = 'tree-md';
export const NAIDAN_SYSFS_BRANCH_TREE_JSON_DIRECTORY_NAME = 'tree-json';
export const NAIDAN_SYSFS_BRANCH_LEAVES_MARKDOWN_DIRECTORY_NAME = 'leaves-md';
export const NAIDAN_SYSFS_BRANCH_LEAVES_JSON_DIRECTORY_NAME = 'leaves-json';
