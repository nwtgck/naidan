import type { DocsLocale, DocsPageId } from '../../../navigation/routes';
import type { AppDestination } from '../../../navigation/app-entry';
import DocsLink from '../../../components/DocsLink.vue';
import AppEntryLink from '../../../components/AppEntryLink.vue';
import UiLabel from '../../../components/UiLabel.vue';

export const messages = {
  launch_app_and_model_guide: ({ locale, destination, page }: { locale: DocsLocale; destination: AppDestination; page: DocsPageId }) => <>{"Open "}<AppEntryLink locale={locale} destination={destination} display="path" />{" and choose or create the Chat where you want to use the file or folder. You can close first-time setup with × to attach it. Before asking AI to inspect a mounted file or folder, finish setup with a working endpoint and a model that supports tool calls."}{" For an in-browser model, see "}<DocsLink locale={locale} page={page}>{"browser model setup"}</DocsLink>{"."}</>,
  read_saved_files_with_shell: ({ locale, page }: { locale: DocsLocale; page: DocsPageId }) => <>{"If the Naidan file mount is on, Shell can also read saved files from other chats. See "}<DocsLink locale={locale} page={page}>{"how to read chats and saved files through Wesh sysfs"}</DocsLink>{"."}</>,
  on_your_device: "On your device",
  other_folders: "Other folders",
  folder_copy: "Folder (copy)",
  mounted_folder: "Mounted folder",
  read_only: "READ ONLY",
  copy_label: "copy",
  reading_allowed_writing_disabled: "Reading allowed · Writing disabled",
  title: "Choose which files and folders AI can read or edit",
  description: "Give AI access to a single file or selected folders in Naidan. Compare folder copies and links, choose read or write access, and check where changes are saved.",
  intro: () => ["Give the AI only the files needed for a task. Choose one file, a working copy of a folder, or a linked folder, then decide whether the AI can make changes."],
  folder_copy_caption: () => <><UiLabel text="Folder (copy)" /> creates a separate working copy. This example exposes that copy as read-only; the original folder stays on your device.</>,
  copy_folder_method_title: () => <><UiLabel text="Folder (copy)" />: try changes separately</>,
  copy_folder_method_body: "Naidan imports the selected folder into browser storage. Edits affect that copy, not the original directory. Download the results when you are ready to use them elsewhere. Later edits to the original and the copy are independent.",
  link_folder_method_title: () => <><UiLabel text="Folder (link)" />: work on the actual folder</>,
  link_folder_method_body: "A supporting browser lets you choose a real folder. Reads reflect its current contents. With both browser write permission and a writable mount, changes affect the original files. Use this when you deliberately want to work in place.",
  read_and_write_permissions_title: "Reading a file and changing it are separate permissions",
  read_and_write_permissions_body: "A read-only mount is useful for reference material and project inspection. Allow writing only for a mounted file or folder you intend to edit. Folder selection, browser permissions and the effective mount configuration together determine access to device folders.",
  choose_file_title: "The file or folder",
  choose_file_body: "Choose one file, a project folder or a smaller subfolder rather than a broad directory of unrelated files.",
  choose_scope_title: "The scope",
  choose_scope_body: "Global settings, Chat Group settings and Chat settings determine the mounts for a conversation. Check which files or folders this Chat actually exposes.",
  check_destination_title: "The destination",
  check_destination_body: "A linked folder changes original files; a copied folder changes browser-held data. Confirm the working location before asking for edits.",
  add_file_or_folder_title: "Add a file or working folder",
  add_file_or_folder_steps: () => ["Open the attachment menu beside the Chat input.", <>{"For one non-image file, choose "}<UiLabel text="Files" />{" and select it. Naidan copies it into browser storage, mounts the copy read-only, and enables "}<UiLabel text="Shell" />{" for this Chat; skip the folder choice in the next step. Images selected alone through "}<UiLabel text="Files" />{" are message attachments instead. To have AI read an attached image, configure a working endpoint and a model that accepts image input before sending the message."}</>, <>{"For a folder, choose "}<UiLabel text="Folder (copy)" />{" or "}<UiLabel text="Folder (link)" />{" and select the folder. The choices available depend on browser capabilities. If you selected a non-image file in step 2, continue with step 4."}</>, <>{"Check the mount path and read-only access above the Chat input. For a mounted file or folder, "}<UiLabel text="Shell" />{" is enabled for this Chat; a model that supports tool calls can use it to inspect the contents. When Shell reads from the mount, its command result becomes input to the selected model; with a server model, that result is sent to the configured endpoint. An image attached to a message does not follow these mount steps."}</>, "Ask for a small inspection first, such as reading a few lines or listing filenames, and review the result. If you then want an edit, select the lock beside the mounted item above the Chat input to allow writing; a linked folder also needs browser write permission."],
  browser_permissions_guide_title: "Understand local AI processing and browser permissions",
  browser_permissions_guide_description: "Trace how a permitted file reaches local AI and where browser access ends.",
  file_explorer_guide_title: "Browse and manage files",
  file_explorer_guide_description: "Open File Explorer to preview, upload, download, or organize files yourself.",
  file_settings_guide_title: "Manage files and folders in Settings",
  file_settings_guide_description: "Review saved files and the working folders available to a Chat.",
};
