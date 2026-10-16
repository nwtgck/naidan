import type { DocsLocale } from '../../../navigation/routes';
import type { AppDestination } from '../../../navigation/app-entry';
import AppEntryLink from '../../../components/AppEntryLink.vue';
import UiLabel from '../../../components/UiLabel.vue';
import DocsLink from '../../../components/DocsLink.vue';

export const messages = {
  title: "Branch and edit AI conversations",
  description: "Keep the original conversation while editing an earlier message, trying another answer, or opening a separate Chat.",
  choose_a_conversation_path: "Keep the original conversation while choosing where and how its next path begins.",
  open_naidan_to_branch: ({ locale, destination }: { locale: DocsLocale; destination: AppDestination }) => <>Open <AppEntryLink locale={locale} destination={destination} display="path" /> to start. If first-time setup appears, choose a working endpoint and model and finish setup before sending or generating replies. Then open a Chat with messages, or start one and exchange a few messages before branching.</>,
  in_browser_model_setup_guide: ({ locale }: { locale: DocsLocale }) => <> For an in-browser model, see <DocsLink locale={locale} page="in-browser-models">browser model setup</DocsLink>.</>,
  create_and_switch_conversation_paths: "Create and switch conversation paths",
  edit_resend_or_regenerate: () => <>Below a message, use the pencil to edit, the send icon to resend, or the circular arrow to regenerate an answer. After editing, choose <UiLabel text="Send & Branch" />.</>,
  switch_message_versions: "Use the arrows around the version number to switch paths. They appear below your message for edit and resend, and below the answer for regenerate.",
  fork_into_a_separate_chat: () => <>For a separate Chat, choose <UiLabel text="More actions" /> → <UiLabel text="Fork Chat" /> below a message. It opens with the current path through that message; the header fork button includes the last message instead.</>,
  try_each_way_to_branch: "Try each way to branch the conversation",
  keep_versions_or_fork_chat: "Keep versions in one Chat, or continue in a separate Chat",
  how_versions_and_forks_differ: () => <>Edit, resend, and regenerate keep alternatives in one Chat. Editing an assistant answer uses <UiLabel text="Update & Branch" />, which saves a version without generating. <UiLabel text="Fork Chat" /> opens a separate Chat in the same Chat Group, such as “Fork of Browser models”.</>,
  rewrite_a_conversation_path: "Rewrite a conversation path",
  edit_and_reorder_a_path: "Edit and reorder the selected path, then apply it as a new branch while preserving the original.",
};
