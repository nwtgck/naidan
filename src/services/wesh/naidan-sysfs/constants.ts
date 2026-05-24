import { NAIDAN_SYSFS_MOUNT_PATH } from '@/services/wesh/types'
import packageJson from '../../../../package.json'

export const NAIDAN_SYSFS_VERSION_TEXT = `${packageJson.version}\n`

export const NAIDAN_SYSFS_ROOT_PATH = NAIDAN_SYSFS_MOUNT_PATH
export const NAIDAN_SYSFS_VERSION_FILE_NAME = 'version'
export const NAIDAN_SYSFS_CURRENT_CHAT_SYMLINK_NAME = 'current-chat'
export const NAIDAN_SYSFS_CURRENT_CHAT_GROUP_SYMLINK_NAME = 'current-chat-group'
export const NAIDAN_SYSFS_CHATS_DIRECTORY_NAME = 'chats'
export const NAIDAN_SYSFS_CHAT_GROUPS_DIRECTORY_NAME = 'chat-groups'
export const NAIDAN_SYSFS_HIERARCHY_DIRECTORY_NAME = 'hierarchy'
export const NAIDAN_SYSFS_METADATA_MARKDOWN_FILE_NAME = 'metadata.md'
export const NAIDAN_SYSFS_METADATA_JSON_FILE_NAME = 'metadata.json'
export const NAIDAN_SYSFS_CONTENT_MARKDOWN_DIRECTORY_NAME = 'content-md'
export const NAIDAN_SYSFS_CONTENT_JSON_DIRECTORY_NAME = 'content-json'
export const NAIDAN_SYSFS_BRANCHES_DIRECTORY_NAME = 'branches'
export const NAIDAN_SYSFS_BRANCH_CURRENT_MARKDOWN_SYMLINK_NAME = 'current-md'
export const NAIDAN_SYSFS_BRANCH_CURRENT_JSON_SYMLINK_NAME = 'current-json'
export const NAIDAN_SYSFS_BRANCH_TREE_MARKDOWN_DIRECTORY_NAME = 'tree-md'
export const NAIDAN_SYSFS_BRANCH_TREE_JSON_DIRECTORY_NAME = 'tree-json'
export const NAIDAN_SYSFS_BRANCH_LEAVES_MARKDOWN_DIRECTORY_NAME = 'leaves-md'
export const NAIDAN_SYSFS_BRANCH_LEAVES_JSON_DIRECTORY_NAME = 'leaves-json'
