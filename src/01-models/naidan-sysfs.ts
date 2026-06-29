/**
 * Scope of Naidan chat data that Wesh can access through /sys/fs/naidan.
 *
 * This is a persisted/user-facing access policy, not the low-level sysfs mount
 * implementation detail. Low-level binary object access is intentionally not
 * persisted in tool config because it is not currently user-selectable and
 * should remain an implementation default.
 *
 * `main_chats` intentionally avoids `all_chats`. "All" is too broad for
 * persisted semantics because future Naidan versions may add broader boundaries
 * or side collections such as trash, archives, profiles, workspaces, separate
 * chat spaces, or other chat-like records.
 *
 * `main_chats` means the main chat collection in the current Naidan space. It
 * does not promise to include every chat-like record that may exist in storage,
 * and it does not promise to cross future higher-level boundaries.
 */
export type NaidanSysfsVisibility =
  | 'current_chat_only'
  | 'current_chat_with_chat_group'
  | 'main_chats';

export type NaidanSysfsAccessScope =
  | NaidanSysfsVisibility
  | 'none';
