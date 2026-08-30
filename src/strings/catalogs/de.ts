// SHARED__ keys intentionally couple every call site to one product-wide copy decision.
// Do not use this scope for deduplication or unclear ownership; follow messages/AGENTS.md.
import { SHARED__all_chats } from '@/strings/messages/SHARED__all_chats/de';
import { SHARED__assistant } from '@/strings/messages/SHARED__assistant/de';
import { SHARED__browser_provided } from '@/strings/messages/SHARED__browser_provided/de';
import { SHARED__cancel } from '@/strings/messages/SHARED__cancel/de';
import { SHARED__choose_which_chats_are_visible_to_the_shell } from '@/strings/messages/SHARED__choose_which_chats_are_visible_to_the_shell/de';
import { SHARED__configure_browser_based_shell_access } from '@/strings/messages/SHARED__configure_browser_based_shell_access/de';
import { SHARED__confirm } from '@/strings/messages/SHARED__confirm/de';
import { SHARED__connection_failed_check_url_or_provider } from '@/strings/messages/SHARED__connection_failed_check_url_or_provider/de';
import { SHARED__current_chat } from '@/strings/messages/SHARED__current_chat/de';
import { SHARED__current_chat_plus_chat_group } from '@/strings/messages/SHARED__current_chat_plus_chat_group/de';
import { SHARED__expose_chat_discovery_paths } from '@/strings/messages/SHARED__expose_chat_discovery_paths/de';
import { SHARED__generated_image } from '@/strings/messages/SHARED__generated_image/de';
import { SHARED__local_and_memory_storage_expose_wesh_as_read_only_without_tmp } from '@/strings/messages/SHARED__local_and_memory_storage_expose_wesh_as_read_only_without_tmp/de';
import { SHARED__mount } from '@/strings/messages/SHARED__mount/de';
import { SHARED__new_chat } from '@/strings/messages/SHARED__new_chat/de';
import { SHARED__no_models_found_at_this_endpoint } from '@/strings/messages/SHARED__no_models_found_at_this_endpoint/de';
import { SHARED__unsupported_experimental_endpoint } from '@/strings/messages/SHARED__unsupported_experimental_endpoint/de';
import { SHARED__uses_a_language_model_provided_and_managed_by_the_browser } from '@/strings/messages/SHARED__uses_a_language_model_provided_and_managed_by_the_browser/de';
import { SHARED__visibility } from '@/strings/messages/SHARED__visibility/de';
import { SHARED__writable_tmp_is_available_with_opfs_storage } from '@/strings/messages/SHARED__writable_tmp_is_available_with_opfs_storage/de';

import { AboutTab__about_naidan } from '@/strings/messages/AboutTab__about_naidan/de';
import { AboutTab__built_with_open_source_software } from '@/strings/messages/AboutTab__built_with_open_source_software/de';
import { AboutTab__github_repository } from '@/strings/messages/AboutTab__github_repository/de';
import { AboutTab__loading_licenses } from '@/strings/messages/AboutTab__loading_licenses/de';
import { AboutTab__open_source_licenses } from '@/strings/messages/AboutTab__open_source_licenses/de';
import { AboutTab__privacy_focused_local_lm_interface } from '@/strings/messages/AboutTab__privacy_focused_local_lm_interface/de';
import { AboutTab__runs_locally_via_file_protocol } from '@/strings/messages/AboutTab__runs_locally_via_file_protocol/de';
import { AboutTab__standalone_app } from '@/strings/messages/AboutTab__standalone_app/de';
import { AboutTab__unknown_package } from '@/strings/messages/AboutTab__unknown_package/de';
import { AboutTab__version } from '@/strings/messages/AboutTab__version/de';
import { AboutTab__view_license_text } from '@/strings/messages/AboutTab__view_license_text/de';
import { AboutTab__view_source_code_and_contribute } from '@/strings/messages/AboutTab__view_source_code_and_contribute/de';
import { AssistantProcessSequence__and_more } from '@/strings/messages/AssistantProcessSequence__and_more/de';
import { AssistantProcessSequence__less } from '@/strings/messages/AssistantProcessSequence__less/de';
import { AssistantProcessSequence__process_details } from '@/strings/messages/AssistantProcessSequence__process_details/de';
import { AssistantProcessSequence__show } from '@/strings/messages/AssistantProcessSequence__show/de';
import { AssistantProcessSequence__thinking_steps } from '@/strings/messages/AssistantProcessSequence__thinking_steps/de';
import { AssistantProcessSequence__tool_executions } from '@/strings/messages/AssistantProcessSequence__tool_executions/de';
import { AssistantProcessSequence__used_tools } from '@/strings/messages/AssistantProcessSequence__used_tools/de';
import { AssistantWaitingIndicator__waiting_for_response } from '@/strings/messages/AssistantWaitingIndicator__waiting_for_response/de';
import { ChatAttachMenu__a_private_copy_is_saved_in_your_browser } from '@/strings/messages/ChatAttachMenu__a_private_copy_is_saved_in_your_browser/de';
import { ChatAttachMenu__attach_files_or_folder } from '@/strings/messages/ChatAttachMenu__attach_files_or_folder/de';
import { ChatAttachMenu__chrome_edge_brave_opera_over_https_links_your_folder_directly_without_copying } from '@/strings/messages/ChatAttachMenu__chrome_edge_brave_opera_over_https_links_your_folder_directly_without_copying/de';
import { ChatAttachMenu__files } from '@/strings/messages/ChatAttachMenu__files/de';
import { ChatAttachMenu__folder_copy } from '@/strings/messages/ChatAttachMenu__folder_copy/de';
import { ChatAttachMenu__folder_link } from '@/strings/messages/ChatAttachMenu__folder_link/de';
import { ChatAttachMenu__naidan_works_from_the_copy_your_original_files_on_disk_stay_safe_and_intact } from '@/strings/messages/ChatAttachMenu__naidan_works_from_the_copy_your_original_files_on_disk_stay_safe_and_intact/de';
import { ChatAttachMenu__requires_a_chromium_based_browser } from '@/strings/messages/ChatAttachMenu__requires_a_chromium_based_browser/de';
import { ChatAttachMenu__what_is_folder_copy } from '@/strings/messages/ChatAttachMenu__what_is_folder_copy/de';
import { ChatAttachMenu__what_is_folder_link } from '@/strings/messages/ChatAttachMenu__what_is_folder_link/de';
import { ChatAttachMenu__why_is_folder_link_unavailable } from '@/strings/messages/ChatAttachMenu__why_is_folder_link_unavailable/de';
import { ChatDebugInspector__active } from '@/strings/messages/ChatDebugInspector__active/de';
import { ChatDebugInspector__chat_inspector } from '@/strings/messages/ChatDebugInspector__chat_inspector/de';
import { ChatDebugInspector__collapse_tree } from '@/strings/messages/ChatDebugInspector__collapse_tree/de';
import { ChatDebugInspector__context_path } from '@/strings/messages/ChatDebugInspector__context_path/de';
import { ChatDebugInspector__data_explorer } from '@/strings/messages/ChatDebugInspector__data_explorer/de';
import { ChatDebugInspector__expand_tree } from '@/strings/messages/ChatDebugInspector__expand_tree/de';
import { ChatDebugInspector__failed_to_parse_image_metadata_during_preview_collection } from '@/strings/messages/ChatDebugInspector__failed_to_parse_image_metadata_during_preview_collection/de';
import { ChatDebugInspector__fake_lm } from '@/strings/messages/ChatDebugInspector__fake_lm/de';
import { ChatDebugInspector__fake_lm_is_only_available_in_hosted_builds } from '@/strings/messages/ChatDebugInspector__fake_lm_is_only_available_in_hosted_builds/de';
import { ChatDebugInspector__full_json } from '@/strings/messages/ChatDebugInspector__full_json/de';
import { ChatDebugInspector__on } from '@/strings/messages/ChatDebugInspector__on/de';
import { ChatDebugInspector__open_at_this_message } from '@/strings/messages/ChatDebugInspector__open_at_this_message/de';
import { ChatDebugInspector__select_a_node_to_inspect } from '@/strings/messages/ChatDebugInspector__select_a_node_to_inspect/de';
import { ChatDebugInspector__set_this_chat_to_ollama_and_enable_global_fake_lm_debug_mode } from '@/strings/messages/ChatDebugInspector__set_this_chat_to_ollama_and_enable_global_fake_lm_debug_mode/de';
import { ChatDebugInspector__toggle_content_collapse } from '@/strings/messages/ChatDebugInspector__toggle_content_collapse/de';
import { ChatDebugInspector__toggle_highlighting } from '@/strings/messages/ChatDebugInspector__toggle_highlighting/de';
import { ChatDebugInspector__tree } from '@/strings/messages/ChatDebugInspector__tree/de';
import { ChatDebugTreeNode__collapse_content } from '@/strings/messages/ChatDebugTreeNode__collapse_content/de';
import { ChatDebugTreeNode__error } from '@/strings/messages/ChatDebugTreeNode__error/de';
import { ChatDebugTreeNode__generated_image_reference } from '@/strings/messages/ChatDebugTreeNode__generated_image_reference/de';
import { ChatDebugTreeNode__show_content } from '@/strings/messages/ChatDebugTreeNode__show_content/de';
import { ChatDebugTreeNode__text_content_hidden } from '@/strings/messages/ChatDebugTreeNode__text_content_hidden/de';
import { ChatDebugTreeNode__thinking_process } from '@/strings/messages/ChatDebugTreeNode__thinking_process/de';
import { ChatGroupActions__delete_group } from '@/strings/messages/ChatGroupActions__delete_group/de';
import { ChatGroupActions__duplicate_group } from '@/strings/messages/ChatGroupActions__duplicate_group/de';
import { ChatGroupActions__more_actions } from '@/strings/messages/ChatGroupActions__more_actions/de';
import { ChatGroupActions__search_in_group } from '@/strings/messages/ChatGroupActions__search_in_group/de';
import { ChatGroupSearchPreview__chat_count } from '@/strings/messages/ChatGroupSearchPreview__chat_count/de';
import { ChatGroupSearchPreview__empty_group } from '@/strings/messages/ChatGroupSearchPreview__empty_group/de';
import { ChatGroupSearchPreview__group_preview } from '@/strings/messages/ChatGroupSearchPreview__group_preview/de';
import { ChatGroupSearchPreview__open_chat } from '@/strings/messages/ChatGroupSearchPreview__open_chat/de';
import { ChatGroupSearchPreview__select_a_chat_to_preview } from '@/strings/messages/ChatGroupSearchPreview__select_a_chat_to_preview/de';
import { ChatGroupSettingsPanel__active_overrides } from '@/strings/messages/ChatGroupSettingsPanel__active_overrides/de';
import { ChatGroupSettingsPanel__add_header } from '@/strings/messages/ChatGroupSettingsPanel__add_header/de';
import { ChatGroupSettingsPanel__added_after_global_instructions } from '@/strings/messages/ChatGroupSettingsPanel__added_after_global_instructions/de';
import { ChatGroupSettingsPanel__append } from '@/strings/messages/ChatGroupSettingsPanel__append/de';
import { ChatGroupSettingsPanel__appending } from '@/strings/messages/ChatGroupSettingsPanel__appending/de';
import { ChatGroupSettingsPanel__automatic_title } from '@/strings/messages/ChatGroupSettingsPanel__automatic_title/de';
import { ChatGroupSettingsPanel__clear } from '@/strings/messages/ChatGroupSettingsPanel__clear/de';
import { ChatGroupSettingsPanel__cleared } from '@/strings/messages/ChatGroupSettingsPanel__cleared/de';
import { ChatGroupSettingsPanel__completely_replaces_global_instructions } from '@/strings/messages/ChatGroupSettingsPanel__completely_replaces_global_instructions/de';
import { ChatGroupSettingsPanel__configure_how_chats_in_this_group_are_automatically_named } from '@/strings/messages/ChatGroupSettingsPanel__configure_how_chats_in_this_group_are_automatically_named/de';
import { ChatGroupSettingsPanel__create_recipe } from '@/strings/messages/ChatGroupSettingsPanel__create_recipe/de';
import { ChatGroupSettingsPanel__custom_http_headers } from '@/strings/messages/ChatGroupSettingsPanel__custom_http_headers/de';
import { ChatGroupSettingsPanel__disabled } from '@/strings/messages/ChatGroupSettingsPanel__disabled/de';
import { ChatGroupSettingsPanel__enabled } from '@/strings/messages/ChatGroupSettingsPanel__enabled/de';
import { ChatGroupSettingsPanel__endpoint_type } from '@/strings/messages/ChatGroupSettingsPanel__endpoint_type/de';
import { ChatGroupSettingsPanel__endpoint_url } from '@/strings/messages/ChatGroupSettingsPanel__endpoint_url/de';
import { ChatGroupSettingsPanel__failed_to_save_chat_group_settings } from '@/strings/messages/ChatGroupSettingsPanel__failed_to_save_chat_group_settings/de';
import { ChatGroupSettingsPanel__files } from '@/strings/messages/ChatGroupSettingsPanel__files/de';
import { ChatGroupSettingsPanel__folders } from '@/strings/messages/ChatGroupSettingsPanel__folders/de';
import { ChatGroupSettingsPanel__global_default } from '@/strings/messages/ChatGroupSettingsPanel__global_default/de';
import { ChatGroupSettingsPanel__global_endpoint_type } from '@/strings/messages/ChatGroupSettingsPanel__global_endpoint_type/de';
import { ChatGroupSettingsPanel__global_model } from '@/strings/messages/ChatGroupSettingsPanel__global_model/de';
import { ChatGroupSettingsPanel__global_prompt_cleared } from '@/strings/messages/ChatGroupSettingsPanel__global_prompt_cleared/de';
import { ChatGroupSettingsPanel__group_level } from '@/strings/messages/ChatGroupSettingsPanel__group_level/de';
import { ChatGroupSettingsPanel__group_overrides } from '@/strings/messages/ChatGroupSettingsPanel__group_overrides/de';
import { ChatGroupSettingsPanel__group_settings_take_precedence_over_global_settings_but_can_be_overridden_by_individual_chats } from '@/strings/messages/ChatGroupSettingsPanel__group_settings_take_precedence_over_global_settings_but_can_be_overridden_by_individual_chats/de';
import { ChatGroupSettingsPanel__group_settings_title } from '@/strings/messages/ChatGroupSettingsPanel__group_settings_title/de';
import { ChatGroupSettingsPanel__group_system_prompt } from '@/strings/messages/ChatGroupSettingsPanel__group_system_prompt/de';
import { ChatGroupSettingsPanel__global } from '@/strings/messages/ChatGroupSettingsPanel__global/de';
import { ChatGroupSettingsPanel__no_prompt } from '@/strings/messages/ChatGroupSettingsPanel__no_prompt/de';
import { ChatGroupSettingsPanel__system_prompt_global_set } from '@/strings/messages/ChatGroupSettingsPanel__system_prompt_global_set/de';
import { ChatGroupSettingsPanel__system_prompt_global_not_set } from '@/strings/messages/ChatGroupSettingsPanel__system_prompt_global_not_set/de';
import { ChatGroupSettingsPanel__system_prompt_no_prompt } from '@/strings/messages/ChatGroupSettingsPanel__system_prompt_no_prompt/de';
import { ChatGroupSettingsPanel__instructions_for_this_chat_group } from '@/strings/messages/ChatGroupSettingsPanel__instructions_for_this_chat_group/de';
import { ChatGroupSettingsPanel__instructions_to_append } from '@/strings/messages/ChatGroupSettingsPanel__instructions_to_append/de';
import { ChatGroupSettingsPanel__start_typing_to_override } from '@/strings/messages/ChatGroupSettingsPanel__start_typing_to_override/de';
import { ChatGroupSettingsPanel__enter_instructions_for_this_chat_group } from '@/strings/messages/ChatGroupSettingsPanel__enter_instructions_for_this_chat_group/de';
import { ChatGroupSettingsPanel__start_typing_to_replace } from '@/strings/messages/ChatGroupSettingsPanel__start_typing_to_replace/de';
import { ChatGroupSettingsPanel__replace } from '@/strings/messages/ChatGroupSettingsPanel__replace/de';
import { ChatGroupSettingsPanel__enter_instructions_that_replace_the_parent_setting } from '@/strings/messages/ChatGroupSettingsPanel__enter_instructions_that_replace_the_parent_setting/de';
import { ChatGroupSettingsPanel__enter_instructions_to_append } from '@/strings/messages/ChatGroupSettingsPanel__enter_instructions_to_append/de';
import { ChatGroupSettingsPanel__inherit } from '@/strings/messages/ChatGroupSettingsPanel__inherit/de';
import { ChatGroupSettingsPanel__inherit_global_settings_or_override_individual_tools_for_this_chat_group } from '@/strings/messages/ChatGroupSettingsPanel__inherit_global_settings_or_override_individual_tools_for_this_chat_group/de';
import { ChatGroupSettingsPanel__inherited } from '@/strings/messages/ChatGroupSettingsPanel__inherited/de';
import { ChatGroupSettingsPanel__inherited_instructions } from '@/strings/messages/ChatGroupSettingsPanel__inherited_instructions/de';
import { ChatGroupSettingsPanel__load_from_saved_profiles } from '@/strings/messages/ChatGroupSettingsPanel__load_from_saved_profiles/de';
import { ChatGroupSettingsPanel__local_overrides } from '@/strings/messages/ChatGroupSettingsPanel__local_overrides/de';
import { ChatGroupSettingsPanel__model_id_override } from '@/strings/messages/ChatGroupSettingsPanel__model_id_override/de';
import { ChatGroupSettingsPanel__name } from '@/strings/messages/ChatGroupSettingsPanel__name/de';
import { ChatGroupSettingsPanel__no_custom_headers } from '@/strings/messages/ChatGroupSettingsPanel__no_custom_headers/de';
import { ChatGroupSettingsPanel__no_global_instructions_defined } from '@/strings/messages/ChatGroupSettingsPanel__no_global_instructions_defined/de';
import { ChatGroupSettingsPanel__none } from '@/strings/messages/ChatGroupSettingsPanel__none/de';
import { ChatGroupSettingsPanel__ollama } from '@/strings/messages/ChatGroupSettingsPanel__ollama/de';
import { ChatGroupSettingsPanel__openai_compatible } from '@/strings/messages/ChatGroupSettingsPanel__openai_compatible/de';
import { ChatGroupSettingsPanel__override } from '@/strings/messages/ChatGroupSettingsPanel__override/de';
import { ChatGroupSettingsPanel__overriding } from '@/strings/messages/ChatGroupSettingsPanel__overriding/de';
import { ChatGroupSettingsPanel__parameters } from '@/strings/messages/ChatGroupSettingsPanel__parameters/de';
import { ChatGroupSettingsPanel__quick_endpoint_presets } from '@/strings/messages/ChatGroupSettingsPanel__quick_endpoint_presets/de';
import { ChatGroupSettingsPanel__quick_profile_switcher } from '@/strings/messages/ChatGroupSettingsPanel__quick_profile_switcher/de';
import { ChatGroupSettingsPanel__restore_defaults } from '@/strings/messages/ChatGroupSettingsPanel__restore_defaults/de';
import { ChatGroupSettingsPanel__search_group } from '@/strings/messages/ChatGroupSettingsPanel__search_group/de';
import { ChatGroupSettingsPanel__search_messages } from '@/strings/messages/ChatGroupSettingsPanel__search_messages/de';
import { ChatGroupSettingsPanel__set_group_name } from '@/strings/messages/ChatGroupSettingsPanel__set_group_name/de';
import { ChatGroupSettingsPanel__settings_resolution } from '@/strings/messages/ChatGroupSettingsPanel__settings_resolution/de';
import { ChatGroupSettingsPanel__share_settings } from '@/strings/messages/ChatGroupSettingsPanel__share_settings/de';
import { ChatGroupSettingsPanel__system_prompt } from '@/strings/messages/ChatGroupSettingsPanel__system_prompt/de';
import { ChatGroupSettingsPanel__these_settings_only_apply_to_this_group } from '@/strings/messages/ChatGroupSettingsPanel__these_settings_only_apply_to_this_group/de';
import { ChatGroupSettingsPanel__these_settings_will_apply_to_all_chats_within_this_group_unless_overridden_by_a_specific_chat } from '@/strings/messages/ChatGroupSettingsPanel__these_settings_will_apply_to_all_chats_within_this_group_unless_overridden_by_a_specific_chat/de';
import { ChatGroupSettingsPanel__this_group_will_not_use_any_system_instructions } from '@/strings/messages/ChatGroupSettingsPanel__this_group_will_not_use_any_system_instructions/de';
import { ChatGroupSettingsPanel__title_model_explanation } from '@/strings/messages/ChatGroupSettingsPanel__title_model_explanation/de';
import { ChatGroupSettingsPanel__use_global_setting } from '@/strings/messages/ChatGroupSettingsPanel__use_global_setting/de';
import { ChatGroupSettingsPanel__title_model_override } from '@/strings/messages/ChatGroupSettingsPanel__title_model_override/de';
import { ChatGroupSettingsPanel__same_as_group_chat_endpoint } from '@/strings/messages/ChatGroupSettingsPanel__same_as_group_chat_endpoint/de';
import { ChatGroupSettingsPanel__title_endpoint_type } from '@/strings/messages/ChatGroupSettingsPanel__title_endpoint_type/de';
import { ChatGroupSettingsPanel__tools } from '@/strings/messages/ChatGroupSettingsPanel__tools/de';
import { ChatGroupSettingsPanel__transformers_js } from '@/strings/messages/ChatGroupSettingsPanel__transformers_js/de';
import { ChatGroupSettingsPanel__transformers_js_experimental } from '@/strings/messages/ChatGroupSettingsPanel__transformers_js_experimental/de';
import { ChatGroupSettingsPanel__value } from '@/strings/messages/ChatGroupSettingsPanel__value/de';
import { ChatGroupSettingsPanel__title_reasoning } from '@/strings/messages/ChatGroupSettingsPanel__title_reasoning/de';
import { ChatInput__cancel } from '@/strings/messages/ChatInput__cancel/de';
import { ChatInput__copying_name } from '@/strings/messages/ChatInput__copying_name/de';
import { ChatInput__edit_image } from '@/strings/messages/ChatInput__edit_image/de';
import { ChatInput__failed_to_copy } from '@/strings/messages/ChatInput__failed_to_copy/de';
import { ChatInput__failed_to_link_folder } from '@/strings/messages/ChatInput__failed_to_link_folder/de';
import { ChatInput__hide_input } from '@/strings/messages/ChatInput__hide_input/de';
import { ChatInput__maximize_input } from '@/strings/messages/ChatInput__maximize_input/de';
import { ChatInput__minimize_input } from '@/strings/messages/ChatInput__minimize_input/de';
import { ChatInput__open_advanced_editor } from '@/strings/messages/ChatInput__open_advanced_editor/de';
import { ChatInput__remove } from '@/strings/messages/ChatInput__remove/de';
import { ChatInput__remove_folder } from '@/strings/messages/ChatInput__remove_folder/de';
import { ChatInput__send_message_with_shortcut } from '@/strings/messages/ChatInput__send_message_with_shortcut/de';
import { ChatInput__show_input } from '@/strings/messages/ChatInput__show_input/de';
import { ChatInput__stop_generating_with_shortcut } from '@/strings/messages/ChatInput__stop_generating_with_shortcut/de';
import { ChatInput__stop_using_folder } from '@/strings/messages/ChatInput__stop_using_folder/de';
import { ChatInput__type_a_message } from '@/strings/messages/ChatInput__type_a_message/de';
import { ChatInput__unlink } from '@/strings/messages/ChatInput__unlink/de';
import { ChatInput__unlink_folder } from '@/strings/messages/ChatInput__unlink_folder/de';
import { ChatMediaShelf__click_to_copy_prompt } from '@/strings/messages/ChatMediaShelf__click_to_copy_prompt/de';
import { ChatMediaShelf__close_shelf } from '@/strings/messages/ChatMediaShelf__close_shelf/de';
import { ChatMediaShelf__copied } from '@/strings/messages/ChatMediaShelf__copied/de';
import { ChatMediaShelf__currently_forward_1_n_first } from '@/strings/messages/ChatMediaShelf__currently_forward_1_n_first/de';
import { ChatMediaShelf__currently_reverse_n_n_first } from '@/strings/messages/ChatMediaShelf__currently_reverse_n_n_first/de';
import { ChatMediaShelf__failed_to_embed_metadata_in_image } from '@/strings/messages/ChatMediaShelf__failed_to_embed_metadata_in_image/de';
import { ChatMediaShelf__forward } from '@/strings/messages/ChatMediaShelf__forward/de';
import { ChatMediaShelf__generated_image } from '@/strings/messages/ChatMediaShelf__generated_image/de';
import { ChatMediaShelf__jump } from '@/strings/messages/ChatMediaShelf__jump/de';
import { ChatMediaShelf__jump_to_this_message_in_chat } from '@/strings/messages/ChatMediaShelf__jump_to_this_message_in_chat/de';
import { ChatMediaShelf__manual_attachment } from '@/strings/messages/ChatMediaShelf__manual_attachment/de';
import { ChatMediaShelf__media_shelf } from '@/strings/messages/ChatMediaShelf__media_shelf/de';
import { ChatMediaShelf__model } from '@/strings/messages/ChatMediaShelf__model/de';
import { ChatMediaShelf__no_images_in_this_chat_yet } from '@/strings/messages/ChatMediaShelf__no_images_in_this_chat_yet/de';
import { ChatMediaShelf__not_available } from '@/strings/messages/ChatMediaShelf__not_available/de';
import { ChatMediaShelf__parameters } from '@/strings/messages/ChatMediaShelf__parameters/de';
import { ChatMediaShelf__reverse } from '@/strings/messages/ChatMediaShelf__reverse/de';
import { ChatMediaShelf__seed } from '@/strings/messages/ChatMediaShelf__seed/de';
import { ChatMediaShelf__steps } from '@/strings/messages/ChatMediaShelf__steps/de';
import { ChatMediaShelf__view_details_and_copy_parameters } from '@/strings/messages/ChatMediaShelf__view_details_and_copy_parameters/de';
import { ChatPaneHeader__chat_settings_and_model_override } from '@/strings/messages/ChatPaneHeader__chat_settings_and_model_override/de';
import { ChatPaneHeader__conversation_outline } from '@/strings/messages/ChatPaneHeader__conversation_outline/de';
import { ChatPaneHeader__copy_shareable_chat_url } from '@/strings/messages/ChatPaneHeader__copy_shareable_chat_url/de';
import { ChatPaneHeader__custom_overrides_active } from '@/strings/messages/ChatPaneHeader__custom_overrides_active/de';
import { ChatPaneHeader__debug_mode } from '@/strings/messages/ChatPaneHeader__debug_mode/de';
import { ChatPaneHeader__delete_chat } from '@/strings/messages/ChatPaneHeader__delete_chat/de';
import { ChatPaneHeader__edit_chat_title } from '@/strings/messages/ChatPaneHeader__edit_chat_title/de';
import { ChatPaneHeader__export_as_markdown } from '@/strings/messages/ChatPaneHeader__export_as_markdown/de';
import { ChatPaneHeader__export_as_url } from '@/strings/messages/ChatPaneHeader__export_as_url/de';
import { ChatPaneHeader__export_markdown } from '@/strings/messages/ChatPaneHeader__export_markdown/de';
import { ChatPaneHeader__file_explorer } from '@/strings/messages/ChatPaneHeader__file_explorer/de';
import { ChatPaneHeader__fork_chat_from_last_message } from '@/strings/messages/ChatPaneHeader__fork_chat_from_last_message/de';
import { ChatPaneHeader__group_name } from '@/strings/messages/ChatPaneHeader__group_name/de';
import { ChatPaneHeader__jump_to_original_chat } from '@/strings/messages/ChatPaneHeader__jump_to_original_chat/de';
import { ChatPaneHeader__media_gallery } from '@/strings/messages/ChatPaneHeader__media_gallery/de';
import { ChatPaneHeader__more_actions } from '@/strings/messages/ChatPaneHeader__more_actions/de';
import { ChatPaneHeader__move_to_group } from '@/strings/messages/ChatPaneHeader__move_to_group/de';
import { ChatPaneHeader__open_print_dialog } from '@/strings/messages/ChatPaneHeader__open_print_dialog/de';
import { ChatPaneHeader__print } from '@/strings/messages/ChatPaneHeader__print/de';
import { ChatPaneHeader__search_in_chat } from '@/strings/messages/ChatPaneHeader__search_in_chat/de';
import { ChatPaneHeader__super_edit } from '@/strings/messages/ChatPaneHeader__super_edit/de';
import { ChatPaneHeader__super_edit_full_history } from '@/strings/messages/ChatPaneHeader__super_edit_full_history/de';
import { ChatPaneHeader__top_level } from '@/strings/messages/ChatPaneHeader__top_level/de';
import { ChatPaneHeader__wesh_terminal } from '@/strings/messages/ChatPaneHeader__wesh_terminal/de';
import { ChatPane__ai } from '@/strings/messages/ChatPane__ai/de';
import { ChatPane__arguments } from '@/strings/messages/ChatPane__arguments/de';
import { ChatPane__binary_error_detail_missing } from '@/strings/messages/ChatPane__binary_error_detail_missing/de';
import { ChatPane__binary_object_missing } from '@/strings/messages/ChatPane__binary_object_missing/de';
import { ChatPane__chat } from '@/strings/messages/ChatPane__chat/de';
import { ChatPane__drop_files_or_folders_to_attach } from '@/strings/messages/ChatPane__drop_files_or_folders_to_attach/de';
import { ChatPane__failed_to_generate_share_url } from '@/strings/messages/ChatPane__failed_to_generate_share_url/de';
import { ChatPane__fake_lm_enabled_for_this_chat_via } from '@/strings/messages/ChatPane__fake_lm_enabled_for_this_chat_via/de';
import { ChatPane__process_sequence } from '@/strings/messages/ChatPane__process_sequence/de';
import { ChatPane__result } from '@/strings/messages/ChatPane__result/de';
import { ChatPane__share_url_copied_to_clipboard } from '@/strings/messages/ChatPane__share_url_copied_to_clipboard/de';
import { ChatPane__system } from '@/strings/messages/ChatPane__system/de';
import { ChatPane__thought } from '@/strings/messages/ChatPane__thought/de';
import { ChatPane__tool } from '@/strings/messages/ChatPane__tool/de';
import { ChatPane__tool_executions } from '@/strings/messages/ChatPane__tool_executions/de';
import { ChatPane__tool_still_executing } from '@/strings/messages/ChatPane__tool_still_executing/de';
import { ChatPane__user } from '@/strings/messages/ChatPane__user/de';
import { ChatPrintContent__chat_history } from '@/strings/messages/ChatPrintContent__chat_history/de';
import { ChatPrintContent__chat_id } from '@/strings/messages/ChatPrintContent__chat_id/de';
import { ChatSettingsPanel__active_overrides } from '@/strings/messages/ChatSettingsPanel__active_overrides/de';
import { ChatSettingsPanel__add_header } from '@/strings/messages/ChatSettingsPanel__add_header/de';
import { ChatSettingsPanel__added_after_global_instructions } from '@/strings/messages/ChatSettingsPanel__added_after_global_instructions/de';
import { ChatSettingsPanel__append } from '@/strings/messages/ChatSettingsPanel__append/de';
import { ChatSettingsPanel__appending } from '@/strings/messages/ChatSettingsPanel__appending/de';
import { ChatSettingsPanel__auto_check } from '@/strings/messages/ChatSettingsPanel__auto_check/de';
import { ChatSettingsPanel__automatic_title } from '@/strings/messages/ChatSettingsPanel__automatic_title/de';
import { ChatSettingsPanel__chat_overrides } from '@/strings/messages/ChatSettingsPanel__chat_overrides/de';
import { ChatSettingsPanel__chat_settings_take_precedence_over_provider_profiles_which_take_precedence_over_group_settings_which_take_precedence_over_global_settings } from '@/strings/messages/ChatSettingsPanel__chat_settings_take_precedence_over_provider_profiles_which_take_precedence_over_group_settings_which_take_precedence_over_global_settings/de';
import { ChatSettingsPanel__chat_specific_overrides } from '@/strings/messages/ChatSettingsPanel__chat_specific_overrides/de';
import { ChatSettingsPanel__chat_system_prompt } from '@/strings/messages/ChatSettingsPanel__chat_system_prompt/de';
import { ChatSettingsPanel__clear } from '@/strings/messages/ChatSettingsPanel__clear/de';
import { ChatSettingsPanel__cleared } from '@/strings/messages/ChatSettingsPanel__cleared/de';
import { ChatSettingsPanel__completely_replaces_global_instructions } from '@/strings/messages/ChatSettingsPanel__completely_replaces_global_instructions/de';
import { ChatSettingsPanel__configure_how_this_chat_is_automatically_named } from '@/strings/messages/ChatSettingsPanel__configure_how_this_chat_is_automatically_named/de';
import { ChatSettingsPanel__connection_check_is_automatically_performed_only_for_localhost_urls } from '@/strings/messages/ChatSettingsPanel__connection_check_is_automatically_performed_only_for_localhost_urls/de';
import { ChatSettingsPanel__custom_http_headers } from '@/strings/messages/ChatSettingsPanel__custom_http_headers/de';
import { ChatSettingsPanel__disabled } from '@/strings/messages/ChatSettingsPanel__disabled/de';
import { ChatSettingsPanel__enabled } from '@/strings/messages/ChatSettingsPanel__enabled/de';
import { ChatSettingsPanel__endpoint_type } from '@/strings/messages/ChatSettingsPanel__endpoint_type/de';
import { ChatSettingsPanel__endpoint_url } from '@/strings/messages/ChatSettingsPanel__endpoint_url/de';
import { ChatSettingsPanel__failed_to_save_chat_settings } from '@/strings/messages/ChatSettingsPanel__failed_to_save_chat_settings/de';
import { ChatSettingsPanel__group_global_default } from '@/strings/messages/ChatSettingsPanel__group_global_default/de';
import { ChatSettingsPanel__chat_group } from '@/strings/messages/ChatSettingsPanel__chat_group/de';
import { ChatSettingsPanel__no_prompt } from '@/strings/messages/ChatSettingsPanel__no_prompt/de';
import { ChatSettingsPanel__system_prompt_chat_group_set } from '@/strings/messages/ChatSettingsPanel__system_prompt_chat_group_set/de';
import { ChatSettingsPanel__system_prompt_chat_group_not_set } from '@/strings/messages/ChatSettingsPanel__system_prompt_chat_group_not_set/de';
import { ChatSettingsPanel__system_prompt_no_prompt } from '@/strings/messages/ChatSettingsPanel__system_prompt_no_prompt/de';
import { ChatSettingsPanel__instructions_for_this_chat } from '@/strings/messages/ChatSettingsPanel__instructions_for_this_chat/de';
import { ChatSettingsPanel__instructions_to_append } from '@/strings/messages/ChatSettingsPanel__instructions_to_append/de';
import { ChatSettingsPanel__start_typing_to_override } from '@/strings/messages/ChatSettingsPanel__start_typing_to_override/de';
import { ChatSettingsPanel__enter_instructions_for_this_chat } from '@/strings/messages/ChatSettingsPanel__enter_instructions_for_this_chat/de';
import { ChatSettingsPanel__start_typing_to_replace } from '@/strings/messages/ChatSettingsPanel__start_typing_to_replace/de';
import { ChatSettingsPanel__replace } from '@/strings/messages/ChatSettingsPanel__replace/de';
import { ChatSettingsPanel__enter_instructions_that_replace_the_parent_setting } from '@/strings/messages/ChatSettingsPanel__enter_instructions_that_replace_the_parent_setting/de';
import { ChatSettingsPanel__enter_instructions_to_append } from '@/strings/messages/ChatSettingsPanel__enter_instructions_to_append/de';
import { ChatSettingsPanel__inherit } from '@/strings/messages/ChatSettingsPanel__inherit/de';
import { ChatSettingsPanel__inherited } from '@/strings/messages/ChatSettingsPanel__inherited/de';
import { ChatSettingsPanel__inherited_instructions } from '@/strings/messages/ChatSettingsPanel__inherited_instructions/de';
import { ChatSettingsPanel__load_from_saved_profiles } from '@/strings/messages/ChatSettingsPanel__load_from_saved_profiles/de';
import { ChatSettingsPanel__local_overrides } from '@/strings/messages/ChatSettingsPanel__local_overrides/de';
import { ChatSettingsPanel__model_override } from '@/strings/messages/ChatSettingsPanel__model_override/de';
import { ChatSettingsPanel__name } from '@/strings/messages/ChatSettingsPanel__name/de';
import { ChatSettingsPanel__no_custom_headers } from '@/strings/messages/ChatSettingsPanel__no_custom_headers/de';
import { ChatSettingsPanel__no_instructions_inherited } from '@/strings/messages/ChatSettingsPanel__no_instructions_inherited/de';
import { ChatSettingsPanel__ollama } from '@/strings/messages/ChatSettingsPanel__ollama/de';
import { ChatSettingsPanel__openai_compatible } from '@/strings/messages/ChatSettingsPanel__openai_compatible/de';
import { ChatSettingsPanel__override } from '@/strings/messages/ChatSettingsPanel__override/de';
import { ChatSettingsPanel__overriding } from '@/strings/messages/ChatSettingsPanel__overriding/de';
import { ChatSettingsPanel__parameters } from '@/strings/messages/ChatSettingsPanel__parameters/de';
import { ChatSettingsPanel__parent_prompt_cleared } from '@/strings/messages/ChatSettingsPanel__parent_prompt_cleared/de';
import { ChatSettingsPanel__quick_endpoint_presets } from '@/strings/messages/ChatSettingsPanel__quick_endpoint_presets/de';
import { ChatSettingsPanel__quick_profile_switcher } from '@/strings/messages/ChatSettingsPanel__quick_profile_switcher/de';
import { ChatSettingsPanel__restore_defaults } from '@/strings/messages/ChatSettingsPanel__restore_defaults/de';
import { ChatSettingsPanel__settings_resolution } from '@/strings/messages/ChatSettingsPanel__settings_resolution/de';
import { ChatSettingsPanel__system_prompt } from '@/strings/messages/ChatSettingsPanel__system_prompt/de';
import { ChatSettingsPanel__these_settings_only_apply_to_this_chat } from '@/strings/messages/ChatSettingsPanel__these_settings_only_apply_to_this_chat/de';
import { ChatSettingsPanel__this_chat_will_not_use_any_system_instructions } from '@/strings/messages/ChatSettingsPanel__this_chat_will_not_use_any_system_instructions/de';
import { ChatSettingsPanel__title_model_explanation } from '@/strings/messages/ChatSettingsPanel__title_model_explanation/de';
import { ChatSettingsPanel__use_chat_group_setting } from '@/strings/messages/ChatSettingsPanel__use_chat_group_setting/de';
import { ChatSettingsPanel__title_model_override } from '@/strings/messages/ChatSettingsPanel__title_model_override/de';
import { ChatSettingsPanel__same_as_chat_endpoint } from '@/strings/messages/ChatSettingsPanel__same_as_chat_endpoint/de';
import { ChatSettingsPanel__title_endpoint_type } from '@/strings/messages/ChatSettingsPanel__title_endpoint_type/de';
import { ChatSettingsPanel__transformers_js } from '@/strings/messages/ChatSettingsPanel__transformers_js/de';
import { ChatSettingsPanel__transformers_js_experimental } from '@/strings/messages/ChatSettingsPanel__transformers_js_experimental/de';
import { ChatSettingsPanel__value } from '@/strings/messages/ChatSettingsPanel__value/de';
import { ChatSettingsPanel__title_reasoning } from '@/strings/messages/ChatSettingsPanel__title_reasoning/de';
import { ChatTitleDialog__chat_override } from '@/strings/messages/ChatTitleDialog__chat_override/de';
import { ChatTitleDialog__chat_title } from '@/strings/messages/ChatTitleDialog__chat_title/de';
import { ChatTitleDialog__close } from '@/strings/messages/ChatTitleDialog__close/de';
import { ChatTitleDialog__edit_the_title_directly_or_generate_a_new_one_from_the_conversation } from '@/strings/messages/ChatTitleDialog__edit_the_title_directly_or_generate_a_new_one_from_the_conversation/de';
import { ChatTitleDialog__editing_source_because_that_is_the_active_source_for_this_chat } from '@/strings/messages/ChatTitleDialog__editing_source_because_that_is_the_active_source_for_this_chat/de';
import { ChatTitleDialog__generate } from '@/strings/messages/ChatTitleDialog__generate/de';
import { ChatTitleDialog__generated_in_this_dialog } from '@/strings/messages/ChatTitleDialog__generated_in_this_dialog/de';
import { ChatTitleDialog__generated_titles_will_appear_here } from '@/strings/messages/ChatTitleDialog__generated_titles_will_appear_here/de';
import { ChatTitleDialog__global_default } from '@/strings/messages/ChatTitleDialog__global_default/de';
import { ChatTitleDialog__group_override } from '@/strings/messages/ChatTitleDialog__group_override/de';
import { ChatTitleDialog__hide } from '@/strings/messages/ChatTitleDialog__hide/de';
import { ChatTitleDialog__options_and_history } from '@/strings/messages/ChatTitleDialog__options_and_history/de';
import { ChatTitleDialog__show } from '@/strings/messages/ChatTitleDialog__show/de';
import { ChatTitleDialog__stop } from '@/strings/messages/ChatTitleDialog__stop/de';
import { ChatTitleDialog__title } from '@/strings/messages/ChatTitleDialog__title/de';
import { ChatTitleDialog__title_model } from '@/strings/messages/ChatTitleDialog__title_model/de';
import { ChatTitleDialog__use } from '@/strings/messages/ChatTitleDialog__use/de';
import { ChatTitleDialog__use_chat_model } from '@/strings/messages/ChatTitleDialog__use_chat_model/de';
import { ChatToolsMenu__close_menu } from '@/strings/messages/ChatToolsMenu__close_menu/de';
import { ChatToolsMenu__options_tools } from '@/strings/messages/ChatToolsMenu__options_tools/de';
import { ChatToolsMenu__tools } from '@/strings/messages/ChatToolsMenu__tools/de';
import { ConnectionTab__add_header } from '@/strings/messages/ConnectionTab__add_header/de';
import { ConnectionTab__api_provider } from '@/strings/messages/ConnectionTab__api_provider/de';
import { ConnectionTab__applied_to_all_new_chats } from '@/strings/messages/ConnectionTab__applied_to_all_new_chats/de';
import { ConnectionTab__auto_title_generation } from '@/strings/messages/ConnectionTab__auto_title_generation/de';
import { ConnectionTab__check_connection } from '@/strings/messages/ConnectionTab__check_connection/de';
import { ConnectionTab__connected } from '@/strings/messages/ConnectionTab__connected/de';
import { ConnectionTab__connection_check_for_localhost_only } from '@/strings/messages/ConnectionTab__connection_check_for_localhost_only/de';
import { ConnectionTab__copy_setup_url } from '@/strings/messages/ConnectionTab__copy_setup_url/de';
import { ConnectionTab__copy_url_with_current_settings } from '@/strings/messages/ConnectionTab__copy_url_with_current_settings/de';
import { ConnectionTab__create } from '@/strings/messages/ConnectionTab__create/de';
import { ConnectionTab__create_new_profile } from '@/strings/messages/ConnectionTab__create_new_profile/de';
import { ConnectionTab__custom_http_headers } from '@/strings/messages/ConnectionTab__custom_http_headers/de';
import { ConnectionTab__default } from '@/strings/messages/ConnectionTab__default/de';
import { ConnectionTab__default_model } from '@/strings/messages/ConnectionTab__default_model/de';
import { ConnectionTab__endpoint_configuration } from '@/strings/messages/ConnectionTab__endpoint_configuration/de';
import { ConnectionTab__endpoint_url } from '@/strings/messages/ConnectionTab__endpoint_url/de';
import { ConnectionTab__failed_to_save_settings } from '@/strings/messages/ConnectionTab__failed_to_save_settings/de';
import { ConnectionTab__give_configuration_a_name } from '@/strings/messages/ConnectionTab__give_configuration_a_name/de';
import { ConnectionTab__global_context_and_parameters } from '@/strings/messages/ConnectionTab__global_context_and_parameters/de';
import { ConnectionTab__global_system_prompt } from '@/strings/messages/ConnectionTab__global_system_prompt/de';
import { ConnectionTab__header_name_example } from '@/strings/messages/ConnectionTab__header_name_example/de';
import { ConnectionTab__helpful_ai_assistant_placeholder } from '@/strings/messages/ConnectionTab__helpful_ai_assistant_placeholder/de';
import { ConnectionTab__load_saved_profile } from '@/strings/messages/ConnectionTab__load_saved_profile/de';
import { ConnectionTab__model_selection } from '@/strings/messages/ConnectionTab__model_selection/de';
import { ConnectionTab__no_custom_headers } from '@/strings/messages/ConnectionTab__no_custom_headers/de';
import { ConnectionTab__none } from '@/strings/messages/ConnectionTab__none/de';
import { ConnectionTab__ollama } from '@/strings/messages/ConnectionTab__ollama/de';
import { ConnectionTab__openai_compatible } from '@/strings/messages/ConnectionTab__openai_compatible/de';
import { ConnectionTab__profile_created } from '@/strings/messages/ConnectionTab__profile_created/de';
import { ConnectionTab__quick_profile_switcher } from '@/strings/messages/ConnectionTab__quick_profile_switcher/de';
import { ConnectionTab__save_as_new_profile } from '@/strings/messages/ConnectionTab__save_as_new_profile/de';
import { ConnectionTab__save_changes } from '@/strings/messages/ConnectionTab__save_changes/de';
import { ConnectionTab__save_failed } from '@/strings/messages/ConnectionTab__save_failed/de';
import { ConnectionTab__settings_saved } from '@/strings/messages/ConnectionTab__settings_saved/de';
import { ConnectionTab__setup_url_copied } from '@/strings/messages/ConnectionTab__setup_url_copied/de';
import { ConnectionTab__title_generation_model } from '@/strings/messages/ConnectionTab__title_generation_model/de';
import { ConnectionTab__transformers_js_experimental } from '@/strings/messages/ConnectionTab__transformers_js_experimental/de';
import { ConnectionTab__use_current_chat_endpoint } from '@/strings/messages/ConnectionTab__use_current_chat_endpoint/de';
import { ConnectionTab__title_endpoint } from '@/strings/messages/ConnectionTab__title_endpoint/de';
import { ConnectionTab__unavailable_in_standalone_due_to_worker_wasm_restrictions } from '@/strings/messages/ConnectionTab__unavailable_in_standalone_due_to_worker_wasm_restrictions/de';
import { ConnectionTab__understand } from '@/strings/messages/ConnectionTab__understand/de';
import { ConnectionTab__url_copied } from '@/strings/messages/ConnectionTab__url_copied/de';
import { ConnectionTab__use_current_chat_model } from '@/strings/messages/ConnectionTab__use_current_chat_model/de';
import { ConnectionTab__used_for_new_conversations } from '@/strings/messages/ConnectionTab__used_for_new_conversations/de';
import { ConnectionTab__value } from '@/strings/messages/ConnectionTab__value/de';
import { ConnectionTab__view_profiles } from '@/strings/messages/ConnectionTab__view_profiles/de';
import { ConnectionTab__title_reasoning } from '@/strings/messages/ConnectionTab__title_reasoning/de';
import { ConnectionTab__use_current_chat_reasoning } from '@/strings/messages/ConnectionTab__use_current_chat_reasoning/de';
import { ContextCompactProgressStrip__abort_compact } from '@/strings/messages/ContextCompactProgressStrip__abort_compact/de';
import { ContextCompactProgressStrip__hide_request } from '@/strings/messages/ContextCompactProgressStrip__hide_request/de';
import { ContextCompactProgressStrip__live_output } from '@/strings/messages/ContextCompactProgressStrip__live_output/de';
import { ContextCompactProgressStrip__show_request } from '@/strings/messages/ContextCompactProgressStrip__show_request/de';
import { ConversationOutlineOverlay__ai } from '@/strings/messages/ConversationOutlineOverlay__ai/de';
import { ConversationOutlineOverlay__close_conversation_outline } from '@/strings/messages/ConversationOutlineOverlay__close_conversation_outline/de';
import { ConversationOutlineOverlay__conversation_outline } from '@/strings/messages/ConversationOutlineOverlay__conversation_outline/de';
import { ConversationOutlineOverlay__empty_message } from '@/strings/messages/ConversationOutlineOverlay__empty_message/de';
import { ConversationOutlineOverlay__peek } from '@/strings/messages/ConversationOutlineOverlay__peek/de';
import { ConversationOutlineOverlay__system } from '@/strings/messages/ConversationOutlineOverlay__system/de';
import { ConversationOutlineOverlay__tool } from '@/strings/messages/ConversationOutlineOverlay__tool/de';
import { ConversationOutlineOverlay__you } from '@/strings/messages/ConversationOutlineOverlay__you/de';
import { CustomDialog__dialog } from '@/strings/messages/CustomDialog__dialog/de';
import { DebugIndexPage__debug } from '@/strings/messages/DebugIndexPage__debug/de';
import { DebugIndexPage__debug_tools } from '@/strings/messages/DebugIndexPage__debug_tools/de';
import { DebugIndexPage__file_protocol_standalone_verification } from '@/strings/messages/DebugIndexPage__file_protocol_standalone_verification/de';
import { DebugIndexPage__open_an_isolated_diagnostic_page_without_adding_debug_only_behavior_to_the_normal_application_flow } from '@/strings/messages/DebugIndexPage__open_an_isolated_diagnostic_page_without_adding_debug_only_behavior_to_the_normal_application_flow/de';
import { DebugIndexPage__verify_generated_scripts_routing_lazy_styles_systemjs_recovery_and_the_reusable_worker_factory } from '@/strings/messages/DebugIndexPage__verify_generated_scripts_routing_lazy_styles_systemjs_recovery_and_the_reusable_worker_factory/de';
import { DebugPanel__application_state_synchronized } from '@/strings/messages/DebugPanel__application_state_synchronized/de';
import { DebugPanel__clear_logs } from '@/strings/messages/DebugPanel__clear_logs/de';
import { DebugPanel__close_panel } from '@/strings/messages/DebugPanel__close_panel/de';
import { DebugPanel__development_tools } from '@/strings/messages/DebugPanel__development_tools/de';
import { DebugPanel__error_count } from '@/strings/messages/DebugPanel__error_count/de';
import { DebugPanel__explore_opfs } from '@/strings/messages/DebugPanel__explore_opfs/de';
import { DebugPanel__intentional_test_error_triggered_by_user } from '@/strings/messages/DebugPanel__intentional_test_error_triggered_by_user/de';
import { DebugPanel__no_events_recorded } from '@/strings/messages/DebugPanel__no_events_recorded/de';
import { DebugPanel__system_events } from '@/strings/messages/DebugPanel__system_events/de';
import { DebugPanel__this_is_used_to_verify_the_error_event_system_ui } from '@/strings/messages/DebugPanel__this_is_used_to_verify_the_error_event_system_ui/de';
import { DebugPanel__total_count } from '@/strings/messages/DebugPanel__total_count/de';
import { DebugPanel__trigger_test_error } from '@/strings/messages/DebugPanel__trigger_test_error/de';
import { DebugPanel__trigger_test_info } from '@/strings/messages/DebugPanel__trigger_test_info/de';
import { DeveloperOpenStateLinks__choose_data_to_omit } from '@/strings/messages/DeveloperOpenStateLinks__choose_data_to_omit/de';
import { DeveloperOpenStateLinks__copied_url_for_host } from '@/strings/messages/DeveloperOpenStateLinks__copied_url_for_host/de';
import { DeveloperOpenStateLinks__copy_url_for_host } from '@/strings/messages/DeveloperOpenStateLinks__copy_url_for_host/de';
import { DeveloperOpenStateLinks__curated } from '@/strings/messages/DeveloperOpenStateLinks__curated/de';
import { DeveloperOpenStateLinks__develop_branch } from '@/strings/messages/DeveloperOpenStateLinks__develop_branch/de';
import { DeveloperOpenStateLinks__exclude_attachments } from '@/strings/messages/DeveloperOpenStateLinks__exclude_attachments/de';
import { DeveloperOpenStateLinks__exclude_chat_history } from '@/strings/messages/DeveloperOpenStateLinks__exclude_chat_history/de';
import { DeveloperOpenStateLinks__exclude_chats } from '@/strings/messages/DeveloperOpenStateLinks__exclude_chats/de';
import { DeveloperOpenStateLinks__excluded_data } from '@/strings/messages/DeveloperOpenStateLinks__excluded_data/de';
import { DeveloperOpenStateLinks__failed_to_copy_state_url } from '@/strings/messages/DeveloperOpenStateLinks__failed_to_copy_state_url/de';
import { DeveloperOpenStateLinks__failed_to_open_state_url } from '@/strings/messages/DeveloperOpenStateLinks__failed_to_open_state_url/de';
import { DeveloperOpenStateLinks__local_only } from '@/strings/messages/DeveloperOpenStateLinks__local_only/de';
import { DeveloperOpenStateLinks__open_current_state } from '@/strings/messages/DeveloperOpenStateLinks__open_current_state/de';
import { DeveloperOpenStateLinks__open_host } from '@/strings/messages/DeveloperOpenStateLinks__open_host/de';
import { DeveloperOpenStateLinks__open_state_description } from '@/strings/messages/DeveloperOpenStateLinks__open_state_description/de';
import { DeveloperOpenStateLinks__production } from '@/strings/messages/DeveloperOpenStateLinks__production/de';
import { DeveloperOpenStateLinks__standard } from '@/strings/messages/DeveloperOpenStateLinks__standard/de';
import { DeveloperOpenStateLinks__state_contents } from '@/strings/messages/DeveloperOpenStateLinks__state_contents/de';
import { DeveloperTab__clear_all } from '@/strings/messages/DeveloperTab__clear_all/de';
import { DeveloperTab__clear_all_cache_storage } from '@/strings/messages/DeveloperTab__clear_all_cache_storage/de';
import { DeveloperTab__clear_cache_storage_warning } from '@/strings/messages/DeveloperTab__clear_cache_storage_warning/de';
import { DeveloperTab__confirm_data_reset } from '@/strings/messages/DeveloperTab__confirm_data_reset/de';
import { DeveloperTab__create_long_sample_chat } from '@/strings/messages/DeveloperTab__create_long_sample_chat/de';
import { DeveloperTab__create_sample_chat } from '@/strings/messages/DeveloperTab__create_sample_chat/de';
import { DeveloperTab__danger_zone } from '@/strings/messages/DeveloperTab__danger_zone/de';
import { DeveloperTab__debug_and_testing } from '@/strings/messages/DeveloperTab__debug_and_testing/de';
import { DeveloperTab__deletes_cache_storage_entries } from '@/strings/messages/DeveloperTab__deletes_cache_storage_entries/de';
import { DeveloperTab__developer_tools } from '@/strings/messages/DeveloperTab__developer_tools/de';
import { DeveloperTab__execute_reset } from '@/strings/messages/DeveloperTab__execute_reset/de';
import { DeveloperTab__experimental_features } from '@/strings/messages/DeveloperTab__experimental_features/de';
import { DeveloperTab__perform_window_reload } from '@/strings/messages/DeveloperTab__perform_window_reload/de';
import { DeveloperTab__reload_application } from '@/strings/messages/DeveloperTab__reload_application/de';
import { DeveloperTab__reset } from '@/strings/messages/DeveloperTab__reset/de';
import { DeveloperTab__reset_all_app_data_warning } from '@/strings/messages/DeveloperTab__reset_all_app_data_warning/de';
import { DeveloperTab__reset_all_application_data } from '@/strings/messages/DeveloperTab__reset_all_application_data/de';
import { DeveloperTab__reset_data_provider_warning } from '@/strings/messages/DeveloperTab__reset_data_provider_warning/de';
import { DeveloperTab__sample_conversations_description } from '@/strings/messages/DeveloperTab__sample_conversations_description/de';
import { DeveloperTab__simulate_pwa_update } from '@/strings/messages/DeveloperTab__simulate_pwa_update/de';
import { DeveloperTab__toggle_update_notification } from '@/strings/messages/DeveloperTab__toggle_update_notification/de';
import { ExperimentalFeatureRow__details } from '@/strings/messages/ExperimentalFeatureRow__details/de';
import { ExperimentalFeatureRow__details_for } from '@/strings/messages/ExperimentalFeatureRow__details_for/de';
import { ExperimentalFeatureRow__disabled } from '@/strings/messages/ExperimentalFeatureRow__disabled/de';
import { ExperimentalFeatureRow__enabled } from '@/strings/messages/ExperimentalFeatureRow__enabled/de';
import { FeatureFlagsSettings__cancel } from '@/strings/messages/FeatureFlagsSettings__cancel/de';
import { FeatureFlagsSettings__disable_fake_lm } from '@/strings/messages/FeatureFlagsSettings__disable_fake_lm/de';
import { FeatureFlagsSettings__disable_folders } from '@/strings/messages/FeatureFlagsSettings__disable_folders/de';
import { FeatureFlagsSettings__disable_move_chat_on_send } from '@/strings/messages/FeatureFlagsSettings__disable_move_chat_on_send/de';
import { FeatureFlagsSettings__disable_shell } from '@/strings/messages/FeatureFlagsSettings__disable_shell/de';
import { FeatureFlagsSettings__disable_tool_config_persistence } from '@/strings/messages/FeatureFlagsSettings__disable_tool_config_persistence/de';
import { FeatureFlagsSettings__enable } from '@/strings/messages/FeatureFlagsSettings__enable/de';
import { FeatureFlagsSettings__enable_experimental_feature } from '@/strings/messages/FeatureFlagsSettings__enable_experimental_feature/de';
import { FeatureFlagsSettings__enable_fake_lm } from '@/strings/messages/FeatureFlagsSettings__enable_fake_lm/de';
import { FeatureFlagsSettings__enable_folders } from '@/strings/messages/FeatureFlagsSettings__enable_folders/de';
import { FeatureFlagsSettings__enable_move_chat_on_send } from '@/strings/messages/FeatureFlagsSettings__enable_move_chat_on_send/de';
import { FeatureFlagsSettings__enable_shell } from '@/strings/messages/FeatureFlagsSettings__enable_shell/de';
import { FeatureFlagsSettings__enable_tool_config_persistence } from '@/strings/messages/FeatureFlagsSettings__enable_tool_config_persistence/de';
import { FeatureFlagsSettings__experimental_feature_warning } from '@/strings/messages/FeatureFlagsSettings__experimental_feature_warning/de';
import { FeatureFlagsSettings__fake_lm_debug_mode } from '@/strings/messages/FeatureFlagsSettings__fake_lm_debug_mode/de';
import { FeatureFlagsSettings__features_may_change } from '@/strings/messages/FeatureFlagsSettings__features_may_change/de';
import { FeatureFlagsSettings__folders } from '@/strings/messages/FeatureFlagsSettings__folders/de';
import { FeatureFlagsSettings__folders_disabled_details } from '@/strings/messages/FeatureFlagsSettings__folders_disabled_details/de';
import { FeatureFlagsSettings__folders_enabled_details } from '@/strings/messages/FeatureFlagsSettings__folders_enabled_details/de';
import { FeatureFlagsSettings__hosted_build_only } from '@/strings/messages/FeatureFlagsSettings__hosted_build_only/de';
import { FeatureFlagsSettings__move_chat_disabled_details } from '@/strings/messages/FeatureFlagsSettings__move_chat_disabled_details/de';
import { FeatureFlagsSettings__move_chat_enabled_details } from '@/strings/messages/FeatureFlagsSettings__move_chat_enabled_details/de';
import { FeatureFlagsSettings__move_chat_on_send } from '@/strings/messages/FeatureFlagsSettings__move_chat_on_send/de';
import { FeatureFlagsSettings__moves_active_chat_after_send } from '@/strings/messages/FeatureFlagsSettings__moves_active_chat_after_send/de';
import { FeatureFlagsSettings__saves_tool_settings } from '@/strings/messages/FeatureFlagsSettings__saves_tool_settings/de';
import { FeatureFlagsSettings__shell_disabled_details } from '@/strings/messages/FeatureFlagsSettings__shell_disabled_details/de';
import { FeatureFlagsSettings__shell_enabled_details } from '@/strings/messages/FeatureFlagsSettings__shell_enabled_details/de';
import { FeatureFlagsSettings__shell_in_browser } from '@/strings/messages/FeatureFlagsSettings__shell_in_browser/de';
import { FeatureFlagsSettings__shows_folders_tab } from '@/strings/messages/FeatureFlagsSettings__shows_folders_tab/de';
import { FeatureFlagsSettings__shows_shell_in_chat_tools } from '@/strings/messages/FeatureFlagsSettings__shows_shell_in_chat_tools/de';
import { FeatureFlagsSettings__tool_config_persistence } from '@/strings/messages/FeatureFlagsSettings__tool_config_persistence/de';
import { FeatureFlagsSettings__tool_persistence_disabled_details } from '@/strings/messages/FeatureFlagsSettings__tool_persistence_disabled_details/de';
import { FeatureFlagsSettings__tool_persistence_enabled_details } from '@/strings/messages/FeatureFlagsSettings__tool_persistence_enabled_details/de';
import { FeatureFlagsSettings__use_fake_lm_endpoint } from '@/strings/messages/FeatureFlagsSettings__use_fake_lm_endpoint/de';
import { FeatureFlagsSettings__uses_bundled_fake_lm } from '@/strings/messages/FeatureFlagsSettings__uses_bundled_fake_lm/de';
import { GlobalSearchModal__all } from '@/strings/messages/GlobalSearchModal__all/de';
import { GlobalSearchModal__alt_branch } from '@/strings/messages/GlobalSearchModal__alt_branch/de';
import { GlobalSearchModal__assistant } from '@/strings/messages/GlobalSearchModal__assistant/de';
import { GlobalSearchModal__chat } from '@/strings/messages/GlobalSearchModal__chat/de';
import { GlobalSearchModal__chat_count } from '@/strings/messages/GlobalSearchModal__chat_count/de';
import { GlobalSearchModal__chats_found } from '@/strings/messages/GlobalSearchModal__chats_found/de';
import { GlobalSearchModal__clear_all_filters } from '@/strings/messages/GlobalSearchModal__clear_all_filters/de';
import { GlobalSearchModal__context } from '@/strings/messages/GlobalSearchModal__context/de';
import { GlobalSearchModal__current_thread } from '@/strings/messages/GlobalSearchModal__current_thread/de';
import { GlobalSearchModal__filter_by_group } from '@/strings/messages/GlobalSearchModal__filter_by_group/de';
import { GlobalSearchModal__filtered_chat } from '@/strings/messages/GlobalSearchModal__filtered_chat/de';
import { GlobalSearchModal__full } from '@/strings/messages/GlobalSearchModal__full/de';
import { GlobalSearchModal__groups } from '@/strings/messages/GlobalSearchModal__groups/de';
import { GlobalSearchModal__navigate } from '@/strings/messages/GlobalSearchModal__navigate/de';
import { GlobalSearchModal__no_groups_available } from '@/strings/messages/GlobalSearchModal__no_groups_available/de';
import { GlobalSearchModal__no_results_for } from '@/strings/messages/GlobalSearchModal__no_results_for/de';
import { GlobalSearchModal__off } from '@/strings/messages/GlobalSearchModal__off/de';
import { GlobalSearchModal__on } from '@/strings/messages/GlobalSearchModal__on/de';
import { GlobalSearchModal__peek } from '@/strings/messages/GlobalSearchModal__peek/de';
import { GlobalSearchModal__preview } from '@/strings/messages/GlobalSearchModal__preview/de';
import { GlobalSearchModal__role } from '@/strings/messages/GlobalSearchModal__role/de';
import { GlobalSearchModal__scanning_content } from '@/strings/messages/GlobalSearchModal__scanning_content/de';
import { GlobalSearchModal__search } from '@/strings/messages/GlobalSearchModal__search/de';
import { GlobalSearchModal__search_chats_and_messages } from '@/strings/messages/GlobalSearchModal__search_chats_and_messages/de';
import { GlobalSearchModal__select } from '@/strings/messages/GlobalSearchModal__select/de';
import { GlobalSearchModal__title_only } from '@/strings/messages/GlobalSearchModal__title_only/de';
import { GlobalSearchModal__total_matches } from '@/strings/messages/GlobalSearchModal__total_matches/de';
import { GlobalSearchModal__type_to_search } from '@/strings/messages/GlobalSearchModal__type_to_search/de';
import { GlobalSearchModal__user } from '@/strings/messages/GlobalSearchModal__user/de';
import { GlobalToolsSettings__global_settings } from '@/strings/messages/GlobalToolsSettings__global_settings/de';
import { GlobalToolsSettings__tool_defaults_can_be_overridden } from '@/strings/messages/GlobalToolsSettings__tool_defaults_can_be_overridden/de';
import { GlobalToolsSettings__tools } from '@/strings/messages/GlobalToolsSettings__tools/de';
import { HistoryManipulationModal__add_first_message } from '@/strings/messages/HistoryManipulationModal__add_first_message/de';
import { HistoryManipulationModal__add_message_after } from '@/strings/messages/HistoryManipulationModal__add_message_after/de';
import { HistoryManipulationModal__append_message } from '@/strings/messages/HistoryManipulationModal__append_message/de';
import { HistoryManipulationModal__apply_changes } from '@/strings/messages/HistoryManipulationModal__apply_changes/de';
import { HistoryManipulationModal__applying_changes_creates_a } from '@/strings/messages/HistoryManipulationModal__applying_changes_creates_a/de';
import { HistoryManipulationModal__attach_media } from '@/strings/messages/HistoryManipulationModal__attach_media/de';
import { HistoryManipulationModal__chat_system_prompt } from '@/strings/messages/HistoryManipulationModal__chat_system_prompt/de';
import { HistoryManipulationModal__copy_message } from '@/strings/messages/HistoryManipulationModal__copy_message/de';
import { HistoryManipulationModal__discard } from '@/strings/messages/HistoryManipulationModal__discard/de';
import { HistoryManipulationModal__enter_system_prompt_content } from '@/strings/messages/HistoryManipulationModal__enter_system_prompt_content/de';
import { HistoryManipulationModal__forge_empty_history } from '@/strings/messages/HistoryManipulationModal__forge_empty_history/de';
import { HistoryManipulationModal__from_the_root_the_original_conversation_remains_preserved } from '@/strings/messages/HistoryManipulationModal__from_the_root_the_original_conversation_remains_preserved/de';
import { HistoryManipulationModal__inherited } from '@/strings/messages/HistoryManipulationModal__inherited/de';
import { HistoryManipulationModal__manipulate_full_chat_history_a_new_branch_will_be_created } from '@/strings/messages/HistoryManipulationModal__manipulate_full_chat_history_a_new_branch_will_be_created/de';
import { HistoryManipulationModal__message_list } from '@/strings/messages/HistoryManipulationModal__message_list/de';
import { HistoryManipulationModal__new_branch } from '@/strings/messages/HistoryManipulationModal__new_branch/de';
import { HistoryManipulationModal__no_system_prompt_inherited } from '@/strings/messages/HistoryManipulationModal__no_system_prompt_inherited/de';
import { HistoryManipulationModal__parent_prompt_cleared } from '@/strings/messages/HistoryManipulationModal__parent_prompt_cleared/de';
import { HistoryManipulationModal__remove_message } from '@/strings/messages/HistoryManipulationModal__remove_message/de';
import { HistoryManipulationModal__super_edit } from '@/strings/messages/HistoryManipulationModal__super_edit/de';
import { HistoryManipulationModal__switch_role } from '@/strings/messages/HistoryManipulationModal__switch_role/de';
import { HistoryManipulationModal__system_prompt_resolution } from '@/strings/messages/HistoryManipulationModal__system_prompt_resolution/de';
import { HistoryManipulationModal__this_chat_will_not_use_any_system_instructions } from '@/strings/messages/HistoryManipulationModal__this_chat_will_not_use_any_system_instructions/de';
import { HistoryManipulationModal__thoughts } from '@/strings/messages/HistoryManipulationModal__thoughts/de';
import { HistoryManipulationModal__type_message_content } from '@/strings/messages/HistoryManipulationModal__type_message_content/de';
import { ImageConjuringLoader__generating_image } from '@/strings/messages/ImageConjuringLoader__generating_image/de';
import { ImageConjuringLoader__generating_images } from '@/strings/messages/ImageConjuringLoader__generating_images/de';
import { ImageConjuringLoader__image_count } from '@/strings/messages/ImageConjuringLoader__image_count/de';
import { ImageConjuringLoader__steps } from '@/strings/messages/ImageConjuringLoader__steps/de';
import { ImageDownloadButton__download_image } from '@/strings/messages/ImageDownloadButton__download_image/de';
import { ImageDownloadButton__embed_prompt_seed_etc } from '@/strings/messages/ImageDownloadButton__embed_prompt_seed_etc/de';
import { ImageDownloadButton__more_options } from '@/strings/messages/ImageDownloadButton__more_options/de';
import { ImageDownloadButton__not_supported_for_this_format } from '@/strings/messages/ImageDownloadButton__not_supported_for_this_format/de';
import { ImageDownloadButton__with_metadata } from '@/strings/messages/ImageDownloadButton__with_metadata/de';
import { ImageEditor__apply_resize } from '@/strings/messages/ImageEditor__apply_resize/de';
import { ImageEditor__black } from '@/strings/messages/ImageEditor__black/de';
import { ImageEditor__close } from '@/strings/messages/ImageEditor__close/de';
import { ImageEditor__close_and_discard_unsaved_changes } from '@/strings/messages/ImageEditor__close_and_discard_unsaved_changes/de';
import { ImageEditor__crop } from '@/strings/messages/ImageEditor__crop/de';
import { ImageEditor__crop_to_selection } from '@/strings/messages/ImageEditor__crop_to_selection/de';
import { ImageEditor__discard } from '@/strings/messages/ImageEditor__discard/de';
import { ImageEditor__discard_changes } from '@/strings/messages/ImageEditor__discard_changes/de';
import { ImageEditor__elliptical_selection } from '@/strings/messages/ImageEditor__elliptical_selection/de';
import { ImageEditor__fill_everything_outside_selection } from '@/strings/messages/ImageEditor__fill_everything_outside_selection/de';
import { ImageEditor__fill_selection_area } from '@/strings/messages/ImageEditor__fill_selection_area/de';
import { ImageEditor__finish } from '@/strings/messages/ImageEditor__finish/de';
import { ImageEditor__flip_horizontal } from '@/strings/messages/ImageEditor__flip_horizontal/de';
import { ImageEditor__flip_vertical } from '@/strings/messages/ImageEditor__flip_vertical/de';
import { ImageEditor__free_resizing } from '@/strings/messages/ImageEditor__free_resizing/de';
import { ImageEditor__image_editor } from '@/strings/messages/ImageEditor__image_editor/de';
import { ImageEditor__maintain_aspect_ratio } from '@/strings/messages/ImageEditor__maintain_aspect_ratio/de';
import { ImageEditor__mask_in } from '@/strings/messages/ImageEditor__mask_in/de';
import { ImageEditor__mask_out } from '@/strings/messages/ImageEditor__mask_out/de';
import { ImageEditor__original } from '@/strings/messages/ImageEditor__original/de';
import { ImageEditor__output_format } from '@/strings/messages/ImageEditor__output_format/de';
import { ImageEditor__pick_color_from_canvas } from '@/strings/messages/ImageEditor__pick_color_from_canvas/de';
import { ImageEditor__recent } from '@/strings/messages/ImageEditor__recent/de';
import { ImageEditor__rectangular_selection } from '@/strings/messages/ImageEditor__rectangular_selection/de';
import { ImageEditor__redo } from '@/strings/messages/ImageEditor__redo/de';
import { ImageEditor__reset } from '@/strings/messages/ImageEditor__reset/de';
import { ImageEditor__reset_image } from '@/strings/messages/ImageEditor__reset_image/de';
import { ImageEditor__reset_zoom } from '@/strings/messages/ImageEditor__reset_zoom/de';
import { ImageEditor__resize_px } from '@/strings/messages/ImageEditor__resize_px/de';
import { ImageEditor__rotate_left } from '@/strings/messages/ImageEditor__rotate_left/de';
import { ImageEditor__rotate_right } from '@/strings/messages/ImageEditor__rotate_right/de';
import { ImageEditor__selection } from '@/strings/messages/ImageEditor__selection/de';
import { ImageEditor__toggle_tools_sidebar } from '@/strings/messages/ImageEditor__toggle_tools_sidebar/de';
import { ImageEditor__tools } from '@/strings/messages/ImageEditor__tools/de';
import { ImageEditor__transform } from '@/strings/messages/ImageEditor__transform/de';
import { ImageEditor__transparent } from '@/strings/messages/ImageEditor__transparent/de';
import { ImageEditor__undo } from '@/strings/messages/ImageEditor__undo/de';
import { ImageEditor__wheel_to_zoom_middle_click_or_alt_plus_drag_to_pan } from '@/strings/messages/ImageEditor__wheel_to_zoom_middle_click_or_alt_plus_drag_to_pan/de';
import { ImageEditor__white } from '@/strings/messages/ImageEditor__white/de';
import { ImageEditor__zoom } from '@/strings/messages/ImageEditor__zoom/de';
import { ImageEditor__zoom_in } from '@/strings/messages/ImageEditor__zoom_in/de';
import { ImageEditor__zoom_out } from '@/strings/messages/ImageEditor__zoom_out/de';
import { ImageGenerationSettings__auto } from '@/strings/messages/ImageGenerationSettings__auto/de';
import { ImageGenerationSettings__click_to_enter_specific_seed } from '@/strings/messages/ImageGenerationSettings__click_to_enter_specific_seed/de';
import { ImageGenerationSettings__create_image_experimental } from '@/strings/messages/ImageGenerationSettings__create_image_experimental/de';
import { ImageGenerationSettings__explicitly_generate_random_seed_in_browser_for_each_image } from '@/strings/messages/ImageGenerationSettings__explicitly_generate_random_seed_in_browser_for_each_image/de';
import { ImageGenerationSettings__height } from '@/strings/messages/ImageGenerationSettings__height/de';
import { ImageGenerationSettings__image_model } from '@/strings/messages/ImageGenerationSettings__image_model/de';
import { ImageGenerationSettings__jpeg } from '@/strings/messages/ImageGenerationSettings__jpeg/de';
import { ImageGenerationSettings__no_tools_available_for_this_provider } from '@/strings/messages/ImageGenerationSettings__no_tools_available_for_this_provider/de';
import { ImageGenerationSettings__number_of_images } from '@/strings/messages/ImageGenerationSettings__number_of_images/de';
import { ImageGenerationSettings__original } from '@/strings/messages/ImageGenerationSettings__original/de';
import { ImageGenerationSettings__png } from '@/strings/messages/ImageGenerationSettings__png/de';
import { ImageGenerationSettings__qty } from '@/strings/messages/ImageGenerationSettings__qty/de';
import { ImageGenerationSettings__resolution } from '@/strings/messages/ImageGenerationSettings__resolution/de';
import { ImageGenerationSettings__save_format } from '@/strings/messages/ImageGenerationSettings__save_format/de';
import { ImageGenerationSettings__seed } from '@/strings/messages/ImageGenerationSettings__seed/de';
import { ImageGenerationSettings__select_image_model } from '@/strings/messages/ImageGenerationSettings__select_image_model/de';
import { ImageGenerationSettings__steps } from '@/strings/messages/ImageGenerationSettings__steps/de';
import { ImageGenerationSettings__swap_width_and_height } from '@/strings/messages/ImageGenerationSettings__swap_width_and_height/de';
import { ImageGenerationSettings__webp } from '@/strings/messages/ImageGenerationSettings__webp/de';
import { ImageGenerationSettings__width } from '@/strings/messages/ImageGenerationSettings__width/de';
import { ImageInfoDisplay__copy_prompt } from '@/strings/messages/ImageInfoDisplay__copy_prompt/de';
import { ImageInfoDisplay__copy_seed } from '@/strings/messages/ImageInfoDisplay__copy_seed/de';
import { ImageInfoDisplay__image_info } from '@/strings/messages/ImageInfoDisplay__image_info/de';
import { ImageInfoDisplay__prompt } from '@/strings/messages/ImageInfoDisplay__prompt/de';
import { ImageInfoDisplay__seed } from '@/strings/messages/ImageInfoDisplay__seed/de';
import { ImageInfoDisplay__size } from '@/strings/messages/ImageInfoDisplay__size/de';
import { ImageInfoDisplay__steps } from '@/strings/messages/ImageInfoDisplay__steps/de';
import { ImportExportModal__add_new } from '@/strings/messages/ImportExportModal__add_new/de';
import { ImportExportModal__analyzing_file } from '@/strings/messages/ImportExportModal__analyzing_file/de';
import { ImportExportModal__append_keeps_current_data } from '@/strings/messages/ImportExportModal__append_keeps_current_data/de';
import { ImportExportModal__append_merge } from '@/strings/messages/ImportExportModal__append_merge/de';
import { ImportExportModal__append_preset } from '@/strings/messages/ImportExportModal__append_preset/de';
import { ImportExportModal__back } from '@/strings/messages/ImportExportModal__back/de';
import { ImportExportModal__back_to_menu } from '@/strings/messages/ImportExportModal__back_to_menu/de';
import { ImportExportModal__cancel } from '@/strings/messages/ImportExportModal__cancel/de';
import { ImportExportModal__chat_count } from '@/strings/messages/ImportExportModal__chat_count/de';
import { ImportExportModal__chat_title_prefix } from '@/strings/messages/ImportExportModal__chat_title_prefix/de';
import { ImportExportModal__chats } from '@/strings/messages/ImportExportModal__chats/de';
import { ImportExportModal__compressing_data } from '@/strings/messages/ImportExportModal__compressing_data/de';
import { ImportExportModal__content_preview } from '@/strings/messages/ImportExportModal__content_preview/de';
import { ImportExportModal__custom_click_to_reset } from '@/strings/messages/ImportExportModal__custom_click_to_reset/de';
import { ImportExportModal__default_marker } from '@/strings/messages/ImportExportModal__default_marker/de';
import { ImportExportModal__default_model } from '@/strings/messages/ImportExportModal__default_model/de';
import { ImportExportModal__download_full_backup } from '@/strings/messages/ImportExportModal__download_full_backup/de';
import { ImportExportModal__error } from '@/strings/messages/ImportExportModal__error/de';
import { ImportExportModal__exclude_attachments } from '@/strings/messages/ImportExportModal__exclude_attachments/de';
import { ImportExportModal__exclude_chat_history } from '@/strings/messages/ImportExportModal__exclude_chat_history/de';
import { ImportExportModal__exclude_chats } from '@/strings/messages/ImportExportModal__exclude_chats/de';
import { ImportExportModal__experimental } from '@/strings/messages/ImportExportModal__experimental/de';
import { ImportExportModal__export } from '@/strings/messages/ImportExportModal__export/de';
import { ImportExportModal__export_failed } from '@/strings/messages/ImportExportModal__export_failed/de';
import { ImportExportModal__export_now } from '@/strings/messages/ImportExportModal__export_now/de';
import { ImportExportModal__export_successful } from '@/strings/messages/ImportExportModal__export_successful/de';
import { ImportExportModal__failed_to_analyze_file } from '@/strings/messages/ImportExportModal__failed_to_analyze_file/de';
import { ImportExportModal__filename_tag_example } from '@/strings/messages/ImportExportModal__filename_tag_example/de';
import { ImportExportModal__filename_tag_optional } from '@/strings/messages/ImportExportModal__filename_tag_optional/de';
import { ImportExportModal__files } from '@/strings/messages/ImportExportModal__files/de';
import { ImportExportModal__global_system_prompt } from '@/strings/messages/ImportExportModal__global_system_prompt/de';
import { ImportExportModal__group_name_prefix } from '@/strings/messages/ImportExportModal__group_name_prefix/de';
import { ImportExportModal__groups } from '@/strings/messages/ImportExportModal__groups/de';
import { ImportExportModal__ignore } from '@/strings/messages/ImportExportModal__ignore/de';
import { ImportExportModal__import } from '@/strings/messages/ImportExportModal__import/de';
import { ImportExportModal__import_export } from '@/strings/messages/ImportExportModal__import_export/de';
import { ImportExportModal__import_failed } from '@/strings/messages/ImportExportModal__import_failed/de';
import { ImportExportModal__import_successful } from '@/strings/messages/ImportExportModal__import_successful/de';
import { ImportExportModal__importing_data } from '@/strings/messages/ImportExportModal__importing_data/de';
import { ImportExportModal__keep_current } from '@/strings/messages/ImportExportModal__keep_current/de';
import { ImportExportModal__lm_parameters } from '@/strings/messages/ImportExportModal__lm_parameters/de';
import { ImportExportModal__mode_and_data_strategy } from '@/strings/messages/ImportExportModal__mode_and_data_strategy/de';
import { ImportExportModal__next } from '@/strings/messages/ImportExportModal__next/de';
import { ImportExportModal__no_settings_or_profiles } from '@/strings/messages/ImportExportModal__no_settings_or_profiles/de';
import { ImportExportModal__output_filename } from '@/strings/messages/ImportExportModal__output_filename/de';
import { ImportExportModal__overwrite } from '@/strings/messages/ImportExportModal__overwrite/de';
import { ImportExportModal__portable_data } from '@/strings/messages/ImportExportModal__portable_data/de';
import { ImportExportModal__profiles } from '@/strings/messages/ImportExportModal__profiles/de';
import { ImportExportModal__provider_profiles } from '@/strings/messages/ImportExportModal__provider_profiles/de';
import { ImportExportModal__ready_to_export } from '@/strings/messages/ImportExportModal__ready_to_export/de';
import { ImportExportModal__replace_clears_current_data } from '@/strings/messages/ImportExportModal__replace_clears_current_data/de';
import { ImportExportModal__replace_restore } from '@/strings/messages/ImportExportModal__replace_restore/de';
import { ImportExportModal__restore_preset } from '@/strings/messages/ImportExportModal__restore_preset/de';
import { ImportExportModal__settings_and_profiles } from '@/strings/messages/ImportExportModal__settings_and_profiles/de';
import { ImportExportModal__title_generation_model } from '@/strings/messages/ImportExportModal__title_generation_model/de';
import { ImportExportModal__untitled_chat } from '@/strings/messages/ImportExportModal__untitled_chat/de';
import { ImportExportModal__upload_backup_to_restore_or_merge } from '@/strings/messages/ImportExportModal__upload_backup_to_restore_or_merge/de';
import { ImportExportModal__url_and_http_headers } from '@/strings/messages/ImportExportModal__url_and_http_headers/de';
import { ImportExportModal__verifying_integrity } from '@/strings/messages/ImportExportModal__verifying_integrity/de';
import { ImportExportModal__zip_contains_all_data_by_default } from '@/strings/messages/ImportExportModal__zip_contains_all_data_by_default/de';
import { ImportExportService__export_dump_failed } from '@/strings/messages/ImportExportService__export_dump_failed/de';
import { ImportExportService__invalid_zip_file } from '@/strings/messages/ImportExportService__invalid_zip_file/de';
import { LanguageSelector__language } from '@/strings/messages/LanguageSelector__language/de';
import { LmParametersEditor__default } from '@/strings/messages/LmParametersEditor__default/de';
import { LmParametersEditor__empty_fields_use_provider_defaults } from '@/strings/messages/LmParametersEditor__empty_fields_use_provider_defaults/de';
import { LmParametersEditor__invalid_json } from '@/strings/messages/LmParametersEditor__invalid_json/de';
import { LmParametersEditor__lm_parameters } from '@/strings/messages/LmParametersEditor__lm_parameters/de';
import { LmParametersEditor__max_tokens } from '@/strings/messages/LmParametersEditor__max_tokens/de';
import { LmParametersEditor__must_be_an_array_of_strings } from '@/strings/messages/LmParametersEditor__must_be_an_array_of_strings/de';
import { LmParametersEditor__presence_penalty } from '@/strings/messages/LmParametersEditor__presence_penalty/de';
import { LmParametersEditor__reset_all } from '@/strings/messages/LmParametersEditor__reset_all/de';
import { LmParametersEditor__reset_to_default } from '@/strings/messages/LmParametersEditor__reset_to_default/de';
import { LmParametersEditor__stop_sequences_json_array } from '@/strings/messages/LmParametersEditor__stop_sequences_json_array/de';
import { LmParametersEditor__temperature } from '@/strings/messages/LmParametersEditor__temperature/de';
import { LmParametersEditor__top_p } from '@/strings/messages/LmParametersEditor__top_p/de';
import { LmToolsSettings__changes_apply_to_this_browser_session_only_while_tool_config_persistence_is_disabled } from '@/strings/messages/LmToolsSettings__changes_apply_to_this_browser_session_only_while_tool_config_persistence_is_disabled/de';
import { LmToolsSettings__failed_to_save_chat_tool_settings } from '@/strings/messages/LmToolsSettings__failed_to_save_chat_tool_settings/de';
import { Logo__naidan_logo } from '@/strings/messages/Logo__naidan_logo/de';
import { MessageActions__compare_versions } from '@/strings/messages/MessageActions__compare_versions/de';
import { MessageActions__copied } from '@/strings/messages/MessageActions__copied/de';
import { MessageActions__copy_link } from '@/strings/messages/MessageActions__copy_link/de';
import { MessageActions__copy_message } from '@/strings/messages/MessageActions__copy_message/de';
import { MessageActions__copy_raw } from '@/strings/messages/MessageActions__copy_raw/de';
import { MessageActions__edit_message } from '@/strings/messages/MessageActions__edit_message/de';
import { MessageActions__failed_to_copy_message_link } from '@/strings/messages/MessageActions__failed_to_copy_message_link/de';
import { MessageActions__fork_chat } from '@/strings/messages/MessageActions__fork_chat/de';
import { MessageActions__message_link_copied } from '@/strings/messages/MessageActions__message_link_copied/de';
import { MessageActions__more_actions } from '@/strings/messages/MessageActions__more_actions/de';
import { MessageActions__more_message_tools } from '@/strings/messages/MessageActions__more_message_tools/de';
import { MessageActions__regenerate_response } from '@/strings/messages/MessageActions__regenerate_response/de';
import { MessageActions__resend_message } from '@/strings/messages/MessageActions__resend_message/de';
import { MessageDiffModal__base } from '@/strings/messages/MessageDiffModal__base/de';
import { MessageDiffModal__comparing_base_version } from '@/strings/messages/MessageDiffModal__comparing_base_version/de';
import { MessageDiffModal__copied } from '@/strings/messages/MessageDiffModal__copied/de';
import { MessageDiffModal__copy_result } from '@/strings/messages/MessageDiffModal__copy_result/de';
import { MessageDiffModal__copy_this_version } from '@/strings/messages/MessageDiffModal__copy_this_version/de';
import { MessageDiffModal__diff_on } from '@/strings/messages/MessageDiffModal__diff_on/de';
import { MessageDiffModal__exclude_from_diff } from '@/strings/messages/MessageDiffModal__exclude_from_diff/de';
import { MessageDiffModal__include } from '@/strings/messages/MessageDiffModal__include/de';
import { MessageDiffModal__include_in_diff } from '@/strings/messages/MessageDiffModal__include_in_diff/de';
import { MessageDiffModal__loading_more_versions } from '@/strings/messages/MessageDiffModal__loading_more_versions/de';
import { MessageDiffModal__message_history_and_compare } from '@/strings/messages/MessageDiffModal__message_history_and_compare/de';
import { MessageDiffModal__off } from '@/strings/messages/MessageDiffModal__off/de';
import { MessageDiffModal__reset_selection } from '@/strings/messages/MessageDiffModal__reset_selection/de';
import { MessageDiffModal__select_versions_to_compare_differences } from '@/strings/messages/MessageDiffModal__select_versions_to_compare_differences/de';
import { MessageDiffModal__skip } from '@/strings/messages/MessageDiffModal__skip/de';
import { MessageDiffModal__target } from '@/strings/messages/MessageDiffModal__target/de';
import { MessageDiffModal__target_version } from '@/strings/messages/MessageDiffModal__target_version/de';
import { MessageItem__cancel } from '@/strings/messages/MessageItem__cancel/de';
import { MessageItem__clear } from '@/strings/messages/MessageItem__clear/de';
import { MessageItem__clear_all_text } from '@/strings/messages/MessageItem__clear_all_text/de';
import { MessageItem__download_image } from '@/strings/messages/MessageItem__download_image/de';
import { MessageItem__generation_failed } from '@/strings/messages/MessageItem__generation_failed/de';
import { MessageItem__high } from '@/strings/messages/MessageItem__high/de';
import { MessageItem__image_generated } from '@/strings/messages/MessageItem__image_generated/de';
import { MessageItem__image_missing } from '@/strings/messages/MessageItem__image_missing/de';
import { MessageItem__low } from '@/strings/messages/MessageItem__low/de';
import { MessageItem__medium } from '@/strings/messages/MessageItem__medium/de';
import { MessageItem__more_message_tools } from '@/strings/messages/MessageItem__more_message_tools/de';
import { MessageItem__off } from '@/strings/messages/MessageItem__off/de';
import { MessageItem__open_advanced_editor } from '@/strings/messages/MessageItem__open_advanced_editor/de';
import { MessageItem__options_tools } from '@/strings/messages/MessageItem__options_tools/de';
import { MessageItem__retry } from '@/strings/messages/MessageItem__retry/de';
import { MessageItem__send_and_branch } from '@/strings/messages/MessageItem__send_and_branch/de';
import { MessageItem__stop_generation } from '@/strings/messages/MessageItem__stop_generation/de';
import { MessageItem__think } from '@/strings/messages/MessageItem__think/de';
import { MessageItem__think_disabled } from '@/strings/messages/MessageItem__think_disabled/de';
import { MessageItem__think_effort_note } from '@/strings/messages/MessageItem__think_effort_note/de';
import { MessageItem__tools } from '@/strings/messages/MessageItem__tools/de';
import { MessageItem__update_and_branch } from '@/strings/messages/MessageItem__update_and_branch/de';
import { MessageItem__you } from '@/strings/messages/MessageItem__you/de';
import { MessageThinking__hide_thought_process } from '@/strings/messages/MessageThinking__hide_thought_process/de';
import { MessageThinking__show_thought_process } from '@/strings/messages/MessageThinking__show_thought_process/de';
import { MessageThinking__thinking } from '@/strings/messages/MessageThinking__thinking/de';
import { MessageThinking__thought_process } from '@/strings/messages/MessageThinking__thought_process/de';
import { ModelSelector__filter_models } from '@/strings/messages/ModelSelector__filter_models/de';
import { ModelSelector__inherit } from '@/strings/messages/ModelSelector__inherit/de';
import { ModelSelector__no_models_found } from '@/strings/messages/ModelSelector__no_models_found/de';
import { ModelSelector__refresh_model_list } from '@/strings/messages/ModelSelector__refresh_model_list/de';
import { ModelSelector__select_a_model } from '@/strings/messages/ModelSelector__select_a_model/de';
import { MountBadgeList__browse_path } from '@/strings/messages/MountBadgeList__browse_path/de';
import { MountBadgeList__read_and_write_click_to_restrict } from '@/strings/messages/MountBadgeList__read_and_write_click_to_restrict/de';
import { MountBadgeList__read_only_click_to_allow_write } from '@/strings/messages/MountBadgeList__read_only_click_to_allow_write/de';
import { MountBadgeList__remove } from '@/strings/messages/MountBadgeList__remove/de';
import { OllamaManagementView__ollama_runtime } from '@/strings/messages/OllamaManagementView__ollama_runtime/de';
import { OllamaManagementView__view_and_unload_models_currently_held_in_memory_by_this_ollama_server } from '@/strings/messages/OllamaManagementView__view_and_unload_models_currently_held_in_memory_by_this_ollama_server/de';
import { OllamaPsView__checking } from '@/strings/messages/OllamaPsView__checking/de';
import { OllamaPsView__context_length } from '@/strings/messages/OllamaPsView__context_length/de';
import { OllamaPsView__could_not_load_running_models } from '@/strings/messages/OllamaPsView__could_not_load_running_models/de';
import { OllamaPsView__digest } from '@/strings/messages/OllamaPsView__digest/de';
import { OllamaPsView__enter_an_ollama_endpoint_url_to_view_running_models } from '@/strings/messages/OllamaPsView__enter_an_ollama_endpoint_url_to_view_running_models/de';
import { OllamaPsView__expires_at } from '@/strings/messages/OllamaPsView__expires_at/de';
import { OllamaPsView__expires_in_minutes } from '@/strings/messages/OllamaPsView__expires_in_minutes/de';
import { OllamaPsView__expires_soon } from '@/strings/messages/OllamaPsView__expires_soon/de';
import { OllamaPsView__families } from '@/strings/messages/OllamaPsView__families/de';
import { OllamaPsView__family } from '@/strings/messages/OllamaPsView__family/de';
import { OllamaPsView__format } from '@/strings/messages/OllamaPsView__format/de';
import { OllamaPsView__kept_indefinitely } from '@/strings/messages/OllamaPsView__kept_indefinitely/de';
import { OllamaPsView__loaded_count } from '@/strings/messages/OllamaPsView__loaded_count/de';
import { OllamaPsView__loaded_models_remain_available_until_their_keep_alive_period_expires } from '@/strings/messages/OllamaPsView__loaded_models_remain_available_until_their_keep_alive_period_expires/de';
import { OllamaPsView__loading_models } from '@/strings/messages/OllamaPsView__loading_models/de';
import { OllamaPsView__memory_size } from '@/strings/messages/OllamaPsView__memory_size/de';
import { OllamaPsView__model } from '@/strings/messages/OllamaPsView__model/de';
import { OllamaPsView__model_details } from '@/strings/messages/OllamaPsView__model_details/de';
import { OllamaPsView__model_details_aria } from '@/strings/messages/OllamaPsView__model_details_aria/de';
import { OllamaPsView__model_unload_requested } from '@/strings/messages/OllamaPsView__model_unload_requested/de';
import { OllamaPsView__model_unloaded } from '@/strings/messages/OllamaPsView__model_unloaded/de';
import { OllamaPsView__models_appear_here_after_ollama_loads_them_for_a_request } from '@/strings/messages/OllamaPsView__models_appear_here_after_ollama_loads_them_for_a_request/de';
import { OllamaPsView__models_currently_using_system_or_video_memory } from '@/strings/messages/OllamaPsView__models_currently_using_system_or_video_memory/de';
import { OllamaPsView__no_models_are_currently_loaded } from '@/strings/messages/OllamaPsView__no_models_are_currently_loaded/de';
import { OllamaPsView__not_checked } from '@/strings/messages/OllamaPsView__not_checked/de';
import { OllamaPsView__parent_model } from '@/strings/messages/OllamaPsView__parent_model/de';
import { OllamaPsView__refresh } from '@/strings/messages/OllamaPsView__refresh/de';
import { OllamaPsView__refresh_to_check_this_ollama_server } from '@/strings/messages/OllamaPsView__refresh_to_check_this_ollama_server/de';
import { OllamaPsView__refreshing } from '@/strings/messages/OllamaPsView__refreshing/de';
import { OllamaPsView__running_models } from '@/strings/messages/OllamaPsView__running_models/de';
import { OllamaPsView__running_ollama_models } from '@/strings/messages/OllamaPsView__running_ollama_models/de';
import { OllamaPsView__try_again } from '@/strings/messages/OllamaPsView__try_again/de';
import { OllamaPsView__unavailable } from '@/strings/messages/OllamaPsView__unavailable/de';
import { OllamaPsView__unload } from '@/strings/messages/OllamaPsView__unload/de';
import { OllamaPsView__unload_requested } from '@/strings/messages/OllamaPsView__unload_requested/de';
import { OllamaPsView__unload_requested_ollama_may_keep_showing_this_model_until_active_requests_finish_refresh_to_check_again } from '@/strings/messages/OllamaPsView__unload_requested_ollama_may_keep_showing_this_model_until_active_requests_finish_refresh_to_check_again/de';
import { OllamaPsView__unloading } from '@/strings/messages/OllamaPsView__unloading/de';
import { OllamaPsView__vram_size } from '@/strings/messages/OllamaPsView__vram_size/de';
import { OnboardingModal__add_header } from '@/strings/messages/OnboardingModal__add_header/de';
import { OnboardingModal__back } from '@/strings/messages/OnboardingModal__back/de';
import { OnboardingModal__cancel } from '@/strings/messages/OnboardingModal__cancel/de';
import { OnboardingModal__check_connection } from '@/strings/messages/OnboardingModal__check_connection/de';
import { OnboardingModal__connecting } from '@/strings/messages/OnboardingModal__connecting/de';
import { OnboardingModal__connection_attempt_cancelled } from '@/strings/messages/OnboardingModal__connection_attempt_cancelled/de';
import { OnboardingModal__custom_http_headers } from '@/strings/messages/OnboardingModal__custom_http_headers/de';
import { OnboardingModal__default_model } from '@/strings/messages/OnboardingModal__default_model/de';
import { OnboardingModal__do_not_have_a_server } from '@/strings/messages/OnboardingModal__do_not_have_a_server/de';
import { OnboardingModal__endpoint_configuration } from '@/strings/messages/OnboardingModal__endpoint_configuration/de';
import { OnboardingModal__enter_existing_server_url } from '@/strings/messages/OnboardingModal__enter_existing_server_url/de';
import { OnboardingModal__enter_valid_url } from '@/strings/messages/OnboardingModal__enter_valid_url/de';
import { OnboardingModal__experimental } from '@/strings/messages/OnboardingModal__experimental/de';
import { OnboardingModal__failed_to_connect } from '@/strings/messages/OnboardingModal__failed_to_connect/de';
import { OnboardingModal__failed_to_save_settings } from '@/strings/messages/OnboardingModal__failed_to_save_settings/de';
import { OnboardingModal__get_started } from '@/strings/messages/OnboardingModal__get_started/de';
import { OnboardingModal__help_and_guide } from '@/strings/messages/OnboardingModal__help_and_guide/de';
import { OnboardingModal__in_browser_ai } from '@/strings/messages/OnboardingModal__in_browser_ai/de';
import { OnboardingModal__name } from '@/strings/messages/OnboardingModal__name/de';
import { OnboardingModal__ollama } from '@/strings/messages/OnboardingModal__ollama/de';
import { OnboardingModal__openai_compatible } from '@/strings/messages/OnboardingModal__openai_compatible/de';
import { OnboardingModal__quick_presets } from '@/strings/messages/OnboardingModal__quick_presets/de';
import { OnboardingModal__run_models_in_browser } from '@/strings/messages/OnboardingModal__run_models_in_browser/de';
import { OnboardingModal__select_a_model } from '@/strings/messages/OnboardingModal__select_a_model/de';
import { OnboardingModal__settings_can_be_changed_later } from '@/strings/messages/OnboardingModal__settings_can_be_changed_later/de';
import { OnboardingModal__settings_saved_for_local_inference } from '@/strings/messages/OnboardingModal__settings_saved_for_local_inference/de';
import { OnboardingModal__setup_endpoint } from '@/strings/messages/OnboardingModal__setup_endpoint/de';
import { OnboardingModal__setup_endpoint_description } from '@/strings/messages/OnboardingModal__setup_endpoint_description/de';
import { OnboardingModal__successfully_connected } from '@/strings/messages/OnboardingModal__successfully_connected/de';
import { OnboardingModal__transformers_js } from '@/strings/messages/OnboardingModal__transformers_js/de';
import { OnboardingModal__value } from '@/strings/messages/OnboardingModal__value/de';
import { PWAManager__app_ready_to_work_offline } from '@/strings/messages/PWAManager__app_ready_to_work_offline/de';
import { PWAUpdateNotification__reload_to_update } from '@/strings/messages/PWAUpdateNotification__reload_to_update/de';
import { PromptApiStatus__browser_provided_language_models_are_not_available_in_this_browser } from '@/strings/messages/PromptApiStatus__browser_provided_language_models_are_not_available_in_this_browser/de';
import { PromptApiStatus__browser_provided_model_is_not_available_on_this_device } from '@/strings/messages/PromptApiStatus__browser_provided_model_is_not_available_on_this_device/de';
import { PromptApiStatus__browser_provided_model_is_ready } from '@/strings/messages/PromptApiStatus__browser_provided_model_is_ready/de';
import { PromptApiStatus__browser_reported_model_unavailable } from '@/strings/messages/PromptApiStatus__browser_reported_model_unavailable/de';
import { PromptApiStatus__browser_returned_an_error_while_checking_availability } from '@/strings/messages/PromptApiStatus__browser_returned_an_error_while_checking_availability/de';
import { PromptApiStatus__browser_returned_an_error_while_preparing_model } from '@/strings/messages/PromptApiStatus__browser_returned_an_error_while_preparing_model/de';
import { PromptApiStatus__checking_browser_provided_language_model_availability } from '@/strings/messages/PromptApiStatus__checking_browser_provided_language_model_availability/de';
import { PromptApiStatus__chrome_148_or_later_desktop } from '@/strings/messages/PromptApiStatus__chrome_148_or_later_desktop/de';
import { PromptApiStatus__chrome_gpu_with_4_gb_vram_or_less } from '@/strings/messages/PromptApiStatus__chrome_gpu_with_4_gb_vram_or_less/de';
import { PromptApiStatus__common_reasons_include } from '@/strings/messages/PromptApiStatus__common_reasons_include/de';
import { PromptApiStatus__could_not_check_browser_provided_model_availability } from '@/strings/messages/PromptApiStatus__could_not_check_browser_provided_model_availability/de';
import { PromptApiStatus__downloading_browser_provided_model } from '@/strings/messages/PromptApiStatus__downloading_browser_provided_model/de';
import { PromptApiStatus__downloading_browser_provided_model_progress } from '@/strings/messages/PromptApiStatus__downloading_browser_provided_model_progress/de';
import { PromptApiStatus__edge_canary_or_dev_138_or_later_with_prompt_api_flag } from '@/strings/messages/PromptApiStatus__edge_canary_or_dev_138_or_later_with_prompt_api_flag/de';
import { PromptApiStatus__edge_gpu_with_less_than_5_5_gb_vram_for_phi_4_mini } from '@/strings/messages/PromptApiStatus__edge_gpu_with_less_than_5_5_gb_vram_for_phi_4_mini/de';
import { PromptApiStatus__if_unavailable_in_a_supported_browser } from '@/strings/messages/PromptApiStatus__if_unavailable_in_a_supported_browser/de';
import { PromptApiStatus__language_model_api_was_not_detected } from '@/strings/messages/PromptApiStatus__language_model_api_was_not_detected/de';
import { PromptApiStatus__less_than_16_gb_ram_or_fewer_than_4_cpu_cores_for_cpu_inference } from '@/strings/messages/PromptApiStatus__less_than_16_gb_ram_or_fewer_than_4_cpu_cores_for_cpu_inference/de';
import { PromptApiStatus__less_than_required_free_space_on_browser_profile_volume } from '@/strings/messages/PromptApiStatus__less_than_required_free_space_on_browser_profile_volume/de';
import { PromptApiStatus__metered_or_unavailable_network_during_initial_download } from '@/strings/messages/PromptApiStatus__metered_or_unavailable_network_during_initial_download/de';
import { PromptApiStatus__model_download_may_require_an_unmetered_network } from '@/strings/messages/PromptApiStatus__model_download_may_require_an_unmetered_network/de';
import { PromptApiStatus__model_download_may_require_more_free_space } from '@/strings/messages/PromptApiStatus__model_download_may_require_more_free_space/de';
import { PromptApiStatus__model_preparation_failed } from '@/strings/messages/PromptApiStatus__model_preparation_failed/de';
import { PromptApiStatus__operating_system_or_hardware_requirements_may_not_be_met } from '@/strings/messages/PromptApiStatus__operating_system_or_hardware_requirements_may_not_be_met/de';
import { PromptApiStatus__prepare_browser_provided_model } from '@/strings/messages/PromptApiStatus__prepare_browser_provided_model/de';
import { PromptApiStatus__preparing_browser_provided_model } from '@/strings/messages/PromptApiStatus__preparing_browser_provided_model/de';
import { PromptApiStatus__prompt_api_may_be_disabled_by_browser_settings_flags_or_policy } from '@/strings/messages/PromptApiStatus__prompt_api_may_be_disabled_by_browser_settings_flags_or_policy/de';
import { PromptApiStatus__required_edge_experimental_flags_are_not_enabled } from '@/strings/messages/PromptApiStatus__required_edge_experimental_flags_are_not_enabled/de';
import { PromptApiStatus__supported_browsers } from '@/strings/messages/PromptApiStatus__supported_browsers/de';
import { PromptApiStatus__supported_browsers_and_requirements } from '@/strings/messages/PromptApiStatus__supported_browsers_and_requirements/de';
import { PromptApiStatus__technical_details } from '@/strings/messages/PromptApiStatus__technical_details/de';
import { PromptApiStatus__try_again } from '@/strings/messages/PromptApiStatus__try_again/de';
import { PromptApiStatus__unsupported_operating_system_or_device } from '@/strings/messages/PromptApiStatus__unsupported_operating_system_or_device/de';
import { PromptApiStatus__unsupported_operating_system_or_device_performance_class } from '@/strings/messages/PromptApiStatus__unsupported_operating_system_or_device_performance_class/de';
import { ProviderProfilePreview__configuration_preview } from '@/strings/messages/ProviderProfilePreview__configuration_preview/de';
import { ProviderProfilePreview__endpoint_url } from '@/strings/messages/ProviderProfilePreview__endpoint_url/de';
import { ProviderProfilePreview__headers } from '@/strings/messages/ProviderProfilePreview__headers/de';
import { ProviderProfilePreview__lm_params } from '@/strings/messages/ProviderProfilePreview__lm_params/de';
import { ProviderProfilePreview__none } from '@/strings/messages/ProviderProfilePreview__none/de';
import { ProviderProfilePreview__provider_and_model } from '@/strings/messages/ProviderProfilePreview__provider_and_model/de';
import { ProviderProfilePreview__system_prompt } from '@/strings/messages/ProviderProfilePreview__system_prompt/de';
import { ProviderProfilesTab__delete_profile } from '@/strings/messages/ProviderProfilesTab__delete_profile/de';
import { ProviderProfilesTab__go_to_connection_to_create_one } from '@/strings/messages/ProviderProfilesTab__go_to_connection_to_create_one/de';
import { ProviderProfilesTab__no_default_model } from '@/strings/messages/ProviderProfilesTab__no_default_model/de';
import { ProviderProfilesTab__no_profiles_saved_yet } from '@/strings/messages/ProviderProfilesTab__no_profiles_saved_yet/de';
import { ProviderProfilesTab__profile_was_deleted } from '@/strings/messages/ProviderProfilesTab__profile_was_deleted/de';
import { ProviderProfilesTab__provider_profiles } from '@/strings/messages/ProviderProfilesTab__provider_profiles/de';
import { ProviderProfilesTab__rename_profile } from '@/strings/messages/ProviderProfilesTab__rename_profile/de';
import { ProviderProfilesTab__save_and_switch_provider_configurations } from '@/strings/messages/ProviderProfilesTab__save_and_switch_provider_configurations/de';
import { ProviderProfilesTab__title_model } from '@/strings/messages/ProviderProfilesTab__title_model/de';
import { ProviderProfilesTab__undo } from '@/strings/messages/ProviderProfilesTab__undo/de';
import { ReasoningSettings__default } from '@/strings/messages/ReasoningSettings__default/de';
import { ReasoningSettings__effort_levels_may_be_ignored_by_some_models } from '@/strings/messages/ReasoningSettings__effort_levels_may_be_ignored_by_some_models/de';
import { ReasoningSettings__high } from '@/strings/messages/ReasoningSettings__high/de';
import { ReasoningSettings__low } from '@/strings/messages/ReasoningSettings__low/de';
import { ReasoningSettings__med } from '@/strings/messages/ReasoningSettings__med/de';
import { ReasoningSettings__medium } from '@/strings/messages/ReasoningSettings__medium/de';
import { ReasoningSettings__off } from '@/strings/messages/ReasoningSettings__off/de';
import { ReasoningSettings__think } from '@/strings/messages/ReasoningSettings__think/de';
import { RecentChatsModal__filter } from '@/strings/messages/RecentChatsModal__filter/de';
import { RecentChatsModal__filter_recent_chats } from '@/strings/messages/RecentChatsModal__filter_recent_chats/de';
import { RecentChatsModal__navigate } from '@/strings/messages/RecentChatsModal__navigate/de';
import { RecentChatsModal__no_chats_match_filter } from '@/strings/messages/RecentChatsModal__no_chats_match_filter/de';
import { RecentChatsModal__no_recent_chats } from '@/strings/messages/RecentChatsModal__no_recent_chats/de';
import { RecentChatsModal__off } from '@/strings/messages/RecentChatsModal__off/de';
import { RecentChatsModal__on } from '@/strings/messages/RecentChatsModal__on/de';
import { RecentChatsModal__peek } from '@/strings/messages/RecentChatsModal__peek/de';
import { RecentChatsModal__preview } from '@/strings/messages/RecentChatsModal__preview/de';
import { RecentChatsModal__select } from '@/strings/messages/RecentChatsModal__select/de';
import { RecipeExportModal__aa } from '@/strings/messages/RecipeExportModal__aa/de';
import { RecipeExportModal__add_rule } from '@/strings/messages/RecipeExportModal__add_rule/de';
import { RecipeExportModal__append } from '@/strings/messages/RecipeExportModal__append/de';
import { RecipeExportModal__clear } from '@/strings/messages/RecipeExportModal__clear/de';
import { RecipeExportModal__copied_to_clipboard } from '@/strings/messages/RecipeExportModal__copied_to_clipboard/de';
import { RecipeExportModal__copy_recipe_json } from '@/strings/messages/RecipeExportModal__copy_recipe_json/de';
import { RecipeExportModal__description } from '@/strings/messages/RecipeExportModal__description/de';
import { RecipeExportModal__include_custom_instructions_in_the_recipe } from '@/strings/messages/RecipeExportModal__include_custom_instructions_in_the_recipe/de';
import { RecipeExportModal__invalid_regular_expression } from '@/strings/messages/RecipeExportModal__invalid_regular_expression/de';
import { RecipeExportModal__live_recipe_preview } from '@/strings/messages/RecipeExportModal__live_recipe_preview/de';
import { RecipeExportModal__model_matching_rules_regex } from '@/strings/messages/RecipeExportModal__model_matching_rules_regex/de';
import { RecipeExportModal__no_matching_rules_recipe_will_use_the_default_model } from '@/strings/messages/RecipeExportModal__no_matching_rules_recipe_will_use_the_default_model/de';
import { RecipeExportModal__override } from '@/strings/messages/RecipeExportModal__override/de';
import { RecipeExportModal__parent_prompt_cleared } from '@/strings/messages/RecipeExportModal__parent_prompt_cleared/de';
import { RecipeExportModal__recipe_editor } from '@/strings/messages/RecipeExportModal__recipe_editor/de';
import { RecipeExportModal__recipe_name } from '@/strings/messages/RecipeExportModal__recipe_name/de';
import { RecipeExportModal__recipe_system_prompt } from '@/strings/messages/RecipeExportModal__recipe_system_prompt/de';
import { RecipeExportModal__regex } from '@/strings/messages/RecipeExportModal__regex/de';
import { RecipeExportModal__temperature_top_p_and_other_lm_parameters_are_automatically_included_from_your_current_group_overrides } from '@/strings/messages/RecipeExportModal__temperature_top_p_and_other_lm_parameters_are_automatically_included_from_your_current_group_overrides/de';
import { RecipeExportModal__this_recipe_will_explicitly_clear_any_inherited_system_instructions } from '@/strings/messages/RecipeExportModal__this_recipe_will_explicitly_clear_any_inherited_system_instructions/de';
import { RecipeExportModal__toggle_case_sensitivity } from '@/strings/messages/RecipeExportModal__toggle_case_sensitivity/de';
import { RecipeExportModal__what_makes_this_recipe_special } from '@/strings/messages/RecipeExportModal__what_makes_this_recipe_special/de';
import { RecipeImportTab__chat_group_name } from '@/strings/messages/RecipeImportTab__chat_group_name/de';
import { RecipeImportTab__detected_recipes } from '@/strings/messages/RecipeImportTab__detected_recipes/de';
import { RecipeImportTab__import_chat_group_recipes } from '@/strings/messages/RecipeImportTab__import_chat_group_recipes/de';
import { RecipeImportTab__import_selected } from '@/strings/messages/RecipeImportTab__import_selected/de';
import { RecipeImportTab__model_selection } from '@/strings/messages/RecipeImportTab__model_selection/de';
import { RecipeImportTab__paste_recipe_json_concatenated_json_objects_supported } from '@/strings/messages/RecipeImportTab__paste_recipe_json_concatenated_json_objects_supported/de';
import { RecipeImportTab__recipes } from '@/strings/messages/RecipeImportTab__recipes/de';
import { RecipeImportTab__system_prompt } from '@/strings/messages/RecipeImportTab__system_prompt/de';
import { RecipeImportTab__use_default_model } from '@/strings/messages/RecipeImportTab__use_default_model/de';
import { RelativeTime__days_ago } from '@/strings/messages/RelativeTime__days_ago/de';
import { RelativeTime__hours_ago } from '@/strings/messages/RelativeTime__hours_ago/de';
import { RelativeTime__just_now } from '@/strings/messages/RelativeTime__just_now/de';
import { RelativeTime__minutes_ago } from '@/strings/messages/RelativeTime__minutes_ago/de';
import { RelativeTime__seconds_ago } from '@/strings/messages/RelativeTime__seconds_ago/de';
import { SearchPreview__alt_branch } from '@/strings/messages/SearchPreview__alt_branch/de';
import { SearchPreview__conversation_match } from '@/strings/messages/SearchPreview__conversation_match/de';
import { SearchPreview__following_messages } from '@/strings/messages/SearchPreview__following_messages/de';
import { SearchPreview__message_count } from '@/strings/messages/SearchPreview__message_count/de';
import { SearchPreview__previous_messages } from '@/strings/messages/SearchPreview__previous_messages/de';
import { SearchPreview__recent_history } from '@/strings/messages/SearchPreview__recent_history/de';
import { SearchPreview__select_an_item_to_preview } from '@/strings/messages/SearchPreview__select_an_item_to_preview/de';
import { ServerSetupGuide__download_the_installer_from_the_official_website } from '@/strings/messages/ServerSetupGuide__download_the_installer_from_the_official_website/de';
import { ServerSetupGuide__download_the_latest_binary_or_build_from_source } from '@/strings/messages/ServerSetupGuide__download_the_latest_binary_or_build_from_source/de';
import { ServerSetupGuide__external } from '@/strings/messages/ServerSetupGuide__external/de';
import { ServerSetupGuide__install_using_homebrew } from '@/strings/messages/ServerSetupGuide__install_using_homebrew/de';
import { ServerSetupGuide__releases } from '@/strings/messages/ServerSetupGuide__releases/de';
import { ServerSetupGuide__run_gemma_3n } from '@/strings/messages/ServerSetupGuide__run_gemma_3n/de';
import { ServerSetupGuide__run_the_installation_script } from '@/strings/messages/ServerSetupGuide__run_the_installation_script/de';
import { ServerSetupGuide__start_server } from '@/strings/messages/ServerSetupGuide__start_server/de';
import { SettingsModal__about } from '@/strings/messages/SettingsModal__about/de';
import { SettingsModal__connection } from '@/strings/messages/SettingsModal__connection/de';
import { SettingsModal__developer } from '@/strings/messages/SettingsModal__developer/de';
import { SettingsModal__discard } from '@/strings/messages/SettingsModal__discard/de';
import { SettingsModal__discard_unsaved_changes } from '@/strings/messages/SettingsModal__discard_unsaved_changes/de';
import { SettingsModal__discard_unsaved_connection_changes } from '@/strings/messages/SettingsModal__discard_unsaved_connection_changes/de';
import { SettingsModal__failed_to_import_recipes } from '@/strings/messages/SettingsModal__failed_to_import_recipes/de';
import { SettingsModal__files } from '@/strings/messages/SettingsModal__files/de';
import { SettingsModal__folders } from '@/strings/messages/SettingsModal__folders/de';
import { SettingsModal__keep_editing } from '@/strings/messages/SettingsModal__keep_editing/de';
import { SettingsModal__provider_profiles } from '@/strings/messages/SettingsModal__provider_profiles/de';
import { SettingsModal__recipes } from '@/strings/messages/SettingsModal__recipes/de';
import { SettingsModal__settings } from '@/strings/messages/SettingsModal__settings/de';
import { SettingsModal__standalone } from '@/strings/messages/SettingsModal__standalone/de';
import { SettingsModal__storage } from '@/strings/messages/SettingsModal__storage/de';
import { SettingsModal__successfully_imported_recipes_as_chat_groups } from '@/strings/messages/SettingsModal__successfully_imported_recipes_as_chat_groups/de';
import { SettingsModal__tools } from '@/strings/messages/SettingsModal__tools/de';
import { SettingsModal__transformers_js } from '@/strings/messages/SettingsModal__transformers_js/de';
import { SidebarDebugControls__debug_events } from '@/strings/messages/SidebarDebugControls__debug_events/de';
import { SidebarDebugControls__file_explorer } from '@/strings/messages/SidebarDebugControls__file_explorer/de';
import { SidebarDebugControls__more_actions } from '@/strings/messages/SidebarDebugControls__more_actions/de';
import { SidebarDebugControls__quick_access } from '@/strings/messages/SidebarDebugControls__quick_access/de';
import { SidebarDebugControls__recent_chats } from '@/strings/messages/SidebarDebugControls__recent_chats/de';
import { SidebarDebugControls__wesh_terminal } from '@/strings/messages/SidebarDebugControls__wesh_terminal/de';
import { Sidebar__add_chat } from '@/strings/messages/Sidebar__add_chat/de';
import { Sidebar__cancel } from '@/strings/messages/Sidebar__cancel/de';
import { Sidebar__close_sidebar } from '@/strings/messages/Sidebar__close_sidebar/de';
import { Sidebar__create_chat_group } from '@/strings/messages/Sidebar__create_chat_group/de';
import { Sidebar__current_group } from '@/strings/messages/Sidebar__current_group/de';
import { Sidebar__default_model } from '@/strings/messages/Sidebar__default_model/de';
import { Sidebar__delete_group } from '@/strings/messages/Sidebar__delete_group/de';
import { Sidebar__delete_group_question } from '@/strings/messages/Sidebar__delete_group_question/de';
import { Sidebar__delete_group_warning } from '@/strings/messages/Sidebar__delete_group_warning/de';
import { Sidebar__ephemeral_session } from '@/strings/messages/Sidebar__ephemeral_session/de';
import { Sidebar__group_name } from '@/strings/messages/Sidebar__group_name/de';
import { Sidebar__new_chat_in_group } from '@/strings/messages/Sidebar__new_chat_in_group/de';
import { Sidebar__none } from '@/strings/messages/Sidebar__none/de';
import { Sidebar__open_sidebar } from '@/strings/messages/Sidebar__open_sidebar/de';
import { Sidebar__rename_group } from '@/strings/messages/Sidebar__rename_group/de';
import { Sidebar__search_cmd_k } from '@/strings/messages/Sidebar__search_cmd_k/de';
import { Sidebar__select_default_model } from '@/strings/messages/Sidebar__select_default_model/de';
import { Sidebar__settings } from '@/strings/messages/Sidebar__settings/de';
import { Sidebar__show_less } from '@/strings/messages/Sidebar__show_less/de';
import { Sidebar__show_more } from '@/strings/messages/Sidebar__show_more/de';
import { SpeechControl__pause } from '@/strings/messages/SpeechControl__pause/de';
import { SpeechControl__read_aloud } from '@/strings/messages/SpeechControl__read_aloud/de';
import { SpeechControl__restart } from '@/strings/messages/SpeechControl__restart/de';
import { SpeechControl__resume } from '@/strings/messages/SpeechControl__resume/de';
import { SpeechControl__stop } from '@/strings/messages/SpeechControl__stop/de';
import { SpeechLanguageSelector__auto } from '@/strings/messages/SpeechLanguageSelector__auto/de';
import { SpeechLanguageSelector__auto_detect } from '@/strings/messages/SpeechLanguageSelector__auto_detect/de';
import { SpeechLanguageSelector__auto_detect_with_language } from '@/strings/messages/SpeechLanguageSelector__auto_detect_with_language/de';
import { SpeechLanguageSelector__english } from '@/strings/messages/SpeechLanguageSelector__english/de';
import { SpeechLanguageSelector__language } from '@/strings/messages/SpeechLanguageSelector__language/de';
import { SpeechLanguageSelector__redetect_language } from '@/strings/messages/SpeechLanguageSelector__redetect_language/de';
import { StandaloneVerificationPage__checks_file_protocol_startup_routing_styles_lazy_chunks_systemjs_and_repeated_worker_creation_without_changing_chats_or_settings } from '@/strings/messages/StandaloneVerificationPage__checks_file_protocol_startup_routing_styles_lazy_chunks_systemjs_and_repeated_worker_creation_without_changing_chats_or_settings/de';
import { StandaloneVerificationPage__copied_diagnostics_may_contain_local_file_paths_in_browser_provided_error_stacks_or_resource_timing_entries } from '@/strings/messages/StandaloneVerificationPage__copied_diagnostics_may_contain_local_file_paths_in_browser_provided_error_stacks_or_resource_timing_entries/de';
import { StandaloneVerificationPage__copy_json } from '@/strings/messages/StandaloneVerificationPage__copy_json/de';
import { StandaloneVerificationPage__failed_to_copy_verification_json } from '@/strings/messages/StandaloneVerificationPage__failed_to_copy_verification_json/de';
import { StandaloneVerificationPage__run_standalone_verification } from '@/strings/messages/StandaloneVerificationPage__run_standalone_verification/de';
import { StandaloneVerificationPage__running } from '@/strings/messages/StandaloneVerificationPage__running/de';
import { StandaloneVerificationPage__standalone_verification } from '@/strings/messages/StandaloneVerificationPage__standalone_verification/de';
import { StandaloneVerificationPage__standalone_verification_json_copied } from '@/strings/messages/StandaloneVerificationPage__standalone_verification_json_copied/de';
import { StandaloneVerificationPage__these_checks_require_a_standalone_build_opened_through_file } from '@/strings/messages/StandaloneVerificationPage__these_checks_require_a_standalone_build_opened_through_file/de';
import { StandaloneVerificationPage__verification_failed_to_run } from '@/strings/messages/StandaloneVerificationPage__verification_failed_to_run/de';
import { StandaloneVerificationPage__verification_summary } from '@/strings/messages/StandaloneVerificationPage__verification_summary/de';
import { StorageService__an_error_occurred_during_a_storage_operation } from '@/strings/messages/StorageService__an_error_occurred_during_a_storage_operation/de';
import { StorageTab__active } from '@/strings/messages/StorageTab__active/de';
import { StorageTab__active_storage_provider } from '@/strings/messages/StorageTab__active_storage_provider/de';
import { StorageTab__attachments_will_be_inaccessible } from '@/strings/messages/StorageTab__attachments_will_be_inaccessible/de';
import { StorageTab__backup_and_restore } from '@/strings/messages/StorageTab__backup_and_restore/de';
import { StorageTab__backup_restore_description } from '@/strings/messages/StorageTab__backup_restore_description/de';
import { StorageTab__best_effort } from '@/strings/messages/StorageTab__best_effort/de';
import { StorageTab__browser_declined_persistence } from '@/strings/messages/StorageTab__browser_declined_persistence/de';
import { StorageTab__checking } from '@/strings/messages/StorageTab__checking/de';
import { StorageTab__clear_all } from '@/strings/messages/StorageTab__clear_all/de';
import { StorageTab__clear_all_conversation_history } from '@/strings/messages/StorageTab__clear_all_conversation_history/de';
import { StorageTab__clear_conversation_history } from '@/strings/messages/StorageTab__clear_conversation_history/de';
import { StorageTab__clear_history } from '@/strings/messages/StorageTab__clear_history/de';
import { StorageTab__clear_history_description } from '@/strings/messages/StorageTab__clear_history_description/de';
import { StorageTab__confirm_storage_switch } from '@/strings/messages/StorageTab__confirm_storage_switch/de';
import { StorageTab__confirm_switch_to_storage } from '@/strings/messages/StorageTab__confirm_switch_to_storage/de';
import { StorageTab__copy_link } from '@/strings/messages/StorageTab__copy_link/de';
import { StorageTab__data_cleanup } from '@/strings/messages/StorageTab__data_cleanup/de';
import { StorageTab__data_durability } from '@/strings/messages/StorageTab__data_durability/de';
import { StorageTab__delete_all_chats_warning } from '@/strings/messages/StorageTab__delete_all_chats_warning/de';
import { StorageTab__enable } from '@/strings/messages/StorageTab__enable/de';
import { StorageTab__ephemeral } from '@/strings/messages/StorageTab__ephemeral/de';
import { StorageTab__ephemeral_description } from '@/strings/messages/StorageTab__ephemeral_description/de';
import { StorageTab__error } from '@/strings/messages/StorageTab__error/de';
import { StorageTab__exclude_attachments } from '@/strings/messages/StorageTab__exclude_attachments/de';
import { StorageTab__exclude_chat_history } from '@/strings/messages/StorageTab__exclude_chat_history/de';
import { StorageTab__exclude_chats } from '@/strings/messages/StorageTab__exclude_chats/de';
import { StorageTab__experimental } from '@/strings/messages/StorageTab__experimental/de';
import { StorageTab__export_import } from '@/strings/messages/StorageTab__export_import/de';
import { StorageTab__export_url_copied } from '@/strings/messages/StorageTab__export_url_copied/de';
import { StorageTab__failed_to_enable_persistence } from '@/strings/messages/StorageTab__failed_to_enable_persistence/de';
import { StorageTab__failed_to_generate_export_url } from '@/strings/messages/StorageTab__failed_to_generate_export_url/de';
import { StorageTab__failed_to_migrate_data } from '@/strings/messages/StorageTab__failed_to_migrate_data/de';
import { StorageTab__generating } from '@/strings/messages/StorageTab__generating/de';
import { StorageTab__large_storage_link_warning } from '@/strings/messages/StorageTab__large_storage_link_warning/de';
import { StorageTab__local_storage } from '@/strings/messages/StorageTab__local_storage/de';
import { StorageTab__local_storage_description } from '@/strings/messages/StorageTab__local_storage_description/de';
import { StorageTab__local_storage_loses_attachments } from '@/strings/messages/StorageTab__local_storage_loses_attachments/de';
import { StorageTab__manage_data } from '@/strings/messages/StorageTab__manage_data/de';
import { StorageTab__migration_failed } from '@/strings/messages/StorageTab__migration_failed/de';
import { StorageTab__not_supported } from '@/strings/messages/StorageTab__not_supported/de';
import { StorageTab__opfs_description } from '@/strings/messages/StorageTab__opfs_description/de';
import { StorageTab__origin_private_file_system } from '@/strings/messages/StorageTab__origin_private_file_system/de';
import { StorageTab__persistence_denied } from '@/strings/messages/StorageTab__persistence_denied/de';
import { StorageTab__persistent_storage } from '@/strings/messages/StorageTab__persistent_storage/de';
import { StorageTab__persistent_storage_description } from '@/strings/messages/StorageTab__persistent_storage_description/de';
import { StorageTab__persistent_storage_not_supported } from '@/strings/messages/StorageTab__persistent_storage_not_supported/de';
import { StorageTab__protected } from '@/strings/messages/StorageTab__protected/de';
import { StorageTab__recommended } from '@/strings/messages/StorageTab__recommended/de';
import { StorageTab__share_url_description } from '@/strings/messages/StorageTab__share_url_description/de';
import { StorageTab__share_via_url } from '@/strings/messages/StorageTab__share_via_url/de';
import { StorageTab__storage_management } from '@/strings/messages/StorageTab__storage_management/de';
import { StorageTab__storage_migration_description } from '@/strings/messages/StorageTab__storage_migration_description/de';
import { StorageTab__switch_and_lose_attachments } from '@/strings/messages/StorageTab__switch_and_lose_attachments/de';
import { StorageTab__switch_and_migrate } from '@/strings/messages/StorageTab__switch_and_migrate/de';
import { StorageTab__understand } from '@/strings/messages/StorageTab__understand/de';
import { StorageTab__unsupported } from '@/strings/messages/StorageTab__unsupported/de';
import { ThemeToggle__dark_mode } from '@/strings/messages/ThemeToggle__dark_mode/de';
import { ThemeToggle__light_mode } from '@/strings/messages/ThemeToggle__light_mode/de';
import { ThemeToggle__system_mode } from '@/strings/messages/ThemeToggle__system_mode/de';
import { ToolCallGroupItem__used_tools } from '@/strings/messages/ToolCallGroupItem__used_tools/de';
import { ToolConfigHierarchySettings__access_global_knowledge } from '@/strings/messages/ToolConfigHierarchySettings__access_global_knowledge/de';
import { ToolConfigHierarchySettings__calculator } from '@/strings/messages/ToolConfigHierarchySettings__calculator/de';
import { ToolConfigHierarchySettings__choices } from '@/strings/messages/ToolConfigHierarchySettings__choices/de';
import { ToolConfigHierarchySettings__choose_from_model_provided_options } from '@/strings/messages/ToolConfigHierarchySettings__choose_from_model_provided_options/de';
import { ToolConfigHierarchySettings__off } from '@/strings/messages/ToolConfigHierarchySettings__off/de';
import { ToolConfigHierarchySettings__on } from '@/strings/messages/ToolConfigHierarchySettings__on/de';
import { ToolConfigHierarchySettings__reset_to_defaults } from '@/strings/messages/ToolConfigHierarchySettings__reset_to_defaults/de';
import { ToolConfigHierarchySettings__shell } from '@/strings/messages/ToolConfigHierarchySettings__shell/de';
import { ToolConfigHierarchySettings__shell_in_browser } from '@/strings/messages/ToolConfigHierarchySettings__shell_in_browser/de';
import { ToolConfigHierarchySettings__shell_settings } from '@/strings/messages/ToolConfigHierarchySettings__shell_settings/de';
import { ToolConfigHierarchySettings__solve_math_expressions } from '@/strings/messages/ToolConfigHierarchySettings__solve_math_expressions/de';
import { ToolConfigHierarchySettings__tool_config_persistence_is_disabled_saved_settings_remain_active_but_changes_cannot_be_saved_here } from '@/strings/messages/ToolConfigHierarchySettings__tool_config_persistence_is_disabled_saved_settings_remain_active_but_changes_cannot_be_saved_here/de';
import { ToolConfigHierarchySettings__turn_off_tool } from '@/strings/messages/ToolConfigHierarchySettings__turn_off_tool/de';
import { ToolConfigHierarchySettings__turn_on_tool } from '@/strings/messages/ToolConfigHierarchySettings__turn_on_tool/de';
import { ToolConfigHierarchySettings__use_global } from '@/strings/messages/ToolConfigHierarchySettings__use_global/de';
import { ToolConfigHierarchySettings__use_group } from '@/strings/messages/ToolConfigHierarchySettings__use_group/de';
import { ToolConfigHierarchySettings__wikipedia } from '@/strings/messages/ToolConfigHierarchySettings__wikipedia/de';
import { TransformersJsLoadingIndicator__downloading_model } from '@/strings/messages/TransformersJsLoadingIndicator__downloading_model/de';
import { TransformersJsLoadingIndicator__downloading_model_weights_from_hugging_face_this_only_happens_once_per_model } from '@/strings/messages/TransformersJsLoadingIndicator__downloading_model_weights_from_hugging_face_this_only_happens_once_per_model/de';
import { TransformersJsLoadingIndicator__initializing_model } from '@/strings/messages/TransformersJsLoadingIndicator__initializing_model/de';
import { TransformersJsLoadingIndicator__loading_model_progress } from '@/strings/messages/TransformersJsLoadingIndicator__loading_model_progress/de';
import { TransformersJsLoadingIndicator__loading_model_weights_into_browser_memory_for_local_inference } from '@/strings/messages/TransformersJsLoadingIndicator__loading_model_weights_into_browser_memory_for_local_inference/de';
import { TransformersJsLoadingIndicator__model } from '@/strings/messages/TransformersJsLoadingIndicator__model/de';
import { TransformersJsLoadingIndicator__on_device_execution } from '@/strings/messages/TransformersJsLoadingIndicator__on_device_execution/de';
import { TransformersJsLoadingIndicator__transformers_js_error } from '@/strings/messages/TransformersJsLoadingIndicator__transformers_js_error/de';
import { ModelSupportInvestigationModal__blocked } from '@/strings/messages/ModelSupportInvestigationModal__blocked/de';
import { ModelSupportInvestigationModal__candidate_eligible } from '@/strings/messages/ModelSupportInvestigationModal__candidate_eligible/de';
import { ModelSupportInvestigationModal__candidate_ineligible } from '@/strings/messages/ModelSupportInvestigationModal__candidate_ineligible/de';
import { ModelSupportInvestigationModal__candidate_plan_summary } from '@/strings/messages/ModelSupportInvestigationModal__candidate_plan_summary/de';
import { ModelSupportInvestigationModal__candidate_registry_failed } from '@/strings/messages/ModelSupportInvestigationModal__candidate_registry_failed/de';
import { ModelSupportInvestigationModal__model_file_plan } from '@/strings/messages/ModelSupportInvestigationModal__model_file_plan/de';
import { ModelSupportInvestigationModal__model_file_plan_summary } from '@/strings/messages/ModelSupportInvestigationModal__model_file_plan_summary/de';
import { ModelSupportInvestigationModal__cache_revision_unknown } from '@/strings/messages/ModelSupportInvestigationModal__cache_revision_unknown/de';
import { ModelSupportInvestigationModal__checking_same_origin_runtime_assets } from '@/strings/messages/ModelSupportInvestigationModal__checking_same_origin_runtime_assets/de';
import { ModelSupportInvestigationModal__close } from '@/strings/messages/ModelSupportInvestigationModal__close/de';
import { ModelSupportInvestigationModal__current_operation } from '@/strings/messages/ModelSupportInvestigationModal__current_operation/de';
import { ModelSupportInvestigationModal__declaration_files_summary } from '@/strings/messages/ModelSupportInvestigationModal__declaration_files_summary/de';
import { ModelSupportInvestigationModal__download_partial_evidence } from '@/strings/messages/ModelSupportInvestigationModal__download_partial_evidence/de';
import { ModelSupportInvestigationModal__evidence_export } from '@/strings/messages/ModelSupportInvestigationModal__evidence_export/de';
import { ModelSupportInvestigationModal__environment_evidence_disclosure } from '@/strings/messages/ModelSupportInvestigationModal__environment_evidence_disclosure/de';
import { ModelSupportInvestigationModal__evidence_readiness } from '@/strings/messages/ModelSupportInvestigationModal__evidence_readiness/de';
import { ModelSupportInvestigationModal__evidence_readiness_summary } from '@/strings/messages/ModelSupportInvestigationModal__evidence_readiness_summary/de';
import { ModelSupportInvestigationModal__existing_model_data } from '@/strings/messages/ModelSupportInvestigationModal__existing_model_data/de';
import { ModelSupportInvestigationModal__failed } from '@/strings/messages/ModelSupportInvestigationModal__failed/de';
import { ModelSupportInvestigationModal__findings } from '@/strings/messages/ModelSupportInvestigationModal__findings/de';
import { ModelSupportInvestigationModal__loading_investigation } from '@/strings/messages/ModelSupportInvestigationModal__loading_investigation/de';
import { ModelSupportInvestigationModal__lane_comparison } from '@/strings/messages/ModelSupportInvestigationModal__lane_comparison/de';
import { ModelSupportInvestigationModal__lane_continuity_failed } from '@/strings/messages/ModelSupportInvestigationModal__lane_continuity_failed/de';
import { ModelSupportInvestigationModal__lane_continuity_summary } from '@/strings/messages/ModelSupportInvestigationModal__lane_continuity_summary/de';
import { ModelSupportInvestigationModal__lane_failed } from '@/strings/messages/ModelSupportInvestigationModal__lane_failed/de';
import { ModelSupportInvestigationModal__lane_input_match } from '@/strings/messages/ModelSupportInvestigationModal__lane_input_match/de';
import { ModelSupportInvestigationModal__lane_input_mismatch } from '@/strings/messages/ModelSupportInvestigationModal__lane_input_mismatch/de';
import { ModelSupportInvestigationModal__lane_route_summary } from '@/strings/messages/ModelSupportInvestigationModal__lane_route_summary/de';
import { ModelSupportInvestigationModal__multimodal_failed } from '@/strings/messages/ModelSupportInvestigationModal__multimodal_failed/de';
import { ModelSupportInvestigationModal__multimodal_observed } from '@/strings/messages/ModelSupportInvestigationModal__multimodal_observed/de';
import { ModelSupportInvestigationModal__multimodal_unavailable } from '@/strings/messages/ModelSupportInvestigationModal__multimodal_unavailable/de';
import { ModelSupportInvestigationModal__reasoning_differential_failed } from '@/strings/messages/ModelSupportInvestigationModal__reasoning_differential_failed/de';
import { ModelSupportInvestigationModal__reasoning_differential_observed } from '@/strings/messages/ModelSupportInvestigationModal__reasoning_differential_observed/de';
import { ModelSupportInvestigationModal__reasoning_differential_unavailable } from '@/strings/messages/ModelSupportInvestigationModal__reasoning_differential_unavailable/de';
import { ModelSupportInvestigationModal__model_declarations } from '@/strings/messages/ModelSupportInvestigationModal__model_declarations/de';
import { ModelSupportInvestigationModal__model_support_investigation } from '@/strings/messages/ModelSupportInvestigationModal__model_support_investigation/de';
import { ModelSupportInvestigationModal__missing_model_type } from '@/strings/messages/ModelSupportInvestigationModal__missing_model_type/de';
import { ModelSupportInvestigationModal__model_type } from '@/strings/messages/ModelSupportInvestigationModal__model_type/de';
import { ModelSupportInvestigationModal__no_supported_auto_classes } from '@/strings/messages/ModelSupportInvestigationModal__no_supported_auto_classes/de';
import { ModelSupportInvestigationModal__not_run } from '@/strings/messages/ModelSupportInvestigationModal__not_run/de';
import { ModelSupportInvestigationModal__opfs_inventory } from '@/strings/messages/ModelSupportInvestigationModal__opfs_inventory/de';
import { ModelSupportInvestigationModal__opfs_inventory_summary } from '@/strings/messages/ModelSupportInvestigationModal__opfs_inventory_summary/de';
import { ModelSupportInvestigationModal__passed } from '@/strings/messages/ModelSupportInvestigationModal__passed/de';
import { ModelSupportInvestigationModal__repository } from '@/strings/messages/ModelSupportInvestigationModal__repository/de';
import { ModelSupportInvestigationModal__repository_information } from '@/strings/messages/ModelSupportInvestigationModal__repository_information/de';
import { ModelSupportInvestigationModal__repository_summary } from '@/strings/messages/ModelSupportInvestigationModal__repository_summary/de';
import { ModelSupportInvestigationModal__running } from '@/strings/messages/ModelSupportInvestigationModal__running/de';
import { ModelSupportInvestigationModal__runtime_assets } from '@/strings/messages/ModelSupportInvestigationModal__runtime_assets/de';
import { ModelSupportInvestigationModal__runtime_control_webgpu } from '@/strings/messages/ModelSupportInvestigationModal__runtime_control_webgpu/de';
import { ModelSupportInvestigationModal__runtime_no_output } from '@/strings/messages/ModelSupportInvestigationModal__runtime_no_output/de';
import { ModelSupportInvestigationModal__runtime_bytes } from '@/strings/messages/ModelSupportInvestigationModal__runtime_bytes/de';
import { ModelSupportInvestigationModal__runtime_control } from '@/strings/messages/ModelSupportInvestigationModal__runtime_control/de';
import { ModelSupportInvestigationModal__runtime_environment } from '@/strings/messages/ModelSupportInvestigationModal__runtime_environment/de';
import { ModelSupportInvestigationModal__runtime_environment_summary } from '@/strings/messages/ModelSupportInvestigationModal__runtime_environment_summary/de';
import { ModelSupportInvestigationModal__runtime_mjs } from '@/strings/messages/ModelSupportInvestigationModal__runtime_mjs/de';
import { ModelSupportInvestigationModal__runtime_variant } from '@/strings/messages/ModelSupportInvestigationModal__runtime_variant/de';
import { ModelSupportInvestigationModal__runtime_wasm } from '@/strings/messages/ModelSupportInvestigationModal__runtime_wasm/de';
import { ModelSupportInvestigationModal__supported_auto_classes } from '@/strings/messages/ModelSupportInvestigationModal__supported_auto_classes/de';
import { ModelSupportInvestigationModal__support_boundary } from '@/strings/messages/ModelSupportInvestigationModal__support_boundary/de';
import { ModelSupportInvestigationModal__support_boundary_summary } from '@/strings/messages/ModelSupportInvestigationModal__support_boundary_summary/de';
import { ModelSupportInvestigationModal__template_behavior } from '@/strings/messages/ModelSupportInvestigationModal__template_behavior/de';
import { ModelSupportInvestigationModal__template_behavior_summary } from '@/strings/messages/ModelSupportInvestigationModal__template_behavior_summary/de';
import { ModelSupportInvestigationModal__tool_protocol_probe_summary } from '@/strings/messages/ModelSupportInvestigationModal__tool_protocol_probe_summary/de';
import { ModelSupportInvestigationModal__tool_result_production_continuation_failed } from '@/strings/messages/ModelSupportInvestigationModal__tool_result_production_continuation_failed/de';
import { ModelSupportInvestigationModal__tool_result_production_continuation_passed } from '@/strings/messages/ModelSupportInvestigationModal__tool_result_production_continuation_passed/de';
import { ModelSupportInvestigationModal__tool_template_provenance_summary } from '@/strings/messages/ModelSupportInvestigationModal__tool_template_provenance_summary/de';
import { ModelSupportInvestigationModal__this_is_partial_evidence } from '@/strings/messages/ModelSupportInvestigationModal__this_is_partial_evidence/de';
import { TransformersJsManager__investigate } from '@/strings/messages/TransformersJsManager__investigate/de';
import { TransformersJsManager__active } from '@/strings/messages/TransformersJsManager__active/de';
import { TransformersJsManager__active_model } from '@/strings/messages/TransformersJsManager__active_model/de';
import { TransformersJsManager__add_new_models } from '@/strings/messages/TransformersJsManager__add_new_models/de';
import { TransformersJsManager__ai_engine_worker_restarted_successfully } from '@/strings/messages/TransformersJsManager__ai_engine_worker_restarted_successfully/de';
import { TransformersJsManager__asset_details } from '@/strings/messages/TransformersJsManager__asset_details/de';
import { TransformersJsManager__browsers_often_disable_the } from '@/strings/messages/TransformersJsManager__browsers_often_disable_the/de';
import { TransformersJsManager__cache_api } from '@/strings/messages/TransformersJsManager__cache_api/de';
import { TransformersJsManager__could_not_determine_a_valid_model_name_from_folder_structure } from '@/strings/messages/TransformersJsManager__could_not_determine_a_valid_model_name_from_folder_structure/de';
import { TransformersJsManager__delete } from '@/strings/messages/TransformersJsManager__delete/de';
import { TransformersJsManager__delete_downloaded_model } from '@/strings/messages/TransformersJsManager__delete_downloaded_model/de';
import { TransformersJsManager__delete_failed } from '@/strings/messages/TransformersJsManager__delete_failed/de';
import { TransformersJsManager__delete_model } from '@/strings/messages/TransformersJsManager__delete_model/de';
import { TransformersJsManager__delete_model_warning } from '@/strings/messages/TransformersJsManager__delete_model_warning/de';
import { TransformersJsManager__deleted_model } from '@/strings/messages/TransformersJsManager__deleted_model/de';
import { TransformersJsManager__download_failed } from '@/strings/messages/TransformersJsManager__download_failed/de';
import { TransformersJsManager__download_failed_check_details_in_the_section_below } from '@/strings/messages/TransformersJsManager__download_failed_check_details_in_the_section_below/de';
import { TransformersJsManager__download_from_hugging_face } from '@/strings/messages/TransformersJsManager__download_from_hugging_face/de';
import { TransformersJsManager__download_model } from '@/strings/messages/TransformersJsManager__download_model/de';
import { TransformersJsManager__downloaded_models } from '@/strings/messages/TransformersJsManager__downloaded_models/de';
import { TransformersJsManager__downloading_and_compiling } from '@/strings/messages/TransformersJsManager__downloading_and_compiling/de';
import { TransformersJsManager__engine_control } from '@/strings/messages/TransformersJsManager__engine_control/de';
import { TransformersJsManager__engine_idle } from '@/strings/messages/TransformersJsManager__engine_idle/de';
import { TransformersJsManager__engine_ready } from '@/strings/messages/TransformersJsManager__engine_ready/de';
import { TransformersJsManager__engine_unloaded_and_resources_released } from '@/strings/messages/TransformersJsManager__engine_unloaded_and_resources_released/de';
import { TransformersJsManager__enter_hugging_face_model_id_e_g_onnx_community_phi_4 } from '@/strings/messages/TransformersJsManager__enter_hugging_face_model_id_e_g_onnx_community_phi_4/de';
import { TransformersJsManager__error } from '@/strings/messages/TransformersJsManager__error/de';
import { TransformersJsManager__filter_downloaded_models } from '@/strings/messages/TransformersJsManager__filter_downloaded_models/de';
import { TransformersJsManager__find_more_models } from '@/strings/messages/TransformersJsManager__find_more_models/de';
import { TransformersJsManager__for_local_file_urls_to_avoid_downloading_models_on_every_reload_use_a_local_web_server_or_the_hosted_version } from '@/strings/messages/TransformersJsManager__for_local_file_urls_to_avoid_downloading_models_on_every_reload_use_a_local_web_server_or_the_hosted_version/de';
import { TransformersJsManager__get_hosted_version_github } from '@/strings/messages/TransformersJsManager__get_hosted_version_github/de';
import { TransformersJsManager__hard_restart_ai_worker_engine } from '@/strings/messages/TransformersJsManager__hard_restart_ai_worker_engine/de';
import { TransformersJsManager__import_failed } from '@/strings/messages/TransformersJsManager__import_failed/de';
import { TransformersJsManager__import_from_local_files } from '@/strings/messages/TransformersJsManager__import_from_local_files/de';
import { TransformersJsManager__importing_local_model } from '@/strings/messages/TransformersJsManager__importing_local_model/de';
import { TransformersJsManager__in_browser_ai_transformers_js_is_not_available_because_the_browser_does_not_support_or_allow_access_to } from '@/strings/messages/TransformersJsManager__in_browser_ai_transformers_js_is_not_available_because_the_browser_does_not_support_or_allow_access_to/de';
import { TransformersJsManager__in_browser_ai_transformers_js_is_not_available_in_the_standalone_build_due_to_browser_restrictions_on_web_workers_and_webassembly_when_running_from_a_local_file } from '@/strings/messages/TransformersJsManager__in_browser_ai_transformers_js_is_not_available_in_the_standalone_build_due_to_browser_restrictions_on_web_workers_and_webassembly_when_running_from_a_local_file/de';
import { TransformersJsManager__incomplete } from '@/strings/messages/TransformersJsManager__incomplete/de';
import { TransformersJsManager__initializing_engine } from '@/strings/messages/TransformersJsManager__initializing_engine/de';
import { TransformersJsManager__load } from '@/strings/messages/TransformersJsManager__load/de';
import { TransformersJsManager__load_a_model_from_the_list_below_to_start_in_browser_inference } from '@/strings/messages/TransformersJsManager__load_a_model_from_the_list_below_to_start_in_browser_inference/de';
import { TransformersJsManager__loading_from_local_storage } from '@/strings/messages/TransformersJsManager__loading_from_local_storage/de';
import { TransformersJsManager__local_cache } from '@/strings/messages/TransformersJsManager__local_cache/de';
import { TransformersJsManager__model_is_already_downloaded } from '@/strings/messages/TransformersJsManager__model_is_already_downloaded/de';
import { TransformersJsManager__models_are_cached_locally_in_the_browser_opfs_for_offline_use } from '@/strings/messages/TransformersJsManager__models_are_cached_locally_in_the_browser_opfs_for_offline_use/de';
import { TransformersJsManager__no_models_downloaded_yet } from '@/strings/messages/TransformersJsManager__no_models_downloaded_yet/de';
import { TransformersJsManager__no_models_match_your_filter } from '@/strings/messages/TransformersJsManager__no_models_match_your_filter/de';
import { TransformersJsManager__note } from '@/strings/messages/TransformersJsManager__note/de';
import { TransformersJsManager__origin_private_file_system_opfs } from '@/strings/messages/TransformersJsManager__origin_private_file_system_opfs/de';
import { TransformersJsManager__overall_progress } from '@/strings/messages/TransformersJsManager__overall_progress/de';
import { TransformersJsManager__preset_model_paths } from '@/strings/messages/TransformersJsManager__preset_model_paths/de';
import { TransformersJsManager__refresh } from '@/strings/messages/TransformersJsManager__refresh/de';
import { TransformersJsManager__restart } from '@/strings/messages/TransformersJsManager__restart/de';
import { TransformersJsManager__restart_ai_engine } from '@/strings/messages/TransformersJsManager__restart_ai_engine/de';
import { TransformersJsManager__resume } from '@/strings/messages/TransformersJsManager__resume/de';
import { TransformersJsManager__select_a_folder_containing_onnx_model_files_to_import_it_into_the_browsers_storage } from '@/strings/messages/TransformersJsManager__select_a_folder_containing_onnx_model_files_to_import_it_into_the_browsers_storage/de';
import { TransformersJsManager__select_model_folder } from '@/strings/messages/TransformersJsManager__select_model_folder/de';
import { TransformersJsManager__successfully_downloaded_model } from '@/strings/messages/TransformersJsManager__successfully_downloaded_model/de';
import { TransformersJsManager__successfully_imported_model } from '@/strings/messages/TransformersJsManager__successfully_imported_model/de';
import { TransformersJsManager__this_will_terminate_the_current_background_worker_and_start_a_fresh_one_use_this_if_the_engine_becomes_unresponsive_or_shows_fatal_errors } from '@/strings/messages/TransformersJsManager__this_will_terminate_the_current_background_worker_and_start_a_fresh_one_use_this_if_the_engine_becomes_unresponsive_or_shows_fatal_errors/de';
import { TransformersJsManager__unknown } from '@/strings/messages/TransformersJsManager__unknown/de';
import { TransformersJsManager__unload_model_and_release_resources } from '@/strings/messages/TransformersJsManager__unload_model_and_release_resources/de';
import { TransformersJsManager__use_custom_id } from '@/strings/messages/TransformersJsManager__use_custom_id/de';
import { TransformersJsManager__which_is_required_for_storing_model_files_this_often_happens_in_private_browsing_modes_or_insecure_contexts } from '@/strings/messages/TransformersJsManager__which_is_required_for_storing_model_files_this_often_happens_in_private_browsing_modes_or_insecure_contexts/de';
import { TransformersJsManager__writing_model_files_to_browser_local_storage_opfs } from '@/strings/messages/TransformersJsManager__writing_model_files_to_browser_local_storage_opfs/de';
import { TransformersJsUpsell__add_manage_models } from '@/strings/messages/TransformersJsUpsell__add_manage_models/de';
import { TransformersJsUpsell__local_browser_models } from '@/strings/messages/TransformersJsUpsell__local_browser_models/de';
import { TransformersJsUpsell__need_more_models_you_can_download_and_manage_local_llms_to_run_directly_in_your_browser } from '@/strings/messages/TransformersJsUpsell__need_more_models_you_can_download_and_manage_local_llms_to_run_directly_in_your_browser/de';
import { UnselectedChatPane__select_or_create_a_chat_to_start } from '@/strings/messages/UnselectedChatPane__select_or_create_a_chat_to_start/de';
import { WelcomeScreen__all_conversations_are_stored_locally } from '@/strings/messages/WelcomeScreen__all_conversations_are_stored_locally/de';
import { WelcomeScreen__brainstorm } from '@/strings/messages/WelcomeScreen__brainstorm/de';
import { WelcomeScreen__code_help } from '@/strings/messages/WelcomeScreen__code_help/de';
import { WelcomeScreen__conversations_are_stored_in_memory } from '@/strings/messages/WelcomeScreen__conversations_are_stored_in_memory/de';
import { WelcomeScreen__data_is_cleared_on_reload } from '@/strings/messages/WelcomeScreen__data_is_cleared_on_reload/de';
import { WelcomeScreen__download_portable_app } from '@/strings/messages/WelcomeScreen__download_portable_app/de';
import { WelcomeScreen__download_standalone_portable_version } from '@/strings/messages/WelcomeScreen__download_standalone_portable_version/de';
import { WelcomeScreen__explain_vue_composition_api } from '@/strings/messages/WelcomeScreen__explain_vue_composition_api/de';
import { WelcomeScreen__home_automation_project_ideas } from '@/strings/messages/WelcomeScreen__home_automation_project_ideas/de';
import { WelcomeScreen__summarize } from '@/strings/messages/WelcomeScreen__summarize/de';
import { WelcomeScreen__summarize_local_lm_architectures } from '@/strings/messages/WelcomeScreen__summarize_local_lm_architectures/de';
import { WelcomeScreen__write_a_story } from '@/strings/messages/WelcomeScreen__write_a_story/de';
import { WelcomeScreen__write_a_time_travel_detective_story } from '@/strings/messages/WelcomeScreen__write_a_time_travel_detective_story/de';
import { WelcomeScreen__your_data_stays_on_your_device } from '@/strings/messages/WelcomeScreen__your_data_stays_on_your_device/de';
import { WeshToolSettings__shell } from '@/strings/messages/WeshToolSettings__shell/de';
import { WeshToolSettings__shell_in_browser } from '@/strings/messages/WeshToolSettings__shell_in_browser/de';
import { WeshToolSettings__shell_settings } from '@/strings/messages/WeshToolSettings__shell_settings/de';
import { advancedTextEditor__aa } from '@/strings/messages/advancedTextEditor__aa/de';
import { advancedTextEditor__cancel_esc } from '@/strings/messages/advancedTextEditor__cancel_esc/de';
import { advancedTextEditor__chars } from '@/strings/messages/advancedTextEditor__chars/de';
import { advancedTextEditor__clear_all } from '@/strings/messages/advancedTextEditor__clear_all/de';
import { advancedTextEditor__close_editor_esc } from '@/strings/messages/advancedTextEditor__close_editor_esc/de';
import { advancedTextEditor__confirm_enter } from '@/strings/messages/advancedTextEditor__confirm_enter/de';
import { advancedTextEditor__copy_all } from '@/strings/messages/advancedTextEditor__copy_all/de';
import { advancedTextEditor__enter } from '@/strings/messages/advancedTextEditor__enter/de';
import { advancedTextEditor__enter_to_find_next } from '@/strings/messages/advancedTextEditor__enter_to_find_next/de';
import { advancedTextEditor__esc } from '@/strings/messages/advancedTextEditor__esc/de';
import { advancedTextEditor__find_and_replace_with_shortcut } from '@/strings/messages/advancedTextEditor__find_and_replace_with_shortcut/de';
import { advancedTextEditor__instance_count } from '@/strings/messages/advancedTextEditor__instance_count/de';
import { advancedTextEditor__lines } from '@/strings/messages/advancedTextEditor__lines/de';
import { advancedTextEditor__match_case } from '@/strings/messages/advancedTextEditor__match_case/de';
import { advancedTextEditor__multi_edit_mode } from '@/strings/messages/advancedTextEditor__multi_edit_mode/de';
import { advancedTextEditor__multi_edit_occurrence_with_shortcut } from '@/strings/messages/advancedTextEditor__multi_edit_occurrence_with_shortcut/de';
import { advancedTextEditor__redo_with_shortcut } from '@/strings/messages/advancedTextEditor__redo_with_shortcut/de';
import { advancedTextEditor__renaming_text } from '@/strings/messages/advancedTextEditor__renaming_text/de';
import { advancedTextEditor__replace } from '@/strings/messages/advancedTextEditor__replace/de';
import { advancedTextEditor__replace_all } from '@/strings/messages/advancedTextEditor__replace_all/de';
import { advancedTextEditor__replace_with } from '@/strings/messages/advancedTextEditor__replace_with/de';
import { advancedTextEditor__search } from '@/strings/messages/advancedTextEditor__search/de';
import { advancedTextEditor__selection } from '@/strings/messages/advancedTextEditor__selection/de';
import { advancedTextEditor__steps } from '@/strings/messages/advancedTextEditor__steps/de';
import { advancedTextEditor__switch_to_advanced_editor } from '@/strings/messages/advancedTextEditor__switch_to_advanced_editor/de';
import { advancedTextEditor__switch_to_normal_textarea } from '@/strings/messages/advancedTextEditor__switch_to_normal_textarea/de';
import { advancedTextEditor__to_apply } from '@/strings/messages/advancedTextEditor__to_apply/de';
import { advancedTextEditor__to_cancel } from '@/strings/messages/advancedTextEditor__to_cancel/de';
import { advancedTextEditor__toggle_stats } from '@/strings/messages/advancedTextEditor__toggle_stats/de';
import { advancedTextEditor__toggle_word_wrap } from '@/strings/messages/advancedTextEditor__toggle_word_wrap/de';
import { advancedTextEditor__type_to_rename_all } from '@/strings/messages/advancedTextEditor__type_to_rename_all/de';
import { advancedTextEditor__type_to_replace_all } from '@/strings/messages/advancedTextEditor__type_to_replace_all/de';
import { advancedTextEditor__undo_with_shortcut } from '@/strings/messages/advancedTextEditor__undo_with_shortcut/de';
import { advancedTextEditor__updating } from '@/strings/messages/advancedTextEditor__updating/de';
import { advancedTextEditor__use_regex } from '@/strings/messages/advancedTextEditor__use_regex/de';
import { advancedTextEditor__words } from '@/strings/messages/advancedTextEditor__words/de';
import { binaryObjects__binary_objects } from '@/strings/messages/binaryObjects__binary_objects/de';
import { binaryObjects__close_with_escape } from '@/strings/messages/binaryObjects__close_with_escape/de';
import { binaryObjects__copy_name } from '@/strings/messages/binaryObjects__copy_name/de';
import { binaryObjects__date } from '@/strings/messages/binaryObjects__date/de';
import { binaryObjects__delete } from '@/strings/messages/binaryObjects__delete/de';
import { binaryObjects__download } from '@/strings/messages/binaryObjects__download/de';
import { binaryObjects__file_type_cannot_be_previewed } from '@/strings/messages/binaryObjects__file_type_cannot_be_previewed/de';
import { binaryObjects__loading } from '@/strings/messages/binaryObjects__loading/de';
import { binaryObjects__loading_more } from '@/strings/messages/binaryObjects__loading_more/de';
import { binaryObjects__loading_objects } from '@/strings/messages/binaryObjects__loading_objects/de';
import { binaryObjects__manage_persisted_files } from '@/strings/messages/binaryObjects__manage_persisted_files/de';
import { binaryObjects__name } from '@/strings/messages/binaryObjects__name/de';
import { binaryObjects__no_objects_found } from '@/strings/messages/binaryObjects__no_objects_found/de';
import { binaryObjects__preview_unavailable } from '@/strings/messages/binaryObjects__preview_unavailable/de';
import { binaryObjects__reset_zoom } from '@/strings/messages/binaryObjects__reset_zoom/de';
import { binaryObjects__search_by_name_id_or_type } from '@/strings/messages/binaryObjects__search_by_name_id_or_type/de';
import { binaryObjects__size } from '@/strings/messages/binaryObjects__size/de';
import { binaryObjects__unnamed } from '@/strings/messages/binaryObjects__unnamed/de';
import { binaryObjects__zoom_in } from '@/strings/messages/binaryObjects__zoom_in/de';
import { binaryObjects__zoom_out } from '@/strings/messages/binaryObjects__zoom_out/de';
import { blockMarkdown__allow_all_external_images_in_this_session } from '@/strings/messages/blockMarkdown__allow_all_external_images_in_this_session/de';
import { blockMarkdown__code } from '@/strings/messages/blockMarkdown__code/de';
import { blockMarkdown__copied } from '@/strings/messages/blockMarkdown__copied/de';
import { blockMarkdown__copy_code } from '@/strings/messages/blockMarkdown__copy_code/de';
import { blockMarkdown__copy_source } from '@/strings/messages/blockMarkdown__copy_source/de';
import { blockMarkdown__external_image } from '@/strings/messages/blockMarkdown__external_image/de';
import { blockMarkdown__failed_to_embed_metadata_in_image } from '@/strings/messages/blockMarkdown__failed_to_embed_metadata_in_image/de';
import { blockMarkdown__failed_to_load_image } from '@/strings/messages/blockMarkdown__failed_to_load_image/de';
import { blockMarkdown__failed_to_render_mermaid_diagram } from '@/strings/messages/blockMarkdown__failed_to_render_mermaid_diagram/de';
import { blockMarkdown__image_not_found_in_storage } from '@/strings/messages/blockMarkdown__image_not_found_in_storage/de';
import { blockMarkdown__invalid_image_block_data } from '@/strings/messages/blockMarkdown__invalid_image_block_data/de';
import { blockMarkdown__preview } from '@/strings/messages/blockMarkdown__preview/de';
import { blockMarkdown__split_view } from '@/strings/messages/blockMarkdown__split_view/de';
import { blockMarkdown__toggle_line_wrap } from '@/strings/messages/blockMarkdown__toggle_line_wrap/de';
import { blockMarkdown__unknown_token_type } from '@/strings/messages/blockMarkdown__unknown_token_type/de';
import { chatApproval__allow_action } from '@/strings/messages/chatApproval__allow_action/de';
import { chatApproval__allow_for_this_chat } from '@/strings/messages/chatApproval__allow_for_this_chat/de';
import { chatApproval__allow_globally } from '@/strings/messages/chatApproval__allow_globally/de';
import { chatApproval__allow_once } from '@/strings/messages/chatApproval__allow_once/de';
import { chatApproval__deny } from '@/strings/messages/chatApproval__deny/de';
import { chatApproval__get_wikipedia_page } from '@/strings/messages/chatApproval__get_wikipedia_page/de';
import { chatApproval__keyword_label } from '@/strings/messages/chatApproval__keyword_label/de';
import { chatApproval__page_id_label } from '@/strings/messages/chatApproval__page_id_label/de';
import { chatApproval__search_wikipedia } from '@/strings/messages/chatApproval__search_wikipedia/de';
import { chatGenerationFlow__attachments_cannot_be_saved } from '@/strings/messages/chatGenerationFlow__attachments_cannot_be_saved/de';
import { chatGenerationFlow__cancel } from '@/strings/messages/chatGenerationFlow__cancel/de';
import { chatGenerationFlow__continue_anyway } from '@/strings/messages/chatGenerationFlow__continue_anyway/de';
import { chatGenerationFlow__generation_failed_in_chat } from '@/strings/messages/chatGenerationFlow__generation_failed_in_chat/de';
import { chatGenerationFlow__local_storage_attachments_are_only_available_during_this_session } from '@/strings/messages/chatGenerationFlow__local_storage_attachments_are_only_available_during_this_session/de';
import { chatGenerationFlow__no_image_generation_model_was_found } from '@/strings/messages/chatGenerationFlow__no_image_generation_model_was_found/de';
import { chatGenerationFlow__view } from '@/strings/messages/chatGenerationFlow__view/de';
import { chatHistoryFlow__fork_of_chat } from '@/strings/messages/chatHistoryFlow__fork_of_chat/de';
import { chatModelFetch__failed_to_fetch_models_for_resolution } from '@/strings/messages/chatModelFetch__failed_to_fetch_models_for_resolution/de';
import { contextCompact__aborted } from '@/strings/messages/contextCompact__aborted/de';
import { contextCompact__applying_compact_branch } from '@/strings/messages/contextCompact__applying_compact_branch/de';
import { contextCompact__balanced } from '@/strings/messages/contextCompact__balanced/de';
import { contextCompact__building_compact_request } from '@/strings/messages/contextCompact__building_compact_request/de';
import { contextCompact__cancel } from '@/strings/messages/contextCompact__cancel/de';
import { contextCompact__compact } from '@/strings/messages/contextCompact__compact/de';
import { contextCompact__compact_context } from '@/strings/messages/contextCompact__compact_context/de';
import { contextCompact__compact_now } from '@/strings/messages/contextCompact__compact_now/de';
import { contextCompact__compact_prompt } from '@/strings/messages/contextCompact__compact_prompt/de';
import { contextCompact__compacting_context } from '@/strings/messages/contextCompact__compacting_context/de';
import { contextCompact__compacting_context_failed } from '@/strings/messages/contextCompact__compacting_context_failed/de';
import { contextCompact__compacting_will_condense_messages_into_a_single_summary } from '@/strings/messages/contextCompact__compacting_will_condense_messages_into_a_single_summary/de';
import { contextCompact__complete } from '@/strings/messages/contextCompact__complete/de';
import { contextCompact__deep } from '@/strings/messages/contextCompact__deep/de';
import { contextCompact__editable_prompt } from '@/strings/messages/contextCompact__editable_prompt/de';
import { contextCompact__generating_compact_context_with_characters_received } from '@/strings/messages/contextCompact__generating_compact_context_with_characters_received/de';
import { contextCompact__memory_reconfiguration } from '@/strings/messages/contextCompact__memory_reconfiguration/de';
import { contextCompact__messages_to_keep } from '@/strings/messages/contextCompact__messages_to_keep/de';
import { contextCompact__more_context } from '@/strings/messages/contextCompact__more_context/de';
import { contextCompact__more_history } from '@/strings/messages/contextCompact__more_history/de';
import { contextCompact__preparing_messages_and_keeping_recent_messages } from '@/strings/messages/contextCompact__preparing_messages_and_keeping_recent_messages/de';
import { contextCompact__requires_a_configured_model_and_endpoint } from '@/strings/messages/contextCompact__requires_a_configured_model_and_endpoint/de';
import { contextCompact__response_was_empty } from '@/strings/messages/contextCompact__response_was_empty/de';
import { contextCompact__to_compact } from '@/strings/messages/contextCompact__to_compact/de';
import { contextCompact__to_keep } from '@/strings/messages/contextCompact__to_keep/de';
import { contextCompact__waiting_for_the_model } from '@/strings/messages/contextCompact__waiting_for_the_model/de';
import { dataDeletion__advanced_mode } from '@/strings/messages/dataDeletion__advanced_mode/de';
import { dataDeletion__checked_selectors_matching_entries } from '@/strings/messages/dataDeletion__checked_selectors_matching_entries/de';
import { dataDeletion__delete_application_data } from '@/strings/messages/dataDeletion__delete_application_data/de';
import { dataDeletion__delete_data_matched_by_selected_selectors } from '@/strings/messages/dataDeletion__delete_data_matched_by_selected_selectors/de';
import { dataDeletion__delete_selected_data } from '@/strings/messages/dataDeletion__delete_selected_data/de';
import { dataDeletion__delete_selected_data_and_reload } from '@/strings/messages/dataDeletion__delete_selected_data_and_reload/de';
import { dataDeletion__delete_selected_data_question } from '@/strings/messages/dataDeletion__delete_selected_data_question/de';
import { dataDeletion__deletion_preview } from '@/strings/messages/dataDeletion__deletion_preview/de';
import { dataDeletion__developer_focused_deletion_controls_for_naidan_storage_selectors } from '@/strings/messages/dataDeletion__developer_focused_deletion_controls_for_naidan_storage_selectors/de';
import { dataDeletion__factory_reset } from '@/strings/messages/dataDeletion__factory_reset/de';
import { dataDeletion__no_matching_entries } from '@/strings/messages/dataDeletion__no_matching_entries/de';
import { dataDeletion__not_available_in_this_runtime } from '@/strings/messages/dataDeletion__not_available_in_this_runtime/de';
import { dataDeletion__preview_entries } from '@/strings/messages/dataDeletion__preview_entries/de';
import { dataDeletion__scanning_storage } from '@/strings/messages/dataDeletion__scanning_storage/de';
import { dataDeletion__select_at_least_one_deletion_selector } from '@/strings/messages/dataDeletion__select_at_least_one_deletion_selector/de';
import { fileExplorer__add } from '@/strings/messages/fileExplorer__add/de';
import { fileExplorer__archive_name } from '@/strings/messages/fileExplorer__archive_name/de';
import { fileExplorer__binary_file } from '@/strings/messages/fileExplorer__binary_file/de';
import { fileExplorer__byte_count } from '@/strings/messages/fileExplorer__byte_count/de';
import { fileExplorer__close } from '@/strings/messages/fileExplorer__close/de';
import { fileExplorer__close_preview } from '@/strings/messages/fileExplorer__close_preview/de';
import { fileExplorer__column_view } from '@/strings/messages/fileExplorer__column_view/de';
import { fileExplorer__copy } from '@/strings/messages/fileExplorer__copy/de';
import { fileExplorer__create } from '@/strings/messages/fileExplorer__create/de';
import { fileExplorer__creating_archive } from '@/strings/messages/fileExplorer__creating_archive/de';
import { fileExplorer__cut } from '@/strings/messages/fileExplorer__cut/de';
import { fileExplorer__delete } from '@/strings/messages/fileExplorer__delete/de';
import { fileExplorer__delete_confirmation } from '@/strings/messages/fileExplorer__delete_confirmation/de';
import { fileExplorer__delete_file } from '@/strings/messages/fileExplorer__delete_file/de';
import { fileExplorer__delete_folder } from '@/strings/messages/fileExplorer__delete_folder/de';
import { fileExplorer__delete_items } from '@/strings/messages/fileExplorer__delete_items/de';
import { fileExplorer__download } from '@/strings/messages/fileExplorer__download/de';
import { fileExplorer__download_directory } from '@/strings/messages/fileExplorer__download_directory/de';
import { fileExplorer__empty } from '@/strings/messages/fileExplorer__empty/de';
import { fileExplorer__empty_folder } from '@/strings/messages/fileExplorer__empty_folder/de';
import { fileExplorer__enter_a_name_for_the_new_file } from '@/strings/messages/fileExplorer__enter_a_name_for_the_new_file/de';
import { fileExplorer__enter_a_name_for_the_new_folder } from '@/strings/messages/fileExplorer__enter_a_name_for_the_new_folder/de';
import { fileExplorer__entry_info } from '@/strings/messages/fileExplorer__entry_info/de';
import { fileExplorer__exclude_items } from '@/strings/messages/fileExplorer__exclude_items/de';
import { fileExplorer__exclude_items_help } from '@/strings/messages/fileExplorer__exclude_items_help/de';
import { fileExplorer__failed_to_copy_items } from '@/strings/messages/fileExplorer__failed_to_copy_items/de';
import { fileExplorer__failed_to_create_file } from '@/strings/messages/fileExplorer__failed_to_create_file/de';
import { fileExplorer__failed_to_create_folder } from '@/strings/messages/fileExplorer__failed_to_create_folder/de';
import { fileExplorer__failed_to_load_exclusion_suggestions } from '@/strings/messages/fileExplorer__failed_to_load_exclusion_suggestions/de';
import { fileExplorer__failed_to_delete } from '@/strings/messages/fileExplorer__failed_to_delete/de';
import { fileExplorer__failed_to_download } from '@/strings/messages/fileExplorer__failed_to_download/de';
import { fileExplorer__failed_to_load_directory } from '@/strings/messages/fileExplorer__failed_to_load_directory/de';
import { fileExplorer__failed_to_move_items } from '@/strings/messages/fileExplorer__failed_to_move_items/de';
import { fileExplorer__failed_to_rename } from '@/strings/messages/fileExplorer__failed_to_rename/de';
import { fileExplorer__failed_to_upload_files } from '@/strings/messages/fileExplorer__failed_to_upload_files/de';
import { fileExplorer__file } from '@/strings/messages/fileExplorer__file/de';
import { fileExplorer__file_explorer_opfs } from '@/strings/messages/fileExplorer__file_explorer_opfs/de';
import { fileExplorer__file_is_too_large_to_preview } from '@/strings/messages/fileExplorer__file_is_too_large_to_preview/de';
import { fileExplorer__files } from '@/strings/messages/fileExplorer__files/de';
import { fileExplorer__filter_by_name } from '@/strings/messages/fileExplorer__filter_by_name/de';
import { fileExplorer__folder } from '@/strings/messages/fileExplorer__folder/de';
import { fileExplorer__folder_is_no_longer_available } from '@/strings/messages/fileExplorer__folder_is_no_longer_available/de';
import { fileExplorer__format } from '@/strings/messages/fileExplorer__format/de';
import { fileExplorer__get_info } from '@/strings/messages/fileExplorer__get_info/de';
import { fileExplorer__go_back } from '@/strings/messages/fileExplorer__go_back/de';
import { fileExplorer__hide_preview } from '@/strings/messages/fileExplorer__hide_preview/de';
import { fileExplorer__icon_view } from '@/strings/messages/fileExplorer__icon_view/de';
import { fileExplorer__item_count_label } from '@/strings/messages/fileExplorer__item_count_label/de';
import { fileExplorer__list_view } from '@/strings/messages/fileExplorer__list_view/de';
import { fileExplorer__load_anyway } from '@/strings/messages/fileExplorer__load_anyway/de';
import { fileExplorer__locked_click_to_unlock } from '@/strings/messages/fileExplorer__locked_click_to_unlock/de';
import { fileExplorer__modified } from '@/strings/messages/fileExplorer__modified/de';
import { fileExplorer__modified_label } from '@/strings/messages/fileExplorer__modified_label/de';
import { fileExplorer__name } from '@/strings/messages/fileExplorer__name/de';
import { fileExplorer__new_file } from '@/strings/messages/fileExplorer__new_file/de';
import { fileExplorer__new_file_unlock_to_enable } from '@/strings/messages/fileExplorer__new_file_unlock_to_enable/de';
import { fileExplorer__new_folder } from '@/strings/messages/fileExplorer__new_folder/de';
import { fileExplorer__new_folder_unlock_to_enable } from '@/strings/messages/fileExplorer__new_folder_unlock_to_enable/de';
import { fileExplorer__no_matching_items } from '@/strings/messages/fileExplorer__no_matching_items/de';
import { fileExplorer__open } from '@/strings/messages/fileExplorer__open/de';
import { fileExplorer__optional } from '@/strings/messages/fileExplorer__optional/de';
import { fileExplorer__paste } from '@/strings/messages/fileExplorer__paste/de';
import { fileExplorer__preview } from '@/strings/messages/fileExplorer__preview/de';
import { fileExplorer__refresh } from '@/strings/messages/fileExplorer__refresh/de';
import { fileExplorer__relative_path } from '@/strings/messages/fileExplorer__relative_path/de';
import { fileExplorer__rename } from '@/strings/messages/fileExplorer__rename/de';
import { fileExplorer__search } from '@/strings/messages/fileExplorer__search/de';
import { fileExplorer__select_a_file } from '@/strings/messages/fileExplorer__select_a_file/de';
import { fileExplorer__select_all } from '@/strings/messages/fileExplorer__select_all/de';
import { fileExplorer__selected_count_label } from '@/strings/messages/fileExplorer__selected_count_label/de';
import { fileExplorer__show_preview } from '@/strings/messages/fileExplorer__show_preview/de';
import { fileExplorer__size } from '@/strings/messages/fileExplorer__size/de';
import { fileExplorer__size_label } from '@/strings/messages/fileExplorer__size_label/de';
import { fileExplorer__type } from '@/strings/messages/fileExplorer__type/de';
import { fileExplorer__type_to_narrow_results } from '@/strings/messages/fileExplorer__type_to_narrow_results/de';
import { fileExplorer__unlock_to_enable } from '@/strings/messages/fileExplorer__unlock_to_enable/de';
import { fileExplorer__unlocked_click_to_lock } from '@/strings/messages/fileExplorer__unlocked_click_to_lock/de';
import { fileExplorer__unsupported_items_were_skipped } from '@/strings/messages/fileExplorer__unsupported_items_were_skipped/de';
import { fileExplorer__upload_files } from '@/strings/messages/fileExplorer__upload_files/de';
import { fileExplorer__upload_files_unlock_to_enable } from '@/strings/messages/fileExplorer__upload_files_unlock_to_enable/de';
import { fileExplorer__addition_count } from '@/strings/messages/fileExplorer__addition_count/de';
import { fileExplorer__analyzing_zip } from '@/strings/messages/fileExplorer__analyzing_zip/de';
import { fileExplorer__blocked_count } from '@/strings/messages/fileExplorer__blocked_count/de';
import { fileExplorer__cannot_be_placed } from '@/strings/messages/fileExplorer__cannot_be_placed/de';
import { fileExplorer__existing } from '@/strings/messages/fileExplorer__existing/de';
import { fileExplorer__extract_and_place } from '@/strings/messages/fileExplorer__extract_and_place/de';
import { fileExplorer__extract_and_place_description } from '@/strings/messages/fileExplorer__extract_and_place_description/de';
import { fileExplorer__merge_count } from '@/strings/messages/fileExplorer__merge_count/de';
import { fileExplorer__next_zip } from '@/strings/messages/fileExplorer__next_zip/de';
import { fileExplorer__not_changed_yet } from '@/strings/messages/fileExplorer__not_changed_yet/de';
import { fileExplorer__overwrite_count } from '@/strings/messages/fileExplorer__overwrite_count/de';
import { fileExplorer__place_contents_here } from '@/strings/messages/fileExplorer__place_contents_here/de';
import { fileExplorer__place_contents_here_description } from '@/strings/messages/fileExplorer__place_contents_here_description/de';
import { fileExplorer__place_directory_itself } from '@/strings/messages/fileExplorer__place_directory_itself/de';
import { fileExplorer__place_directory_itself_description } from '@/strings/messages/fileExplorer__place_directory_itself_description/de';
import { fileExplorer__place_zip_file_as_is } from '@/strings/messages/fileExplorer__place_zip_file_as_is/de';
import { fileExplorer__place_zip_file_as_is_description } from '@/strings/messages/fileExplorer__place_zip_file_as_is_description/de';
import { fileExplorer__placement_method } from '@/strings/messages/fileExplorer__placement_method/de';
import { fileExplorer__placement_preview } from '@/strings/messages/fileExplorer__placement_preview/de';
import { fileExplorer__planned_addition } from '@/strings/messages/fileExplorer__planned_addition/de';
import { fileExplorer__planned_merge } from '@/strings/messages/fileExplorer__planned_merge/de';
import { fileExplorer__planned_overwrite } from '@/strings/messages/fileExplorer__planned_overwrite/de';
import { fileExplorer__root_directory_handling } from '@/strings/messages/fileExplorer__root_directory_handling/de';
import { fileExplorer__status } from '@/strings/messages/fileExplorer__status/de';
import { fileExplorer__uploading } from '@/strings/messages/fileExplorer__uploading/de';
import { fileExplorer__zip_archive } from '@/strings/messages/fileExplorer__zip_archive/de';
import { fileExplorer__zip_cannot_be_extracted } from '@/strings/messages/fileExplorer__zip_cannot_be_extracted/de';
import { fileExplorer__zip_file_upload } from '@/strings/messages/fileExplorer__zip_file_upload/de';
import { fileExplorer__zip_upload_preview_outdated } from '@/strings/messages/fileExplorer__zip_upload_preview_outdated/de';
import { formatSettingsSourceLabel__default } from '@/strings/messages/formatSettingsSourceLabel__default/de';
import { formatSettingsSourceLabel__value_from_chat } from '@/strings/messages/formatSettingsSourceLabel__value_from_chat/de';
import { formatSettingsSourceLabel__none } from '@/strings/messages/formatSettingsSourceLabel__none/de';
import { formatSettingsSourceLabel__value_from_global } from '@/strings/messages/formatSettingsSourceLabel__value_from_global/de';
import { formatSettingsSourceLabel__value_from_group } from '@/strings/messages/formatSettingsSourceLabel__value_from_group/de';
import { toolCall__arguments } from '@/strings/messages/toolCall__arguments/de';
import { toolCall__code } from '@/strings/messages/toolCall__code/de';
import { toolCall__disable_wrap } from '@/strings/messages/toolCall__disable_wrap/de';
import { toolCall__enable_wrap } from '@/strings/messages/toolCall__enable_wrap/de';
import { toolCall__error } from '@/strings/messages/toolCall__error/de';
import { toolCall__executing } from '@/strings/messages/toolCall__executing/de';
import { toolCall__hide_tool_executions } from '@/strings/messages/toolCall__hide_tool_executions/de';
import { toolCall__live_output } from '@/strings/messages/toolCall__live_output/de';
import { toolCall__loading_large_result } from '@/strings/messages/toolCall__loading_large_result/de';
import { toolCall__raw_json } from '@/strings/messages/toolCall__raw_json/de';
import { toolCall__result } from '@/strings/messages/toolCall__result/de';
import { toolCall__show_tools_count } from '@/strings/messages/toolCall__show_tools_count/de';
import { toolCall__tool_executions } from '@/strings/messages/toolCall__tool_executions/de';
import { useBinaryActions__delete_binary_object } from '@/strings/messages/useBinaryActions__delete_binary_object/de';
import { useBinaryActions__delete_binary_object_warning } from '@/strings/messages/useBinaryActions__delete_binary_object_warning/de';
import { useBinaryActions__delete_permanently } from '@/strings/messages/useBinaryActions__delete_permanently/de';
import { useChatLifecycle__chat_was_deleted } from '@/strings/messages/useChatLifecycle__chat_was_deleted/de';
import { useChatLifecycle__undo } from '@/strings/messages/useChatLifecycle__undo/de';
import { useChatOrganization__copy_of_chat_group } from '@/strings/messages/useChatOrganization__copy_of_chat_group/de';
import { useImageGeneration__failed_to_generate_image } from '@/strings/messages/useImageGeneration__failed_to_generate_image/de';
import { useImageGeneration__failed_to_reencode_image } from '@/strings/messages/useImageGeneration__failed_to_reencode_image/de';
import { useImageGeneration__no_suitable_image_generation_model_found } from '@/strings/messages/useImageGeneration__no_suitable_image_generation_model_found/de';
import { usePrompt__prompt } from '@/strings/messages/usePrompt__prompt/de';
import { useSettings__data_successfully_imported_from_url } from '@/strings/messages/useSettings__data_successfully_imported_from_url/de';
import { useSettings__failed_to_fetch_models_for_settings } from '@/strings/messages/useSettings__failed_to_fetch_models_for_settings/de';
import { useSettings__failed_to_import_data_from_url } from '@/strings/messages/useSettings__failed_to_import_data_from_url/de';
import { useSettings__invalid_storage_type_falling_back_to_default_detection } from '@/strings/messages/useSettings__invalid_storage_type_falling_back_to_default_detection/de';
import { useSettings__ok } from '@/strings/messages/useSettings__ok/de';
import { useSettings__request_to_use_storage_type_was_ignored } from '@/strings/messages/useSettings__request_to_use_storage_type_was_ignored/de';
import { useSettings__storage_already_initialized } from '@/strings/messages/useSettings__storage_already_initialized/de';
import { useSettings__storage_type_is_already_set_and_requested_type_was_ignored } from '@/strings/messages/useSettings__storage_type_is_already_set_and_requested_type_was_ignored/de';
import { volumes__access_mode } from '@/strings/messages/volumes__access_mode/de';
import { volumes__active_count } from '@/strings/messages/volumes__active_count/de';
import { volumes__add_folder } from '@/strings/messages/volumes__add_folder/de';
import { volumes__add_folder_requires_chromium } from '@/strings/messages/volumes__add_folder_requires_chromium/de';
import { volumes__add_or_copy_folder_into_browser_storage } from '@/strings/messages/volumes__add_or_copy_folder_into_browser_storage/de';
import { volumes__ai_can_read_and_modify_files } from '@/strings/messages/volumes__ai_can_read_and_modify_files/de';
import { volumes__ai_can_read_not_write } from '@/strings/messages/volumes__ai_can_read_not_write/de';
import { volumes__cancel } from '@/strings/messages/volumes__cancel/de';
import { volumes__change_access_later } from '@/strings/messages/volumes__change_access_later/de';
import { volumes__choose_access_level } from '@/strings/messages/volumes__choose_access_level/de';
import { volumes__chromium_browser_over_https } from '@/strings/messages/volumes__chromium_browser_over_https/de';
import { volumes__configure } from '@/strings/messages/volumes__configure/de';
import { volumes__copied } from '@/strings/messages/volumes__copied/de';
import { volumes__copied_folder } from '@/strings/messages/volumes__copied_folder/de';
import { volumes__copy_does_not_change_disk_files } from '@/strings/messages/volumes__copy_does_not_change_disk_files/de';
import { volumes__copy_folder } from '@/strings/messages/volumes__copy_folder/de';
import { volumes__copy_is_stored_in_browser_opfs } from '@/strings/messages/volumes__copy_is_stored_in_browser_opfs/de';
import { volumes__copy_single_file_instead } from '@/strings/messages/volumes__copy_single_file_instead/de';
import { volumes__copying_file_to_browser } from '@/strings/messages/volumes__copying_file_to_browser/de';
import { volumes__copying_folder_to_browser } from '@/strings/messages/volumes__copying_folder_to_browser/de';
import { volumes__delete } from '@/strings/messages/volumes__delete/de';
import { volumes__delete_folder } from '@/strings/messages/volumes__delete_folder/de';
import { volumes__delete_folder_warning } from '@/strings/messages/volumes__delete_folder_warning/de';
import { volumes__drop_to_copy_to_browser } from '@/strings/messages/volumes__drop_to_copy_to_browser/de';
import { volumes__failed_to_add_folder } from '@/strings/messages/volumes__failed_to_add_folder/de';
import { volumes__failed_to_add_folder_with_error } from '@/strings/messages/volumes__failed_to_add_folder_with_error/de';
import { volumes__failed_to_copy } from '@/strings/messages/volumes__failed_to_copy/de';
import { volumes__failed_to_copy_file } from '@/strings/messages/volumes__failed_to_copy_file/de';
import { volumes__failed_to_copy_folder } from '@/strings/messages/volumes__failed_to_copy_folder/de';
import { volumes__failed_to_delete_folder } from '@/strings/messages/volumes__failed_to_delete_folder/de';
import { volumes__failed_to_load_folders } from '@/strings/messages/volumes__failed_to_load_folders/de';
import { volumes__failed_to_remove_folder } from '@/strings/messages/volumes__failed_to_remove_folder/de';
import { volumes__failed_to_rename_folder } from '@/strings/messages/volumes__failed_to_rename_folder/de';
import { volumes__failed_to_update_path_settings } from '@/strings/messages/volumes__failed_to_update_path_settings/de';
import { volumes__file_copied_to_your_folders } from '@/strings/messages/volumes__file_copied_to_your_folders/de';
import { volumes__file_progress } from '@/strings/messages/volumes__file_progress/de';
import { volumes__folder_added_to_your_folders } from '@/strings/messages/volumes__folder_added_to_your_folders/de';
import { volumes__folder_deleted } from '@/strings/messages/volumes__folder_deleted/de';
import { volumes__folder_is_no_longer_in_use } from '@/strings/messages/volumes__folder_is_no_longer_in_use/de';
import { volumes__folder_is_now_in_use } from '@/strings/messages/volumes__folder_is_now_in_use/de';
import { volumes__folder_or_file } from '@/strings/messages/volumes__folder_or_file/de';
import { volumes__folder_removed } from '@/strings/messages/volumes__folder_removed/de';
import { volumes__folders } from '@/strings/messages/volumes__folders/de';
import { volumes__give_ai_access_to_files_in_your_folders } from '@/strings/messages/volumes__give_ai_access_to_files_in_your_folders/de';
import { volumes__imported_folder } from '@/strings/messages/volumes__imported_folder/de';
import { volumes__in_use } from '@/strings/messages/volumes__in_use/de';
import { volumes__in_use_globally } from '@/strings/messages/volumes__in_use_globally/de';
import { volumes__linked } from '@/strings/messages/volumes__linked/de';
import { volumes__linked_folder } from '@/strings/messages/volumes__linked_folder/de';
import { volumes__linking_external_folders_not_supported } from '@/strings/messages/volumes__linking_external_folders_not_supported/de';
import { volumes__more_actions } from '@/strings/messages/volumes__more_actions/de';
import { volumes__mount_path_already_in_use } from '@/strings/messages/volumes__mount_path_already_in_use/de';
import { volumes__name_cannot_be_empty } from '@/strings/messages/volumes__name_cannot_be_empty/de';
import { volumes__no_folders_configured } from '@/strings/messages/volumes__no_folders_configured/de';
import { volumes__not_in_use } from '@/strings/messages/volumes__not_in_use/de';
import { volumes__not_in_use_globally } from '@/strings/messages/volumes__not_in_use_globally/de';
import { volumes__not_supported_in_browser_or_context } from '@/strings/messages/volumes__not_supported_in_browser_or_context/de';
import { volumes__opfs_not_supported } from '@/strings/messages/volumes__opfs_not_supported/de';
import { volumes__original_folder_is_never_touched } from '@/strings/messages/volumes__original_folder_is_never_touched/de';
import { volumes__path } from '@/strings/messages/volumes__path/de';
import { volumes__path_settings_updated } from '@/strings/messages/volumes__path_settings_updated/de';
import { volumes__permission_denied_folder_may_not_be_accessible } from '@/strings/messages/volumes__permission_denied_folder_may_not_be_accessible/de';
import { volumes__read_only } from '@/strings/messages/volumes__read_only/de';
import { volumes__read_write } from '@/strings/messages/volumes__read_write/de';
import { volumes__remove } from '@/strings/messages/volumes__remove/de';
import { volumes__remove_folder } from '@/strings/messages/volumes__remove_folder/de';
import { volumes__remove_folder_warning } from '@/strings/messages/volumes__remove_folder_warning/de';
import { volumes__rename } from '@/strings/messages/volumes__rename/de';
import { volumes__save } from '@/strings/messages/volumes__save/de';
import { volumes__save_changes } from '@/strings/messages/volumes__save_changes/de';
import { volumes__stop_using } from '@/strings/messages/volumes__stop_using/de';
import { volumes__use } from '@/strings/messages/volumes__use/de';
import { volumes__what_is_copy_folder } from '@/strings/messages/volumes__what_is_copy_folder/de';
import { volumes__why_add_folder_disabled } from '@/strings/messages/volumes__why_add_folder_disabled/de';
import { weshTerminal__cancel } from '@/strings/messages/weshTerminal__cancel/de';
import { weshTerminal__close_session } from '@/strings/messages/weshTerminal__close_session/de';
import { weshTerminal__close_session_aria } from '@/strings/messages/weshTerminal__close_session_aria/de';
import { weshTerminal__close_session_question } from '@/strings/messages/weshTerminal__close_session_question/de';
import { weshTerminal__close_terminal } from '@/strings/messages/weshTerminal__close_terminal/de';
import { weshTerminal__debug_terminal } from '@/strings/messages/weshTerminal__debug_terminal/de';
import { weshTerminal__initializing_worker } from '@/strings/messages/weshTerminal__initializing_worker/de';
import { weshTerminal__new } from '@/strings/messages/weshTerminal__new/de';
import { weshTerminal__no_sessions_press_new_to_start_a_worker_backed_shell } from '@/strings/messages/weshTerminal__no_sessions_press_new_to_start_a_worker_backed_shell/de';
import { weshTerminal__session } from '@/strings/messages/weshTerminal__session/de';
import { weshTerminal__this_will_dispose_the_worker_and_lose_the_session_history_continue } from '@/strings/messages/weshTerminal__this_will_dispose_the_worker_and_lose_the_session_history_continue/de';
import { weshTerminal__wesh_terminal } from '@/strings/messages/weshTerminal__wesh_terminal/de';

import { OpfsEncryptionSettingsPanel__additional_conflicting_entries } from '@/strings/messages/OpfsEncryptionSettingsPanel__additional_conflicting_entries/de';
import { OpfsEncryptionSettingsPanel__conflict_changed } from '@/strings/messages/OpfsEncryptionSettingsPanel__conflict_changed/de';
import { OpfsEncryptionSettingsPanel__delete_conflicting_data_and_retry } from '@/strings/messages/OpfsEncryptionSettingsPanel__delete_conflicting_data_and_retry/de';
import { OpfsEncryptionSettingsPanel__encrypted_source_remains_authoritative } from '@/strings/messages/OpfsEncryptionSettingsPanel__encrypted_source_remains_authoritative/de';
import { OpfsEncryptionSettingsPanel__plain_target_conflict } from '@/strings/messages/OpfsEncryptionSettingsPanel__plain_target_conflict/de';
import { OpfsEncryptionSettingsPanel__plain_target_conflict_explanation } from '@/strings/messages/OpfsEncryptionSettingsPanel__plain_target_conflict_explanation/de';
import { OpfsEncryptionSettingsPanel__plain_target_conflict_loss_warning } from '@/strings/messages/OpfsEncryptionSettingsPanel__plain_target_conflict_loss_warning/de';
import { opfsEncryption__build_and_verify_separate_encrypted_store } from '@/strings/messages/opfsEncryption__build_and_verify_separate_encrypted_store/de';
import { opfsEncryption__cancel } from '@/strings/messages/opfsEncryption__cancel/de';
import { opfsEncryption__change_opfs_passphrase } from '@/strings/messages/opfsEncryption__change_opfs_passphrase/de';
import { opfsEncryption__change_passphrase } from '@/strings/messages/opfsEncryption__change_passphrase/de';
import { opfsEncryption__changing_raw_opfs_during_transition_can_prevent_recovery } from '@/strings/messages/opfsEncryption__changing_raw_opfs_during_transition_can_prevent_recovery/de';
import { opfsEncryption__confirm_new_passphrase } from '@/strings/messages/opfsEncryption__confirm_new_passphrase/de';
import { opfsEncryption__confirm_passphrase } from '@/strings/messages/opfsEncryption__confirm_passphrase/de';
import { opfsEncryption__copied } from '@/strings/messages/opfsEncryption__copied/de';
import { opfsEncryption__copy } from '@/strings/messages/opfsEncryption__copy/de';
import { opfsEncryption__copy_source } from '@/strings/messages/opfsEncryption__copy_source/de';
import { opfsEncryption__copying_and_verifying_complete_opfs_storage } from '@/strings/messages/opfsEncryption__copying_and_verifying_complete_opfs_storage/de';
import { opfsEncryption__could_not_read_encryption_control_state } from '@/strings/messages/opfsEncryption__could_not_read_encryption_control_state/de';
import { opfsEncryption__decrypt_storage } from '@/strings/messages/opfsEncryption__decrypt_storage/de';
import { opfsEncryption__decrypt_storage_explanation } from '@/strings/messages/opfsEncryption__decrypt_storage_explanation/de';
import { opfsEncryption__enable_opfs_encryption } from '@/strings/messages/opfsEncryption__enable_opfs_encryption/de';
import { opfsEncryption__encrypt_storage } from '@/strings/messages/opfsEncryption__encrypt_storage/de';
import { opfsEncryption__encrypted_storage_needs_recovery } from '@/strings/messages/opfsEncryption__encrypted_storage_needs_recovery/de';
import { opfsEncryption__encryption_control_state_cannot_be_read_safely } from '@/strings/messages/opfsEncryption__encryption_control_state_cannot_be_read_safely/de';
import { opfsEncryption__encryption_enabled } from '@/strings/messages/opfsEncryption__encryption_enabled/de';
import { opfsEncryption__encryption_state_is_unreadable } from '@/strings/messages/opfsEncryption__encryption_state_is_unreadable/de';
import { opfsEncryption__encryption_transition_must_finish_before_changing_this_setting } from '@/strings/messages/opfsEncryption__encryption_transition_must_finish_before_changing_this_setting/de';
import { opfsEncryption__enter_passphrase_for_opfs_storage } from '@/strings/messages/opfsEncryption__enter_passphrase_for_opfs_storage/de';
import { opfsEncryption__experimental } from '@/strings/messages/opfsEncryption__experimental/de';
import { opfsEncryption__experimental_format_may_change_incompatibly } from '@/strings/messages/opfsEncryption__experimental_format_may_change_incompatibly/de';
import { opfsEncryption__hide_passphrase } from '@/strings/messages/opfsEncryption__hide_passphrase/de';
import { opfsEncryption__interrupted_encryption_operation } from '@/strings/messages/opfsEncryption__interrupted_encryption_operation/de';
import { opfsEncryption__leading_or_trailing_whitespace_is_part_of_passphrase } from '@/strings/messages/opfsEncryption__leading_or_trailing_whitespace_is_part_of_passphrase/de';
import { opfsEncryption__loading_recovery_source } from '@/strings/messages/opfsEncryption__loading_recovery_source/de';
import { opfsEncryption__new_passphrase } from '@/strings/messages/opfsEncryption__new_passphrase/de';
import { opfsEncryption__only_passphrase_keyslot_is_replaced } from '@/strings/messages/opfsEncryption__only_passphrase_keyslot_is_replaced/de';
import { opfsEncryption__open_raw_opfs_explorer } from '@/strings/messages/opfsEncryption__open_raw_opfs_explorer/de';
import { opfsEncryption__opfs_encryption } from '@/strings/messages/opfsEncryption__opfs_encryption/de';
import { opfsEncryption__passphrase } from '@/strings/messages/opfsEncryption__passphrase/de';
import { opfsEncryption__passphrases_cannot_contain_line_breaks } from '@/strings/messages/opfsEncryption__passphrases_cannot_contain_line_breaks/de';
import { opfsEncryption__passphrases_do_not_match } from '@/strings/messages/opfsEncryption__passphrases_do_not_match/de';
import { opfsEncryption__naidan_could_not_finish_loading } from '@/strings/messages/opfsEncryption__naidan_could_not_finish_loading/de';
import { opfsEncryption__preparing_naidan } from '@/strings/messages/opfsEncryption__preparing_naidan/de';
import { opfsEncryption__raw_opfs_access_does_not_decrypt } from '@/strings/messages/opfsEncryption__raw_opfs_access_does_not_decrypt/de';
import { opfsEncryption__re_encrypt } from '@/strings/messages/opfsEncryption__re_encrypt/de';
import { opfsEncryption__re_encrypt_opfs_storage } from '@/strings/messages/opfsEncryption__re_encrypt_opfs_storage/de';
import { opfsEncryption__re_encrypt_storage } from '@/strings/messages/opfsEncryption__re_encrypt_storage/de';
import { opfsEncryption__re_encrypt_storage_explanation } from '@/strings/messages/opfsEncryption__re_encrypt_storage_explanation/de';
import { opfsEncryption__recovery_source } from '@/strings/messages/opfsEncryption__recovery_source/de';
import { opfsEncryption__resolve_interrupted_opfs_decryption } from '@/strings/messages/opfsEncryption__resolve_interrupted_opfs_decryption/de';
import { opfsEncryption__resolve_interrupted_opfs_encryption } from '@/strings/messages/opfsEncryption__resolve_interrupted_opfs_encryption/de';
import { opfsEncryption__resolve_interrupted_opfs_reencryption } from '@/strings/messages/opfsEncryption__resolve_interrupted_opfs_reencryption/de';
import { opfsEncryption__retry_after_recovery } from '@/strings/messages/opfsEncryption__retry_after_recovery/de';
import { opfsEncryption__save_file } from '@/strings/messages/opfsEncryption__save_file/de';
import { opfsEncryption__save_source } from '@/strings/messages/opfsEncryption__save_source/de';
import { opfsEncryption__select_opfs_as_active_storage_to_enable_encryption } from '@/strings/messages/opfsEncryption__select_opfs_as_active_storage_to_enable_encryption/de';
import { opfsEncryption__show_passphrase } from '@/strings/messages/opfsEncryption__show_passphrase/de';
import { opfsEncryption__source_remains_until_verified } from '@/strings/messages/opfsEncryption__source_remains_until_verified/de';
import { opfsEncryption__storage_unlocked_but_naidan_could_not_finish_loading } from '@/strings/messages/opfsEncryption__storage_unlocked_but_naidan_could_not_finish_loading/de';
import { opfsEncryption__storage_unlocked_preparing_application } from '@/strings/messages/opfsEncryption__storage_unlocked_preparing_application/de';
import { opfsEncryption__transparently_encrypt_naidan_opfs_data } from '@/strings/messages/opfsEncryption__transparently_encrypt_naidan_opfs_data/de';
import { opfsEncryption__turn_off_opfs_encryption } from '@/strings/messages/opfsEncryption__turn_off_opfs_encryption/de';
import { opfsEncryption__understand_experimental_storage_risk } from '@/strings/messages/opfsEncryption__understand_experimental_storage_risk/de';
import { opfsEncryption__unlock_and_resolve } from '@/strings/messages/opfsEncryption__unlock_and_resolve/de';
import { opfsEncryption__unlock_encrypted_storage } from '@/strings/messages/opfsEncryption__unlock_encrypted_storage/de';
import { opfsEncryption__unlock_storage } from '@/strings/messages/opfsEncryption__unlock_storage/de';
import { opfsEncryption__unlocked } from '@/strings/messages/opfsEncryption__unlocked/de';
import { opfsEncryption__updating_encrypted_storage } from '@/strings/messages/opfsEncryption__updating_encrypted_storage/de';
import { DeveloperOpfsEncryptionInterruptionPanel__after_authority_switch } from '@/strings/messages/DeveloperOpfsEncryptionInterruptionPanel__after_authority_switch/de';
import { DeveloperOpfsEncryptionInterruptionPanel__before_authority_switch } from '@/strings/messages/DeveloperOpfsEncryptionInterruptionPanel__before_authority_switch/de';
import { DeveloperOpfsEncryptionInterruptionPanel__confirm_passphrase } from '@/strings/messages/DeveloperOpfsEncryptionInterruptionPanel__confirm_passphrase/de';
import { DeveloperOpfsEncryptionInterruptionPanel__interrupt_and_reload } from '@/strings/messages/DeveloperOpfsEncryptionInterruptionPanel__interrupt_and_reload/de';
import { DeveloperOpfsEncryptionInterruptionPanel__interrupt_opfs_transition } from '@/strings/messages/DeveloperOpfsEncryptionInterruptionPanel__interrupt_opfs_transition/de';
import { DeveloperOpfsEncryptionInterruptionPanel__interruption_boundary } from '@/strings/messages/DeveloperOpfsEncryptionInterruptionPanel__interruption_boundary/de';
import { DeveloperOpfsEncryptionInterruptionPanel__interrupts_ordinary_transition } from '@/strings/messages/DeveloperOpfsEncryptionInterruptionPanel__interrupts_ordinary_transition/de';
import { DeveloperOpfsEncryptionInterruptionPanel__operation } from '@/strings/messages/DeveloperOpfsEncryptionInterruptionPanel__operation/de';
import { DeveloperOpfsEncryptionInterruptionPanel__opfs_only } from '@/strings/messages/DeveloperOpfsEncryptionInterruptionPanel__opfs_only/de';
import { DeveloperOpfsEncryptionInterruptionPanel__opfs_transition_interruption } from '@/strings/messages/DeveloperOpfsEncryptionInterruptionPanel__opfs_transition_interruption/de';
import { DeveloperOpfsEncryptionInterruptionPanel__ordinary_transition_warning } from '@/strings/messages/DeveloperOpfsEncryptionInterruptionPanel__ordinary_transition_warning/de';
import { DeveloperOpfsEncryptionInterruptionPanel__transition_in_progress } from '@/strings/messages/DeveloperOpfsEncryptionInterruptionPanel__transition_in_progress/de';
import { opfsEncryption__progress_bytes } from '@/strings/messages/opfsEncryption__progress_bytes/de';
import { opfsEncryption__progress_cleaning_source } from '@/strings/messages/opfsEncryption__progress_cleaning_source/de';
import { opfsEncryption__progress_copying } from '@/strings/messages/opfsEncryption__progress_copying/de';
import { opfsEncryption__progress_entries } from '@/strings/messages/opfsEncryption__progress_entries/de';
import { opfsEncryption__progress_finalizing } from '@/strings/messages/opfsEncryption__progress_finalizing/de';
import { opfsEncryption__progress_preparing } from '@/strings/messages/opfsEncryption__progress_preparing/de';
import { opfsEncryption__progress_switching_authority } from '@/strings/messages/opfsEncryption__progress_switching_authority/de';
import { opfsEncryption__progress_verifying } from '@/strings/messages/opfsEncryption__progress_verifying/de';
import { opfsEncryption__return_to_plain_after_authority_switch } from '@/strings/messages/opfsEncryption__return_to_plain_after_authority_switch/de';
import { opfsEncryption__return_to_plain_before_authority_switch } from '@/strings/messages/opfsEncryption__return_to_plain_before_authority_switch/de';
import { opfsEncryption__stop_encryption_and_return_to_plain } from '@/strings/messages/opfsEncryption__stop_encryption_and_return_to_plain/de';
import { opfsEncryption__returning_to_plain_storage } from '@/strings/messages/opfsEncryption__returning_to_plain_storage/de';

import type { Strings } from './en';

export const catalog = {
  SHARED__all_chats,
  SHARED__assistant,
  SHARED__browser_provided,
  SHARED__cancel,
  SHARED__choose_which_chats_are_visible_to_the_shell,
  SHARED__configure_browser_based_shell_access,
  SHARED__confirm,
  SHARED__connection_failed_check_url_or_provider,
  SHARED__current_chat,
  SHARED__current_chat_plus_chat_group,
  SHARED__expose_chat_discovery_paths,
  SHARED__generated_image,
  SHARED__local_and_memory_storage_expose_wesh_as_read_only_without_tmp,
  SHARED__mount,
  SHARED__new_chat,
  SHARED__no_models_found_at_this_endpoint,
  SHARED__unsupported_experimental_endpoint,
  SHARED__uses_a_language_model_provided_and_managed_by_the_browser,
  SHARED__visibility,
  SHARED__writable_tmp_is_available_with_opfs_storage,

  AboutTab__about_naidan,
  AboutTab__built_with_open_source_software,
  AboutTab__github_repository,
  AboutTab__loading_licenses,
  AboutTab__open_source_licenses,
  AboutTab__privacy_focused_local_lm_interface,
  AboutTab__runs_locally_via_file_protocol,
  AboutTab__standalone_app,
  AboutTab__unknown_package,
  AboutTab__version,
  AboutTab__view_license_text,
  AboutTab__view_source_code_and_contribute,
  AssistantProcessSequence__and_more,
  AssistantProcessSequence__less,
  AssistantProcessSequence__process_details,
  AssistantProcessSequence__show,
  AssistantProcessSequence__thinking_steps,
  AssistantProcessSequence__tool_executions,
  AssistantProcessSequence__used_tools,
  AssistantWaitingIndicator__waiting_for_response,
  ChatAttachMenu__a_private_copy_is_saved_in_your_browser,
  ChatAttachMenu__attach_files_or_folder,
  ChatAttachMenu__chrome_edge_brave_opera_over_https_links_your_folder_directly_without_copying,
  ChatAttachMenu__files,
  ChatAttachMenu__folder_copy,
  ChatAttachMenu__folder_link,
  ChatAttachMenu__naidan_works_from_the_copy_your_original_files_on_disk_stay_safe_and_intact,
  ChatAttachMenu__requires_a_chromium_based_browser,
  ChatAttachMenu__what_is_folder_copy,
  ChatAttachMenu__what_is_folder_link,
  ChatAttachMenu__why_is_folder_link_unavailable,
  ChatDebugInspector__active,
  ChatDebugInspector__chat_inspector,
  ChatDebugInspector__collapse_tree,
  ChatDebugInspector__context_path,
  ChatDebugInspector__data_explorer,
  ChatDebugInspector__expand_tree,
  ChatDebugInspector__failed_to_parse_image_metadata_during_preview_collection,
  ChatDebugInspector__fake_lm,
  ChatDebugInspector__fake_lm_is_only_available_in_hosted_builds,
  ChatDebugInspector__full_json,
  ChatDebugInspector__on,
  ChatDebugInspector__open_at_this_message,
  ChatDebugInspector__select_a_node_to_inspect,
  ChatDebugInspector__set_this_chat_to_ollama_and_enable_global_fake_lm_debug_mode,
  ChatDebugInspector__toggle_content_collapse,
  ChatDebugInspector__toggle_highlighting,
  ChatDebugInspector__tree,
  ChatDebugTreeNode__collapse_content,
  ChatDebugTreeNode__error,
  ChatDebugTreeNode__generated_image_reference,
  ChatDebugTreeNode__show_content,
  ChatDebugTreeNode__text_content_hidden,
  ChatDebugTreeNode__thinking_process,
  ChatGroupActions__delete_group,
  ChatGroupActions__duplicate_group,
  ChatGroupActions__more_actions,
  ChatGroupActions__search_in_group,
  ChatGroupSearchPreview__chat_count,
  ChatGroupSearchPreview__empty_group,
  ChatGroupSearchPreview__group_preview,
  ChatGroupSearchPreview__open_chat,
  ChatGroupSearchPreview__select_a_chat_to_preview,
  ChatGroupSettingsPanel__active_overrides,
  ChatGroupSettingsPanel__add_header,
  ChatGroupSettingsPanel__added_after_global_instructions,
  ChatGroupSettingsPanel__append,
  ChatGroupSettingsPanel__appending,
  ChatGroupSettingsPanel__automatic_title,
  ChatGroupSettingsPanel__clear,
  ChatGroupSettingsPanel__cleared,
  ChatGroupSettingsPanel__completely_replaces_global_instructions,
  ChatGroupSettingsPanel__configure_how_chats_in_this_group_are_automatically_named,
  ChatGroupSettingsPanel__create_recipe,
  ChatGroupSettingsPanel__custom_http_headers,
  ChatGroupSettingsPanel__disabled,
  ChatGroupSettingsPanel__enabled,
  ChatGroupSettingsPanel__endpoint_type,
  ChatGroupSettingsPanel__endpoint_url,
  ChatGroupSettingsPanel__failed_to_save_chat_group_settings,
  ChatGroupSettingsPanel__files,
  ChatGroupSettingsPanel__folders,
  ChatGroupSettingsPanel__global_default,
  ChatGroupSettingsPanel__global_endpoint_type,
  ChatGroupSettingsPanel__global_model,
  ChatGroupSettingsPanel__global_prompt_cleared,
  ChatGroupSettingsPanel__group_level,
  ChatGroupSettingsPanel__group_overrides,
  ChatGroupSettingsPanel__group_settings_take_precedence_over_global_settings_but_can_be_overridden_by_individual_chats,
  ChatGroupSettingsPanel__group_settings_title,
  ChatGroupSettingsPanel__group_system_prompt,
  ChatGroupSettingsPanel__global,
  ChatGroupSettingsPanel__no_prompt,
  ChatGroupSettingsPanel__system_prompt_global_set,
  ChatGroupSettingsPanel__system_prompt_global_not_set,
  ChatGroupSettingsPanel__system_prompt_no_prompt,
  ChatGroupSettingsPanel__instructions_for_this_chat_group,
  ChatGroupSettingsPanel__instructions_to_append,
  ChatGroupSettingsPanel__start_typing_to_override,
  ChatGroupSettingsPanel__enter_instructions_for_this_chat_group,
  ChatGroupSettingsPanel__start_typing_to_replace,
  ChatGroupSettingsPanel__replace,
  ChatGroupSettingsPanel__enter_instructions_that_replace_the_parent_setting,
  ChatGroupSettingsPanel__enter_instructions_to_append,
  ChatGroupSettingsPanel__inherit,
  ChatGroupSettingsPanel__inherit_global_settings_or_override_individual_tools_for_this_chat_group,
  ChatGroupSettingsPanel__inherited,
  ChatGroupSettingsPanel__inherited_instructions,
  ChatGroupSettingsPanel__load_from_saved_profiles,
  ChatGroupSettingsPanel__local_overrides,
  ChatGroupSettingsPanel__model_id_override,
  ChatGroupSettingsPanel__name,
  ChatGroupSettingsPanel__no_custom_headers,
  ChatGroupSettingsPanel__no_global_instructions_defined,
  ChatGroupSettingsPanel__none,
  ChatGroupSettingsPanel__ollama,
  ChatGroupSettingsPanel__openai_compatible,
  ChatGroupSettingsPanel__override,
  ChatGroupSettingsPanel__overriding,
  ChatGroupSettingsPanel__parameters,
  ChatGroupSettingsPanel__quick_endpoint_presets,
  ChatGroupSettingsPanel__quick_profile_switcher,
  ChatGroupSettingsPanel__restore_defaults,
  ChatGroupSettingsPanel__search_group,
  ChatGroupSettingsPanel__search_messages,
  ChatGroupSettingsPanel__set_group_name,
  ChatGroupSettingsPanel__settings_resolution,
  ChatGroupSettingsPanel__share_settings,
  ChatGroupSettingsPanel__system_prompt,
  ChatGroupSettingsPanel__these_settings_only_apply_to_this_group,
  ChatGroupSettingsPanel__these_settings_will_apply_to_all_chats_within_this_group_unless_overridden_by_a_specific_chat,
  ChatGroupSettingsPanel__this_group_will_not_use_any_system_instructions,
  ChatGroupSettingsPanel__title_model_explanation,
  ChatGroupSettingsPanel__use_global_setting,
  ChatGroupSettingsPanel__title_model_override,
  ChatGroupSettingsPanel__same_as_group_chat_endpoint,
  ChatGroupSettingsPanel__title_endpoint_type,
  ChatGroupSettingsPanel__tools,
  ChatGroupSettingsPanel__transformers_js,
  ChatGroupSettingsPanel__transformers_js_experimental,
  ChatGroupSettingsPanel__value,
  ChatGroupSettingsPanel__title_reasoning,
  ChatInput__cancel,
  ChatInput__copying_name,
  ChatInput__edit_image,
  ChatInput__failed_to_copy,
  ChatInput__failed_to_link_folder,
  ChatInput__hide_input,
  ChatInput__maximize_input,
  ChatInput__minimize_input,
  ChatInput__open_advanced_editor,
  ChatInput__remove,
  ChatInput__remove_folder,
  ChatInput__send_message_with_shortcut,
  ChatInput__show_input,
  ChatInput__stop_generating_with_shortcut,
  ChatInput__stop_using_folder,
  ChatInput__type_a_message,
  ChatInput__unlink,
  ChatInput__unlink_folder,
  ChatMediaShelf__click_to_copy_prompt,
  ChatMediaShelf__close_shelf,
  ChatMediaShelf__copied,
  ChatMediaShelf__currently_forward_1_n_first,
  ChatMediaShelf__currently_reverse_n_n_first,
  ChatMediaShelf__failed_to_embed_metadata_in_image,
  ChatMediaShelf__forward,
  ChatMediaShelf__generated_image,
  ChatMediaShelf__jump,
  ChatMediaShelf__jump_to_this_message_in_chat,
  ChatMediaShelf__manual_attachment,
  ChatMediaShelf__media_shelf,
  ChatMediaShelf__model,
  ChatMediaShelf__no_images_in_this_chat_yet,
  ChatMediaShelf__not_available,
  ChatMediaShelf__parameters,
  ChatMediaShelf__reverse,
  ChatMediaShelf__seed,
  ChatMediaShelf__steps,
  ChatMediaShelf__view_details_and_copy_parameters,
  ChatPaneHeader__chat_settings_and_model_override,
  ChatPaneHeader__conversation_outline,
  ChatPaneHeader__copy_shareable_chat_url,
  ChatPaneHeader__custom_overrides_active,
  ChatPaneHeader__debug_mode,
  ChatPaneHeader__delete_chat,
  ChatPaneHeader__edit_chat_title,
  ChatPaneHeader__export_as_markdown,
  ChatPaneHeader__export_as_url,
  ChatPaneHeader__export_markdown,
  ChatPaneHeader__file_explorer,
  ChatPaneHeader__fork_chat_from_last_message,
  ChatPaneHeader__group_name,
  ChatPaneHeader__jump_to_original_chat,
  ChatPaneHeader__media_gallery,
  ChatPaneHeader__more_actions,
  ChatPaneHeader__move_to_group,
  ChatPaneHeader__open_print_dialog,
  ChatPaneHeader__print,
  ChatPaneHeader__search_in_chat,
  ChatPaneHeader__super_edit,
  ChatPaneHeader__super_edit_full_history,
  ChatPaneHeader__top_level,
  ChatPaneHeader__wesh_terminal,
  ChatPane__ai,
  ChatPane__arguments,
  ChatPane__binary_error_detail_missing,
  ChatPane__binary_object_missing,
  ChatPane__chat,
  ChatPane__drop_files_or_folders_to_attach,
  ChatPane__failed_to_generate_share_url,
  ChatPane__fake_lm_enabled_for_this_chat_via,
  ChatPane__process_sequence,
  ChatPane__result,
  ChatPane__share_url_copied_to_clipboard,
  ChatPane__system,
  ChatPane__thought,
  ChatPane__tool,
  ChatPane__tool_executions,
  ChatPane__tool_still_executing,
  ChatPane__user,
  ChatPrintContent__chat_history,
  ChatPrintContent__chat_id,
  ChatSettingsPanel__active_overrides,
  ChatSettingsPanel__add_header,
  ChatSettingsPanel__added_after_global_instructions,
  ChatSettingsPanel__append,
  ChatSettingsPanel__appending,
  ChatSettingsPanel__auto_check,
  ChatSettingsPanel__automatic_title,
  ChatSettingsPanel__chat_overrides,
  ChatSettingsPanel__chat_settings_take_precedence_over_provider_profiles_which_take_precedence_over_group_settings_which_take_precedence_over_global_settings,
  ChatSettingsPanel__chat_specific_overrides,
  ChatSettingsPanel__chat_system_prompt,
  ChatSettingsPanel__clear,
  ChatSettingsPanel__cleared,
  ChatSettingsPanel__completely_replaces_global_instructions,
  ChatSettingsPanel__configure_how_this_chat_is_automatically_named,
  ChatSettingsPanel__connection_check_is_automatically_performed_only_for_localhost_urls,
  ChatSettingsPanel__custom_http_headers,
  ChatSettingsPanel__disabled,
  ChatSettingsPanel__enabled,
  ChatSettingsPanel__endpoint_type,
  ChatSettingsPanel__endpoint_url,
  ChatSettingsPanel__failed_to_save_chat_settings,
  ChatSettingsPanel__group_global_default,
  ChatSettingsPanel__chat_group,
  ChatSettingsPanel__no_prompt,
  ChatSettingsPanel__system_prompt_chat_group_set,
  ChatSettingsPanel__system_prompt_chat_group_not_set,
  ChatSettingsPanel__system_prompt_no_prompt,
  ChatSettingsPanel__instructions_for_this_chat,
  ChatSettingsPanel__instructions_to_append,
  ChatSettingsPanel__start_typing_to_override,
  ChatSettingsPanel__enter_instructions_for_this_chat,
  ChatSettingsPanel__start_typing_to_replace,
  ChatSettingsPanel__replace,
  ChatSettingsPanel__enter_instructions_that_replace_the_parent_setting,
  ChatSettingsPanel__enter_instructions_to_append,
  ChatSettingsPanel__inherit,
  ChatSettingsPanel__inherited,
  ChatSettingsPanel__inherited_instructions,
  ChatSettingsPanel__load_from_saved_profiles,
  ChatSettingsPanel__local_overrides,
  ChatSettingsPanel__model_override,
  ChatSettingsPanel__name,
  ChatSettingsPanel__no_custom_headers,
  ChatSettingsPanel__no_instructions_inherited,
  ChatSettingsPanel__ollama,
  ChatSettingsPanel__openai_compatible,
  ChatSettingsPanel__override,
  ChatSettingsPanel__overriding,
  ChatSettingsPanel__parameters,
  ChatSettingsPanel__parent_prompt_cleared,
  ChatSettingsPanel__quick_endpoint_presets,
  ChatSettingsPanel__quick_profile_switcher,
  ChatSettingsPanel__restore_defaults,
  ChatSettingsPanel__settings_resolution,
  ChatSettingsPanel__system_prompt,
  ChatSettingsPanel__these_settings_only_apply_to_this_chat,
  ChatSettingsPanel__this_chat_will_not_use_any_system_instructions,
  ChatSettingsPanel__title_model_explanation,
  ChatSettingsPanel__use_chat_group_setting,
  ChatSettingsPanel__title_model_override,
  ChatSettingsPanel__same_as_chat_endpoint,
  ChatSettingsPanel__title_endpoint_type,
  ChatSettingsPanel__transformers_js,
  ChatSettingsPanel__transformers_js_experimental,
  ChatSettingsPanel__value,
  ChatSettingsPanel__title_reasoning,
  ChatTitleDialog__chat_override,
  ChatTitleDialog__chat_title,
  ChatTitleDialog__close,
  ChatTitleDialog__edit_the_title_directly_or_generate_a_new_one_from_the_conversation,
  ChatTitleDialog__editing_source_because_that_is_the_active_source_for_this_chat,
  ChatTitleDialog__generate,
  ChatTitleDialog__generated_in_this_dialog,
  ChatTitleDialog__generated_titles_will_appear_here,
  ChatTitleDialog__global_default,
  ChatTitleDialog__group_override,
  ChatTitleDialog__hide,
  ChatTitleDialog__options_and_history,
  ChatTitleDialog__show,
  ChatTitleDialog__stop,
  ChatTitleDialog__title,
  ChatTitleDialog__title_model,
  ChatTitleDialog__use,
  ChatTitleDialog__use_chat_model,
  ChatToolsMenu__close_menu,
  ChatToolsMenu__options_tools,
  ChatToolsMenu__tools,
  ConnectionTab__add_header,
  ConnectionTab__api_provider,
  ConnectionTab__applied_to_all_new_chats,
  ConnectionTab__auto_title_generation,
  ConnectionTab__check_connection,
  ConnectionTab__connected,
  ConnectionTab__connection_check_for_localhost_only,
  ConnectionTab__copy_setup_url,
  ConnectionTab__copy_url_with_current_settings,
  ConnectionTab__create,
  ConnectionTab__create_new_profile,
  ConnectionTab__custom_http_headers,
  ConnectionTab__default,
  ConnectionTab__default_model,
  ConnectionTab__endpoint_configuration,
  ConnectionTab__endpoint_url,
  ConnectionTab__failed_to_save_settings,
  ConnectionTab__give_configuration_a_name,
  ConnectionTab__global_context_and_parameters,
  ConnectionTab__global_system_prompt,
  ConnectionTab__header_name_example,
  ConnectionTab__helpful_ai_assistant_placeholder,
  ConnectionTab__load_saved_profile,
  ConnectionTab__model_selection,
  ConnectionTab__no_custom_headers,
  ConnectionTab__none,
  ConnectionTab__ollama,
  ConnectionTab__openai_compatible,
  ConnectionTab__profile_created,
  ConnectionTab__quick_profile_switcher,
  ConnectionTab__save_as_new_profile,
  ConnectionTab__save_changes,
  ConnectionTab__save_failed,
  ConnectionTab__settings_saved,
  ConnectionTab__setup_url_copied,
  ConnectionTab__title_generation_model,
  ConnectionTab__transformers_js_experimental,
  ConnectionTab__use_current_chat_endpoint,
  ConnectionTab__title_endpoint,
  ConnectionTab__unavailable_in_standalone_due_to_worker_wasm_restrictions,
  ConnectionTab__understand,
  ConnectionTab__url_copied,
  ConnectionTab__use_current_chat_model,
  ConnectionTab__used_for_new_conversations,
  ConnectionTab__value,
  ConnectionTab__view_profiles,
  ConnectionTab__title_reasoning,
  ConnectionTab__use_current_chat_reasoning,
  ContextCompactProgressStrip__abort_compact,
  ContextCompactProgressStrip__hide_request,
  ContextCompactProgressStrip__live_output,
  ContextCompactProgressStrip__show_request,
  ConversationOutlineOverlay__ai,
  ConversationOutlineOverlay__close_conversation_outline,
  ConversationOutlineOverlay__conversation_outline,
  ConversationOutlineOverlay__empty_message,
  ConversationOutlineOverlay__peek,
  ConversationOutlineOverlay__system,
  ConversationOutlineOverlay__tool,
  ConversationOutlineOverlay__you,
  CustomDialog__dialog,
  DebugIndexPage__debug,
  DebugIndexPage__debug_tools,
  DebugIndexPage__file_protocol_standalone_verification,
  DebugIndexPage__open_an_isolated_diagnostic_page_without_adding_debug_only_behavior_to_the_normal_application_flow,
  DebugIndexPage__verify_generated_scripts_routing_lazy_styles_systemjs_recovery_and_the_reusable_worker_factory,
  DebugPanel__application_state_synchronized,
  DebugPanel__clear_logs,
  DebugPanel__close_panel,
  DebugPanel__development_tools,
  DebugPanel__error_count,
  DebugPanel__explore_opfs,
  DebugPanel__intentional_test_error_triggered_by_user,
  DebugPanel__no_events_recorded,
  DebugPanel__system_events,
  DebugPanel__this_is_used_to_verify_the_error_event_system_ui,
  DebugPanel__total_count,
  DebugPanel__trigger_test_error,
  DebugPanel__trigger_test_info,
  DeveloperOpenStateLinks__choose_data_to_omit,
  DeveloperOpenStateLinks__copied_url_for_host,
  DeveloperOpenStateLinks__copy_url_for_host,
  DeveloperOpenStateLinks__curated,
  DeveloperOpenStateLinks__develop_branch,
  DeveloperOpenStateLinks__exclude_attachments,
  DeveloperOpenStateLinks__exclude_chat_history,
  DeveloperOpenStateLinks__exclude_chats,
  DeveloperOpenStateLinks__excluded_data,
  DeveloperOpenStateLinks__failed_to_copy_state_url,
  DeveloperOpenStateLinks__failed_to_open_state_url,
  DeveloperOpenStateLinks__local_only,
  DeveloperOpenStateLinks__open_current_state,
  DeveloperOpenStateLinks__open_host,
  DeveloperOpenStateLinks__open_state_description,
  DeveloperOpenStateLinks__production,
  DeveloperOpenStateLinks__standard,
  DeveloperOpenStateLinks__state_contents,
  DeveloperTab__clear_all,
  DeveloperTab__clear_all_cache_storage,
  DeveloperTab__clear_cache_storage_warning,
  DeveloperTab__confirm_data_reset,
  DeveloperTab__create_long_sample_chat,
  DeveloperTab__create_sample_chat,
  DeveloperTab__danger_zone,
  DeveloperTab__debug_and_testing,
  DeveloperTab__deletes_cache_storage_entries,
  DeveloperTab__developer_tools,
  DeveloperTab__execute_reset,
  DeveloperTab__experimental_features,
  DeveloperTab__perform_window_reload,
  DeveloperTab__reload_application,
  DeveloperTab__reset,
  DeveloperTab__reset_all_app_data_warning,
  DeveloperTab__reset_all_application_data,
  DeveloperTab__reset_data_provider_warning,
  DeveloperTab__sample_conversations_description,
  DeveloperTab__simulate_pwa_update,
  DeveloperTab__toggle_update_notification,
  ExperimentalFeatureRow__details,
  ExperimentalFeatureRow__details_for,
  ExperimentalFeatureRow__disabled,
  ExperimentalFeatureRow__enabled,
  FeatureFlagsSettings__cancel,
  FeatureFlagsSettings__disable_fake_lm,
  FeatureFlagsSettings__disable_folders,
  FeatureFlagsSettings__disable_move_chat_on_send,
  FeatureFlagsSettings__disable_shell,
  FeatureFlagsSettings__disable_tool_config_persistence,
  FeatureFlagsSettings__enable,
  FeatureFlagsSettings__enable_experimental_feature,
  FeatureFlagsSettings__enable_fake_lm,
  FeatureFlagsSettings__enable_folders,
  FeatureFlagsSettings__enable_move_chat_on_send,
  FeatureFlagsSettings__enable_shell,
  FeatureFlagsSettings__enable_tool_config_persistence,
  FeatureFlagsSettings__experimental_feature_warning,
  FeatureFlagsSettings__fake_lm_debug_mode,
  FeatureFlagsSettings__features_may_change,
  FeatureFlagsSettings__folders,
  FeatureFlagsSettings__folders_disabled_details,
  FeatureFlagsSettings__folders_enabled_details,
  FeatureFlagsSettings__hosted_build_only,
  FeatureFlagsSettings__move_chat_disabled_details,
  FeatureFlagsSettings__move_chat_enabled_details,
  FeatureFlagsSettings__move_chat_on_send,
  FeatureFlagsSettings__moves_active_chat_after_send,
  FeatureFlagsSettings__saves_tool_settings,
  FeatureFlagsSettings__shell_disabled_details,
  FeatureFlagsSettings__shell_enabled_details,
  FeatureFlagsSettings__shell_in_browser,
  FeatureFlagsSettings__shows_folders_tab,
  FeatureFlagsSettings__shows_shell_in_chat_tools,
  FeatureFlagsSettings__tool_config_persistence,
  FeatureFlagsSettings__tool_persistence_disabled_details,
  FeatureFlagsSettings__tool_persistence_enabled_details,
  FeatureFlagsSettings__use_fake_lm_endpoint,
  FeatureFlagsSettings__uses_bundled_fake_lm,
  GlobalSearchModal__all,
  GlobalSearchModal__alt_branch,
  GlobalSearchModal__assistant,
  GlobalSearchModal__chat,
  GlobalSearchModal__chat_count,
  GlobalSearchModal__chats_found,
  GlobalSearchModal__clear_all_filters,
  GlobalSearchModal__context,
  GlobalSearchModal__current_thread,
  GlobalSearchModal__filter_by_group,
  GlobalSearchModal__filtered_chat,
  GlobalSearchModal__full,
  GlobalSearchModal__groups,
  GlobalSearchModal__navigate,
  GlobalSearchModal__no_groups_available,
  GlobalSearchModal__no_results_for,
  GlobalSearchModal__off,
  GlobalSearchModal__on,
  GlobalSearchModal__peek,
  GlobalSearchModal__preview,
  GlobalSearchModal__role,
  GlobalSearchModal__scanning_content,
  GlobalSearchModal__search,
  GlobalSearchModal__search_chats_and_messages,
  GlobalSearchModal__select,
  GlobalSearchModal__title_only,
  GlobalSearchModal__total_matches,
  GlobalSearchModal__type_to_search,
  GlobalSearchModal__user,
  GlobalToolsSettings__global_settings,
  GlobalToolsSettings__tool_defaults_can_be_overridden,
  GlobalToolsSettings__tools,
  HistoryManipulationModal__add_first_message,
  HistoryManipulationModal__add_message_after,
  HistoryManipulationModal__append_message,
  HistoryManipulationModal__apply_changes,
  HistoryManipulationModal__applying_changes_creates_a,
  HistoryManipulationModal__attach_media,
  HistoryManipulationModal__chat_system_prompt,
  HistoryManipulationModal__copy_message,
  HistoryManipulationModal__discard,
  HistoryManipulationModal__enter_system_prompt_content,
  HistoryManipulationModal__forge_empty_history,
  HistoryManipulationModal__from_the_root_the_original_conversation_remains_preserved,
  HistoryManipulationModal__inherited,
  HistoryManipulationModal__manipulate_full_chat_history_a_new_branch_will_be_created,
  HistoryManipulationModal__message_list,
  HistoryManipulationModal__new_branch,
  HistoryManipulationModal__no_system_prompt_inherited,
  HistoryManipulationModal__parent_prompt_cleared,
  HistoryManipulationModal__remove_message,
  HistoryManipulationModal__super_edit,
  HistoryManipulationModal__switch_role,
  HistoryManipulationModal__system_prompt_resolution,
  HistoryManipulationModal__this_chat_will_not_use_any_system_instructions,
  HistoryManipulationModal__thoughts,
  HistoryManipulationModal__type_message_content,
  ImageConjuringLoader__generating_image,
  ImageConjuringLoader__generating_images,
  ImageConjuringLoader__image_count,
  ImageConjuringLoader__steps,
  ImageDownloadButton__download_image,
  ImageDownloadButton__embed_prompt_seed_etc,
  ImageDownloadButton__more_options,
  ImageDownloadButton__not_supported_for_this_format,
  ImageDownloadButton__with_metadata,
  ImageEditor__apply_resize,
  ImageEditor__black,
  ImageEditor__close,
  ImageEditor__close_and_discard_unsaved_changes,
  ImageEditor__crop,
  ImageEditor__crop_to_selection,
  ImageEditor__discard,
  ImageEditor__discard_changes,
  ImageEditor__elliptical_selection,
  ImageEditor__fill_everything_outside_selection,
  ImageEditor__fill_selection_area,
  ImageEditor__finish,
  ImageEditor__flip_horizontal,
  ImageEditor__flip_vertical,
  ImageEditor__free_resizing,
  ImageEditor__image_editor,
  ImageEditor__maintain_aspect_ratio,
  ImageEditor__mask_in,
  ImageEditor__mask_out,
  ImageEditor__original,
  ImageEditor__output_format,
  ImageEditor__pick_color_from_canvas,
  ImageEditor__recent,
  ImageEditor__rectangular_selection,
  ImageEditor__redo,
  ImageEditor__reset,
  ImageEditor__reset_image,
  ImageEditor__reset_zoom,
  ImageEditor__resize_px,
  ImageEditor__rotate_left,
  ImageEditor__rotate_right,
  ImageEditor__selection,
  ImageEditor__toggle_tools_sidebar,
  ImageEditor__tools,
  ImageEditor__transform,
  ImageEditor__transparent,
  ImageEditor__undo,
  ImageEditor__wheel_to_zoom_middle_click_or_alt_plus_drag_to_pan,
  ImageEditor__white,
  ImageEditor__zoom,
  ImageEditor__zoom_in,
  ImageEditor__zoom_out,
  ImageGenerationSettings__auto,
  ImageGenerationSettings__click_to_enter_specific_seed,
  ImageGenerationSettings__create_image_experimental,
  ImageGenerationSettings__explicitly_generate_random_seed_in_browser_for_each_image,
  ImageGenerationSettings__height,
  ImageGenerationSettings__image_model,
  ImageGenerationSettings__jpeg,
  ImageGenerationSettings__no_tools_available_for_this_provider,
  ImageGenerationSettings__number_of_images,
  ImageGenerationSettings__original,
  ImageGenerationSettings__png,
  ImageGenerationSettings__qty,
  ImageGenerationSettings__resolution,
  ImageGenerationSettings__save_format,
  ImageGenerationSettings__seed,
  ImageGenerationSettings__select_image_model,
  ImageGenerationSettings__steps,
  ImageGenerationSettings__swap_width_and_height,
  ImageGenerationSettings__webp,
  ImageGenerationSettings__width,
  ImageInfoDisplay__copy_prompt,
  ImageInfoDisplay__copy_seed,
  ImageInfoDisplay__image_info,
  ImageInfoDisplay__prompt,
  ImageInfoDisplay__seed,
  ImageInfoDisplay__size,
  ImageInfoDisplay__steps,
  ImportExportModal__add_new,
  ImportExportModal__analyzing_file,
  ImportExportModal__append_keeps_current_data,
  ImportExportModal__append_merge,
  ImportExportModal__append_preset,
  ImportExportModal__back,
  ImportExportModal__back_to_menu,
  ImportExportModal__cancel,
  ImportExportModal__chat_count,
  ImportExportModal__chat_title_prefix,
  ImportExportModal__chats,
  ImportExportModal__compressing_data,
  ImportExportModal__content_preview,
  ImportExportModal__custom_click_to_reset,
  ImportExportModal__default_marker,
  ImportExportModal__default_model,
  ImportExportModal__download_full_backup,
  ImportExportModal__error,
  ImportExportModal__exclude_attachments,
  ImportExportModal__exclude_chat_history,
  ImportExportModal__exclude_chats,
  ImportExportModal__experimental,
  ImportExportModal__export,
  ImportExportModal__export_failed,
  ImportExportModal__export_now,
  ImportExportModal__export_successful,
  ImportExportModal__failed_to_analyze_file,
  ImportExportModal__filename_tag_example,
  ImportExportModal__filename_tag_optional,
  ImportExportModal__files,
  ImportExportModal__global_system_prompt,
  ImportExportModal__group_name_prefix,
  ImportExportModal__groups,
  ImportExportModal__ignore,
  ImportExportModal__import,
  ImportExportModal__import_export,
  ImportExportModal__import_failed,
  ImportExportModal__import_successful,
  ImportExportModal__importing_data,
  ImportExportModal__keep_current,
  ImportExportModal__lm_parameters,
  ImportExportModal__mode_and_data_strategy,
  ImportExportModal__next,
  ImportExportModal__no_settings_or_profiles,
  ImportExportModal__output_filename,
  ImportExportModal__overwrite,
  ImportExportModal__portable_data,
  ImportExportModal__profiles,
  ImportExportModal__provider_profiles,
  ImportExportModal__ready_to_export,
  ImportExportModal__replace_clears_current_data,
  ImportExportModal__replace_restore,
  ImportExportModal__restore_preset,
  ImportExportModal__settings_and_profiles,
  ImportExportModal__title_generation_model,
  ImportExportModal__untitled_chat,
  ImportExportModal__upload_backup_to_restore_or_merge,
  ImportExportModal__url_and_http_headers,
  ImportExportModal__verifying_integrity,
  ImportExportModal__zip_contains_all_data_by_default,
  ImportExportService__export_dump_failed,
  ImportExportService__invalid_zip_file,
  LanguageSelector__language,
  LmParametersEditor__default,
  LmParametersEditor__empty_fields_use_provider_defaults,
  LmParametersEditor__invalid_json,
  LmParametersEditor__lm_parameters,
  LmParametersEditor__max_tokens,
  LmParametersEditor__must_be_an_array_of_strings,
  LmParametersEditor__presence_penalty,
  LmParametersEditor__reset_all,
  LmParametersEditor__reset_to_default,
  LmParametersEditor__stop_sequences_json_array,
  LmParametersEditor__temperature,
  LmParametersEditor__top_p,
  LmToolsSettings__changes_apply_to_this_browser_session_only_while_tool_config_persistence_is_disabled,
  LmToolsSettings__failed_to_save_chat_tool_settings,
  Logo__naidan_logo,
  MessageActions__compare_versions,
  MessageActions__copied,
  MessageActions__copy_link,
  MessageActions__copy_message,
  MessageActions__copy_raw,
  MessageActions__edit_message,
  MessageActions__failed_to_copy_message_link,
  MessageActions__fork_chat,
  MessageActions__message_link_copied,
  MessageActions__more_actions,
  MessageActions__more_message_tools,
  MessageActions__regenerate_response,
  MessageActions__resend_message,
  MessageDiffModal__base,
  MessageDiffModal__comparing_base_version,
  MessageDiffModal__copied,
  MessageDiffModal__copy_result,
  MessageDiffModal__copy_this_version,
  MessageDiffModal__diff_on,
  MessageDiffModal__exclude_from_diff,
  MessageDiffModal__include,
  MessageDiffModal__include_in_diff,
  MessageDiffModal__loading_more_versions,
  MessageDiffModal__message_history_and_compare,
  MessageDiffModal__off,
  MessageDiffModal__reset_selection,
  MessageDiffModal__select_versions_to_compare_differences,
  MessageDiffModal__skip,
  MessageDiffModal__target,
  MessageDiffModal__target_version,
  MessageItem__cancel,
  MessageItem__clear,
  MessageItem__clear_all_text,
  MessageItem__download_image,
  MessageItem__generation_failed,
  MessageItem__high,
  MessageItem__image_generated,
  MessageItem__image_missing,
  MessageItem__low,
  MessageItem__medium,
  MessageItem__more_message_tools,
  MessageItem__off,
  MessageItem__open_advanced_editor,
  MessageItem__options_tools,
  MessageItem__retry,
  MessageItem__send_and_branch,
  MessageItem__stop_generation,
  MessageItem__think,
  MessageItem__think_disabled,
  MessageItem__think_effort_note,
  MessageItem__tools,
  MessageItem__update_and_branch,
  MessageItem__you,
  MessageThinking__hide_thought_process,
  MessageThinking__show_thought_process,
  MessageThinking__thinking,
  MessageThinking__thought_process,
  ModelSelector__filter_models,
  ModelSelector__inherit,
  ModelSelector__no_models_found,
  ModelSelector__refresh_model_list,
  ModelSelector__select_a_model,
  MountBadgeList__browse_path,
  MountBadgeList__read_and_write_click_to_restrict,
  MountBadgeList__read_only_click_to_allow_write,
  MountBadgeList__remove,
  OllamaManagementView__ollama_runtime,
  OllamaManagementView__view_and_unload_models_currently_held_in_memory_by_this_ollama_server,
  OllamaPsView__checking,
  OllamaPsView__context_length,
  OllamaPsView__could_not_load_running_models,
  OllamaPsView__digest,
  OllamaPsView__enter_an_ollama_endpoint_url_to_view_running_models,
  OllamaPsView__expires_at,
  OllamaPsView__expires_in_minutes,
  OllamaPsView__expires_soon,
  OllamaPsView__families,
  OllamaPsView__family,
  OllamaPsView__format,
  OllamaPsView__kept_indefinitely,
  OllamaPsView__loaded_count,
  OllamaPsView__loaded_models_remain_available_until_their_keep_alive_period_expires,
  OllamaPsView__loading_models,
  OllamaPsView__memory_size,
  OllamaPsView__model,
  OllamaPsView__model_details,
  OllamaPsView__model_details_aria,
  OllamaPsView__model_unload_requested,
  OllamaPsView__model_unloaded,
  OllamaPsView__models_appear_here_after_ollama_loads_them_for_a_request,
  OllamaPsView__models_currently_using_system_or_video_memory,
  OllamaPsView__no_models_are_currently_loaded,
  OllamaPsView__not_checked,
  OllamaPsView__parent_model,
  OllamaPsView__refresh,
  OllamaPsView__refresh_to_check_this_ollama_server,
  OllamaPsView__refreshing,
  OllamaPsView__running_models,
  OllamaPsView__running_ollama_models,
  OllamaPsView__try_again,
  OllamaPsView__unavailable,
  OllamaPsView__unload,
  OllamaPsView__unload_requested,
  OllamaPsView__unload_requested_ollama_may_keep_showing_this_model_until_active_requests_finish_refresh_to_check_again,
  OllamaPsView__unloading,
  OllamaPsView__vram_size,
  OnboardingModal__add_header,
  OnboardingModal__back,
  OnboardingModal__cancel,
  OnboardingModal__check_connection,
  OnboardingModal__connecting,
  OnboardingModal__connection_attempt_cancelled,
  OnboardingModal__custom_http_headers,
  OnboardingModal__default_model,
  OnboardingModal__do_not_have_a_server,
  OnboardingModal__endpoint_configuration,
  OnboardingModal__enter_existing_server_url,
  OnboardingModal__enter_valid_url,
  OnboardingModal__experimental,
  OnboardingModal__failed_to_connect,
  OnboardingModal__failed_to_save_settings,
  OnboardingModal__get_started,
  OnboardingModal__help_and_guide,
  OnboardingModal__in_browser_ai,
  OnboardingModal__name,
  OnboardingModal__ollama,
  OnboardingModal__openai_compatible,
  OnboardingModal__quick_presets,
  OnboardingModal__run_models_in_browser,
  OnboardingModal__select_a_model,
  OnboardingModal__settings_can_be_changed_later,
  OnboardingModal__settings_saved_for_local_inference,
  OnboardingModal__setup_endpoint,
  OnboardingModal__setup_endpoint_description,
  OnboardingModal__successfully_connected,
  OnboardingModal__transformers_js,
  OnboardingModal__value,
  PWAManager__app_ready_to_work_offline,
  PWAUpdateNotification__reload_to_update,
  PromptApiStatus__browser_provided_language_models_are_not_available_in_this_browser,
  PromptApiStatus__browser_provided_model_is_not_available_on_this_device,
  PromptApiStatus__browser_provided_model_is_ready,
  PromptApiStatus__browser_reported_model_unavailable,
  PromptApiStatus__browser_returned_an_error_while_checking_availability,
  PromptApiStatus__browser_returned_an_error_while_preparing_model,
  PromptApiStatus__checking_browser_provided_language_model_availability,
  PromptApiStatus__chrome_148_or_later_desktop,
  PromptApiStatus__chrome_gpu_with_4_gb_vram_or_less,
  PromptApiStatus__common_reasons_include,
  PromptApiStatus__could_not_check_browser_provided_model_availability,
  PromptApiStatus__downloading_browser_provided_model,
  PromptApiStatus__downloading_browser_provided_model_progress,
  PromptApiStatus__edge_canary_or_dev_138_or_later_with_prompt_api_flag,
  PromptApiStatus__edge_gpu_with_less_than_5_5_gb_vram_for_phi_4_mini,
  PromptApiStatus__if_unavailable_in_a_supported_browser,
  PromptApiStatus__language_model_api_was_not_detected,
  PromptApiStatus__less_than_16_gb_ram_or_fewer_than_4_cpu_cores_for_cpu_inference,
  PromptApiStatus__less_than_required_free_space_on_browser_profile_volume,
  PromptApiStatus__metered_or_unavailable_network_during_initial_download,
  PromptApiStatus__model_download_may_require_an_unmetered_network,
  PromptApiStatus__model_download_may_require_more_free_space,
  PromptApiStatus__model_preparation_failed,
  PromptApiStatus__operating_system_or_hardware_requirements_may_not_be_met,
  PromptApiStatus__prepare_browser_provided_model,
  PromptApiStatus__preparing_browser_provided_model,
  PromptApiStatus__prompt_api_may_be_disabled_by_browser_settings_flags_or_policy,
  PromptApiStatus__required_edge_experimental_flags_are_not_enabled,
  PromptApiStatus__supported_browsers,
  PromptApiStatus__supported_browsers_and_requirements,
  PromptApiStatus__technical_details,
  PromptApiStatus__try_again,
  PromptApiStatus__unsupported_operating_system_or_device,
  PromptApiStatus__unsupported_operating_system_or_device_performance_class,
  ProviderProfilePreview__configuration_preview,
  ProviderProfilePreview__endpoint_url,
  ProviderProfilePreview__headers,
  ProviderProfilePreview__lm_params,
  ProviderProfilePreview__none,
  ProviderProfilePreview__provider_and_model,
  ProviderProfilePreview__system_prompt,
  ProviderProfilesTab__delete_profile,
  ProviderProfilesTab__go_to_connection_to_create_one,
  ProviderProfilesTab__no_default_model,
  ProviderProfilesTab__no_profiles_saved_yet,
  ProviderProfilesTab__profile_was_deleted,
  ProviderProfilesTab__provider_profiles,
  ProviderProfilesTab__rename_profile,
  ProviderProfilesTab__save_and_switch_provider_configurations,
  ProviderProfilesTab__title_model,
  ProviderProfilesTab__undo,
  ReasoningSettings__default,
  ReasoningSettings__effort_levels_may_be_ignored_by_some_models,
  ReasoningSettings__high,
  ReasoningSettings__low,
  ReasoningSettings__med,
  ReasoningSettings__medium,
  ReasoningSettings__off,
  ReasoningSettings__think,
  RecentChatsModal__filter,
  RecentChatsModal__filter_recent_chats,
  RecentChatsModal__navigate,
  RecentChatsModal__no_chats_match_filter,
  RecentChatsModal__no_recent_chats,
  RecentChatsModal__off,
  RecentChatsModal__on,
  RecentChatsModal__peek,
  RecentChatsModal__preview,
  RecentChatsModal__select,
  RecipeExportModal__aa,
  RecipeExportModal__add_rule,
  RecipeExportModal__append,
  RecipeExportModal__clear,
  RecipeExportModal__copied_to_clipboard,
  RecipeExportModal__copy_recipe_json,
  RecipeExportModal__description,
  RecipeExportModal__include_custom_instructions_in_the_recipe,
  RecipeExportModal__invalid_regular_expression,
  RecipeExportModal__live_recipe_preview,
  RecipeExportModal__model_matching_rules_regex,
  RecipeExportModal__no_matching_rules_recipe_will_use_the_default_model,
  RecipeExportModal__override,
  RecipeExportModal__parent_prompt_cleared,
  RecipeExportModal__recipe_editor,
  RecipeExportModal__recipe_name,
  RecipeExportModal__recipe_system_prompt,
  RecipeExportModal__regex,
  RecipeExportModal__temperature_top_p_and_other_lm_parameters_are_automatically_included_from_your_current_group_overrides,
  RecipeExportModal__this_recipe_will_explicitly_clear_any_inherited_system_instructions,
  RecipeExportModal__toggle_case_sensitivity,
  RecipeExportModal__what_makes_this_recipe_special,
  RecipeImportTab__chat_group_name,
  RecipeImportTab__detected_recipes,
  RecipeImportTab__import_chat_group_recipes,
  RecipeImportTab__import_selected,
  RecipeImportTab__model_selection,
  RecipeImportTab__paste_recipe_json_concatenated_json_objects_supported,
  RecipeImportTab__recipes,
  RecipeImportTab__system_prompt,
  RecipeImportTab__use_default_model,
  RelativeTime__days_ago,
  RelativeTime__hours_ago,
  RelativeTime__just_now,
  RelativeTime__minutes_ago,
  RelativeTime__seconds_ago,
  SearchPreview__alt_branch,
  SearchPreview__conversation_match,
  SearchPreview__following_messages,
  SearchPreview__message_count,
  SearchPreview__previous_messages,
  SearchPreview__recent_history,
  SearchPreview__select_an_item_to_preview,
  ServerSetupGuide__download_the_installer_from_the_official_website,
  ServerSetupGuide__download_the_latest_binary_or_build_from_source,
  ServerSetupGuide__external,
  ServerSetupGuide__install_using_homebrew,
  ServerSetupGuide__releases,
  ServerSetupGuide__run_gemma_3n,
  ServerSetupGuide__run_the_installation_script,
  ServerSetupGuide__start_server,
  SettingsModal__about,
  SettingsModal__connection,
  SettingsModal__developer,
  SettingsModal__discard,
  SettingsModal__discard_unsaved_changes,
  SettingsModal__discard_unsaved_connection_changes,
  SettingsModal__failed_to_import_recipes,
  SettingsModal__files,
  SettingsModal__folders,
  SettingsModal__keep_editing,
  SettingsModal__provider_profiles,
  SettingsModal__recipes,
  SettingsModal__settings,
  SettingsModal__standalone,
  SettingsModal__storage,
  SettingsModal__successfully_imported_recipes_as_chat_groups,
  SettingsModal__tools,
  SettingsModal__transformers_js,
  SidebarDebugControls__debug_events,
  SidebarDebugControls__file_explorer,
  SidebarDebugControls__more_actions,
  SidebarDebugControls__quick_access,
  SidebarDebugControls__recent_chats,
  SidebarDebugControls__wesh_terminal,
  Sidebar__add_chat,
  Sidebar__cancel,
  Sidebar__close_sidebar,
  Sidebar__create_chat_group,
  Sidebar__current_group,
  Sidebar__default_model,
  Sidebar__delete_group,
  Sidebar__delete_group_question,
  Sidebar__delete_group_warning,
  Sidebar__ephemeral_session,
  Sidebar__group_name,
  Sidebar__new_chat_in_group,
  Sidebar__none,
  Sidebar__open_sidebar,
  Sidebar__rename_group,
  Sidebar__search_cmd_k,
  Sidebar__select_default_model,
  Sidebar__settings,
  Sidebar__show_less,
  Sidebar__show_more,
  SpeechControl__pause,
  SpeechControl__read_aloud,
  SpeechControl__restart,
  SpeechControl__resume,
  SpeechControl__stop,
  SpeechLanguageSelector__auto,
  SpeechLanguageSelector__auto_detect,
  SpeechLanguageSelector__auto_detect_with_language,
  SpeechLanguageSelector__english,
  SpeechLanguageSelector__language,
  SpeechLanguageSelector__redetect_language,
  StandaloneVerificationPage__checks_file_protocol_startup_routing_styles_lazy_chunks_systemjs_and_repeated_worker_creation_without_changing_chats_or_settings,
  StandaloneVerificationPage__copied_diagnostics_may_contain_local_file_paths_in_browser_provided_error_stacks_or_resource_timing_entries,
  StandaloneVerificationPage__copy_json,
  StandaloneVerificationPage__failed_to_copy_verification_json,
  StandaloneVerificationPage__run_standalone_verification,
  StandaloneVerificationPage__running,
  StandaloneVerificationPage__standalone_verification,
  StandaloneVerificationPage__standalone_verification_json_copied,
  StandaloneVerificationPage__these_checks_require_a_standalone_build_opened_through_file,
  StandaloneVerificationPage__verification_failed_to_run,
  StandaloneVerificationPage__verification_summary,
  StorageService__an_error_occurred_during_a_storage_operation,
  StorageTab__active,
  StorageTab__active_storage_provider,
  StorageTab__attachments_will_be_inaccessible,
  StorageTab__backup_and_restore,
  StorageTab__backup_restore_description,
  StorageTab__best_effort,
  StorageTab__browser_declined_persistence,
  StorageTab__checking,
  StorageTab__clear_all,
  StorageTab__clear_all_conversation_history,
  StorageTab__clear_conversation_history,
  StorageTab__clear_history,
  StorageTab__clear_history_description,
  StorageTab__confirm_storage_switch,
  StorageTab__confirm_switch_to_storage,
  StorageTab__copy_link,
  StorageTab__data_cleanup,
  StorageTab__data_durability,
  StorageTab__delete_all_chats_warning,
  StorageTab__enable,
  StorageTab__ephemeral,
  StorageTab__ephemeral_description,
  StorageTab__error,
  StorageTab__exclude_attachments,
  StorageTab__exclude_chat_history,
  StorageTab__exclude_chats,
  StorageTab__experimental,
  StorageTab__export_import,
  StorageTab__export_url_copied,
  StorageTab__failed_to_enable_persistence,
  StorageTab__failed_to_generate_export_url,
  StorageTab__failed_to_migrate_data,
  StorageTab__generating,
  StorageTab__large_storage_link_warning,
  StorageTab__local_storage,
  StorageTab__local_storage_description,
  StorageTab__local_storage_loses_attachments,
  StorageTab__manage_data,
  StorageTab__migration_failed,
  StorageTab__not_supported,
  StorageTab__opfs_description,
  StorageTab__origin_private_file_system,
  StorageTab__persistence_denied,
  StorageTab__persistent_storage,
  StorageTab__persistent_storage_description,
  StorageTab__persistent_storage_not_supported,
  StorageTab__protected,
  StorageTab__recommended,
  StorageTab__share_url_description,
  StorageTab__share_via_url,
  StorageTab__storage_management,
  StorageTab__storage_migration_description,
  StorageTab__switch_and_lose_attachments,
  StorageTab__switch_and_migrate,
  StorageTab__understand,
  StorageTab__unsupported,
  ThemeToggle__dark_mode,
  ThemeToggle__light_mode,
  ThemeToggle__system_mode,
  ToolCallGroupItem__used_tools,
  ToolConfigHierarchySettings__access_global_knowledge,
  ToolConfigHierarchySettings__calculator,
  ToolConfigHierarchySettings__choices,
  ToolConfigHierarchySettings__choose_from_model_provided_options,
  ToolConfigHierarchySettings__off,
  ToolConfigHierarchySettings__on,
  ToolConfigHierarchySettings__reset_to_defaults,
  ToolConfigHierarchySettings__shell,
  ToolConfigHierarchySettings__shell_in_browser,
  ToolConfigHierarchySettings__shell_settings,
  ToolConfigHierarchySettings__solve_math_expressions,
  ToolConfigHierarchySettings__tool_config_persistence_is_disabled_saved_settings_remain_active_but_changes_cannot_be_saved_here,
  ToolConfigHierarchySettings__turn_off_tool,
  ToolConfigHierarchySettings__turn_on_tool,
  ToolConfigHierarchySettings__use_global,
  ToolConfigHierarchySettings__use_group,
  ToolConfigHierarchySettings__wikipedia,
  TransformersJsLoadingIndicator__downloading_model,
  TransformersJsLoadingIndicator__downloading_model_weights_from_hugging_face_this_only_happens_once_per_model,
  TransformersJsLoadingIndicator__initializing_model,
  TransformersJsLoadingIndicator__loading_model_progress,
  TransformersJsLoadingIndicator__loading_model_weights_into_browser_memory_for_local_inference,
  TransformersJsLoadingIndicator__model,
  TransformersJsLoadingIndicator__on_device_execution,
  TransformersJsLoadingIndicator__transformers_js_error,
  ModelSupportInvestigationModal__blocked,
  ModelSupportInvestigationModal__candidate_eligible,
  ModelSupportInvestigationModal__candidate_ineligible,
  ModelSupportInvestigationModal__candidate_plan_summary,
  ModelSupportInvestigationModal__candidate_registry_failed,
  ModelSupportInvestigationModal__model_file_plan,
  ModelSupportInvestigationModal__model_file_plan_summary,
  ModelSupportInvestigationModal__cache_revision_unknown,
  ModelSupportInvestigationModal__checking_same_origin_runtime_assets,
  ModelSupportInvestigationModal__close,
  ModelSupportInvestigationModal__current_operation,
  ModelSupportInvestigationModal__declaration_files_summary,
  ModelSupportInvestigationModal__download_partial_evidence,
  ModelSupportInvestigationModal__evidence_export,
  ModelSupportInvestigationModal__environment_evidence_disclosure,
  ModelSupportInvestigationModal__evidence_readiness,
  ModelSupportInvestigationModal__evidence_readiness_summary,
  ModelSupportInvestigationModal__existing_model_data,
  ModelSupportInvestigationModal__failed,
  ModelSupportInvestigationModal__findings,
  ModelSupportInvestigationModal__loading_investigation,
  ModelSupportInvestigationModal__lane_comparison,
  ModelSupportInvestigationModal__lane_continuity_failed,
  ModelSupportInvestigationModal__lane_continuity_summary,
  ModelSupportInvestigationModal__lane_failed,
  ModelSupportInvestigationModal__lane_input_match,
  ModelSupportInvestigationModal__lane_input_mismatch,
  ModelSupportInvestigationModal__lane_route_summary,
  ModelSupportInvestigationModal__multimodal_failed,
  ModelSupportInvestigationModal__multimodal_observed,
  ModelSupportInvestigationModal__multimodal_unavailable,
  ModelSupportInvestigationModal__reasoning_differential_failed,
  ModelSupportInvestigationModal__reasoning_differential_observed,
  ModelSupportInvestigationModal__reasoning_differential_unavailable,
  ModelSupportInvestigationModal__model_declarations,
  ModelSupportInvestigationModal__model_support_investigation,
  ModelSupportInvestigationModal__missing_model_type,
  ModelSupportInvestigationModal__model_type,
  ModelSupportInvestigationModal__no_supported_auto_classes,
  ModelSupportInvestigationModal__not_run,
  ModelSupportInvestigationModal__opfs_inventory,
  ModelSupportInvestigationModal__opfs_inventory_summary,
  ModelSupportInvestigationModal__passed,
  ModelSupportInvestigationModal__repository,
  ModelSupportInvestigationModal__repository_information,
  ModelSupportInvestigationModal__repository_summary,
  ModelSupportInvestigationModal__running,
  ModelSupportInvestigationModal__runtime_assets,
  ModelSupportInvestigationModal__runtime_control_webgpu,
  ModelSupportInvestigationModal__runtime_no_output,
  ModelSupportInvestigationModal__runtime_bytes,
  ModelSupportInvestigationModal__runtime_control,
  ModelSupportInvestigationModal__runtime_environment,
  ModelSupportInvestigationModal__runtime_environment_summary,
  ModelSupportInvestigationModal__runtime_mjs,
  ModelSupportInvestigationModal__runtime_variant,
  ModelSupportInvestigationModal__runtime_wasm,
  ModelSupportInvestigationModal__supported_auto_classes,
  ModelSupportInvestigationModal__support_boundary,
  ModelSupportInvestigationModal__support_boundary_summary,
  ModelSupportInvestigationModal__template_behavior,
  ModelSupportInvestigationModal__template_behavior_summary,
  ModelSupportInvestigationModal__tool_protocol_probe_summary,
  ModelSupportInvestigationModal__tool_result_production_continuation_failed,
  ModelSupportInvestigationModal__tool_result_production_continuation_passed,
  ModelSupportInvestigationModal__tool_template_provenance_summary,
  ModelSupportInvestigationModal__this_is_partial_evidence,
  TransformersJsManager__investigate,
  TransformersJsManager__active,
  TransformersJsManager__active_model,
  TransformersJsManager__add_new_models,
  TransformersJsManager__ai_engine_worker_restarted_successfully,
  TransformersJsManager__asset_details,
  TransformersJsManager__browsers_often_disable_the,
  TransformersJsManager__cache_api,
  TransformersJsManager__could_not_determine_a_valid_model_name_from_folder_structure,
  TransformersJsManager__delete,
  TransformersJsManager__delete_downloaded_model,
  TransformersJsManager__delete_failed,
  TransformersJsManager__delete_model,
  TransformersJsManager__delete_model_warning,
  TransformersJsManager__deleted_model,
  TransformersJsManager__download_failed,
  TransformersJsManager__download_failed_check_details_in_the_section_below,
  TransformersJsManager__download_from_hugging_face,
  TransformersJsManager__download_model,
  TransformersJsManager__downloaded_models,
  TransformersJsManager__downloading_and_compiling,
  TransformersJsManager__engine_control,
  TransformersJsManager__engine_idle,
  TransformersJsManager__engine_ready,
  TransformersJsManager__engine_unloaded_and_resources_released,
  TransformersJsManager__enter_hugging_face_model_id_e_g_onnx_community_phi_4,
  TransformersJsManager__error,
  TransformersJsManager__filter_downloaded_models,
  TransformersJsManager__find_more_models,
  TransformersJsManager__for_local_file_urls_to_avoid_downloading_models_on_every_reload_use_a_local_web_server_or_the_hosted_version,
  TransformersJsManager__get_hosted_version_github,
  TransformersJsManager__hard_restart_ai_worker_engine,
  TransformersJsManager__import_failed,
  TransformersJsManager__import_from_local_files,
  TransformersJsManager__importing_local_model,
  TransformersJsManager__in_browser_ai_transformers_js_is_not_available_because_the_browser_does_not_support_or_allow_access_to,
  TransformersJsManager__in_browser_ai_transformers_js_is_not_available_in_the_standalone_build_due_to_browser_restrictions_on_web_workers_and_webassembly_when_running_from_a_local_file,
  TransformersJsManager__incomplete,
  TransformersJsManager__initializing_engine,
  TransformersJsManager__load,
  TransformersJsManager__load_a_model_from_the_list_below_to_start_in_browser_inference,
  TransformersJsManager__loading_from_local_storage,
  TransformersJsManager__local_cache,
  TransformersJsManager__model_is_already_downloaded,
  TransformersJsManager__models_are_cached_locally_in_the_browser_opfs_for_offline_use,
  TransformersJsManager__no_models_downloaded_yet,
  TransformersJsManager__no_models_match_your_filter,
  TransformersJsManager__note,
  TransformersJsManager__origin_private_file_system_opfs,
  TransformersJsManager__overall_progress,
  TransformersJsManager__preset_model_paths,
  TransformersJsManager__refresh,
  TransformersJsManager__restart,
  TransformersJsManager__restart_ai_engine,
  TransformersJsManager__resume,
  TransformersJsManager__select_a_folder_containing_onnx_model_files_to_import_it_into_the_browsers_storage,
  TransformersJsManager__select_model_folder,
  TransformersJsManager__successfully_downloaded_model,
  TransformersJsManager__successfully_imported_model,
  TransformersJsManager__this_will_terminate_the_current_background_worker_and_start_a_fresh_one_use_this_if_the_engine_becomes_unresponsive_or_shows_fatal_errors,
  TransformersJsManager__unknown,
  TransformersJsManager__unload_model_and_release_resources,
  TransformersJsManager__use_custom_id,
  TransformersJsManager__which_is_required_for_storing_model_files_this_often_happens_in_private_browsing_modes_or_insecure_contexts,
  TransformersJsManager__writing_model_files_to_browser_local_storage_opfs,
  TransformersJsUpsell__add_manage_models,
  TransformersJsUpsell__local_browser_models,
  TransformersJsUpsell__need_more_models_you_can_download_and_manage_local_llms_to_run_directly_in_your_browser,
  UnselectedChatPane__select_or_create_a_chat_to_start,
  WelcomeScreen__all_conversations_are_stored_locally,
  WelcomeScreen__brainstorm,
  WelcomeScreen__code_help,
  WelcomeScreen__conversations_are_stored_in_memory,
  WelcomeScreen__data_is_cleared_on_reload,
  WelcomeScreen__download_portable_app,
  WelcomeScreen__download_standalone_portable_version,
  WelcomeScreen__explain_vue_composition_api,
  WelcomeScreen__home_automation_project_ideas,
  WelcomeScreen__summarize,
  WelcomeScreen__summarize_local_lm_architectures,
  WelcomeScreen__write_a_story,
  WelcomeScreen__write_a_time_travel_detective_story,
  WelcomeScreen__your_data_stays_on_your_device,
  WeshToolSettings__shell,
  WeshToolSettings__shell_in_browser,
  WeshToolSettings__shell_settings,
  advancedTextEditor__aa,
  advancedTextEditor__cancel_esc,
  advancedTextEditor__chars,
  advancedTextEditor__clear_all,
  advancedTextEditor__close_editor_esc,
  advancedTextEditor__confirm_enter,
  advancedTextEditor__copy_all,
  advancedTextEditor__enter,
  advancedTextEditor__enter_to_find_next,
  advancedTextEditor__esc,
  advancedTextEditor__find_and_replace_with_shortcut,
  advancedTextEditor__instance_count,
  advancedTextEditor__lines,
  advancedTextEditor__match_case,
  advancedTextEditor__multi_edit_mode,
  advancedTextEditor__multi_edit_occurrence_with_shortcut,
  advancedTextEditor__redo_with_shortcut,
  advancedTextEditor__renaming_text,
  advancedTextEditor__replace,
  advancedTextEditor__replace_all,
  advancedTextEditor__replace_with,
  advancedTextEditor__search,
  advancedTextEditor__selection,
  advancedTextEditor__steps,
  advancedTextEditor__switch_to_advanced_editor,
  advancedTextEditor__switch_to_normal_textarea,
  advancedTextEditor__to_apply,
  advancedTextEditor__to_cancel,
  advancedTextEditor__toggle_stats,
  advancedTextEditor__toggle_word_wrap,
  advancedTextEditor__type_to_rename_all,
  advancedTextEditor__type_to_replace_all,
  advancedTextEditor__undo_with_shortcut,
  advancedTextEditor__updating,
  advancedTextEditor__use_regex,
  advancedTextEditor__words,
  binaryObjects__binary_objects,
  binaryObjects__close_with_escape,
  binaryObjects__copy_name,
  binaryObjects__date,
  binaryObjects__delete,
  binaryObjects__download,
  binaryObjects__file_type_cannot_be_previewed,
  binaryObjects__loading,
  binaryObjects__loading_more,
  binaryObjects__loading_objects,
  binaryObjects__manage_persisted_files,
  binaryObjects__name,
  binaryObjects__no_objects_found,
  binaryObjects__preview_unavailable,
  binaryObjects__reset_zoom,
  binaryObjects__search_by_name_id_or_type,
  binaryObjects__size,
  binaryObjects__unnamed,
  binaryObjects__zoom_in,
  binaryObjects__zoom_out,
  blockMarkdown__allow_all_external_images_in_this_session,
  blockMarkdown__code,
  blockMarkdown__copied,
  blockMarkdown__copy_code,
  blockMarkdown__copy_source,
  blockMarkdown__external_image,
  blockMarkdown__failed_to_embed_metadata_in_image,
  blockMarkdown__failed_to_load_image,
  blockMarkdown__failed_to_render_mermaid_diagram,
  blockMarkdown__image_not_found_in_storage,
  blockMarkdown__invalid_image_block_data,
  blockMarkdown__preview,
  blockMarkdown__split_view,
  blockMarkdown__toggle_line_wrap,
  blockMarkdown__unknown_token_type,
  chatApproval__allow_action,
  chatApproval__allow_for_this_chat,
  chatApproval__allow_globally,
  chatApproval__allow_once,
  chatApproval__deny,
  chatApproval__get_wikipedia_page,
  chatApproval__keyword_label,
  chatApproval__page_id_label,
  chatApproval__search_wikipedia,
  chatGenerationFlow__attachments_cannot_be_saved,
  chatGenerationFlow__cancel,
  chatGenerationFlow__continue_anyway,
  chatGenerationFlow__generation_failed_in_chat,
  chatGenerationFlow__local_storage_attachments_are_only_available_during_this_session,
  chatGenerationFlow__no_image_generation_model_was_found,
  chatGenerationFlow__view,
  chatHistoryFlow__fork_of_chat,
  chatModelFetch__failed_to_fetch_models_for_resolution,
  contextCompact__aborted,
  contextCompact__applying_compact_branch,
  contextCompact__balanced,
  contextCompact__building_compact_request,
  contextCompact__cancel,
  contextCompact__compact,
  contextCompact__compact_context,
  contextCompact__compact_now,
  contextCompact__compact_prompt,
  contextCompact__compacting_context,
  contextCompact__compacting_context_failed,
  contextCompact__compacting_will_condense_messages_into_a_single_summary,
  contextCompact__complete,
  contextCompact__deep,
  contextCompact__editable_prompt,
  contextCompact__generating_compact_context_with_characters_received,
  contextCompact__memory_reconfiguration,
  contextCompact__messages_to_keep,
  contextCompact__more_context,
  contextCompact__more_history,
  contextCompact__preparing_messages_and_keeping_recent_messages,
  contextCompact__requires_a_configured_model_and_endpoint,
  contextCompact__response_was_empty,
  contextCompact__to_compact,
  contextCompact__to_keep,
  contextCompact__waiting_for_the_model,
  dataDeletion__advanced_mode,
  dataDeletion__checked_selectors_matching_entries,
  dataDeletion__delete_application_data,
  dataDeletion__delete_data_matched_by_selected_selectors,
  dataDeletion__delete_selected_data,
  dataDeletion__delete_selected_data_and_reload,
  dataDeletion__delete_selected_data_question,
  dataDeletion__deletion_preview,
  dataDeletion__developer_focused_deletion_controls_for_naidan_storage_selectors,
  dataDeletion__factory_reset,
  dataDeletion__no_matching_entries,
  dataDeletion__not_available_in_this_runtime,
  dataDeletion__preview_entries,
  dataDeletion__scanning_storage,
  dataDeletion__select_at_least_one_deletion_selector,
  fileExplorer__add,
  fileExplorer__archive_name,
  fileExplorer__binary_file,
  fileExplorer__byte_count,
  fileExplorer__close,
  fileExplorer__close_preview,
  fileExplorer__column_view,
  fileExplorer__copy,
  fileExplorer__create,
  fileExplorer__creating_archive,
  fileExplorer__cut,
  fileExplorer__delete,
  fileExplorer__delete_confirmation,
  fileExplorer__delete_file,
  fileExplorer__delete_folder,
  fileExplorer__delete_items,
  fileExplorer__download,
  fileExplorer__download_directory,
  fileExplorer__empty,
  fileExplorer__empty_folder,
  fileExplorer__enter_a_name_for_the_new_file,
  fileExplorer__enter_a_name_for_the_new_folder,
  fileExplorer__entry_info,
  fileExplorer__exclude_items,
  fileExplorer__exclude_items_help,
  fileExplorer__failed_to_copy_items,
  fileExplorer__failed_to_create_file,
  fileExplorer__failed_to_create_folder,
  fileExplorer__failed_to_load_exclusion_suggestions,
  fileExplorer__failed_to_delete,
  fileExplorer__failed_to_download,
  fileExplorer__failed_to_load_directory,
  fileExplorer__failed_to_move_items,
  fileExplorer__failed_to_rename,
  fileExplorer__failed_to_upload_files,
  fileExplorer__file,
  fileExplorer__file_explorer_opfs,
  fileExplorer__file_is_too_large_to_preview,
  fileExplorer__files,
  fileExplorer__filter_by_name,
  fileExplorer__folder,
  fileExplorer__folder_is_no_longer_available,
  fileExplorer__format,
  fileExplorer__get_info,
  fileExplorer__go_back,
  fileExplorer__hide_preview,
  fileExplorer__icon_view,
  fileExplorer__item_count_label,
  fileExplorer__list_view,
  fileExplorer__load_anyway,
  fileExplorer__locked_click_to_unlock,
  fileExplorer__modified,
  fileExplorer__modified_label,
  fileExplorer__name,
  fileExplorer__new_file,
  fileExplorer__new_file_unlock_to_enable,
  fileExplorer__new_folder,
  fileExplorer__new_folder_unlock_to_enable,
  fileExplorer__no_matching_items,
  fileExplorer__open,
  fileExplorer__optional,
  fileExplorer__paste,
  fileExplorer__preview,
  fileExplorer__refresh,
  fileExplorer__relative_path,
  fileExplorer__rename,
  fileExplorer__search,
  fileExplorer__select_a_file,
  fileExplorer__select_all,
  fileExplorer__selected_count_label,
  fileExplorer__show_preview,
  fileExplorer__size,
  fileExplorer__size_label,
  fileExplorer__type,
  fileExplorer__type_to_narrow_results,
  fileExplorer__unlock_to_enable,
  fileExplorer__unlocked_click_to_lock,
  fileExplorer__unsupported_items_were_skipped,
  fileExplorer__upload_files,
  fileExplorer__upload_files_unlock_to_enable,
  fileExplorer__addition_count,
  fileExplorer__analyzing_zip,
  fileExplorer__blocked_count,
  fileExplorer__cannot_be_placed,
  fileExplorer__existing,
  fileExplorer__extract_and_place,
  fileExplorer__extract_and_place_description,
  fileExplorer__merge_count,
  fileExplorer__next_zip,
  fileExplorer__not_changed_yet,
  fileExplorer__overwrite_count,
  fileExplorer__place_contents_here,
  fileExplorer__place_contents_here_description,
  fileExplorer__place_directory_itself,
  fileExplorer__place_directory_itself_description,
  fileExplorer__place_zip_file_as_is,
  fileExplorer__place_zip_file_as_is_description,
  fileExplorer__placement_method,
  fileExplorer__placement_preview,
  fileExplorer__planned_addition,
  fileExplorer__planned_merge,
  fileExplorer__planned_overwrite,
  fileExplorer__root_directory_handling,
  fileExplorer__status,
  fileExplorer__uploading,
  fileExplorer__zip_archive,
  fileExplorer__zip_cannot_be_extracted,
  fileExplorer__zip_file_upload,
  fileExplorer__zip_upload_preview_outdated,
  formatSettingsSourceLabel__default,
  formatSettingsSourceLabel__none,
  formatSettingsSourceLabel__value_from_chat,
  formatSettingsSourceLabel__value_from_global,
  formatSettingsSourceLabel__value_from_group,
  toolCall__arguments,
  toolCall__code,
  toolCall__disable_wrap,
  toolCall__enable_wrap,
  toolCall__error,
  toolCall__executing,
  toolCall__hide_tool_executions,
  toolCall__live_output,
  toolCall__loading_large_result,
  toolCall__raw_json,
  toolCall__result,
  toolCall__show_tools_count,
  toolCall__tool_executions,
  useBinaryActions__delete_binary_object,
  useBinaryActions__delete_binary_object_warning,
  useBinaryActions__delete_permanently,
  useChatLifecycle__chat_was_deleted,
  useChatLifecycle__undo,
  useChatOrganization__copy_of_chat_group,
  useImageGeneration__failed_to_generate_image,
  useImageGeneration__failed_to_reencode_image,
  useImageGeneration__no_suitable_image_generation_model_found,
  usePrompt__prompt,
  useSettings__data_successfully_imported_from_url,
  useSettings__failed_to_fetch_models_for_settings,
  useSettings__failed_to_import_data_from_url,
  useSettings__invalid_storage_type_falling_back_to_default_detection,
  useSettings__ok,
  useSettings__request_to_use_storage_type_was_ignored,
  useSettings__storage_already_initialized,
  useSettings__storage_type_is_already_set_and_requested_type_was_ignored,
  volumes__access_mode,
  volumes__active_count,
  volumes__add_folder,
  volumes__add_folder_requires_chromium,
  volumes__add_or_copy_folder_into_browser_storage,
  volumes__ai_can_read_and_modify_files,
  volumes__ai_can_read_not_write,
  volumes__cancel,
  volumes__change_access_later,
  volumes__choose_access_level,
  volumes__chromium_browser_over_https,
  volumes__configure,
  volumes__copied,
  volumes__copied_folder,
  volumes__copy_does_not_change_disk_files,
  volumes__copy_folder,
  volumes__copy_is_stored_in_browser_opfs,
  volumes__copy_single_file_instead,
  volumes__copying_file_to_browser,
  volumes__copying_folder_to_browser,
  volumes__delete,
  volumes__delete_folder,
  volumes__delete_folder_warning,
  volumes__drop_to_copy_to_browser,
  volumes__failed_to_add_folder,
  volumes__failed_to_add_folder_with_error,
  volumes__failed_to_copy,
  volumes__failed_to_copy_file,
  volumes__failed_to_copy_folder,
  volumes__failed_to_delete_folder,
  volumes__failed_to_load_folders,
  volumes__failed_to_remove_folder,
  volumes__failed_to_rename_folder,
  volumes__failed_to_update_path_settings,
  volumes__file_copied_to_your_folders,
  volumes__file_progress,
  volumes__folder_added_to_your_folders,
  volumes__folder_deleted,
  volumes__folder_is_no_longer_in_use,
  volumes__folder_is_now_in_use,
  volumes__folder_or_file,
  volumes__folder_removed,
  volumes__folders,
  volumes__give_ai_access_to_files_in_your_folders,
  volumes__imported_folder,
  volumes__in_use,
  volumes__in_use_globally,
  volumes__linked,
  volumes__linked_folder,
  volumes__linking_external_folders_not_supported,
  volumes__more_actions,
  volumes__mount_path_already_in_use,
  volumes__name_cannot_be_empty,
  volumes__no_folders_configured,
  volumes__not_in_use,
  volumes__not_in_use_globally,
  volumes__not_supported_in_browser_or_context,
  volumes__opfs_not_supported,
  volumes__original_folder_is_never_touched,
  volumes__path,
  volumes__path_settings_updated,
  volumes__permission_denied_folder_may_not_be_accessible,
  volumes__read_only,
  volumes__read_write,
  volumes__remove,
  volumes__remove_folder,
  volumes__remove_folder_warning,
  volumes__rename,
  volumes__save,
  volumes__save_changes,
  volumes__stop_using,
  volumes__use,
  volumes__what_is_copy_folder,
  volumes__why_add_folder_disabled,
  weshTerminal__cancel,
  weshTerminal__close_session,
  weshTerminal__close_session_aria,
  weshTerminal__close_session_question,
  weshTerminal__close_terminal,
  weshTerminal__debug_terminal,
  weshTerminal__initializing_worker,
  weshTerminal__new,
  weshTerminal__no_sessions_press_new_to_start_a_worker_backed_shell,
  weshTerminal__session,
  weshTerminal__this_will_dispose_the_worker_and_lose_the_session_history_continue,
  weshTerminal__wesh_terminal,
  OpfsEncryptionSettingsPanel__additional_conflicting_entries,
  OpfsEncryptionSettingsPanel__conflict_changed,
  OpfsEncryptionSettingsPanel__delete_conflicting_data_and_retry,
  OpfsEncryptionSettingsPanel__encrypted_source_remains_authoritative,
  OpfsEncryptionSettingsPanel__plain_target_conflict,
  OpfsEncryptionSettingsPanel__plain_target_conflict_explanation,
  OpfsEncryptionSettingsPanel__plain_target_conflict_loss_warning,
  opfsEncryption__build_and_verify_separate_encrypted_store,
  opfsEncryption__cancel,
  opfsEncryption__change_opfs_passphrase,
  opfsEncryption__change_passphrase,
  opfsEncryption__changing_raw_opfs_during_transition_can_prevent_recovery,
  opfsEncryption__confirm_new_passphrase,
  opfsEncryption__confirm_passphrase,
  opfsEncryption__copied,
  opfsEncryption__copy,
  opfsEncryption__copy_source,
  opfsEncryption__copying_and_verifying_complete_opfs_storage,
  opfsEncryption__could_not_read_encryption_control_state,
  opfsEncryption__decrypt_storage,
  opfsEncryption__decrypt_storage_explanation,
  opfsEncryption__enable_opfs_encryption,
  opfsEncryption__encrypt_storage,
  opfsEncryption__encrypted_storage_needs_recovery,
  opfsEncryption__encryption_control_state_cannot_be_read_safely,
  opfsEncryption__encryption_enabled,
  opfsEncryption__encryption_state_is_unreadable,
  opfsEncryption__encryption_transition_must_finish_before_changing_this_setting,
  opfsEncryption__enter_passphrase_for_opfs_storage,
  opfsEncryption__experimental,
  opfsEncryption__experimental_format_may_change_incompatibly,
  opfsEncryption__hide_passphrase,
  opfsEncryption__interrupted_encryption_operation,
  opfsEncryption__leading_or_trailing_whitespace_is_part_of_passphrase,
  opfsEncryption__loading_recovery_source,
  opfsEncryption__new_passphrase,
  opfsEncryption__only_passphrase_keyslot_is_replaced,
  opfsEncryption__open_raw_opfs_explorer,
  opfsEncryption__opfs_encryption,
  opfsEncryption__passphrase,
  opfsEncryption__passphrases_cannot_contain_line_breaks,
  opfsEncryption__passphrases_do_not_match,
  opfsEncryption__naidan_could_not_finish_loading,
  opfsEncryption__preparing_naidan,
  opfsEncryption__raw_opfs_access_does_not_decrypt,
  opfsEncryption__re_encrypt,
  opfsEncryption__re_encrypt_opfs_storage,
  opfsEncryption__re_encrypt_storage,
  opfsEncryption__re_encrypt_storage_explanation,
  opfsEncryption__recovery_source,
  opfsEncryption__resolve_interrupted_opfs_decryption,
  opfsEncryption__resolve_interrupted_opfs_encryption,
  opfsEncryption__resolve_interrupted_opfs_reencryption,
  opfsEncryption__retry_after_recovery,
  opfsEncryption__save_file,
  opfsEncryption__save_source,
  opfsEncryption__select_opfs_as_active_storage_to_enable_encryption,
  opfsEncryption__show_passphrase,
  opfsEncryption__source_remains_until_verified,
  opfsEncryption__storage_unlocked_but_naidan_could_not_finish_loading,
  opfsEncryption__storage_unlocked_preparing_application,
  opfsEncryption__transparently_encrypt_naidan_opfs_data,
  opfsEncryption__turn_off_opfs_encryption,
  opfsEncryption__understand_experimental_storage_risk,
  opfsEncryption__unlock_and_resolve,
  opfsEncryption__unlock_encrypted_storage,
  opfsEncryption__unlock_storage,
  opfsEncryption__unlocked,
  opfsEncryption__updating_encrypted_storage,
  DeveloperOpfsEncryptionInterruptionPanel__after_authority_switch,
  DeveloperOpfsEncryptionInterruptionPanel__before_authority_switch,
  DeveloperOpfsEncryptionInterruptionPanel__confirm_passphrase,
  DeveloperOpfsEncryptionInterruptionPanel__interrupt_and_reload,
  DeveloperOpfsEncryptionInterruptionPanel__interrupt_opfs_transition,
  DeveloperOpfsEncryptionInterruptionPanel__interruption_boundary,
  DeveloperOpfsEncryptionInterruptionPanel__interrupts_ordinary_transition,
  DeveloperOpfsEncryptionInterruptionPanel__operation,
  DeveloperOpfsEncryptionInterruptionPanel__opfs_only,
  DeveloperOpfsEncryptionInterruptionPanel__opfs_transition_interruption,
  DeveloperOpfsEncryptionInterruptionPanel__ordinary_transition_warning,
  DeveloperOpfsEncryptionInterruptionPanel__transition_in_progress,
  opfsEncryption__progress_bytes,
  opfsEncryption__progress_cleaning_source,
  opfsEncryption__progress_copying,
  opfsEncryption__progress_entries,
  opfsEncryption__progress_finalizing,
  opfsEncryption__progress_preparing,
  opfsEncryption__progress_switching_authority,
  opfsEncryption__progress_verifying,
  opfsEncryption__return_to_plain_after_authority_switch,
  opfsEncryption__return_to_plain_before_authority_switch,
  opfsEncryption__stop_encryption_and_return_to_plain,
  opfsEncryption__returning_to_plain_storage,
} satisfies Strings;
