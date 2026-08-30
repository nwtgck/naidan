// SHARED__ keys intentionally couple every call site to one product-wide copy decision.
// Do not use this scope for deduplication or unclear ownership; follow messages/AGENTS.md.
import { SHARED__all_chats } from '@/strings/messages/SHARED__all_chats/pt-BR';
import { SHARED__assistant } from '@/strings/messages/SHARED__assistant/pt-BR';
import { SHARED__browser_provided } from '@/strings/messages/SHARED__browser_provided/pt-BR';
import { SHARED__cancel } from '@/strings/messages/SHARED__cancel/pt-BR';
import { SHARED__choose_which_chats_are_visible_to_the_shell } from '@/strings/messages/SHARED__choose_which_chats_are_visible_to_the_shell/pt-BR';
import { SHARED__configure_browser_based_shell_access } from '@/strings/messages/SHARED__configure_browser_based_shell_access/pt-BR';
import { SHARED__confirm } from '@/strings/messages/SHARED__confirm/pt-BR';
import { SHARED__connection_failed_check_url_or_provider } from '@/strings/messages/SHARED__connection_failed_check_url_or_provider/pt-BR';
import { SHARED__current_chat } from '@/strings/messages/SHARED__current_chat/pt-BR';
import { SHARED__current_chat_plus_chat_group } from '@/strings/messages/SHARED__current_chat_plus_chat_group/pt-BR';
import { SHARED__expose_chat_discovery_paths } from '@/strings/messages/SHARED__expose_chat_discovery_paths/pt-BR';
import { SHARED__generated_image } from '@/strings/messages/SHARED__generated_image/pt-BR';
import { SHARED__local_and_memory_storage_expose_wesh_as_read_only_without_tmp } from '@/strings/messages/SHARED__local_and_memory_storage_expose_wesh_as_read_only_without_tmp/pt-BR';
import { SHARED__mount } from '@/strings/messages/SHARED__mount/pt-BR';
import { SHARED__new_chat } from '@/strings/messages/SHARED__new_chat/pt-BR';
import { SHARED__no_models_found_at_this_endpoint } from '@/strings/messages/SHARED__no_models_found_at_this_endpoint/pt-BR';
import { SHARED__unsupported_experimental_endpoint } from '@/strings/messages/SHARED__unsupported_experimental_endpoint/pt-BR';
import { SHARED__uses_a_language_model_provided_and_managed_by_the_browser } from '@/strings/messages/SHARED__uses_a_language_model_provided_and_managed_by_the_browser/pt-BR';
import { SHARED__visibility } from '@/strings/messages/SHARED__visibility/pt-BR';
import { SHARED__writable_tmp_is_available_with_opfs_storage } from '@/strings/messages/SHARED__writable_tmp_is_available_with_opfs_storage/pt-BR';

import { AboutTab__about_naidan } from '@/strings/messages/AboutTab__about_naidan/pt-BR';
import { AboutTab__built_with_open_source_software } from '@/strings/messages/AboutTab__built_with_open_source_software/pt-BR';
import { AboutTab__github_repository } from '@/strings/messages/AboutTab__github_repository/pt-BR';
import { AboutTab__loading_licenses } from '@/strings/messages/AboutTab__loading_licenses/pt-BR';
import { AboutTab__open_source_licenses } from '@/strings/messages/AboutTab__open_source_licenses/pt-BR';
import { AboutTab__privacy_focused_local_lm_interface } from '@/strings/messages/AboutTab__privacy_focused_local_lm_interface/pt-BR';
import { AboutTab__runs_locally_via_file_protocol } from '@/strings/messages/AboutTab__runs_locally_via_file_protocol/pt-BR';
import { AboutTab__standalone_app } from '@/strings/messages/AboutTab__standalone_app/pt-BR';
import { AboutTab__unknown_package } from '@/strings/messages/AboutTab__unknown_package/pt-BR';
import { AboutTab__version } from '@/strings/messages/AboutTab__version/pt-BR';
import { AboutTab__view_license_text } from '@/strings/messages/AboutTab__view_license_text/pt-BR';
import { AboutTab__view_source_code_and_contribute } from '@/strings/messages/AboutTab__view_source_code_and_contribute/pt-BR';
import { AssistantProcessSequence__and_more } from '@/strings/messages/AssistantProcessSequence__and_more/pt-BR';
import { AssistantProcessSequence__less } from '@/strings/messages/AssistantProcessSequence__less/pt-BR';
import { AssistantProcessSequence__process_details } from '@/strings/messages/AssistantProcessSequence__process_details/pt-BR';
import { AssistantProcessSequence__show } from '@/strings/messages/AssistantProcessSequence__show/pt-BR';
import { AssistantProcessSequence__thinking_steps } from '@/strings/messages/AssistantProcessSequence__thinking_steps/pt-BR';
import { AssistantProcessSequence__tool_executions } from '@/strings/messages/AssistantProcessSequence__tool_executions/pt-BR';
import { AssistantProcessSequence__used_tools } from '@/strings/messages/AssistantProcessSequence__used_tools/pt-BR';
import { AssistantWaitingIndicator__waiting_for_response } from '@/strings/messages/AssistantWaitingIndicator__waiting_for_response/pt-BR';
import { ChatAttachMenu__a_private_copy_is_saved_in_your_browser } from '@/strings/messages/ChatAttachMenu__a_private_copy_is_saved_in_your_browser/pt-BR';
import { ChatAttachMenu__attach_files_or_folder } from '@/strings/messages/ChatAttachMenu__attach_files_or_folder/pt-BR';
import { ChatAttachMenu__chrome_edge_brave_opera_over_https_links_your_folder_directly_without_copying } from '@/strings/messages/ChatAttachMenu__chrome_edge_brave_opera_over_https_links_your_folder_directly_without_copying/pt-BR';
import { ChatAttachMenu__files } from '@/strings/messages/ChatAttachMenu__files/pt-BR';
import { ChatAttachMenu__folder_copy } from '@/strings/messages/ChatAttachMenu__folder_copy/pt-BR';
import { ChatAttachMenu__folder_link } from '@/strings/messages/ChatAttachMenu__folder_link/pt-BR';
import { ChatAttachMenu__naidan_works_from_the_copy_your_original_files_on_disk_stay_safe_and_intact } from '@/strings/messages/ChatAttachMenu__naidan_works_from_the_copy_your_original_files_on_disk_stay_safe_and_intact/pt-BR';
import { ChatAttachMenu__requires_a_chromium_based_browser } from '@/strings/messages/ChatAttachMenu__requires_a_chromium_based_browser/pt-BR';
import { ChatAttachMenu__what_is_folder_copy } from '@/strings/messages/ChatAttachMenu__what_is_folder_copy/pt-BR';
import { ChatAttachMenu__what_is_folder_link } from '@/strings/messages/ChatAttachMenu__what_is_folder_link/pt-BR';
import { ChatAttachMenu__why_is_folder_link_unavailable } from '@/strings/messages/ChatAttachMenu__why_is_folder_link_unavailable/pt-BR';
import { ChatDebugInspector__active } from '@/strings/messages/ChatDebugInspector__active/pt-BR';
import { ChatDebugInspector__chat_inspector } from '@/strings/messages/ChatDebugInspector__chat_inspector/pt-BR';
import { ChatDebugInspector__collapse_tree } from '@/strings/messages/ChatDebugInspector__collapse_tree/pt-BR';
import { ChatDebugInspector__context_path } from '@/strings/messages/ChatDebugInspector__context_path/pt-BR';
import { ChatDebugInspector__data_explorer } from '@/strings/messages/ChatDebugInspector__data_explorer/pt-BR';
import { ChatDebugInspector__expand_tree } from '@/strings/messages/ChatDebugInspector__expand_tree/pt-BR';
import { ChatDebugInspector__failed_to_parse_image_metadata_during_preview_collection } from '@/strings/messages/ChatDebugInspector__failed_to_parse_image_metadata_during_preview_collection/pt-BR';
import { ChatDebugInspector__fake_lm } from '@/strings/messages/ChatDebugInspector__fake_lm/pt-BR';
import { ChatDebugInspector__fake_lm_is_only_available_in_hosted_builds } from '@/strings/messages/ChatDebugInspector__fake_lm_is_only_available_in_hosted_builds/pt-BR';
import { ChatDebugInspector__full_json } from '@/strings/messages/ChatDebugInspector__full_json/pt-BR';
import { ChatDebugInspector__on } from '@/strings/messages/ChatDebugInspector__on/pt-BR';
import { ChatDebugInspector__open_at_this_message } from '@/strings/messages/ChatDebugInspector__open_at_this_message/pt-BR';
import { ChatDebugInspector__select_a_node_to_inspect } from '@/strings/messages/ChatDebugInspector__select_a_node_to_inspect/pt-BR';
import { ChatDebugInspector__set_this_chat_to_ollama_and_enable_global_fake_lm_debug_mode } from '@/strings/messages/ChatDebugInspector__set_this_chat_to_ollama_and_enable_global_fake_lm_debug_mode/pt-BR';
import { ChatDebugInspector__toggle_content_collapse } from '@/strings/messages/ChatDebugInspector__toggle_content_collapse/pt-BR';
import { ChatDebugInspector__toggle_highlighting } from '@/strings/messages/ChatDebugInspector__toggle_highlighting/pt-BR';
import { ChatDebugInspector__tree } from '@/strings/messages/ChatDebugInspector__tree/pt-BR';
import { ChatDebugTreeNode__collapse_content } from '@/strings/messages/ChatDebugTreeNode__collapse_content/pt-BR';
import { ChatDebugTreeNode__error } from '@/strings/messages/ChatDebugTreeNode__error/pt-BR';
import { ChatDebugTreeNode__generated_image_reference } from '@/strings/messages/ChatDebugTreeNode__generated_image_reference/pt-BR';
import { ChatDebugTreeNode__show_content } from '@/strings/messages/ChatDebugTreeNode__show_content/pt-BR';
import { ChatDebugTreeNode__text_content_hidden } from '@/strings/messages/ChatDebugTreeNode__text_content_hidden/pt-BR';
import { ChatDebugTreeNode__thinking_process } from '@/strings/messages/ChatDebugTreeNode__thinking_process/pt-BR';
import { ChatGroupActions__delete_group } from '@/strings/messages/ChatGroupActions__delete_group/pt-BR';
import { ChatGroupActions__duplicate_group } from '@/strings/messages/ChatGroupActions__duplicate_group/pt-BR';
import { ChatGroupActions__more_actions } from '@/strings/messages/ChatGroupActions__more_actions/pt-BR';
import { ChatGroupActions__search_in_group } from '@/strings/messages/ChatGroupActions__search_in_group/pt-BR';
import { ChatGroupSearchPreview__chat_count } from '@/strings/messages/ChatGroupSearchPreview__chat_count/pt-BR';
import { ChatGroupSearchPreview__empty_group } from '@/strings/messages/ChatGroupSearchPreview__empty_group/pt-BR';
import { ChatGroupSearchPreview__group_preview } from '@/strings/messages/ChatGroupSearchPreview__group_preview/pt-BR';
import { ChatGroupSearchPreview__open_chat } from '@/strings/messages/ChatGroupSearchPreview__open_chat/pt-BR';
import { ChatGroupSearchPreview__select_a_chat_to_preview } from '@/strings/messages/ChatGroupSearchPreview__select_a_chat_to_preview/pt-BR';
import { ChatGroupSettingsPanel__active_overrides } from '@/strings/messages/ChatGroupSettingsPanel__active_overrides/pt-BR';
import { ChatGroupSettingsPanel__add_header } from '@/strings/messages/ChatGroupSettingsPanel__add_header/pt-BR';
import { ChatGroupSettingsPanel__added_after_global_instructions } from '@/strings/messages/ChatGroupSettingsPanel__added_after_global_instructions/pt-BR';
import { ChatGroupSettingsPanel__append } from '@/strings/messages/ChatGroupSettingsPanel__append/pt-BR';
import { ChatGroupSettingsPanel__appending } from '@/strings/messages/ChatGroupSettingsPanel__appending/pt-BR';
import { ChatGroupSettingsPanel__automatic_title } from '@/strings/messages/ChatGroupSettingsPanel__automatic_title/pt-BR';
import { ChatGroupSettingsPanel__clear } from '@/strings/messages/ChatGroupSettingsPanel__clear/pt-BR';
import { ChatGroupSettingsPanel__cleared } from '@/strings/messages/ChatGroupSettingsPanel__cleared/pt-BR';
import { ChatGroupSettingsPanel__completely_replaces_global_instructions } from '@/strings/messages/ChatGroupSettingsPanel__completely_replaces_global_instructions/pt-BR';
import { ChatGroupSettingsPanel__configure_how_chats_in_this_group_are_automatically_named } from '@/strings/messages/ChatGroupSettingsPanel__configure_how_chats_in_this_group_are_automatically_named/pt-BR';
import { ChatGroupSettingsPanel__create_recipe } from '@/strings/messages/ChatGroupSettingsPanel__create_recipe/pt-BR';
import { ChatGroupSettingsPanel__custom_http_headers } from '@/strings/messages/ChatGroupSettingsPanel__custom_http_headers/pt-BR';
import { ChatGroupSettingsPanel__disabled } from '@/strings/messages/ChatGroupSettingsPanel__disabled/pt-BR';
import { ChatGroupSettingsPanel__enabled } from '@/strings/messages/ChatGroupSettingsPanel__enabled/pt-BR';
import { ChatGroupSettingsPanel__endpoint_type } from '@/strings/messages/ChatGroupSettingsPanel__endpoint_type/pt-BR';
import { ChatGroupSettingsPanel__endpoint_url } from '@/strings/messages/ChatGroupSettingsPanel__endpoint_url/pt-BR';
import { ChatGroupSettingsPanel__failed_to_save_chat_group_settings } from '@/strings/messages/ChatGroupSettingsPanel__failed_to_save_chat_group_settings/pt-BR';
import { ChatGroupSettingsPanel__files } from '@/strings/messages/ChatGroupSettingsPanel__files/pt-BR';
import { ChatGroupSettingsPanel__folders } from '@/strings/messages/ChatGroupSettingsPanel__folders/pt-BR';
import { ChatGroupSettingsPanel__global_default } from '@/strings/messages/ChatGroupSettingsPanel__global_default/pt-BR';
import { ChatGroupSettingsPanel__global_endpoint_type } from '@/strings/messages/ChatGroupSettingsPanel__global_endpoint_type/pt-BR';
import { ChatGroupSettingsPanel__global_model } from '@/strings/messages/ChatGroupSettingsPanel__global_model/pt-BR';
import { ChatGroupSettingsPanel__global_prompt_cleared } from '@/strings/messages/ChatGroupSettingsPanel__global_prompt_cleared/pt-BR';
import { ChatGroupSettingsPanel__group_level } from '@/strings/messages/ChatGroupSettingsPanel__group_level/pt-BR';
import { ChatGroupSettingsPanel__group_overrides } from '@/strings/messages/ChatGroupSettingsPanel__group_overrides/pt-BR';
import { ChatGroupSettingsPanel__group_settings_take_precedence_over_global_settings_but_can_be_overridden_by_individual_chats } from '@/strings/messages/ChatGroupSettingsPanel__group_settings_take_precedence_over_global_settings_but_can_be_overridden_by_individual_chats/pt-BR';
import { ChatGroupSettingsPanel__group_settings_title } from '@/strings/messages/ChatGroupSettingsPanel__group_settings_title/pt-BR';
import { ChatGroupSettingsPanel__group_system_prompt } from '@/strings/messages/ChatGroupSettingsPanel__group_system_prompt/pt-BR';
import { ChatGroupSettingsPanel__global } from '@/strings/messages/ChatGroupSettingsPanel__global/pt-BR';
import { ChatGroupSettingsPanel__no_prompt } from '@/strings/messages/ChatGroupSettingsPanel__no_prompt/pt-BR';
import { ChatGroupSettingsPanel__system_prompt_global_set } from '@/strings/messages/ChatGroupSettingsPanel__system_prompt_global_set/pt-BR';
import { ChatGroupSettingsPanel__system_prompt_global_not_set } from '@/strings/messages/ChatGroupSettingsPanel__system_prompt_global_not_set/pt-BR';
import { ChatGroupSettingsPanel__system_prompt_no_prompt } from '@/strings/messages/ChatGroupSettingsPanel__system_prompt_no_prompt/pt-BR';
import { ChatGroupSettingsPanel__instructions_for_this_chat_group } from '@/strings/messages/ChatGroupSettingsPanel__instructions_for_this_chat_group/pt-BR';
import { ChatGroupSettingsPanel__instructions_to_append } from '@/strings/messages/ChatGroupSettingsPanel__instructions_to_append/pt-BR';
import { ChatGroupSettingsPanel__start_typing_to_override } from '@/strings/messages/ChatGroupSettingsPanel__start_typing_to_override/pt-BR';
import { ChatGroupSettingsPanel__enter_instructions_for_this_chat_group } from '@/strings/messages/ChatGroupSettingsPanel__enter_instructions_for_this_chat_group/pt-BR';
import { ChatGroupSettingsPanel__start_typing_to_replace } from '@/strings/messages/ChatGroupSettingsPanel__start_typing_to_replace/pt-BR';
import { ChatGroupSettingsPanel__replace } from '@/strings/messages/ChatGroupSettingsPanel__replace/pt-BR';
import { ChatGroupSettingsPanel__enter_instructions_that_replace_the_parent_setting } from '@/strings/messages/ChatGroupSettingsPanel__enter_instructions_that_replace_the_parent_setting/pt-BR';
import { ChatGroupSettingsPanel__enter_instructions_to_append } from '@/strings/messages/ChatGroupSettingsPanel__enter_instructions_to_append/pt-BR';
import { ChatGroupSettingsPanel__inherit } from '@/strings/messages/ChatGroupSettingsPanel__inherit/pt-BR';
import { ChatGroupSettingsPanel__inherit_global_settings_or_override_individual_tools_for_this_chat_group } from '@/strings/messages/ChatGroupSettingsPanel__inherit_global_settings_or_override_individual_tools_for_this_chat_group/pt-BR';
import { ChatGroupSettingsPanel__inherited } from '@/strings/messages/ChatGroupSettingsPanel__inherited/pt-BR';
import { ChatGroupSettingsPanel__inherited_instructions } from '@/strings/messages/ChatGroupSettingsPanel__inherited_instructions/pt-BR';
import { ChatGroupSettingsPanel__load_from_saved_profiles } from '@/strings/messages/ChatGroupSettingsPanel__load_from_saved_profiles/pt-BR';
import { ChatGroupSettingsPanel__local_overrides } from '@/strings/messages/ChatGroupSettingsPanel__local_overrides/pt-BR';
import { ChatGroupSettingsPanel__model_id_override } from '@/strings/messages/ChatGroupSettingsPanel__model_id_override/pt-BR';
import { ChatGroupSettingsPanel__name } from '@/strings/messages/ChatGroupSettingsPanel__name/pt-BR';
import { ChatGroupSettingsPanel__no_custom_headers } from '@/strings/messages/ChatGroupSettingsPanel__no_custom_headers/pt-BR';
import { ChatGroupSettingsPanel__no_global_instructions_defined } from '@/strings/messages/ChatGroupSettingsPanel__no_global_instructions_defined/pt-BR';
import { ChatGroupSettingsPanel__none } from '@/strings/messages/ChatGroupSettingsPanel__none/pt-BR';
import { ChatGroupSettingsPanel__ollama } from '@/strings/messages/ChatGroupSettingsPanel__ollama/pt-BR';
import { ChatGroupSettingsPanel__openai_compatible } from '@/strings/messages/ChatGroupSettingsPanel__openai_compatible/pt-BR';
import { ChatGroupSettingsPanel__override } from '@/strings/messages/ChatGroupSettingsPanel__override/pt-BR';
import { ChatGroupSettingsPanel__overriding } from '@/strings/messages/ChatGroupSettingsPanel__overriding/pt-BR';
import { ChatGroupSettingsPanel__parameters } from '@/strings/messages/ChatGroupSettingsPanel__parameters/pt-BR';
import { ChatGroupSettingsPanel__quick_endpoint_presets } from '@/strings/messages/ChatGroupSettingsPanel__quick_endpoint_presets/pt-BR';
import { ChatGroupSettingsPanel__quick_profile_switcher } from '@/strings/messages/ChatGroupSettingsPanel__quick_profile_switcher/pt-BR';
import { ChatGroupSettingsPanel__restore_defaults } from '@/strings/messages/ChatGroupSettingsPanel__restore_defaults/pt-BR';
import { ChatGroupSettingsPanel__search_group } from '@/strings/messages/ChatGroupSettingsPanel__search_group/pt-BR';
import { ChatGroupSettingsPanel__search_messages } from '@/strings/messages/ChatGroupSettingsPanel__search_messages/pt-BR';
import { ChatGroupSettingsPanel__set_group_name } from '@/strings/messages/ChatGroupSettingsPanel__set_group_name/pt-BR';
import { ChatGroupSettingsPanel__settings_resolution } from '@/strings/messages/ChatGroupSettingsPanel__settings_resolution/pt-BR';
import { ChatGroupSettingsPanel__share_settings } from '@/strings/messages/ChatGroupSettingsPanel__share_settings/pt-BR';
import { ChatGroupSettingsPanel__system_prompt } from '@/strings/messages/ChatGroupSettingsPanel__system_prompt/pt-BR';
import { ChatGroupSettingsPanel__these_settings_only_apply_to_this_group } from '@/strings/messages/ChatGroupSettingsPanel__these_settings_only_apply_to_this_group/pt-BR';
import { ChatGroupSettingsPanel__these_settings_will_apply_to_all_chats_within_this_group_unless_overridden_by_a_specific_chat } from '@/strings/messages/ChatGroupSettingsPanel__these_settings_will_apply_to_all_chats_within_this_group_unless_overridden_by_a_specific_chat/pt-BR';
import { ChatGroupSettingsPanel__this_group_will_not_use_any_system_instructions } from '@/strings/messages/ChatGroupSettingsPanel__this_group_will_not_use_any_system_instructions/pt-BR';
import { ChatGroupSettingsPanel__title_model_explanation } from '@/strings/messages/ChatGroupSettingsPanel__title_model_explanation/pt-BR';
import { ChatGroupSettingsPanel__use_global_setting } from '@/strings/messages/ChatGroupSettingsPanel__use_global_setting/pt-BR';
import { ChatGroupSettingsPanel__title_model_override } from '@/strings/messages/ChatGroupSettingsPanel__title_model_override/pt-BR';
import { ChatGroupSettingsPanel__same_as_group_chat_endpoint } from '@/strings/messages/ChatGroupSettingsPanel__same_as_group_chat_endpoint/pt-BR';
import { ChatGroupSettingsPanel__title_endpoint_type } from '@/strings/messages/ChatGroupSettingsPanel__title_endpoint_type/pt-BR';
import { ChatGroupSettingsPanel__tools } from '@/strings/messages/ChatGroupSettingsPanel__tools/pt-BR';
import { ChatGroupSettingsPanel__transformers_js } from '@/strings/messages/ChatGroupSettingsPanel__transformers_js/pt-BR';
import { ChatGroupSettingsPanel__transformers_js_experimental } from '@/strings/messages/ChatGroupSettingsPanel__transformers_js_experimental/pt-BR';
import { ChatGroupSettingsPanel__value } from '@/strings/messages/ChatGroupSettingsPanel__value/pt-BR';
import { ChatGroupSettingsPanel__title_reasoning } from '@/strings/messages/ChatGroupSettingsPanel__title_reasoning/pt-BR';
import { ChatInput__cancel } from '@/strings/messages/ChatInput__cancel/pt-BR';
import { ChatInput__copying_name } from '@/strings/messages/ChatInput__copying_name/pt-BR';
import { ChatInput__edit_image } from '@/strings/messages/ChatInput__edit_image/pt-BR';
import { ChatInput__failed_to_copy } from '@/strings/messages/ChatInput__failed_to_copy/pt-BR';
import { ChatInput__failed_to_link_folder } from '@/strings/messages/ChatInput__failed_to_link_folder/pt-BR';
import { ChatInput__hide_input } from '@/strings/messages/ChatInput__hide_input/pt-BR';
import { ChatInput__maximize_input } from '@/strings/messages/ChatInput__maximize_input/pt-BR';
import { ChatInput__minimize_input } from '@/strings/messages/ChatInput__minimize_input/pt-BR';
import { ChatInput__open_advanced_editor } from '@/strings/messages/ChatInput__open_advanced_editor/pt-BR';
import { ChatInput__remove } from '@/strings/messages/ChatInput__remove/pt-BR';
import { ChatInput__remove_folder } from '@/strings/messages/ChatInput__remove_folder/pt-BR';
import { ChatInput__send_message_with_shortcut } from '@/strings/messages/ChatInput__send_message_with_shortcut/pt-BR';
import { ChatInput__show_input } from '@/strings/messages/ChatInput__show_input/pt-BR';
import { ChatInput__stop_generating_with_shortcut } from '@/strings/messages/ChatInput__stop_generating_with_shortcut/pt-BR';
import { ChatInput__stop_using_folder } from '@/strings/messages/ChatInput__stop_using_folder/pt-BR';
import { ChatInput__type_a_message } from '@/strings/messages/ChatInput__type_a_message/pt-BR';
import { ChatInput__unlink } from '@/strings/messages/ChatInput__unlink/pt-BR';
import { ChatInput__unlink_folder } from '@/strings/messages/ChatInput__unlink_folder/pt-BR';
import { ChatMediaShelf__click_to_copy_prompt } from '@/strings/messages/ChatMediaShelf__click_to_copy_prompt/pt-BR';
import { ChatMediaShelf__close_shelf } from '@/strings/messages/ChatMediaShelf__close_shelf/pt-BR';
import { ChatMediaShelf__copied } from '@/strings/messages/ChatMediaShelf__copied/pt-BR';
import { ChatMediaShelf__currently_forward_1_n_first } from '@/strings/messages/ChatMediaShelf__currently_forward_1_n_first/pt-BR';
import { ChatMediaShelf__currently_reverse_n_n_first } from '@/strings/messages/ChatMediaShelf__currently_reverse_n_n_first/pt-BR';
import { ChatMediaShelf__failed_to_embed_metadata_in_image } from '@/strings/messages/ChatMediaShelf__failed_to_embed_metadata_in_image/pt-BR';
import { ChatMediaShelf__forward } from '@/strings/messages/ChatMediaShelf__forward/pt-BR';
import { ChatMediaShelf__generated_image } from '@/strings/messages/ChatMediaShelf__generated_image/pt-BR';
import { ChatMediaShelf__jump } from '@/strings/messages/ChatMediaShelf__jump/pt-BR';
import { ChatMediaShelf__jump_to_this_message_in_chat } from '@/strings/messages/ChatMediaShelf__jump_to_this_message_in_chat/pt-BR';
import { ChatMediaShelf__manual_attachment } from '@/strings/messages/ChatMediaShelf__manual_attachment/pt-BR';
import { ChatMediaShelf__media_shelf } from '@/strings/messages/ChatMediaShelf__media_shelf/pt-BR';
import { ChatMediaShelf__model } from '@/strings/messages/ChatMediaShelf__model/pt-BR';
import { ChatMediaShelf__no_images_in_this_chat_yet } from '@/strings/messages/ChatMediaShelf__no_images_in_this_chat_yet/pt-BR';
import { ChatMediaShelf__not_available } from '@/strings/messages/ChatMediaShelf__not_available/pt-BR';
import { ChatMediaShelf__parameters } from '@/strings/messages/ChatMediaShelf__parameters/pt-BR';
import { ChatMediaShelf__reverse } from '@/strings/messages/ChatMediaShelf__reverse/pt-BR';
import { ChatMediaShelf__seed } from '@/strings/messages/ChatMediaShelf__seed/pt-BR';
import { ChatMediaShelf__steps } from '@/strings/messages/ChatMediaShelf__steps/pt-BR';
import { ChatMediaShelf__view_details_and_copy_parameters } from '@/strings/messages/ChatMediaShelf__view_details_and_copy_parameters/pt-BR';
import { ChatPaneHeader__chat_settings_and_model_override } from '@/strings/messages/ChatPaneHeader__chat_settings_and_model_override/pt-BR';
import { ChatPaneHeader__conversation_outline } from '@/strings/messages/ChatPaneHeader__conversation_outline/pt-BR';
import { ChatPaneHeader__copy_shareable_chat_url } from '@/strings/messages/ChatPaneHeader__copy_shareable_chat_url/pt-BR';
import { ChatPaneHeader__custom_overrides_active } from '@/strings/messages/ChatPaneHeader__custom_overrides_active/pt-BR';
import { ChatPaneHeader__debug_mode } from '@/strings/messages/ChatPaneHeader__debug_mode/pt-BR';
import { ChatPaneHeader__delete_chat } from '@/strings/messages/ChatPaneHeader__delete_chat/pt-BR';
import { ChatPaneHeader__edit_chat_title } from '@/strings/messages/ChatPaneHeader__edit_chat_title/pt-BR';
import { ChatPaneHeader__export_as_markdown } from '@/strings/messages/ChatPaneHeader__export_as_markdown/pt-BR';
import { ChatPaneHeader__export_as_url } from '@/strings/messages/ChatPaneHeader__export_as_url/pt-BR';
import { ChatPaneHeader__export_markdown } from '@/strings/messages/ChatPaneHeader__export_markdown/pt-BR';
import { ChatPaneHeader__file_explorer } from '@/strings/messages/ChatPaneHeader__file_explorer/pt-BR';
import { ChatPaneHeader__fork_chat_from_last_message } from '@/strings/messages/ChatPaneHeader__fork_chat_from_last_message/pt-BR';
import { ChatPaneHeader__group_name } from '@/strings/messages/ChatPaneHeader__group_name/pt-BR';
import { ChatPaneHeader__jump_to_original_chat } from '@/strings/messages/ChatPaneHeader__jump_to_original_chat/pt-BR';
import { ChatPaneHeader__media_gallery } from '@/strings/messages/ChatPaneHeader__media_gallery/pt-BR';
import { ChatPaneHeader__more_actions } from '@/strings/messages/ChatPaneHeader__more_actions/pt-BR';
import { ChatPaneHeader__move_to_group } from '@/strings/messages/ChatPaneHeader__move_to_group/pt-BR';
import { ChatPaneHeader__open_print_dialog } from '@/strings/messages/ChatPaneHeader__open_print_dialog/pt-BR';
import { ChatPaneHeader__print } from '@/strings/messages/ChatPaneHeader__print/pt-BR';
import { ChatPaneHeader__search_in_chat } from '@/strings/messages/ChatPaneHeader__search_in_chat/pt-BR';
import { ChatPaneHeader__super_edit } from '@/strings/messages/ChatPaneHeader__super_edit/pt-BR';
import { ChatPaneHeader__super_edit_full_history } from '@/strings/messages/ChatPaneHeader__super_edit_full_history/pt-BR';
import { ChatPaneHeader__top_level } from '@/strings/messages/ChatPaneHeader__top_level/pt-BR';
import { ChatPaneHeader__wesh_terminal } from '@/strings/messages/ChatPaneHeader__wesh_terminal/pt-BR';
import { ChatPane__ai } from '@/strings/messages/ChatPane__ai/pt-BR';
import { ChatPane__arguments } from '@/strings/messages/ChatPane__arguments/pt-BR';
import { ChatPane__binary_error_detail_missing } from '@/strings/messages/ChatPane__binary_error_detail_missing/pt-BR';
import { ChatPane__binary_object_missing } from '@/strings/messages/ChatPane__binary_object_missing/pt-BR';
import { ChatPane__chat } from '@/strings/messages/ChatPane__chat/pt-BR';
import { ChatPane__drop_files_or_folders_to_attach } from '@/strings/messages/ChatPane__drop_files_or_folders_to_attach/pt-BR';
import { ChatPane__failed_to_generate_share_url } from '@/strings/messages/ChatPane__failed_to_generate_share_url/pt-BR';
import { ChatPane__fake_lm_enabled_for_this_chat_via } from '@/strings/messages/ChatPane__fake_lm_enabled_for_this_chat_via/pt-BR';
import { ChatPane__process_sequence } from '@/strings/messages/ChatPane__process_sequence/pt-BR';
import { ChatPane__result } from '@/strings/messages/ChatPane__result/pt-BR';
import { ChatPane__share_url_copied_to_clipboard } from '@/strings/messages/ChatPane__share_url_copied_to_clipboard/pt-BR';
import { ChatPane__system } from '@/strings/messages/ChatPane__system/pt-BR';
import { ChatPane__thought } from '@/strings/messages/ChatPane__thought/pt-BR';
import { ChatPane__tool } from '@/strings/messages/ChatPane__tool/pt-BR';
import { ChatPane__tool_executions } from '@/strings/messages/ChatPane__tool_executions/pt-BR';
import { ChatPane__tool_still_executing } from '@/strings/messages/ChatPane__tool_still_executing/pt-BR';
import { ChatPane__user } from '@/strings/messages/ChatPane__user/pt-BR';
import { ChatPrintContent__chat_history } from '@/strings/messages/ChatPrintContent__chat_history/pt-BR';
import { ChatPrintContent__chat_id } from '@/strings/messages/ChatPrintContent__chat_id/pt-BR';
import { ChatSettingsPanel__active_overrides } from '@/strings/messages/ChatSettingsPanel__active_overrides/pt-BR';
import { ChatSettingsPanel__add_header } from '@/strings/messages/ChatSettingsPanel__add_header/pt-BR';
import { ChatSettingsPanel__added_after_global_instructions } from '@/strings/messages/ChatSettingsPanel__added_after_global_instructions/pt-BR';
import { ChatSettingsPanel__append } from '@/strings/messages/ChatSettingsPanel__append/pt-BR';
import { ChatSettingsPanel__appending } from '@/strings/messages/ChatSettingsPanel__appending/pt-BR';
import { ChatSettingsPanel__auto_check } from '@/strings/messages/ChatSettingsPanel__auto_check/pt-BR';
import { ChatSettingsPanel__automatic_title } from '@/strings/messages/ChatSettingsPanel__automatic_title/pt-BR';
import { ChatSettingsPanel__chat_overrides } from '@/strings/messages/ChatSettingsPanel__chat_overrides/pt-BR';
import { ChatSettingsPanel__chat_settings_take_precedence_over_provider_profiles_which_take_precedence_over_group_settings_which_take_precedence_over_global_settings } from '@/strings/messages/ChatSettingsPanel__chat_settings_take_precedence_over_provider_profiles_which_take_precedence_over_group_settings_which_take_precedence_over_global_settings/pt-BR';
import { ChatSettingsPanel__chat_specific_overrides } from '@/strings/messages/ChatSettingsPanel__chat_specific_overrides/pt-BR';
import { ChatSettingsPanel__chat_system_prompt } from '@/strings/messages/ChatSettingsPanel__chat_system_prompt/pt-BR';
import { ChatSettingsPanel__clear } from '@/strings/messages/ChatSettingsPanel__clear/pt-BR';
import { ChatSettingsPanel__cleared } from '@/strings/messages/ChatSettingsPanel__cleared/pt-BR';
import { ChatSettingsPanel__completely_replaces_global_instructions } from '@/strings/messages/ChatSettingsPanel__completely_replaces_global_instructions/pt-BR';
import { ChatSettingsPanel__configure_how_this_chat_is_automatically_named } from '@/strings/messages/ChatSettingsPanel__configure_how_this_chat_is_automatically_named/pt-BR';
import { ChatSettingsPanel__connection_check_is_automatically_performed_only_for_localhost_urls } from '@/strings/messages/ChatSettingsPanel__connection_check_is_automatically_performed_only_for_localhost_urls/pt-BR';
import { ChatSettingsPanel__custom_http_headers } from '@/strings/messages/ChatSettingsPanel__custom_http_headers/pt-BR';
import { ChatSettingsPanel__disabled } from '@/strings/messages/ChatSettingsPanel__disabled/pt-BR';
import { ChatSettingsPanel__enabled } from '@/strings/messages/ChatSettingsPanel__enabled/pt-BR';
import { ChatSettingsPanel__endpoint_type } from '@/strings/messages/ChatSettingsPanel__endpoint_type/pt-BR';
import { ChatSettingsPanel__endpoint_url } from '@/strings/messages/ChatSettingsPanel__endpoint_url/pt-BR';
import { ChatSettingsPanel__failed_to_save_chat_settings } from '@/strings/messages/ChatSettingsPanel__failed_to_save_chat_settings/pt-BR';
import { ChatSettingsPanel__group_global_default } from '@/strings/messages/ChatSettingsPanel__group_global_default/pt-BR';
import { ChatSettingsPanel__chat_group } from '@/strings/messages/ChatSettingsPanel__chat_group/pt-BR';
import { ChatSettingsPanel__no_prompt } from '@/strings/messages/ChatSettingsPanel__no_prompt/pt-BR';
import { ChatSettingsPanel__system_prompt_chat_group_set } from '@/strings/messages/ChatSettingsPanel__system_prompt_chat_group_set/pt-BR';
import { ChatSettingsPanel__system_prompt_chat_group_not_set } from '@/strings/messages/ChatSettingsPanel__system_prompt_chat_group_not_set/pt-BR';
import { ChatSettingsPanel__system_prompt_no_prompt } from '@/strings/messages/ChatSettingsPanel__system_prompt_no_prompt/pt-BR';
import { ChatSettingsPanel__instructions_for_this_chat } from '@/strings/messages/ChatSettingsPanel__instructions_for_this_chat/pt-BR';
import { ChatSettingsPanel__instructions_to_append } from '@/strings/messages/ChatSettingsPanel__instructions_to_append/pt-BR';
import { ChatSettingsPanel__start_typing_to_override } from '@/strings/messages/ChatSettingsPanel__start_typing_to_override/pt-BR';
import { ChatSettingsPanel__enter_instructions_for_this_chat } from '@/strings/messages/ChatSettingsPanel__enter_instructions_for_this_chat/pt-BR';
import { ChatSettingsPanel__start_typing_to_replace } from '@/strings/messages/ChatSettingsPanel__start_typing_to_replace/pt-BR';
import { ChatSettingsPanel__replace } from '@/strings/messages/ChatSettingsPanel__replace/pt-BR';
import { ChatSettingsPanel__enter_instructions_that_replace_the_parent_setting } from '@/strings/messages/ChatSettingsPanel__enter_instructions_that_replace_the_parent_setting/pt-BR';
import { ChatSettingsPanel__enter_instructions_to_append } from '@/strings/messages/ChatSettingsPanel__enter_instructions_to_append/pt-BR';
import { ChatSettingsPanel__inherit } from '@/strings/messages/ChatSettingsPanel__inherit/pt-BR';
import { ChatSettingsPanel__inherited } from '@/strings/messages/ChatSettingsPanel__inherited/pt-BR';
import { ChatSettingsPanel__inherited_instructions } from '@/strings/messages/ChatSettingsPanel__inherited_instructions/pt-BR';
import { ChatSettingsPanel__load_from_saved_profiles } from '@/strings/messages/ChatSettingsPanel__load_from_saved_profiles/pt-BR';
import { ChatSettingsPanel__local_overrides } from '@/strings/messages/ChatSettingsPanel__local_overrides/pt-BR';
import { ChatSettingsPanel__model_override } from '@/strings/messages/ChatSettingsPanel__model_override/pt-BR';
import { ChatSettingsPanel__name } from '@/strings/messages/ChatSettingsPanel__name/pt-BR';
import { ChatSettingsPanel__no_custom_headers } from '@/strings/messages/ChatSettingsPanel__no_custom_headers/pt-BR';
import { ChatSettingsPanel__no_instructions_inherited } from '@/strings/messages/ChatSettingsPanel__no_instructions_inherited/pt-BR';
import { ChatSettingsPanel__ollama } from '@/strings/messages/ChatSettingsPanel__ollama/pt-BR';
import { ChatSettingsPanel__openai_compatible } from '@/strings/messages/ChatSettingsPanel__openai_compatible/pt-BR';
import { ChatSettingsPanel__override } from '@/strings/messages/ChatSettingsPanel__override/pt-BR';
import { ChatSettingsPanel__overriding } from '@/strings/messages/ChatSettingsPanel__overriding/pt-BR';
import { ChatSettingsPanel__parameters } from '@/strings/messages/ChatSettingsPanel__parameters/pt-BR';
import { ChatSettingsPanel__parent_prompt_cleared } from '@/strings/messages/ChatSettingsPanel__parent_prompt_cleared/pt-BR';
import { ChatSettingsPanel__quick_endpoint_presets } from '@/strings/messages/ChatSettingsPanel__quick_endpoint_presets/pt-BR';
import { ChatSettingsPanel__quick_profile_switcher } from '@/strings/messages/ChatSettingsPanel__quick_profile_switcher/pt-BR';
import { ChatSettingsPanel__restore_defaults } from '@/strings/messages/ChatSettingsPanel__restore_defaults/pt-BR';
import { ChatSettingsPanel__settings_resolution } from '@/strings/messages/ChatSettingsPanel__settings_resolution/pt-BR';
import { ChatSettingsPanel__system_prompt } from '@/strings/messages/ChatSettingsPanel__system_prompt/pt-BR';
import { ChatSettingsPanel__these_settings_only_apply_to_this_chat } from '@/strings/messages/ChatSettingsPanel__these_settings_only_apply_to_this_chat/pt-BR';
import { ChatSettingsPanel__this_chat_will_not_use_any_system_instructions } from '@/strings/messages/ChatSettingsPanel__this_chat_will_not_use_any_system_instructions/pt-BR';
import { ChatSettingsPanel__title_model_explanation } from '@/strings/messages/ChatSettingsPanel__title_model_explanation/pt-BR';
import { ChatSettingsPanel__use_chat_group_setting } from '@/strings/messages/ChatSettingsPanel__use_chat_group_setting/pt-BR';
import { ChatSettingsPanel__title_model_override } from '@/strings/messages/ChatSettingsPanel__title_model_override/pt-BR';
import { ChatSettingsPanel__same_as_chat_endpoint } from '@/strings/messages/ChatSettingsPanel__same_as_chat_endpoint/pt-BR';
import { ChatSettingsPanel__title_endpoint_type } from '@/strings/messages/ChatSettingsPanel__title_endpoint_type/pt-BR';
import { ChatSettingsPanel__transformers_js } from '@/strings/messages/ChatSettingsPanel__transformers_js/pt-BR';
import { ChatSettingsPanel__transformers_js_experimental } from '@/strings/messages/ChatSettingsPanel__transformers_js_experimental/pt-BR';
import { ChatSettingsPanel__value } from '@/strings/messages/ChatSettingsPanel__value/pt-BR';
import { ChatSettingsPanel__title_reasoning } from '@/strings/messages/ChatSettingsPanel__title_reasoning/pt-BR';
import { ChatTitleDialog__chat_override } from '@/strings/messages/ChatTitleDialog__chat_override/pt-BR';
import { ChatTitleDialog__chat_title } from '@/strings/messages/ChatTitleDialog__chat_title/pt-BR';
import { ChatTitleDialog__close } from '@/strings/messages/ChatTitleDialog__close/pt-BR';
import { ChatTitleDialog__edit_the_title_directly_or_generate_a_new_one_from_the_conversation } from '@/strings/messages/ChatTitleDialog__edit_the_title_directly_or_generate_a_new_one_from_the_conversation/pt-BR';
import { ChatTitleDialog__editing_source_because_that_is_the_active_source_for_this_chat } from '@/strings/messages/ChatTitleDialog__editing_source_because_that_is_the_active_source_for_this_chat/pt-BR';
import { ChatTitleDialog__generate } from '@/strings/messages/ChatTitleDialog__generate/pt-BR';
import { ChatTitleDialog__generated_in_this_dialog } from '@/strings/messages/ChatTitleDialog__generated_in_this_dialog/pt-BR';
import { ChatTitleDialog__generated_titles_will_appear_here } from '@/strings/messages/ChatTitleDialog__generated_titles_will_appear_here/pt-BR';
import { ChatTitleDialog__global_default } from '@/strings/messages/ChatTitleDialog__global_default/pt-BR';
import { ChatTitleDialog__group_override } from '@/strings/messages/ChatTitleDialog__group_override/pt-BR';
import { ChatTitleDialog__hide } from '@/strings/messages/ChatTitleDialog__hide/pt-BR';
import { ChatTitleDialog__options_and_history } from '@/strings/messages/ChatTitleDialog__options_and_history/pt-BR';
import { ChatTitleDialog__show } from '@/strings/messages/ChatTitleDialog__show/pt-BR';
import { ChatTitleDialog__stop } from '@/strings/messages/ChatTitleDialog__stop/pt-BR';
import { ChatTitleDialog__title } from '@/strings/messages/ChatTitleDialog__title/pt-BR';
import { ChatTitleDialog__title_model } from '@/strings/messages/ChatTitleDialog__title_model/pt-BR';
import { ChatTitleDialog__use } from '@/strings/messages/ChatTitleDialog__use/pt-BR';
import { ChatTitleDialog__use_chat_model } from '@/strings/messages/ChatTitleDialog__use_chat_model/pt-BR';
import { ChatToolsMenu__close_menu } from '@/strings/messages/ChatToolsMenu__close_menu/pt-BR';
import { ChatToolsMenu__options_tools } from '@/strings/messages/ChatToolsMenu__options_tools/pt-BR';
import { ChatToolsMenu__tools } from '@/strings/messages/ChatToolsMenu__tools/pt-BR';
import { ConnectionTab__add_header } from '@/strings/messages/ConnectionTab__add_header/pt-BR';
import { ConnectionTab__api_provider } from '@/strings/messages/ConnectionTab__api_provider/pt-BR';
import { ConnectionTab__applied_to_all_new_chats } from '@/strings/messages/ConnectionTab__applied_to_all_new_chats/pt-BR';
import { ConnectionTab__auto_title_generation } from '@/strings/messages/ConnectionTab__auto_title_generation/pt-BR';
import { ConnectionTab__check_connection } from '@/strings/messages/ConnectionTab__check_connection/pt-BR';
import { ConnectionTab__connected } from '@/strings/messages/ConnectionTab__connected/pt-BR';
import { ConnectionTab__connection_check_for_localhost_only } from '@/strings/messages/ConnectionTab__connection_check_for_localhost_only/pt-BR';
import { ConnectionTab__copy_setup_url } from '@/strings/messages/ConnectionTab__copy_setup_url/pt-BR';
import { ConnectionTab__copy_url_with_current_settings } from '@/strings/messages/ConnectionTab__copy_url_with_current_settings/pt-BR';
import { ConnectionTab__create } from '@/strings/messages/ConnectionTab__create/pt-BR';
import { ConnectionTab__create_new_profile } from '@/strings/messages/ConnectionTab__create_new_profile/pt-BR';
import { ConnectionTab__custom_http_headers } from '@/strings/messages/ConnectionTab__custom_http_headers/pt-BR';
import { ConnectionTab__default } from '@/strings/messages/ConnectionTab__default/pt-BR';
import { ConnectionTab__default_model } from '@/strings/messages/ConnectionTab__default_model/pt-BR';
import { ConnectionTab__endpoint_configuration } from '@/strings/messages/ConnectionTab__endpoint_configuration/pt-BR';
import { ConnectionTab__endpoint_url } from '@/strings/messages/ConnectionTab__endpoint_url/pt-BR';
import { ConnectionTab__failed_to_save_settings } from '@/strings/messages/ConnectionTab__failed_to_save_settings/pt-BR';
import { ConnectionTab__give_configuration_a_name } from '@/strings/messages/ConnectionTab__give_configuration_a_name/pt-BR';
import { ConnectionTab__global_context_and_parameters } from '@/strings/messages/ConnectionTab__global_context_and_parameters/pt-BR';
import { ConnectionTab__global_system_prompt } from '@/strings/messages/ConnectionTab__global_system_prompt/pt-BR';
import { ConnectionTab__header_name_example } from '@/strings/messages/ConnectionTab__header_name_example/pt-BR';
import { ConnectionTab__helpful_ai_assistant_placeholder } from '@/strings/messages/ConnectionTab__helpful_ai_assistant_placeholder/pt-BR';
import { ConnectionTab__load_saved_profile } from '@/strings/messages/ConnectionTab__load_saved_profile/pt-BR';
import { ConnectionTab__model_selection } from '@/strings/messages/ConnectionTab__model_selection/pt-BR';
import { ConnectionTab__no_custom_headers } from '@/strings/messages/ConnectionTab__no_custom_headers/pt-BR';
import { ConnectionTab__none } from '@/strings/messages/ConnectionTab__none/pt-BR';
import { ConnectionTab__ollama } from '@/strings/messages/ConnectionTab__ollama/pt-BR';
import { ConnectionTab__openai_compatible } from '@/strings/messages/ConnectionTab__openai_compatible/pt-BR';
import { ConnectionTab__profile_created } from '@/strings/messages/ConnectionTab__profile_created/pt-BR';
import { ConnectionTab__quick_profile_switcher } from '@/strings/messages/ConnectionTab__quick_profile_switcher/pt-BR';
import { ConnectionTab__save_as_new_profile } from '@/strings/messages/ConnectionTab__save_as_new_profile/pt-BR';
import { ConnectionTab__save_changes } from '@/strings/messages/ConnectionTab__save_changes/pt-BR';
import { ConnectionTab__save_failed } from '@/strings/messages/ConnectionTab__save_failed/pt-BR';
import { ConnectionTab__settings_saved } from '@/strings/messages/ConnectionTab__settings_saved/pt-BR';
import { ConnectionTab__setup_url_copied } from '@/strings/messages/ConnectionTab__setup_url_copied/pt-BR';
import { ConnectionTab__title_generation_model } from '@/strings/messages/ConnectionTab__title_generation_model/pt-BR';
import { ConnectionTab__transformers_js_experimental } from '@/strings/messages/ConnectionTab__transformers_js_experimental/pt-BR';
import { ConnectionTab__use_current_chat_endpoint } from '@/strings/messages/ConnectionTab__use_current_chat_endpoint/pt-BR';
import { ConnectionTab__title_endpoint } from '@/strings/messages/ConnectionTab__title_endpoint/pt-BR';
import { ConnectionTab__unavailable_in_standalone_due_to_worker_wasm_restrictions } from '@/strings/messages/ConnectionTab__unavailable_in_standalone_due_to_worker_wasm_restrictions/pt-BR';
import { ConnectionTab__understand } from '@/strings/messages/ConnectionTab__understand/pt-BR';
import { ConnectionTab__url_copied } from '@/strings/messages/ConnectionTab__url_copied/pt-BR';
import { ConnectionTab__use_current_chat_model } from '@/strings/messages/ConnectionTab__use_current_chat_model/pt-BR';
import { ConnectionTab__used_for_new_conversations } from '@/strings/messages/ConnectionTab__used_for_new_conversations/pt-BR';
import { ConnectionTab__value } from '@/strings/messages/ConnectionTab__value/pt-BR';
import { ConnectionTab__view_profiles } from '@/strings/messages/ConnectionTab__view_profiles/pt-BR';
import { ConnectionTab__title_reasoning } from '@/strings/messages/ConnectionTab__title_reasoning/pt-BR';
import { ConnectionTab__use_current_chat_reasoning } from '@/strings/messages/ConnectionTab__use_current_chat_reasoning/pt-BR';
import { ContextCompactProgressStrip__abort_compact } from '@/strings/messages/ContextCompactProgressStrip__abort_compact/pt-BR';
import { ContextCompactProgressStrip__hide_request } from '@/strings/messages/ContextCompactProgressStrip__hide_request/pt-BR';
import { ContextCompactProgressStrip__live_output } from '@/strings/messages/ContextCompactProgressStrip__live_output/pt-BR';
import { ContextCompactProgressStrip__show_request } from '@/strings/messages/ContextCompactProgressStrip__show_request/pt-BR';
import { ConversationOutlineOverlay__ai } from '@/strings/messages/ConversationOutlineOverlay__ai/pt-BR';
import { ConversationOutlineOverlay__close_conversation_outline } from '@/strings/messages/ConversationOutlineOverlay__close_conversation_outline/pt-BR';
import { ConversationOutlineOverlay__conversation_outline } from '@/strings/messages/ConversationOutlineOverlay__conversation_outline/pt-BR';
import { ConversationOutlineOverlay__empty_message } from '@/strings/messages/ConversationOutlineOverlay__empty_message/pt-BR';
import { ConversationOutlineOverlay__peek } from '@/strings/messages/ConversationOutlineOverlay__peek/pt-BR';
import { ConversationOutlineOverlay__system } from '@/strings/messages/ConversationOutlineOverlay__system/pt-BR';
import { ConversationOutlineOverlay__tool } from '@/strings/messages/ConversationOutlineOverlay__tool/pt-BR';
import { ConversationOutlineOverlay__you } from '@/strings/messages/ConversationOutlineOverlay__you/pt-BR';
import { CustomDialog__dialog } from '@/strings/messages/CustomDialog__dialog/pt-BR';
import { DebugIndexPage__debug } from '@/strings/messages/DebugIndexPage__debug/pt-BR';
import { DebugIndexPage__debug_tools } from '@/strings/messages/DebugIndexPage__debug_tools/pt-BR';
import { DebugIndexPage__file_protocol_standalone_verification } from '@/strings/messages/DebugIndexPage__file_protocol_standalone_verification/pt-BR';
import { DebugIndexPage__open_an_isolated_diagnostic_page_without_adding_debug_only_behavior_to_the_normal_application_flow } from '@/strings/messages/DebugIndexPage__open_an_isolated_diagnostic_page_without_adding_debug_only_behavior_to_the_normal_application_flow/pt-BR';
import { DebugIndexPage__verify_generated_scripts_routing_lazy_styles_systemjs_recovery_and_the_reusable_worker_factory } from '@/strings/messages/DebugIndexPage__verify_generated_scripts_routing_lazy_styles_systemjs_recovery_and_the_reusable_worker_factory/pt-BR';
import { DebugPanel__application_state_synchronized } from '@/strings/messages/DebugPanel__application_state_synchronized/pt-BR';
import { DebugPanel__clear_logs } from '@/strings/messages/DebugPanel__clear_logs/pt-BR';
import { DebugPanel__close_panel } from '@/strings/messages/DebugPanel__close_panel/pt-BR';
import { DebugPanel__development_tools } from '@/strings/messages/DebugPanel__development_tools/pt-BR';
import { DebugPanel__error_count } from '@/strings/messages/DebugPanel__error_count/pt-BR';
import { DebugPanel__explore_opfs } from '@/strings/messages/DebugPanel__explore_opfs/pt-BR';
import { DebugPanel__intentional_test_error_triggered_by_user } from '@/strings/messages/DebugPanel__intentional_test_error_triggered_by_user/pt-BR';
import { DebugPanel__no_events_recorded } from '@/strings/messages/DebugPanel__no_events_recorded/pt-BR';
import { DebugPanel__system_events } from '@/strings/messages/DebugPanel__system_events/pt-BR';
import { DebugPanel__this_is_used_to_verify_the_error_event_system_ui } from '@/strings/messages/DebugPanel__this_is_used_to_verify_the_error_event_system_ui/pt-BR';
import { DebugPanel__total_count } from '@/strings/messages/DebugPanel__total_count/pt-BR';
import { DebugPanel__trigger_test_error } from '@/strings/messages/DebugPanel__trigger_test_error/pt-BR';
import { DebugPanel__trigger_test_info } from '@/strings/messages/DebugPanel__trigger_test_info/pt-BR';
import { DeveloperOpenStateLinks__choose_data_to_omit } from '@/strings/messages/DeveloperOpenStateLinks__choose_data_to_omit/pt-BR';
import { DeveloperOpenStateLinks__copied_url_for_host } from '@/strings/messages/DeveloperOpenStateLinks__copied_url_for_host/pt-BR';
import { DeveloperOpenStateLinks__copy_url_for_host } from '@/strings/messages/DeveloperOpenStateLinks__copy_url_for_host/pt-BR';
import { DeveloperOpenStateLinks__curated } from '@/strings/messages/DeveloperOpenStateLinks__curated/pt-BR';
import { DeveloperOpenStateLinks__develop_branch } from '@/strings/messages/DeveloperOpenStateLinks__develop_branch/pt-BR';
import { DeveloperOpenStateLinks__exclude_attachments } from '@/strings/messages/DeveloperOpenStateLinks__exclude_attachments/pt-BR';
import { DeveloperOpenStateLinks__exclude_chat_history } from '@/strings/messages/DeveloperOpenStateLinks__exclude_chat_history/pt-BR';
import { DeveloperOpenStateLinks__exclude_chats } from '@/strings/messages/DeveloperOpenStateLinks__exclude_chats/pt-BR';
import { DeveloperOpenStateLinks__excluded_data } from '@/strings/messages/DeveloperOpenStateLinks__excluded_data/pt-BR';
import { DeveloperOpenStateLinks__failed_to_copy_state_url } from '@/strings/messages/DeveloperOpenStateLinks__failed_to_copy_state_url/pt-BR';
import { DeveloperOpenStateLinks__failed_to_open_state_url } from '@/strings/messages/DeveloperOpenStateLinks__failed_to_open_state_url/pt-BR';
import { DeveloperOpenStateLinks__local_only } from '@/strings/messages/DeveloperOpenStateLinks__local_only/pt-BR';
import { DeveloperOpenStateLinks__open_current_state } from '@/strings/messages/DeveloperOpenStateLinks__open_current_state/pt-BR';
import { DeveloperOpenStateLinks__open_host } from '@/strings/messages/DeveloperOpenStateLinks__open_host/pt-BR';
import { DeveloperOpenStateLinks__open_state_description } from '@/strings/messages/DeveloperOpenStateLinks__open_state_description/pt-BR';
import { DeveloperOpenStateLinks__production } from '@/strings/messages/DeveloperOpenStateLinks__production/pt-BR';
import { DeveloperOpenStateLinks__standard } from '@/strings/messages/DeveloperOpenStateLinks__standard/pt-BR';
import { DeveloperOpenStateLinks__state_contents } from '@/strings/messages/DeveloperOpenStateLinks__state_contents/pt-BR';
import { DeveloperTab__clear_all } from '@/strings/messages/DeveloperTab__clear_all/pt-BR';
import { DeveloperTab__clear_all_cache_storage } from '@/strings/messages/DeveloperTab__clear_all_cache_storage/pt-BR';
import { DeveloperTab__clear_cache_storage_warning } from '@/strings/messages/DeveloperTab__clear_cache_storage_warning/pt-BR';
import { DeveloperTab__confirm_data_reset } from '@/strings/messages/DeveloperTab__confirm_data_reset/pt-BR';
import { DeveloperTab__create_long_sample_chat } from '@/strings/messages/DeveloperTab__create_long_sample_chat/pt-BR';
import { DeveloperTab__create_sample_chat } from '@/strings/messages/DeveloperTab__create_sample_chat/pt-BR';
import { DeveloperTab__danger_zone } from '@/strings/messages/DeveloperTab__danger_zone/pt-BR';
import { DeveloperTab__debug_and_testing } from '@/strings/messages/DeveloperTab__debug_and_testing/pt-BR';
import { DeveloperTab__deletes_cache_storage_entries } from '@/strings/messages/DeveloperTab__deletes_cache_storage_entries/pt-BR';
import { DeveloperTab__developer_tools } from '@/strings/messages/DeveloperTab__developer_tools/pt-BR';
import { DeveloperTab__execute_reset } from '@/strings/messages/DeveloperTab__execute_reset/pt-BR';
import { DeveloperTab__experimental_features } from '@/strings/messages/DeveloperTab__experimental_features/pt-BR';
import { DeveloperTab__perform_window_reload } from '@/strings/messages/DeveloperTab__perform_window_reload/pt-BR';
import { DeveloperTab__reload_application } from '@/strings/messages/DeveloperTab__reload_application/pt-BR';
import { DeveloperTab__reset } from '@/strings/messages/DeveloperTab__reset/pt-BR';
import { DeveloperTab__reset_all_app_data_warning } from '@/strings/messages/DeveloperTab__reset_all_app_data_warning/pt-BR';
import { DeveloperTab__reset_all_application_data } from '@/strings/messages/DeveloperTab__reset_all_application_data/pt-BR';
import { DeveloperTab__reset_data_provider_warning } from '@/strings/messages/DeveloperTab__reset_data_provider_warning/pt-BR';
import { DeveloperTab__sample_conversations_description } from '@/strings/messages/DeveloperTab__sample_conversations_description/pt-BR';
import { DeveloperTab__simulate_pwa_update } from '@/strings/messages/DeveloperTab__simulate_pwa_update/pt-BR';
import { DeveloperTab__toggle_update_notification } from '@/strings/messages/DeveloperTab__toggle_update_notification/pt-BR';
import { ExperimentalFeatureRow__details } from '@/strings/messages/ExperimentalFeatureRow__details/pt-BR';
import { ExperimentalFeatureRow__details_for } from '@/strings/messages/ExperimentalFeatureRow__details_for/pt-BR';
import { ExperimentalFeatureRow__disabled } from '@/strings/messages/ExperimentalFeatureRow__disabled/pt-BR';
import { ExperimentalFeatureRow__enabled } from '@/strings/messages/ExperimentalFeatureRow__enabled/pt-BR';
import { FeatureFlagsSettings__cancel } from '@/strings/messages/FeatureFlagsSettings__cancel/pt-BR';
import { FeatureFlagsSettings__disable_fake_lm } from '@/strings/messages/FeatureFlagsSettings__disable_fake_lm/pt-BR';
import { FeatureFlagsSettings__disable_folders } from '@/strings/messages/FeatureFlagsSettings__disable_folders/pt-BR';
import { FeatureFlagsSettings__disable_move_chat_on_send } from '@/strings/messages/FeatureFlagsSettings__disable_move_chat_on_send/pt-BR';
import { FeatureFlagsSettings__disable_shell } from '@/strings/messages/FeatureFlagsSettings__disable_shell/pt-BR';
import { FeatureFlagsSettings__disable_tool_config_persistence } from '@/strings/messages/FeatureFlagsSettings__disable_tool_config_persistence/pt-BR';
import { FeatureFlagsSettings__enable } from '@/strings/messages/FeatureFlagsSettings__enable/pt-BR';
import { FeatureFlagsSettings__enable_experimental_feature } from '@/strings/messages/FeatureFlagsSettings__enable_experimental_feature/pt-BR';
import { FeatureFlagsSettings__enable_fake_lm } from '@/strings/messages/FeatureFlagsSettings__enable_fake_lm/pt-BR';
import { FeatureFlagsSettings__enable_folders } from '@/strings/messages/FeatureFlagsSettings__enable_folders/pt-BR';
import { FeatureFlagsSettings__enable_move_chat_on_send } from '@/strings/messages/FeatureFlagsSettings__enable_move_chat_on_send/pt-BR';
import { FeatureFlagsSettings__enable_shell } from '@/strings/messages/FeatureFlagsSettings__enable_shell/pt-BR';
import { FeatureFlagsSettings__enable_tool_config_persistence } from '@/strings/messages/FeatureFlagsSettings__enable_tool_config_persistence/pt-BR';
import { FeatureFlagsSettings__experimental_feature_warning } from '@/strings/messages/FeatureFlagsSettings__experimental_feature_warning/pt-BR';
import { FeatureFlagsSettings__fake_lm_debug_mode } from '@/strings/messages/FeatureFlagsSettings__fake_lm_debug_mode/pt-BR';
import { FeatureFlagsSettings__features_may_change } from '@/strings/messages/FeatureFlagsSettings__features_may_change/pt-BR';
import { FeatureFlagsSettings__folders } from '@/strings/messages/FeatureFlagsSettings__folders/pt-BR';
import { FeatureFlagsSettings__folders_disabled_details } from '@/strings/messages/FeatureFlagsSettings__folders_disabled_details/pt-BR';
import { FeatureFlagsSettings__folders_enabled_details } from '@/strings/messages/FeatureFlagsSettings__folders_enabled_details/pt-BR';
import { FeatureFlagsSettings__hosted_build_only } from '@/strings/messages/FeatureFlagsSettings__hosted_build_only/pt-BR';
import { FeatureFlagsSettings__move_chat_disabled_details } from '@/strings/messages/FeatureFlagsSettings__move_chat_disabled_details/pt-BR';
import { FeatureFlagsSettings__move_chat_enabled_details } from '@/strings/messages/FeatureFlagsSettings__move_chat_enabled_details/pt-BR';
import { FeatureFlagsSettings__move_chat_on_send } from '@/strings/messages/FeatureFlagsSettings__move_chat_on_send/pt-BR';
import { FeatureFlagsSettings__moves_active_chat_after_send } from '@/strings/messages/FeatureFlagsSettings__moves_active_chat_after_send/pt-BR';
import { FeatureFlagsSettings__saves_tool_settings } from '@/strings/messages/FeatureFlagsSettings__saves_tool_settings/pt-BR';
import { FeatureFlagsSettings__shell_disabled_details } from '@/strings/messages/FeatureFlagsSettings__shell_disabled_details/pt-BR';
import { FeatureFlagsSettings__shell_enabled_details } from '@/strings/messages/FeatureFlagsSettings__shell_enabled_details/pt-BR';
import { FeatureFlagsSettings__shell_in_browser } from '@/strings/messages/FeatureFlagsSettings__shell_in_browser/pt-BR';
import { FeatureFlagsSettings__shows_folders_tab } from '@/strings/messages/FeatureFlagsSettings__shows_folders_tab/pt-BR';
import { FeatureFlagsSettings__shows_shell_in_chat_tools } from '@/strings/messages/FeatureFlagsSettings__shows_shell_in_chat_tools/pt-BR';
import { FeatureFlagsSettings__tool_config_persistence } from '@/strings/messages/FeatureFlagsSettings__tool_config_persistence/pt-BR';
import { FeatureFlagsSettings__tool_persistence_disabled_details } from '@/strings/messages/FeatureFlagsSettings__tool_persistence_disabled_details/pt-BR';
import { FeatureFlagsSettings__tool_persistence_enabled_details } from '@/strings/messages/FeatureFlagsSettings__tool_persistence_enabled_details/pt-BR';
import { FeatureFlagsSettings__use_fake_lm_endpoint } from '@/strings/messages/FeatureFlagsSettings__use_fake_lm_endpoint/pt-BR';
import { FeatureFlagsSettings__uses_bundled_fake_lm } from '@/strings/messages/FeatureFlagsSettings__uses_bundled_fake_lm/pt-BR';
import { GlobalSearchModal__all } from '@/strings/messages/GlobalSearchModal__all/pt-BR';
import { GlobalSearchModal__alt_branch } from '@/strings/messages/GlobalSearchModal__alt_branch/pt-BR';
import { GlobalSearchModal__assistant } from '@/strings/messages/GlobalSearchModal__assistant/pt-BR';
import { GlobalSearchModal__chat } from '@/strings/messages/GlobalSearchModal__chat/pt-BR';
import { GlobalSearchModal__chat_count } from '@/strings/messages/GlobalSearchModal__chat_count/pt-BR';
import { GlobalSearchModal__chats_found } from '@/strings/messages/GlobalSearchModal__chats_found/pt-BR';
import { GlobalSearchModal__clear_all_filters } from '@/strings/messages/GlobalSearchModal__clear_all_filters/pt-BR';
import { GlobalSearchModal__context } from '@/strings/messages/GlobalSearchModal__context/pt-BR';
import { GlobalSearchModal__current_thread } from '@/strings/messages/GlobalSearchModal__current_thread/pt-BR';
import { GlobalSearchModal__filter_by_group } from '@/strings/messages/GlobalSearchModal__filter_by_group/pt-BR';
import { GlobalSearchModal__filtered_chat } from '@/strings/messages/GlobalSearchModal__filtered_chat/pt-BR';
import { GlobalSearchModal__full } from '@/strings/messages/GlobalSearchModal__full/pt-BR';
import { GlobalSearchModal__groups } from '@/strings/messages/GlobalSearchModal__groups/pt-BR';
import { GlobalSearchModal__navigate } from '@/strings/messages/GlobalSearchModal__navigate/pt-BR';
import { GlobalSearchModal__no_groups_available } from '@/strings/messages/GlobalSearchModal__no_groups_available/pt-BR';
import { GlobalSearchModal__no_results_for } from '@/strings/messages/GlobalSearchModal__no_results_for/pt-BR';
import { GlobalSearchModal__off } from '@/strings/messages/GlobalSearchModal__off/pt-BR';
import { GlobalSearchModal__on } from '@/strings/messages/GlobalSearchModal__on/pt-BR';
import { GlobalSearchModal__peek } from '@/strings/messages/GlobalSearchModal__peek/pt-BR';
import { GlobalSearchModal__preview } from '@/strings/messages/GlobalSearchModal__preview/pt-BR';
import { GlobalSearchModal__role } from '@/strings/messages/GlobalSearchModal__role/pt-BR';
import { GlobalSearchModal__scanning_content } from '@/strings/messages/GlobalSearchModal__scanning_content/pt-BR';
import { GlobalSearchModal__search } from '@/strings/messages/GlobalSearchModal__search/pt-BR';
import { GlobalSearchModal__search_chats_and_messages } from '@/strings/messages/GlobalSearchModal__search_chats_and_messages/pt-BR';
import { GlobalSearchModal__select } from '@/strings/messages/GlobalSearchModal__select/pt-BR';
import { GlobalSearchModal__title_only } from '@/strings/messages/GlobalSearchModal__title_only/pt-BR';
import { GlobalSearchModal__total_matches } from '@/strings/messages/GlobalSearchModal__total_matches/pt-BR';
import { GlobalSearchModal__type_to_search } from '@/strings/messages/GlobalSearchModal__type_to_search/pt-BR';
import { GlobalSearchModal__user } from '@/strings/messages/GlobalSearchModal__user/pt-BR';
import { GlobalToolsSettings__global_settings } from '@/strings/messages/GlobalToolsSettings__global_settings/pt-BR';
import { GlobalToolsSettings__tool_defaults_can_be_overridden } from '@/strings/messages/GlobalToolsSettings__tool_defaults_can_be_overridden/pt-BR';
import { GlobalToolsSettings__tools } from '@/strings/messages/GlobalToolsSettings__tools/pt-BR';
import { HistoryManipulationModal__add_first_message } from '@/strings/messages/HistoryManipulationModal__add_first_message/pt-BR';
import { HistoryManipulationModal__add_message_after } from '@/strings/messages/HistoryManipulationModal__add_message_after/pt-BR';
import { HistoryManipulationModal__append_message } from '@/strings/messages/HistoryManipulationModal__append_message/pt-BR';
import { HistoryManipulationModal__apply_changes } from '@/strings/messages/HistoryManipulationModal__apply_changes/pt-BR';
import { HistoryManipulationModal__applying_changes_creates_a } from '@/strings/messages/HistoryManipulationModal__applying_changes_creates_a/pt-BR';
import { HistoryManipulationModal__attach_media } from '@/strings/messages/HistoryManipulationModal__attach_media/pt-BR';
import { HistoryManipulationModal__chat_system_prompt } from '@/strings/messages/HistoryManipulationModal__chat_system_prompt/pt-BR';
import { HistoryManipulationModal__copy_message } from '@/strings/messages/HistoryManipulationModal__copy_message/pt-BR';
import { HistoryManipulationModal__discard } from '@/strings/messages/HistoryManipulationModal__discard/pt-BR';
import { HistoryManipulationModal__enter_system_prompt_content } from '@/strings/messages/HistoryManipulationModal__enter_system_prompt_content/pt-BR';
import { HistoryManipulationModal__forge_empty_history } from '@/strings/messages/HistoryManipulationModal__forge_empty_history/pt-BR';
import { HistoryManipulationModal__from_the_root_the_original_conversation_remains_preserved } from '@/strings/messages/HistoryManipulationModal__from_the_root_the_original_conversation_remains_preserved/pt-BR';
import { HistoryManipulationModal__inherited } from '@/strings/messages/HistoryManipulationModal__inherited/pt-BR';
import { HistoryManipulationModal__manipulate_full_chat_history_a_new_branch_will_be_created } from '@/strings/messages/HistoryManipulationModal__manipulate_full_chat_history_a_new_branch_will_be_created/pt-BR';
import { HistoryManipulationModal__message_list } from '@/strings/messages/HistoryManipulationModal__message_list/pt-BR';
import { HistoryManipulationModal__new_branch } from '@/strings/messages/HistoryManipulationModal__new_branch/pt-BR';
import { HistoryManipulationModal__no_system_prompt_inherited } from '@/strings/messages/HistoryManipulationModal__no_system_prompt_inherited/pt-BR';
import { HistoryManipulationModal__parent_prompt_cleared } from '@/strings/messages/HistoryManipulationModal__parent_prompt_cleared/pt-BR';
import { HistoryManipulationModal__remove_message } from '@/strings/messages/HistoryManipulationModal__remove_message/pt-BR';
import { HistoryManipulationModal__super_edit } from '@/strings/messages/HistoryManipulationModal__super_edit/pt-BR';
import { HistoryManipulationModal__switch_role } from '@/strings/messages/HistoryManipulationModal__switch_role/pt-BR';
import { HistoryManipulationModal__system_prompt_resolution } from '@/strings/messages/HistoryManipulationModal__system_prompt_resolution/pt-BR';
import { HistoryManipulationModal__this_chat_will_not_use_any_system_instructions } from '@/strings/messages/HistoryManipulationModal__this_chat_will_not_use_any_system_instructions/pt-BR';
import { HistoryManipulationModal__thoughts } from '@/strings/messages/HistoryManipulationModal__thoughts/pt-BR';
import { HistoryManipulationModal__type_message_content } from '@/strings/messages/HistoryManipulationModal__type_message_content/pt-BR';
import { ImageConjuringLoader__generating_image } from '@/strings/messages/ImageConjuringLoader__generating_image/pt-BR';
import { ImageConjuringLoader__generating_images } from '@/strings/messages/ImageConjuringLoader__generating_images/pt-BR';
import { ImageConjuringLoader__image_count } from '@/strings/messages/ImageConjuringLoader__image_count/pt-BR';
import { ImageConjuringLoader__steps } from '@/strings/messages/ImageConjuringLoader__steps/pt-BR';
import { ImageDownloadButton__download_image } from '@/strings/messages/ImageDownloadButton__download_image/pt-BR';
import { ImageDownloadButton__embed_prompt_seed_etc } from '@/strings/messages/ImageDownloadButton__embed_prompt_seed_etc/pt-BR';
import { ImageDownloadButton__more_options } from '@/strings/messages/ImageDownloadButton__more_options/pt-BR';
import { ImageDownloadButton__not_supported_for_this_format } from '@/strings/messages/ImageDownloadButton__not_supported_for_this_format/pt-BR';
import { ImageDownloadButton__with_metadata } from '@/strings/messages/ImageDownloadButton__with_metadata/pt-BR';
import { ImageEditor__apply_resize } from '@/strings/messages/ImageEditor__apply_resize/pt-BR';
import { ImageEditor__black } from '@/strings/messages/ImageEditor__black/pt-BR';
import { ImageEditor__close } from '@/strings/messages/ImageEditor__close/pt-BR';
import { ImageEditor__close_and_discard_unsaved_changes } from '@/strings/messages/ImageEditor__close_and_discard_unsaved_changes/pt-BR';
import { ImageEditor__crop } from '@/strings/messages/ImageEditor__crop/pt-BR';
import { ImageEditor__crop_to_selection } from '@/strings/messages/ImageEditor__crop_to_selection/pt-BR';
import { ImageEditor__discard } from '@/strings/messages/ImageEditor__discard/pt-BR';
import { ImageEditor__discard_changes } from '@/strings/messages/ImageEditor__discard_changes/pt-BR';
import { ImageEditor__elliptical_selection } from '@/strings/messages/ImageEditor__elliptical_selection/pt-BR';
import { ImageEditor__fill_everything_outside_selection } from '@/strings/messages/ImageEditor__fill_everything_outside_selection/pt-BR';
import { ImageEditor__fill_selection_area } from '@/strings/messages/ImageEditor__fill_selection_area/pt-BR';
import { ImageEditor__finish } from '@/strings/messages/ImageEditor__finish/pt-BR';
import { ImageEditor__flip_horizontal } from '@/strings/messages/ImageEditor__flip_horizontal/pt-BR';
import { ImageEditor__flip_vertical } from '@/strings/messages/ImageEditor__flip_vertical/pt-BR';
import { ImageEditor__free_resizing } from '@/strings/messages/ImageEditor__free_resizing/pt-BR';
import { ImageEditor__image_editor } from '@/strings/messages/ImageEditor__image_editor/pt-BR';
import { ImageEditor__maintain_aspect_ratio } from '@/strings/messages/ImageEditor__maintain_aspect_ratio/pt-BR';
import { ImageEditor__mask_in } from '@/strings/messages/ImageEditor__mask_in/pt-BR';
import { ImageEditor__mask_out } from '@/strings/messages/ImageEditor__mask_out/pt-BR';
import { ImageEditor__original } from '@/strings/messages/ImageEditor__original/pt-BR';
import { ImageEditor__output_format } from '@/strings/messages/ImageEditor__output_format/pt-BR';
import { ImageEditor__pick_color_from_canvas } from '@/strings/messages/ImageEditor__pick_color_from_canvas/pt-BR';
import { ImageEditor__recent } from '@/strings/messages/ImageEditor__recent/pt-BR';
import { ImageEditor__rectangular_selection } from '@/strings/messages/ImageEditor__rectangular_selection/pt-BR';
import { ImageEditor__redo } from '@/strings/messages/ImageEditor__redo/pt-BR';
import { ImageEditor__reset } from '@/strings/messages/ImageEditor__reset/pt-BR';
import { ImageEditor__reset_image } from '@/strings/messages/ImageEditor__reset_image/pt-BR';
import { ImageEditor__reset_zoom } from '@/strings/messages/ImageEditor__reset_zoom/pt-BR';
import { ImageEditor__resize_px } from '@/strings/messages/ImageEditor__resize_px/pt-BR';
import { ImageEditor__rotate_left } from '@/strings/messages/ImageEditor__rotate_left/pt-BR';
import { ImageEditor__rotate_right } from '@/strings/messages/ImageEditor__rotate_right/pt-BR';
import { ImageEditor__selection } from '@/strings/messages/ImageEditor__selection/pt-BR';
import { ImageEditor__toggle_tools_sidebar } from '@/strings/messages/ImageEditor__toggle_tools_sidebar/pt-BR';
import { ImageEditor__tools } from '@/strings/messages/ImageEditor__tools/pt-BR';
import { ImageEditor__transform } from '@/strings/messages/ImageEditor__transform/pt-BR';
import { ImageEditor__transparent } from '@/strings/messages/ImageEditor__transparent/pt-BR';
import { ImageEditor__undo } from '@/strings/messages/ImageEditor__undo/pt-BR';
import { ImageEditor__wheel_to_zoom_middle_click_or_alt_plus_drag_to_pan } from '@/strings/messages/ImageEditor__wheel_to_zoom_middle_click_or_alt_plus_drag_to_pan/pt-BR';
import { ImageEditor__white } from '@/strings/messages/ImageEditor__white/pt-BR';
import { ImageEditor__zoom } from '@/strings/messages/ImageEditor__zoom/pt-BR';
import { ImageEditor__zoom_in } from '@/strings/messages/ImageEditor__zoom_in/pt-BR';
import { ImageEditor__zoom_out } from '@/strings/messages/ImageEditor__zoom_out/pt-BR';
import { ImageGenerationSettings__auto } from '@/strings/messages/ImageGenerationSettings__auto/pt-BR';
import { ImageGenerationSettings__click_to_enter_specific_seed } from '@/strings/messages/ImageGenerationSettings__click_to_enter_specific_seed/pt-BR';
import { ImageGenerationSettings__create_image_experimental } from '@/strings/messages/ImageGenerationSettings__create_image_experimental/pt-BR';
import { ImageGenerationSettings__explicitly_generate_random_seed_in_browser_for_each_image } from '@/strings/messages/ImageGenerationSettings__explicitly_generate_random_seed_in_browser_for_each_image/pt-BR';
import { ImageGenerationSettings__height } from '@/strings/messages/ImageGenerationSettings__height/pt-BR';
import { ImageGenerationSettings__image_model } from '@/strings/messages/ImageGenerationSettings__image_model/pt-BR';
import { ImageGenerationSettings__jpeg } from '@/strings/messages/ImageGenerationSettings__jpeg/pt-BR';
import { ImageGenerationSettings__no_tools_available_for_this_provider } from '@/strings/messages/ImageGenerationSettings__no_tools_available_for_this_provider/pt-BR';
import { ImageGenerationSettings__number_of_images } from '@/strings/messages/ImageGenerationSettings__number_of_images/pt-BR';
import { ImageGenerationSettings__original } from '@/strings/messages/ImageGenerationSettings__original/pt-BR';
import { ImageGenerationSettings__png } from '@/strings/messages/ImageGenerationSettings__png/pt-BR';
import { ImageGenerationSettings__qty } from '@/strings/messages/ImageGenerationSettings__qty/pt-BR';
import { ImageGenerationSettings__resolution } from '@/strings/messages/ImageGenerationSettings__resolution/pt-BR';
import { ImageGenerationSettings__save_format } from '@/strings/messages/ImageGenerationSettings__save_format/pt-BR';
import { ImageGenerationSettings__seed } from '@/strings/messages/ImageGenerationSettings__seed/pt-BR';
import { ImageGenerationSettings__select_image_model } from '@/strings/messages/ImageGenerationSettings__select_image_model/pt-BR';
import { ImageGenerationSettings__steps } from '@/strings/messages/ImageGenerationSettings__steps/pt-BR';
import { ImageGenerationSettings__swap_width_and_height } from '@/strings/messages/ImageGenerationSettings__swap_width_and_height/pt-BR';
import { ImageGenerationSettings__webp } from '@/strings/messages/ImageGenerationSettings__webp/pt-BR';
import { ImageGenerationSettings__width } from '@/strings/messages/ImageGenerationSettings__width/pt-BR';
import { ImageInfoDisplay__copy_prompt } from '@/strings/messages/ImageInfoDisplay__copy_prompt/pt-BR';
import { ImageInfoDisplay__copy_seed } from '@/strings/messages/ImageInfoDisplay__copy_seed/pt-BR';
import { ImageInfoDisplay__image_info } from '@/strings/messages/ImageInfoDisplay__image_info/pt-BR';
import { ImageInfoDisplay__prompt } from '@/strings/messages/ImageInfoDisplay__prompt/pt-BR';
import { ImageInfoDisplay__seed } from '@/strings/messages/ImageInfoDisplay__seed/pt-BR';
import { ImageInfoDisplay__size } from '@/strings/messages/ImageInfoDisplay__size/pt-BR';
import { ImageInfoDisplay__steps } from '@/strings/messages/ImageInfoDisplay__steps/pt-BR';
import { ImportExportModal__add_new } from '@/strings/messages/ImportExportModal__add_new/pt-BR';
import { ImportExportModal__analyzing_file } from '@/strings/messages/ImportExportModal__analyzing_file/pt-BR';
import { ImportExportModal__append_keeps_current_data } from '@/strings/messages/ImportExportModal__append_keeps_current_data/pt-BR';
import { ImportExportModal__append_merge } from '@/strings/messages/ImportExportModal__append_merge/pt-BR';
import { ImportExportModal__append_preset } from '@/strings/messages/ImportExportModal__append_preset/pt-BR';
import { ImportExportModal__back } from '@/strings/messages/ImportExportModal__back/pt-BR';
import { ImportExportModal__back_to_menu } from '@/strings/messages/ImportExportModal__back_to_menu/pt-BR';
import { ImportExportModal__cancel } from '@/strings/messages/ImportExportModal__cancel/pt-BR';
import { ImportExportModal__chat_count } from '@/strings/messages/ImportExportModal__chat_count/pt-BR';
import { ImportExportModal__chat_title_prefix } from '@/strings/messages/ImportExportModal__chat_title_prefix/pt-BR';
import { ImportExportModal__chats } from '@/strings/messages/ImportExportModal__chats/pt-BR';
import { ImportExportModal__compressing_data } from '@/strings/messages/ImportExportModal__compressing_data/pt-BR';
import { ImportExportModal__content_preview } from '@/strings/messages/ImportExportModal__content_preview/pt-BR';
import { ImportExportModal__custom_click_to_reset } from '@/strings/messages/ImportExportModal__custom_click_to_reset/pt-BR';
import { ImportExportModal__default_marker } from '@/strings/messages/ImportExportModal__default_marker/pt-BR';
import { ImportExportModal__default_model } from '@/strings/messages/ImportExportModal__default_model/pt-BR';
import { ImportExportModal__download_full_backup } from '@/strings/messages/ImportExportModal__download_full_backup/pt-BR';
import { ImportExportModal__error } from '@/strings/messages/ImportExportModal__error/pt-BR';
import { ImportExportModal__exclude_attachments } from '@/strings/messages/ImportExportModal__exclude_attachments/pt-BR';
import { ImportExportModal__exclude_chat_history } from '@/strings/messages/ImportExportModal__exclude_chat_history/pt-BR';
import { ImportExportModal__exclude_chats } from '@/strings/messages/ImportExportModal__exclude_chats/pt-BR';
import { ImportExportModal__experimental } from '@/strings/messages/ImportExportModal__experimental/pt-BR';
import { ImportExportModal__export } from '@/strings/messages/ImportExportModal__export/pt-BR';
import { ImportExportModal__export_failed } from '@/strings/messages/ImportExportModal__export_failed/pt-BR';
import { ImportExportModal__export_now } from '@/strings/messages/ImportExportModal__export_now/pt-BR';
import { ImportExportModal__export_successful } from '@/strings/messages/ImportExportModal__export_successful/pt-BR';
import { ImportExportModal__failed_to_analyze_file } from '@/strings/messages/ImportExportModal__failed_to_analyze_file/pt-BR';
import { ImportExportModal__filename_tag_example } from '@/strings/messages/ImportExportModal__filename_tag_example/pt-BR';
import { ImportExportModal__filename_tag_optional } from '@/strings/messages/ImportExportModal__filename_tag_optional/pt-BR';
import { ImportExportModal__files } from '@/strings/messages/ImportExportModal__files/pt-BR';
import { ImportExportModal__global_system_prompt } from '@/strings/messages/ImportExportModal__global_system_prompt/pt-BR';
import { ImportExportModal__group_name_prefix } from '@/strings/messages/ImportExportModal__group_name_prefix/pt-BR';
import { ImportExportModal__groups } from '@/strings/messages/ImportExportModal__groups/pt-BR';
import { ImportExportModal__ignore } from '@/strings/messages/ImportExportModal__ignore/pt-BR';
import { ImportExportModal__import } from '@/strings/messages/ImportExportModal__import/pt-BR';
import { ImportExportModal__import_export } from '@/strings/messages/ImportExportModal__import_export/pt-BR';
import { ImportExportModal__import_failed } from '@/strings/messages/ImportExportModal__import_failed/pt-BR';
import { ImportExportModal__import_successful } from '@/strings/messages/ImportExportModal__import_successful/pt-BR';
import { ImportExportModal__importing_data } from '@/strings/messages/ImportExportModal__importing_data/pt-BR';
import { ImportExportModal__keep_current } from '@/strings/messages/ImportExportModal__keep_current/pt-BR';
import { ImportExportModal__lm_parameters } from '@/strings/messages/ImportExportModal__lm_parameters/pt-BR';
import { ImportExportModal__mode_and_data_strategy } from '@/strings/messages/ImportExportModal__mode_and_data_strategy/pt-BR';
import { ImportExportModal__next } from '@/strings/messages/ImportExportModal__next/pt-BR';
import { ImportExportModal__no_settings_or_profiles } from '@/strings/messages/ImportExportModal__no_settings_or_profiles/pt-BR';
import { ImportExportModal__output_filename } from '@/strings/messages/ImportExportModal__output_filename/pt-BR';
import { ImportExportModal__overwrite } from '@/strings/messages/ImportExportModal__overwrite/pt-BR';
import { ImportExportModal__portable_data } from '@/strings/messages/ImportExportModal__portable_data/pt-BR';
import { ImportExportModal__profiles } from '@/strings/messages/ImportExportModal__profiles/pt-BR';
import { ImportExportModal__provider_profiles } from '@/strings/messages/ImportExportModal__provider_profiles/pt-BR';
import { ImportExportModal__ready_to_export } from '@/strings/messages/ImportExportModal__ready_to_export/pt-BR';
import { ImportExportModal__replace_clears_current_data } from '@/strings/messages/ImportExportModal__replace_clears_current_data/pt-BR';
import { ImportExportModal__replace_restore } from '@/strings/messages/ImportExportModal__replace_restore/pt-BR';
import { ImportExportModal__restore_preset } from '@/strings/messages/ImportExportModal__restore_preset/pt-BR';
import { ImportExportModal__settings_and_profiles } from '@/strings/messages/ImportExportModal__settings_and_profiles/pt-BR';
import { ImportExportModal__title_generation_model } from '@/strings/messages/ImportExportModal__title_generation_model/pt-BR';
import { ImportExportModal__untitled_chat } from '@/strings/messages/ImportExportModal__untitled_chat/pt-BR';
import { ImportExportModal__upload_backup_to_restore_or_merge } from '@/strings/messages/ImportExportModal__upload_backup_to_restore_or_merge/pt-BR';
import { ImportExportModal__url_and_http_headers } from '@/strings/messages/ImportExportModal__url_and_http_headers/pt-BR';
import { ImportExportModal__verifying_integrity } from '@/strings/messages/ImportExportModal__verifying_integrity/pt-BR';
import { ImportExportModal__zip_contains_all_data_by_default } from '@/strings/messages/ImportExportModal__zip_contains_all_data_by_default/pt-BR';
import { ImportExportService__export_dump_failed } from '@/strings/messages/ImportExportService__export_dump_failed/pt-BR';
import { ImportExportService__invalid_zip_file } from '@/strings/messages/ImportExportService__invalid_zip_file/pt-BR';
import { LanguageSelector__language } from '@/strings/messages/LanguageSelector__language/pt-BR';
import { LmParametersEditor__default } from '@/strings/messages/LmParametersEditor__default/pt-BR';
import { LmParametersEditor__empty_fields_use_provider_defaults } from '@/strings/messages/LmParametersEditor__empty_fields_use_provider_defaults/pt-BR';
import { LmParametersEditor__invalid_json } from '@/strings/messages/LmParametersEditor__invalid_json/pt-BR';
import { LmParametersEditor__lm_parameters } from '@/strings/messages/LmParametersEditor__lm_parameters/pt-BR';
import { LmParametersEditor__max_tokens } from '@/strings/messages/LmParametersEditor__max_tokens/pt-BR';
import { LmParametersEditor__must_be_an_array_of_strings } from '@/strings/messages/LmParametersEditor__must_be_an_array_of_strings/pt-BR';
import { LmParametersEditor__presence_penalty } from '@/strings/messages/LmParametersEditor__presence_penalty/pt-BR';
import { LmParametersEditor__reset_all } from '@/strings/messages/LmParametersEditor__reset_all/pt-BR';
import { LmParametersEditor__reset_to_default } from '@/strings/messages/LmParametersEditor__reset_to_default/pt-BR';
import { LmParametersEditor__stop_sequences_json_array } from '@/strings/messages/LmParametersEditor__stop_sequences_json_array/pt-BR';
import { LmParametersEditor__temperature } from '@/strings/messages/LmParametersEditor__temperature/pt-BR';
import { LmParametersEditor__top_p } from '@/strings/messages/LmParametersEditor__top_p/pt-BR';
import { LmToolsSettings__changes_apply_to_this_browser_session_only_while_tool_config_persistence_is_disabled } from '@/strings/messages/LmToolsSettings__changes_apply_to_this_browser_session_only_while_tool_config_persistence_is_disabled/pt-BR';
import { LmToolsSettings__failed_to_save_chat_tool_settings } from '@/strings/messages/LmToolsSettings__failed_to_save_chat_tool_settings/pt-BR';
import { Logo__naidan_logo } from '@/strings/messages/Logo__naidan_logo/pt-BR';
import { MessageActions__compare_versions } from '@/strings/messages/MessageActions__compare_versions/pt-BR';
import { MessageActions__copied } from '@/strings/messages/MessageActions__copied/pt-BR';
import { MessageActions__copy_link } from '@/strings/messages/MessageActions__copy_link/pt-BR';
import { MessageActions__copy_message } from '@/strings/messages/MessageActions__copy_message/pt-BR';
import { MessageActions__copy_raw } from '@/strings/messages/MessageActions__copy_raw/pt-BR';
import { MessageActions__edit_message } from '@/strings/messages/MessageActions__edit_message/pt-BR';
import { MessageActions__failed_to_copy_message_link } from '@/strings/messages/MessageActions__failed_to_copy_message_link/pt-BR';
import { MessageActions__fork_chat } from '@/strings/messages/MessageActions__fork_chat/pt-BR';
import { MessageActions__message_link_copied } from '@/strings/messages/MessageActions__message_link_copied/pt-BR';
import { MessageActions__more_actions } from '@/strings/messages/MessageActions__more_actions/pt-BR';
import { MessageActions__more_message_tools } from '@/strings/messages/MessageActions__more_message_tools/pt-BR';
import { MessageActions__regenerate_response } from '@/strings/messages/MessageActions__regenerate_response/pt-BR';
import { MessageActions__resend_message } from '@/strings/messages/MessageActions__resend_message/pt-BR';
import { MessageDiffModal__base } from '@/strings/messages/MessageDiffModal__base/pt-BR';
import { MessageDiffModal__comparing_base_version } from '@/strings/messages/MessageDiffModal__comparing_base_version/pt-BR';
import { MessageDiffModal__copied } from '@/strings/messages/MessageDiffModal__copied/pt-BR';
import { MessageDiffModal__copy_result } from '@/strings/messages/MessageDiffModal__copy_result/pt-BR';
import { MessageDiffModal__copy_this_version } from '@/strings/messages/MessageDiffModal__copy_this_version/pt-BR';
import { MessageDiffModal__diff_on } from '@/strings/messages/MessageDiffModal__diff_on/pt-BR';
import { MessageDiffModal__exclude_from_diff } from '@/strings/messages/MessageDiffModal__exclude_from_diff/pt-BR';
import { MessageDiffModal__include } from '@/strings/messages/MessageDiffModal__include/pt-BR';
import { MessageDiffModal__include_in_diff } from '@/strings/messages/MessageDiffModal__include_in_diff/pt-BR';
import { MessageDiffModal__loading_more_versions } from '@/strings/messages/MessageDiffModal__loading_more_versions/pt-BR';
import { MessageDiffModal__message_history_and_compare } from '@/strings/messages/MessageDiffModal__message_history_and_compare/pt-BR';
import { MessageDiffModal__off } from '@/strings/messages/MessageDiffModal__off/pt-BR';
import { MessageDiffModal__reset_selection } from '@/strings/messages/MessageDiffModal__reset_selection/pt-BR';
import { MessageDiffModal__select_versions_to_compare_differences } from '@/strings/messages/MessageDiffModal__select_versions_to_compare_differences/pt-BR';
import { MessageDiffModal__skip } from '@/strings/messages/MessageDiffModal__skip/pt-BR';
import { MessageDiffModal__target } from '@/strings/messages/MessageDiffModal__target/pt-BR';
import { MessageDiffModal__target_version } from '@/strings/messages/MessageDiffModal__target_version/pt-BR';
import { MessageItem__cancel } from '@/strings/messages/MessageItem__cancel/pt-BR';
import { MessageItem__clear } from '@/strings/messages/MessageItem__clear/pt-BR';
import { MessageItem__clear_all_text } from '@/strings/messages/MessageItem__clear_all_text/pt-BR';
import { MessageItem__download_image } from '@/strings/messages/MessageItem__download_image/pt-BR';
import { MessageItem__generation_failed } from '@/strings/messages/MessageItem__generation_failed/pt-BR';
import { MessageItem__high } from '@/strings/messages/MessageItem__high/pt-BR';
import { MessageItem__image_generated } from '@/strings/messages/MessageItem__image_generated/pt-BR';
import { MessageItem__image_missing } from '@/strings/messages/MessageItem__image_missing/pt-BR';
import { MessageItem__low } from '@/strings/messages/MessageItem__low/pt-BR';
import { MessageItem__medium } from '@/strings/messages/MessageItem__medium/pt-BR';
import { MessageItem__more_message_tools } from '@/strings/messages/MessageItem__more_message_tools/pt-BR';
import { MessageItem__off } from '@/strings/messages/MessageItem__off/pt-BR';
import { MessageItem__open_advanced_editor } from '@/strings/messages/MessageItem__open_advanced_editor/pt-BR';
import { MessageItem__options_tools } from '@/strings/messages/MessageItem__options_tools/pt-BR';
import { MessageItem__retry } from '@/strings/messages/MessageItem__retry/pt-BR';
import { MessageItem__send_and_branch } from '@/strings/messages/MessageItem__send_and_branch/pt-BR';
import { MessageItem__stop_generation } from '@/strings/messages/MessageItem__stop_generation/pt-BR';
import { MessageItem__think } from '@/strings/messages/MessageItem__think/pt-BR';
import { MessageItem__think_disabled } from '@/strings/messages/MessageItem__think_disabled/pt-BR';
import { MessageItem__think_effort_note } from '@/strings/messages/MessageItem__think_effort_note/pt-BR';
import { MessageItem__tools } from '@/strings/messages/MessageItem__tools/pt-BR';
import { MessageItem__update_and_branch } from '@/strings/messages/MessageItem__update_and_branch/pt-BR';
import { MessageItem__you } from '@/strings/messages/MessageItem__you/pt-BR';
import { MessageThinking__hide_thought_process } from '@/strings/messages/MessageThinking__hide_thought_process/pt-BR';
import { MessageThinking__show_thought_process } from '@/strings/messages/MessageThinking__show_thought_process/pt-BR';
import { MessageThinking__thinking } from '@/strings/messages/MessageThinking__thinking/pt-BR';
import { MessageThinking__thought_process } from '@/strings/messages/MessageThinking__thought_process/pt-BR';
import { ModelSelector__filter_models } from '@/strings/messages/ModelSelector__filter_models/pt-BR';
import { ModelSelector__inherit } from '@/strings/messages/ModelSelector__inherit/pt-BR';
import { ModelSelector__no_models_found } from '@/strings/messages/ModelSelector__no_models_found/pt-BR';
import { ModelSelector__refresh_model_list } from '@/strings/messages/ModelSelector__refresh_model_list/pt-BR';
import { ModelSelector__select_a_model } from '@/strings/messages/ModelSelector__select_a_model/pt-BR';
import { MountBadgeList__browse_path } from '@/strings/messages/MountBadgeList__browse_path/pt-BR';
import { MountBadgeList__read_and_write_click_to_restrict } from '@/strings/messages/MountBadgeList__read_and_write_click_to_restrict/pt-BR';
import { MountBadgeList__read_only_click_to_allow_write } from '@/strings/messages/MountBadgeList__read_only_click_to_allow_write/pt-BR';
import { MountBadgeList__remove } from '@/strings/messages/MountBadgeList__remove/pt-BR';
import { OllamaManagementView__ollama_runtime } from '@/strings/messages/OllamaManagementView__ollama_runtime/pt-BR';
import { OllamaManagementView__view_and_unload_models_currently_held_in_memory_by_this_ollama_server } from '@/strings/messages/OllamaManagementView__view_and_unload_models_currently_held_in_memory_by_this_ollama_server/pt-BR';
import { OllamaPsView__checking } from '@/strings/messages/OllamaPsView__checking/pt-BR';
import { OllamaPsView__context_length } from '@/strings/messages/OllamaPsView__context_length/pt-BR';
import { OllamaPsView__could_not_load_running_models } from '@/strings/messages/OllamaPsView__could_not_load_running_models/pt-BR';
import { OllamaPsView__digest } from '@/strings/messages/OllamaPsView__digest/pt-BR';
import { OllamaPsView__enter_an_ollama_endpoint_url_to_view_running_models } from '@/strings/messages/OllamaPsView__enter_an_ollama_endpoint_url_to_view_running_models/pt-BR';
import { OllamaPsView__expires_at } from '@/strings/messages/OllamaPsView__expires_at/pt-BR';
import { OllamaPsView__expires_in_minutes } from '@/strings/messages/OllamaPsView__expires_in_minutes/pt-BR';
import { OllamaPsView__expires_soon } from '@/strings/messages/OllamaPsView__expires_soon/pt-BR';
import { OllamaPsView__families } from '@/strings/messages/OllamaPsView__families/pt-BR';
import { OllamaPsView__family } from '@/strings/messages/OllamaPsView__family/pt-BR';
import { OllamaPsView__format } from '@/strings/messages/OllamaPsView__format/pt-BR';
import { OllamaPsView__kept_indefinitely } from '@/strings/messages/OllamaPsView__kept_indefinitely/pt-BR';
import { OllamaPsView__loaded_count } from '@/strings/messages/OllamaPsView__loaded_count/pt-BR';
import { OllamaPsView__loaded_models_remain_available_until_their_keep_alive_period_expires } from '@/strings/messages/OllamaPsView__loaded_models_remain_available_until_their_keep_alive_period_expires/pt-BR';
import { OllamaPsView__loading_models } from '@/strings/messages/OllamaPsView__loading_models/pt-BR';
import { OllamaPsView__memory_size } from '@/strings/messages/OllamaPsView__memory_size/pt-BR';
import { OllamaPsView__model } from '@/strings/messages/OllamaPsView__model/pt-BR';
import { OllamaPsView__model_details } from '@/strings/messages/OllamaPsView__model_details/pt-BR';
import { OllamaPsView__model_details_aria } from '@/strings/messages/OllamaPsView__model_details_aria/pt-BR';
import { OllamaPsView__model_unload_requested } from '@/strings/messages/OllamaPsView__model_unload_requested/pt-BR';
import { OllamaPsView__model_unloaded } from '@/strings/messages/OllamaPsView__model_unloaded/pt-BR';
import { OllamaPsView__models_appear_here_after_ollama_loads_them_for_a_request } from '@/strings/messages/OllamaPsView__models_appear_here_after_ollama_loads_them_for_a_request/pt-BR';
import { OllamaPsView__models_currently_using_system_or_video_memory } from '@/strings/messages/OllamaPsView__models_currently_using_system_or_video_memory/pt-BR';
import { OllamaPsView__no_models_are_currently_loaded } from '@/strings/messages/OllamaPsView__no_models_are_currently_loaded/pt-BR';
import { OllamaPsView__not_checked } from '@/strings/messages/OllamaPsView__not_checked/pt-BR';
import { OllamaPsView__parent_model } from '@/strings/messages/OllamaPsView__parent_model/pt-BR';
import { OllamaPsView__refresh } from '@/strings/messages/OllamaPsView__refresh/pt-BR';
import { OllamaPsView__refresh_to_check_this_ollama_server } from '@/strings/messages/OllamaPsView__refresh_to_check_this_ollama_server/pt-BR';
import { OllamaPsView__refreshing } from '@/strings/messages/OllamaPsView__refreshing/pt-BR';
import { OllamaPsView__running_models } from '@/strings/messages/OllamaPsView__running_models/pt-BR';
import { OllamaPsView__running_ollama_models } from '@/strings/messages/OllamaPsView__running_ollama_models/pt-BR';
import { OllamaPsView__try_again } from '@/strings/messages/OllamaPsView__try_again/pt-BR';
import { OllamaPsView__unavailable } from '@/strings/messages/OllamaPsView__unavailable/pt-BR';
import { OllamaPsView__unload } from '@/strings/messages/OllamaPsView__unload/pt-BR';
import { OllamaPsView__unload_requested } from '@/strings/messages/OllamaPsView__unload_requested/pt-BR';
import { OllamaPsView__unload_requested_ollama_may_keep_showing_this_model_until_active_requests_finish_refresh_to_check_again } from '@/strings/messages/OllamaPsView__unload_requested_ollama_may_keep_showing_this_model_until_active_requests_finish_refresh_to_check_again/pt-BR';
import { OllamaPsView__unloading } from '@/strings/messages/OllamaPsView__unloading/pt-BR';
import { OllamaPsView__vram_size } from '@/strings/messages/OllamaPsView__vram_size/pt-BR';
import { OnboardingModal__add_header } from '@/strings/messages/OnboardingModal__add_header/pt-BR';
import { OnboardingModal__back } from '@/strings/messages/OnboardingModal__back/pt-BR';
import { OnboardingModal__cancel } from '@/strings/messages/OnboardingModal__cancel/pt-BR';
import { OnboardingModal__check_connection } from '@/strings/messages/OnboardingModal__check_connection/pt-BR';
import { OnboardingModal__connecting } from '@/strings/messages/OnboardingModal__connecting/pt-BR';
import { OnboardingModal__connection_attempt_cancelled } from '@/strings/messages/OnboardingModal__connection_attempt_cancelled/pt-BR';
import { OnboardingModal__custom_http_headers } from '@/strings/messages/OnboardingModal__custom_http_headers/pt-BR';
import { OnboardingModal__default_model } from '@/strings/messages/OnboardingModal__default_model/pt-BR';
import { OnboardingModal__do_not_have_a_server } from '@/strings/messages/OnboardingModal__do_not_have_a_server/pt-BR';
import { OnboardingModal__endpoint_configuration } from '@/strings/messages/OnboardingModal__endpoint_configuration/pt-BR';
import { OnboardingModal__enter_existing_server_url } from '@/strings/messages/OnboardingModal__enter_existing_server_url/pt-BR';
import { OnboardingModal__enter_valid_url } from '@/strings/messages/OnboardingModal__enter_valid_url/pt-BR';
import { OnboardingModal__experimental } from '@/strings/messages/OnboardingModal__experimental/pt-BR';
import { OnboardingModal__failed_to_connect } from '@/strings/messages/OnboardingModal__failed_to_connect/pt-BR';
import { OnboardingModal__failed_to_save_settings } from '@/strings/messages/OnboardingModal__failed_to_save_settings/pt-BR';
import { OnboardingModal__get_started } from '@/strings/messages/OnboardingModal__get_started/pt-BR';
import { OnboardingModal__help_and_guide } from '@/strings/messages/OnboardingModal__help_and_guide/pt-BR';
import { OnboardingModal__in_browser_ai } from '@/strings/messages/OnboardingModal__in_browser_ai/pt-BR';
import { OnboardingModal__name } from '@/strings/messages/OnboardingModal__name/pt-BR';
import { OnboardingModal__ollama } from '@/strings/messages/OnboardingModal__ollama/pt-BR';
import { OnboardingModal__openai_compatible } from '@/strings/messages/OnboardingModal__openai_compatible/pt-BR';
import { OnboardingModal__quick_presets } from '@/strings/messages/OnboardingModal__quick_presets/pt-BR';
import { OnboardingModal__run_models_in_browser } from '@/strings/messages/OnboardingModal__run_models_in_browser/pt-BR';
import { OnboardingModal__select_a_model } from '@/strings/messages/OnboardingModal__select_a_model/pt-BR';
import { OnboardingModal__settings_can_be_changed_later } from '@/strings/messages/OnboardingModal__settings_can_be_changed_later/pt-BR';
import { OnboardingModal__settings_saved_for_local_inference } from '@/strings/messages/OnboardingModal__settings_saved_for_local_inference/pt-BR';
import { OnboardingModal__setup_endpoint } from '@/strings/messages/OnboardingModal__setup_endpoint/pt-BR';
import { OnboardingModal__setup_endpoint_description } from '@/strings/messages/OnboardingModal__setup_endpoint_description/pt-BR';
import { OnboardingModal__successfully_connected } from '@/strings/messages/OnboardingModal__successfully_connected/pt-BR';
import { OnboardingModal__transformers_js } from '@/strings/messages/OnboardingModal__transformers_js/pt-BR';
import { OnboardingModal__value } from '@/strings/messages/OnboardingModal__value/pt-BR';
import { PWAManager__app_ready_to_work_offline } from '@/strings/messages/PWAManager__app_ready_to_work_offline/pt-BR';
import { PWAUpdateNotification__reload_to_update } from '@/strings/messages/PWAUpdateNotification__reload_to_update/pt-BR';
import { PromptApiStatus__browser_provided_language_models_are_not_available_in_this_browser } from '@/strings/messages/PromptApiStatus__browser_provided_language_models_are_not_available_in_this_browser/pt-BR';
import { PromptApiStatus__browser_provided_model_is_not_available_on_this_device } from '@/strings/messages/PromptApiStatus__browser_provided_model_is_not_available_on_this_device/pt-BR';
import { PromptApiStatus__browser_provided_model_is_ready } from '@/strings/messages/PromptApiStatus__browser_provided_model_is_ready/pt-BR';
import { PromptApiStatus__browser_reported_model_unavailable } from '@/strings/messages/PromptApiStatus__browser_reported_model_unavailable/pt-BR';
import { PromptApiStatus__browser_returned_an_error_while_checking_availability } from '@/strings/messages/PromptApiStatus__browser_returned_an_error_while_checking_availability/pt-BR';
import { PromptApiStatus__browser_returned_an_error_while_preparing_model } from '@/strings/messages/PromptApiStatus__browser_returned_an_error_while_preparing_model/pt-BR';
import { PromptApiStatus__checking_browser_provided_language_model_availability } from '@/strings/messages/PromptApiStatus__checking_browser_provided_language_model_availability/pt-BR';
import { PromptApiStatus__chrome_148_or_later_desktop } from '@/strings/messages/PromptApiStatus__chrome_148_or_later_desktop/pt-BR';
import { PromptApiStatus__chrome_gpu_with_4_gb_vram_or_less } from '@/strings/messages/PromptApiStatus__chrome_gpu_with_4_gb_vram_or_less/pt-BR';
import { PromptApiStatus__common_reasons_include } from '@/strings/messages/PromptApiStatus__common_reasons_include/pt-BR';
import { PromptApiStatus__could_not_check_browser_provided_model_availability } from '@/strings/messages/PromptApiStatus__could_not_check_browser_provided_model_availability/pt-BR';
import { PromptApiStatus__downloading_browser_provided_model } from '@/strings/messages/PromptApiStatus__downloading_browser_provided_model/pt-BR';
import { PromptApiStatus__downloading_browser_provided_model_progress } from '@/strings/messages/PromptApiStatus__downloading_browser_provided_model_progress/pt-BR';
import { PromptApiStatus__edge_canary_or_dev_138_or_later_with_prompt_api_flag } from '@/strings/messages/PromptApiStatus__edge_canary_or_dev_138_or_later_with_prompt_api_flag/pt-BR';
import { PromptApiStatus__edge_gpu_with_less_than_5_5_gb_vram_for_phi_4_mini } from '@/strings/messages/PromptApiStatus__edge_gpu_with_less_than_5_5_gb_vram_for_phi_4_mini/pt-BR';
import { PromptApiStatus__if_unavailable_in_a_supported_browser } from '@/strings/messages/PromptApiStatus__if_unavailable_in_a_supported_browser/pt-BR';
import { PromptApiStatus__language_model_api_was_not_detected } from '@/strings/messages/PromptApiStatus__language_model_api_was_not_detected/pt-BR';
import { PromptApiStatus__less_than_16_gb_ram_or_fewer_than_4_cpu_cores_for_cpu_inference } from '@/strings/messages/PromptApiStatus__less_than_16_gb_ram_or_fewer_than_4_cpu_cores_for_cpu_inference/pt-BR';
import { PromptApiStatus__less_than_required_free_space_on_browser_profile_volume } from '@/strings/messages/PromptApiStatus__less_than_required_free_space_on_browser_profile_volume/pt-BR';
import { PromptApiStatus__metered_or_unavailable_network_during_initial_download } from '@/strings/messages/PromptApiStatus__metered_or_unavailable_network_during_initial_download/pt-BR';
import { PromptApiStatus__model_download_may_require_an_unmetered_network } from '@/strings/messages/PromptApiStatus__model_download_may_require_an_unmetered_network/pt-BR';
import { PromptApiStatus__model_download_may_require_more_free_space } from '@/strings/messages/PromptApiStatus__model_download_may_require_more_free_space/pt-BR';
import { PromptApiStatus__model_preparation_failed } from '@/strings/messages/PromptApiStatus__model_preparation_failed/pt-BR';
import { PromptApiStatus__operating_system_or_hardware_requirements_may_not_be_met } from '@/strings/messages/PromptApiStatus__operating_system_or_hardware_requirements_may_not_be_met/pt-BR';
import { PromptApiStatus__prepare_browser_provided_model } from '@/strings/messages/PromptApiStatus__prepare_browser_provided_model/pt-BR';
import { PromptApiStatus__preparing_browser_provided_model } from '@/strings/messages/PromptApiStatus__preparing_browser_provided_model/pt-BR';
import { PromptApiStatus__prompt_api_may_be_disabled_by_browser_settings_flags_or_policy } from '@/strings/messages/PromptApiStatus__prompt_api_may_be_disabled_by_browser_settings_flags_or_policy/pt-BR';
import { PromptApiStatus__required_edge_experimental_flags_are_not_enabled } from '@/strings/messages/PromptApiStatus__required_edge_experimental_flags_are_not_enabled/pt-BR';
import { PromptApiStatus__supported_browsers } from '@/strings/messages/PromptApiStatus__supported_browsers/pt-BR';
import { PromptApiStatus__supported_browsers_and_requirements } from '@/strings/messages/PromptApiStatus__supported_browsers_and_requirements/pt-BR';
import { PromptApiStatus__technical_details } from '@/strings/messages/PromptApiStatus__technical_details/pt-BR';
import { PromptApiStatus__try_again } from '@/strings/messages/PromptApiStatus__try_again/pt-BR';
import { PromptApiStatus__unsupported_operating_system_or_device } from '@/strings/messages/PromptApiStatus__unsupported_operating_system_or_device/pt-BR';
import { PromptApiStatus__unsupported_operating_system_or_device_performance_class } from '@/strings/messages/PromptApiStatus__unsupported_operating_system_or_device_performance_class/pt-BR';
import { ProviderProfilePreview__configuration_preview } from '@/strings/messages/ProviderProfilePreview__configuration_preview/pt-BR';
import { ProviderProfilePreview__endpoint_url } from '@/strings/messages/ProviderProfilePreview__endpoint_url/pt-BR';
import { ProviderProfilePreview__headers } from '@/strings/messages/ProviderProfilePreview__headers/pt-BR';
import { ProviderProfilePreview__lm_params } from '@/strings/messages/ProviderProfilePreview__lm_params/pt-BR';
import { ProviderProfilePreview__none } from '@/strings/messages/ProviderProfilePreview__none/pt-BR';
import { ProviderProfilePreview__provider_and_model } from '@/strings/messages/ProviderProfilePreview__provider_and_model/pt-BR';
import { ProviderProfilePreview__system_prompt } from '@/strings/messages/ProviderProfilePreview__system_prompt/pt-BR';
import { ProviderProfilesTab__delete_profile } from '@/strings/messages/ProviderProfilesTab__delete_profile/pt-BR';
import { ProviderProfilesTab__go_to_connection_to_create_one } from '@/strings/messages/ProviderProfilesTab__go_to_connection_to_create_one/pt-BR';
import { ProviderProfilesTab__no_default_model } from '@/strings/messages/ProviderProfilesTab__no_default_model/pt-BR';
import { ProviderProfilesTab__no_profiles_saved_yet } from '@/strings/messages/ProviderProfilesTab__no_profiles_saved_yet/pt-BR';
import { ProviderProfilesTab__profile_was_deleted } from '@/strings/messages/ProviderProfilesTab__profile_was_deleted/pt-BR';
import { ProviderProfilesTab__provider_profiles } from '@/strings/messages/ProviderProfilesTab__provider_profiles/pt-BR';
import { ProviderProfilesTab__rename_profile } from '@/strings/messages/ProviderProfilesTab__rename_profile/pt-BR';
import { ProviderProfilesTab__save_and_switch_provider_configurations } from '@/strings/messages/ProviderProfilesTab__save_and_switch_provider_configurations/pt-BR';
import { ProviderProfilesTab__title_model } from '@/strings/messages/ProviderProfilesTab__title_model/pt-BR';
import { ProviderProfilesTab__undo } from '@/strings/messages/ProviderProfilesTab__undo/pt-BR';
import { ReasoningSettings__default } from '@/strings/messages/ReasoningSettings__default/pt-BR';
import { ReasoningSettings__effort_levels_may_be_ignored_by_some_models } from '@/strings/messages/ReasoningSettings__effort_levels_may_be_ignored_by_some_models/pt-BR';
import { ReasoningSettings__high } from '@/strings/messages/ReasoningSettings__high/pt-BR';
import { ReasoningSettings__low } from '@/strings/messages/ReasoningSettings__low/pt-BR';
import { ReasoningSettings__med } from '@/strings/messages/ReasoningSettings__med/pt-BR';
import { ReasoningSettings__medium } from '@/strings/messages/ReasoningSettings__medium/pt-BR';
import { ReasoningSettings__off } from '@/strings/messages/ReasoningSettings__off/pt-BR';
import { ReasoningSettings__think } from '@/strings/messages/ReasoningSettings__think/pt-BR';
import { RecentChatsModal__filter } from '@/strings/messages/RecentChatsModal__filter/pt-BR';
import { RecentChatsModal__filter_recent_chats } from '@/strings/messages/RecentChatsModal__filter_recent_chats/pt-BR';
import { RecentChatsModal__navigate } from '@/strings/messages/RecentChatsModal__navigate/pt-BR';
import { RecentChatsModal__no_chats_match_filter } from '@/strings/messages/RecentChatsModal__no_chats_match_filter/pt-BR';
import { RecentChatsModal__no_recent_chats } from '@/strings/messages/RecentChatsModal__no_recent_chats/pt-BR';
import { RecentChatsModal__off } from '@/strings/messages/RecentChatsModal__off/pt-BR';
import { RecentChatsModal__on } from '@/strings/messages/RecentChatsModal__on/pt-BR';
import { RecentChatsModal__peek } from '@/strings/messages/RecentChatsModal__peek/pt-BR';
import { RecentChatsModal__preview } from '@/strings/messages/RecentChatsModal__preview/pt-BR';
import { RecentChatsModal__select } from '@/strings/messages/RecentChatsModal__select/pt-BR';
import { RecipeExportModal__aa } from '@/strings/messages/RecipeExportModal__aa/pt-BR';
import { RecipeExportModal__add_rule } from '@/strings/messages/RecipeExportModal__add_rule/pt-BR';
import { RecipeExportModal__append } from '@/strings/messages/RecipeExportModal__append/pt-BR';
import { RecipeExportModal__clear } from '@/strings/messages/RecipeExportModal__clear/pt-BR';
import { RecipeExportModal__copied_to_clipboard } from '@/strings/messages/RecipeExportModal__copied_to_clipboard/pt-BR';
import { RecipeExportModal__copy_recipe_json } from '@/strings/messages/RecipeExportModal__copy_recipe_json/pt-BR';
import { RecipeExportModal__description } from '@/strings/messages/RecipeExportModal__description/pt-BR';
import { RecipeExportModal__include_custom_instructions_in_the_recipe } from '@/strings/messages/RecipeExportModal__include_custom_instructions_in_the_recipe/pt-BR';
import { RecipeExportModal__invalid_regular_expression } from '@/strings/messages/RecipeExportModal__invalid_regular_expression/pt-BR';
import { RecipeExportModal__live_recipe_preview } from '@/strings/messages/RecipeExportModal__live_recipe_preview/pt-BR';
import { RecipeExportModal__model_matching_rules_regex } from '@/strings/messages/RecipeExportModal__model_matching_rules_regex/pt-BR';
import { RecipeExportModal__no_matching_rules_recipe_will_use_the_default_model } from '@/strings/messages/RecipeExportModal__no_matching_rules_recipe_will_use_the_default_model/pt-BR';
import { RecipeExportModal__override } from '@/strings/messages/RecipeExportModal__override/pt-BR';
import { RecipeExportModal__parent_prompt_cleared } from '@/strings/messages/RecipeExportModal__parent_prompt_cleared/pt-BR';
import { RecipeExportModal__recipe_editor } from '@/strings/messages/RecipeExportModal__recipe_editor/pt-BR';
import { RecipeExportModal__recipe_name } from '@/strings/messages/RecipeExportModal__recipe_name/pt-BR';
import { RecipeExportModal__recipe_system_prompt } from '@/strings/messages/RecipeExportModal__recipe_system_prompt/pt-BR';
import { RecipeExportModal__regex } from '@/strings/messages/RecipeExportModal__regex/pt-BR';
import { RecipeExportModal__temperature_top_p_and_other_lm_parameters_are_automatically_included_from_your_current_group_overrides } from '@/strings/messages/RecipeExportModal__temperature_top_p_and_other_lm_parameters_are_automatically_included_from_your_current_group_overrides/pt-BR';
import { RecipeExportModal__this_recipe_will_explicitly_clear_any_inherited_system_instructions } from '@/strings/messages/RecipeExportModal__this_recipe_will_explicitly_clear_any_inherited_system_instructions/pt-BR';
import { RecipeExportModal__toggle_case_sensitivity } from '@/strings/messages/RecipeExportModal__toggle_case_sensitivity/pt-BR';
import { RecipeExportModal__what_makes_this_recipe_special } from '@/strings/messages/RecipeExportModal__what_makes_this_recipe_special/pt-BR';
import { RecipeImportTab__chat_group_name } from '@/strings/messages/RecipeImportTab__chat_group_name/pt-BR';
import { RecipeImportTab__detected_recipes } from '@/strings/messages/RecipeImportTab__detected_recipes/pt-BR';
import { RecipeImportTab__import_chat_group_recipes } from '@/strings/messages/RecipeImportTab__import_chat_group_recipes/pt-BR';
import { RecipeImportTab__import_selected } from '@/strings/messages/RecipeImportTab__import_selected/pt-BR';
import { RecipeImportTab__model_selection } from '@/strings/messages/RecipeImportTab__model_selection/pt-BR';
import { RecipeImportTab__paste_recipe_json_concatenated_json_objects_supported } from '@/strings/messages/RecipeImportTab__paste_recipe_json_concatenated_json_objects_supported/pt-BR';
import { RecipeImportTab__recipes } from '@/strings/messages/RecipeImportTab__recipes/pt-BR';
import { RecipeImportTab__system_prompt } from '@/strings/messages/RecipeImportTab__system_prompt/pt-BR';
import { RecipeImportTab__use_default_model } from '@/strings/messages/RecipeImportTab__use_default_model/pt-BR';
import { RelativeTime__days_ago } from '@/strings/messages/RelativeTime__days_ago/pt-BR';
import { RelativeTime__hours_ago } from '@/strings/messages/RelativeTime__hours_ago/pt-BR';
import { RelativeTime__just_now } from '@/strings/messages/RelativeTime__just_now/pt-BR';
import { RelativeTime__minutes_ago } from '@/strings/messages/RelativeTime__minutes_ago/pt-BR';
import { RelativeTime__seconds_ago } from '@/strings/messages/RelativeTime__seconds_ago/pt-BR';
import { SearchPreview__alt_branch } from '@/strings/messages/SearchPreview__alt_branch/pt-BR';
import { SearchPreview__conversation_match } from '@/strings/messages/SearchPreview__conversation_match/pt-BR';
import { SearchPreview__following_messages } from '@/strings/messages/SearchPreview__following_messages/pt-BR';
import { SearchPreview__message_count } from '@/strings/messages/SearchPreview__message_count/pt-BR';
import { SearchPreview__previous_messages } from '@/strings/messages/SearchPreview__previous_messages/pt-BR';
import { SearchPreview__recent_history } from '@/strings/messages/SearchPreview__recent_history/pt-BR';
import { SearchPreview__select_an_item_to_preview } from '@/strings/messages/SearchPreview__select_an_item_to_preview/pt-BR';
import { ServerSetupGuide__download_the_installer_from_the_official_website } from '@/strings/messages/ServerSetupGuide__download_the_installer_from_the_official_website/pt-BR';
import { ServerSetupGuide__download_the_latest_binary_or_build_from_source } from '@/strings/messages/ServerSetupGuide__download_the_latest_binary_or_build_from_source/pt-BR';
import { ServerSetupGuide__external } from '@/strings/messages/ServerSetupGuide__external/pt-BR';
import { ServerSetupGuide__install_using_homebrew } from '@/strings/messages/ServerSetupGuide__install_using_homebrew/pt-BR';
import { ServerSetupGuide__releases } from '@/strings/messages/ServerSetupGuide__releases/pt-BR';
import { ServerSetupGuide__run_gemma_3n } from '@/strings/messages/ServerSetupGuide__run_gemma_3n/pt-BR';
import { ServerSetupGuide__run_the_installation_script } from '@/strings/messages/ServerSetupGuide__run_the_installation_script/pt-BR';
import { ServerSetupGuide__start_server } from '@/strings/messages/ServerSetupGuide__start_server/pt-BR';
import { SettingsModal__about } from '@/strings/messages/SettingsModal__about/pt-BR';
import { SettingsModal__connection } from '@/strings/messages/SettingsModal__connection/pt-BR';
import { SettingsModal__developer } from '@/strings/messages/SettingsModal__developer/pt-BR';
import { SettingsModal__discard } from '@/strings/messages/SettingsModal__discard/pt-BR';
import { SettingsModal__discard_unsaved_changes } from '@/strings/messages/SettingsModal__discard_unsaved_changes/pt-BR';
import { SettingsModal__discard_unsaved_connection_changes } from '@/strings/messages/SettingsModal__discard_unsaved_connection_changes/pt-BR';
import { SettingsModal__failed_to_import_recipes } from '@/strings/messages/SettingsModal__failed_to_import_recipes/pt-BR';
import { SettingsModal__files } from '@/strings/messages/SettingsModal__files/pt-BR';
import { SettingsModal__folders } from '@/strings/messages/SettingsModal__folders/pt-BR';
import { SettingsModal__keep_editing } from '@/strings/messages/SettingsModal__keep_editing/pt-BR';
import { SettingsModal__provider_profiles } from '@/strings/messages/SettingsModal__provider_profiles/pt-BR';
import { SettingsModal__recipes } from '@/strings/messages/SettingsModal__recipes/pt-BR';
import { SettingsModal__settings } from '@/strings/messages/SettingsModal__settings/pt-BR';
import { SettingsModal__standalone } from '@/strings/messages/SettingsModal__standalone/pt-BR';
import { SettingsModal__storage } from '@/strings/messages/SettingsModal__storage/pt-BR';
import { SettingsModal__successfully_imported_recipes_as_chat_groups } from '@/strings/messages/SettingsModal__successfully_imported_recipes_as_chat_groups/pt-BR';
import { SettingsModal__tools } from '@/strings/messages/SettingsModal__tools/pt-BR';
import { SettingsModal__transformers_js } from '@/strings/messages/SettingsModal__transformers_js/pt-BR';
import { SidebarDebugControls__debug_events } from '@/strings/messages/SidebarDebugControls__debug_events/pt-BR';
import { SidebarDebugControls__file_explorer } from '@/strings/messages/SidebarDebugControls__file_explorer/pt-BR';
import { SidebarDebugControls__more_actions } from '@/strings/messages/SidebarDebugControls__more_actions/pt-BR';
import { SidebarDebugControls__quick_access } from '@/strings/messages/SidebarDebugControls__quick_access/pt-BR';
import { SidebarDebugControls__recent_chats } from '@/strings/messages/SidebarDebugControls__recent_chats/pt-BR';
import { SidebarDebugControls__wesh_terminal } from '@/strings/messages/SidebarDebugControls__wesh_terminal/pt-BR';
import { Sidebar__add_chat } from '@/strings/messages/Sidebar__add_chat/pt-BR';
import { Sidebar__cancel } from '@/strings/messages/Sidebar__cancel/pt-BR';
import { Sidebar__close_sidebar } from '@/strings/messages/Sidebar__close_sidebar/pt-BR';
import { Sidebar__create_chat_group } from '@/strings/messages/Sidebar__create_chat_group/pt-BR';
import { Sidebar__current_group } from '@/strings/messages/Sidebar__current_group/pt-BR';
import { Sidebar__default_model } from '@/strings/messages/Sidebar__default_model/pt-BR';
import { Sidebar__delete_group } from '@/strings/messages/Sidebar__delete_group/pt-BR';
import { Sidebar__delete_group_question } from '@/strings/messages/Sidebar__delete_group_question/pt-BR';
import { Sidebar__delete_group_warning } from '@/strings/messages/Sidebar__delete_group_warning/pt-BR';
import { Sidebar__ephemeral_session } from '@/strings/messages/Sidebar__ephemeral_session/pt-BR';
import { Sidebar__group_name } from '@/strings/messages/Sidebar__group_name/pt-BR';
import { Sidebar__new_chat_in_group } from '@/strings/messages/Sidebar__new_chat_in_group/pt-BR';
import { Sidebar__none } from '@/strings/messages/Sidebar__none/pt-BR';
import { Sidebar__open_sidebar } from '@/strings/messages/Sidebar__open_sidebar/pt-BR';
import { Sidebar__rename_group } from '@/strings/messages/Sidebar__rename_group/pt-BR';
import { Sidebar__search_cmd_k } from '@/strings/messages/Sidebar__search_cmd_k/pt-BR';
import { Sidebar__select_default_model } from '@/strings/messages/Sidebar__select_default_model/pt-BR';
import { Sidebar__settings } from '@/strings/messages/Sidebar__settings/pt-BR';
import { Sidebar__show_less } from '@/strings/messages/Sidebar__show_less/pt-BR';
import { Sidebar__show_more } from '@/strings/messages/Sidebar__show_more/pt-BR';
import { SpeechControl__pause } from '@/strings/messages/SpeechControl__pause/pt-BR';
import { SpeechControl__read_aloud } from '@/strings/messages/SpeechControl__read_aloud/pt-BR';
import { SpeechControl__restart } from '@/strings/messages/SpeechControl__restart/pt-BR';
import { SpeechControl__resume } from '@/strings/messages/SpeechControl__resume/pt-BR';
import { SpeechControl__stop } from '@/strings/messages/SpeechControl__stop/pt-BR';
import { SpeechLanguageSelector__auto } from '@/strings/messages/SpeechLanguageSelector__auto/pt-BR';
import { SpeechLanguageSelector__auto_detect } from '@/strings/messages/SpeechLanguageSelector__auto_detect/pt-BR';
import { SpeechLanguageSelector__auto_detect_with_language } from '@/strings/messages/SpeechLanguageSelector__auto_detect_with_language/pt-BR';
import { SpeechLanguageSelector__english } from '@/strings/messages/SpeechLanguageSelector__english/pt-BR';
import { SpeechLanguageSelector__language } from '@/strings/messages/SpeechLanguageSelector__language/pt-BR';
import { SpeechLanguageSelector__redetect_language } from '@/strings/messages/SpeechLanguageSelector__redetect_language/pt-BR';
import { StandaloneVerificationPage__checks_file_protocol_startup_routing_styles_lazy_chunks_systemjs_and_repeated_worker_creation_without_changing_chats_or_settings } from '@/strings/messages/StandaloneVerificationPage__checks_file_protocol_startup_routing_styles_lazy_chunks_systemjs_and_repeated_worker_creation_without_changing_chats_or_settings/pt-BR';
import { StandaloneVerificationPage__copied_diagnostics_may_contain_local_file_paths_in_browser_provided_error_stacks_or_resource_timing_entries } from '@/strings/messages/StandaloneVerificationPage__copied_diagnostics_may_contain_local_file_paths_in_browser_provided_error_stacks_or_resource_timing_entries/pt-BR';
import { StandaloneVerificationPage__copy_json } from '@/strings/messages/StandaloneVerificationPage__copy_json/pt-BR';
import { StandaloneVerificationPage__failed_to_copy_verification_json } from '@/strings/messages/StandaloneVerificationPage__failed_to_copy_verification_json/pt-BR';
import { StandaloneVerificationPage__run_standalone_verification } from '@/strings/messages/StandaloneVerificationPage__run_standalone_verification/pt-BR';
import { StandaloneVerificationPage__running } from '@/strings/messages/StandaloneVerificationPage__running/pt-BR';
import { StandaloneVerificationPage__standalone_verification } from '@/strings/messages/StandaloneVerificationPage__standalone_verification/pt-BR';
import { StandaloneVerificationPage__standalone_verification_json_copied } from '@/strings/messages/StandaloneVerificationPage__standalone_verification_json_copied/pt-BR';
import { StandaloneVerificationPage__these_checks_require_a_standalone_build_opened_through_file } from '@/strings/messages/StandaloneVerificationPage__these_checks_require_a_standalone_build_opened_through_file/pt-BR';
import { StandaloneVerificationPage__verification_failed_to_run } from '@/strings/messages/StandaloneVerificationPage__verification_failed_to_run/pt-BR';
import { StandaloneVerificationPage__verification_summary } from '@/strings/messages/StandaloneVerificationPage__verification_summary/pt-BR';
import { StorageService__an_error_occurred_during_a_storage_operation } from '@/strings/messages/StorageService__an_error_occurred_during_a_storage_operation/pt-BR';
import { StorageTab__active } from '@/strings/messages/StorageTab__active/pt-BR';
import { StorageTab__active_storage_provider } from '@/strings/messages/StorageTab__active_storage_provider/pt-BR';
import { StorageTab__attachments_will_be_inaccessible } from '@/strings/messages/StorageTab__attachments_will_be_inaccessible/pt-BR';
import { StorageTab__backup_and_restore } from '@/strings/messages/StorageTab__backup_and_restore/pt-BR';
import { StorageTab__backup_restore_description } from '@/strings/messages/StorageTab__backup_restore_description/pt-BR';
import { StorageTab__best_effort } from '@/strings/messages/StorageTab__best_effort/pt-BR';
import { StorageTab__browser_declined_persistence } from '@/strings/messages/StorageTab__browser_declined_persistence/pt-BR';
import { StorageTab__checking } from '@/strings/messages/StorageTab__checking/pt-BR';
import { StorageTab__clear_all } from '@/strings/messages/StorageTab__clear_all/pt-BR';
import { StorageTab__clear_all_conversation_history } from '@/strings/messages/StorageTab__clear_all_conversation_history/pt-BR';
import { StorageTab__clear_conversation_history } from '@/strings/messages/StorageTab__clear_conversation_history/pt-BR';
import { StorageTab__clear_history } from '@/strings/messages/StorageTab__clear_history/pt-BR';
import { StorageTab__clear_history_description } from '@/strings/messages/StorageTab__clear_history_description/pt-BR';
import { StorageTab__confirm_storage_switch } from '@/strings/messages/StorageTab__confirm_storage_switch/pt-BR';
import { StorageTab__confirm_switch_to_storage } from '@/strings/messages/StorageTab__confirm_switch_to_storage/pt-BR';
import { StorageTab__copy_link } from '@/strings/messages/StorageTab__copy_link/pt-BR';
import { StorageTab__data_cleanup } from '@/strings/messages/StorageTab__data_cleanup/pt-BR';
import { StorageTab__data_durability } from '@/strings/messages/StorageTab__data_durability/pt-BR';
import { StorageTab__delete_all_chats_warning } from '@/strings/messages/StorageTab__delete_all_chats_warning/pt-BR';
import { StorageTab__enable } from '@/strings/messages/StorageTab__enable/pt-BR';
import { StorageTab__ephemeral } from '@/strings/messages/StorageTab__ephemeral/pt-BR';
import { StorageTab__ephemeral_description } from '@/strings/messages/StorageTab__ephemeral_description/pt-BR';
import { StorageTab__error } from '@/strings/messages/StorageTab__error/pt-BR';
import { StorageTab__exclude_attachments } from '@/strings/messages/StorageTab__exclude_attachments/pt-BR';
import { StorageTab__exclude_chat_history } from '@/strings/messages/StorageTab__exclude_chat_history/pt-BR';
import { StorageTab__exclude_chats } from '@/strings/messages/StorageTab__exclude_chats/pt-BR';
import { StorageTab__experimental } from '@/strings/messages/StorageTab__experimental/pt-BR';
import { StorageTab__export_import } from '@/strings/messages/StorageTab__export_import/pt-BR';
import { StorageTab__export_url_copied } from '@/strings/messages/StorageTab__export_url_copied/pt-BR';
import { StorageTab__failed_to_enable_persistence } from '@/strings/messages/StorageTab__failed_to_enable_persistence/pt-BR';
import { StorageTab__failed_to_generate_export_url } from '@/strings/messages/StorageTab__failed_to_generate_export_url/pt-BR';
import { StorageTab__failed_to_migrate_data } from '@/strings/messages/StorageTab__failed_to_migrate_data/pt-BR';
import { StorageTab__generating } from '@/strings/messages/StorageTab__generating/pt-BR';
import { StorageTab__large_storage_link_warning } from '@/strings/messages/StorageTab__large_storage_link_warning/pt-BR';
import { StorageTab__local_storage } from '@/strings/messages/StorageTab__local_storage/pt-BR';
import { StorageTab__local_storage_description } from '@/strings/messages/StorageTab__local_storage_description/pt-BR';
import { StorageTab__local_storage_loses_attachments } from '@/strings/messages/StorageTab__local_storage_loses_attachments/pt-BR';
import { StorageTab__manage_data } from '@/strings/messages/StorageTab__manage_data/pt-BR';
import { StorageTab__migration_failed } from '@/strings/messages/StorageTab__migration_failed/pt-BR';
import { StorageTab__not_supported } from '@/strings/messages/StorageTab__not_supported/pt-BR';
import { StorageTab__opfs_description } from '@/strings/messages/StorageTab__opfs_description/pt-BR';
import { StorageTab__origin_private_file_system } from '@/strings/messages/StorageTab__origin_private_file_system/pt-BR';
import { StorageTab__persistence_denied } from '@/strings/messages/StorageTab__persistence_denied/pt-BR';
import { StorageTab__persistent_storage } from '@/strings/messages/StorageTab__persistent_storage/pt-BR';
import { StorageTab__persistent_storage_description } from '@/strings/messages/StorageTab__persistent_storage_description/pt-BR';
import { StorageTab__persistent_storage_not_supported } from '@/strings/messages/StorageTab__persistent_storage_not_supported/pt-BR';
import { StorageTab__protected } from '@/strings/messages/StorageTab__protected/pt-BR';
import { StorageTab__recommended } from '@/strings/messages/StorageTab__recommended/pt-BR';
import { StorageTab__share_url_description } from '@/strings/messages/StorageTab__share_url_description/pt-BR';
import { StorageTab__share_via_url } from '@/strings/messages/StorageTab__share_via_url/pt-BR';
import { StorageTab__storage_management } from '@/strings/messages/StorageTab__storage_management/pt-BR';
import { StorageTab__storage_migration_description } from '@/strings/messages/StorageTab__storage_migration_description/pt-BR';
import { StorageTab__switch_and_lose_attachments } from '@/strings/messages/StorageTab__switch_and_lose_attachments/pt-BR';
import { StorageTab__switch_and_migrate } from '@/strings/messages/StorageTab__switch_and_migrate/pt-BR';
import { StorageTab__understand } from '@/strings/messages/StorageTab__understand/pt-BR';
import { StorageTab__unsupported } from '@/strings/messages/StorageTab__unsupported/pt-BR';
import { ThemeToggle__dark_mode } from '@/strings/messages/ThemeToggle__dark_mode/pt-BR';
import { ThemeToggle__light_mode } from '@/strings/messages/ThemeToggle__light_mode/pt-BR';
import { ThemeToggle__system_mode } from '@/strings/messages/ThemeToggle__system_mode/pt-BR';
import { ToolCallGroupItem__used_tools } from '@/strings/messages/ToolCallGroupItem__used_tools/pt-BR';
import { ToolConfigHierarchySettings__access_global_knowledge } from '@/strings/messages/ToolConfigHierarchySettings__access_global_knowledge/pt-BR';
import { ToolConfigHierarchySettings__calculator } from '@/strings/messages/ToolConfigHierarchySettings__calculator/pt-BR';
import { ToolConfigHierarchySettings__choices } from '@/strings/messages/ToolConfigHierarchySettings__choices/pt-BR';
import { ToolConfigHierarchySettings__choose_from_model_provided_options } from '@/strings/messages/ToolConfigHierarchySettings__choose_from_model_provided_options/pt-BR';
import { ToolConfigHierarchySettings__off } from '@/strings/messages/ToolConfigHierarchySettings__off/pt-BR';
import { ToolConfigHierarchySettings__on } from '@/strings/messages/ToolConfigHierarchySettings__on/pt-BR';
import { ToolConfigHierarchySettings__reset_to_defaults } from '@/strings/messages/ToolConfigHierarchySettings__reset_to_defaults/pt-BR';
import { ToolConfigHierarchySettings__shell } from '@/strings/messages/ToolConfigHierarchySettings__shell/pt-BR';
import { ToolConfigHierarchySettings__shell_in_browser } from '@/strings/messages/ToolConfigHierarchySettings__shell_in_browser/pt-BR';
import { ToolConfigHierarchySettings__shell_settings } from '@/strings/messages/ToolConfigHierarchySettings__shell_settings/pt-BR';
import { ToolConfigHierarchySettings__solve_math_expressions } from '@/strings/messages/ToolConfigHierarchySettings__solve_math_expressions/pt-BR';
import { ToolConfigHierarchySettings__tool_config_persistence_is_disabled_saved_settings_remain_active_but_changes_cannot_be_saved_here } from '@/strings/messages/ToolConfigHierarchySettings__tool_config_persistence_is_disabled_saved_settings_remain_active_but_changes_cannot_be_saved_here/pt-BR';
import { ToolConfigHierarchySettings__turn_off_tool } from '@/strings/messages/ToolConfigHierarchySettings__turn_off_tool/pt-BR';
import { ToolConfigHierarchySettings__turn_on_tool } from '@/strings/messages/ToolConfigHierarchySettings__turn_on_tool/pt-BR';
import { ToolConfigHierarchySettings__use_global } from '@/strings/messages/ToolConfigHierarchySettings__use_global/pt-BR';
import { ToolConfigHierarchySettings__use_group } from '@/strings/messages/ToolConfigHierarchySettings__use_group/pt-BR';
import { ToolConfigHierarchySettings__wikipedia } from '@/strings/messages/ToolConfigHierarchySettings__wikipedia/pt-BR';
import { TransformersJsLoadingIndicator__downloading_model } from '@/strings/messages/TransformersJsLoadingIndicator__downloading_model/pt-BR';
import { TransformersJsLoadingIndicator__downloading_model_weights_from_hugging_face_this_only_happens_once_per_model } from '@/strings/messages/TransformersJsLoadingIndicator__downloading_model_weights_from_hugging_face_this_only_happens_once_per_model/pt-BR';
import { TransformersJsLoadingIndicator__initializing_model } from '@/strings/messages/TransformersJsLoadingIndicator__initializing_model/pt-BR';
import { TransformersJsLoadingIndicator__loading_model_progress } from '@/strings/messages/TransformersJsLoadingIndicator__loading_model_progress/pt-BR';
import { TransformersJsLoadingIndicator__loading_model_weights_into_browser_memory_for_local_inference } from '@/strings/messages/TransformersJsLoadingIndicator__loading_model_weights_into_browser_memory_for_local_inference/pt-BR';
import { TransformersJsLoadingIndicator__model } from '@/strings/messages/TransformersJsLoadingIndicator__model/pt-BR';
import { TransformersJsLoadingIndicator__on_device_execution } from '@/strings/messages/TransformersJsLoadingIndicator__on_device_execution/pt-BR';
import { TransformersJsLoadingIndicator__transformers_js_error } from '@/strings/messages/TransformersJsLoadingIndicator__transformers_js_error/pt-BR';
import { ModelSupportInvestigationModal__blocked } from '@/strings/messages/ModelSupportInvestigationModal__blocked/pt-BR';
import { ModelSupportInvestigationModal__candidate_eligible } from '@/strings/messages/ModelSupportInvestigationModal__candidate_eligible/pt-BR';
import { ModelSupportInvestigationModal__candidate_ineligible } from '@/strings/messages/ModelSupportInvestigationModal__candidate_ineligible/pt-BR';
import { ModelSupportInvestigationModal__candidate_plan_summary } from '@/strings/messages/ModelSupportInvestigationModal__candidate_plan_summary/pt-BR';
import { ModelSupportInvestigationModal__candidate_registry_failed } from '@/strings/messages/ModelSupportInvestigationModal__candidate_registry_failed/pt-BR';
import { ModelSupportInvestigationModal__model_file_plan } from '@/strings/messages/ModelSupportInvestigationModal__model_file_plan/pt-BR';
import { ModelSupportInvestigationModal__model_file_plan_summary } from '@/strings/messages/ModelSupportInvestigationModal__model_file_plan_summary/pt-BR';
import { ModelSupportInvestigationModal__cache_revision_unknown } from '@/strings/messages/ModelSupportInvestigationModal__cache_revision_unknown/pt-BR';
import { ModelSupportInvestigationModal__checking_same_origin_runtime_assets } from '@/strings/messages/ModelSupportInvestigationModal__checking_same_origin_runtime_assets/pt-BR';
import { ModelSupportInvestigationModal__close } from '@/strings/messages/ModelSupportInvestigationModal__close/pt-BR';
import { ModelSupportInvestigationModal__current_operation } from '@/strings/messages/ModelSupportInvestigationModal__current_operation/pt-BR';
import { ModelSupportInvestigationModal__declaration_files_summary } from '@/strings/messages/ModelSupportInvestigationModal__declaration_files_summary/pt-BR';
import { ModelSupportInvestigationModal__download_partial_evidence } from '@/strings/messages/ModelSupportInvestigationModal__download_partial_evidence/pt-BR';
import { ModelSupportInvestigationModal__evidence_export } from '@/strings/messages/ModelSupportInvestigationModal__evidence_export/pt-BR';
import { ModelSupportInvestigationModal__environment_evidence_disclosure } from '@/strings/messages/ModelSupportInvestigationModal__environment_evidence_disclosure/pt-BR';
import { ModelSupportInvestigationModal__evidence_readiness } from '@/strings/messages/ModelSupportInvestigationModal__evidence_readiness/pt-BR';
import { ModelSupportInvestigationModal__evidence_readiness_summary } from '@/strings/messages/ModelSupportInvestigationModal__evidence_readiness_summary/pt-BR';
import { ModelSupportInvestigationModal__existing_model_data } from '@/strings/messages/ModelSupportInvestigationModal__existing_model_data/pt-BR';
import { ModelSupportInvestigationModal__failed } from '@/strings/messages/ModelSupportInvestigationModal__failed/pt-BR';
import { ModelSupportInvestigationModal__findings } from '@/strings/messages/ModelSupportInvestigationModal__findings/pt-BR';
import { ModelSupportInvestigationModal__loading_investigation } from '@/strings/messages/ModelSupportInvestigationModal__loading_investigation/pt-BR';
import { ModelSupportInvestigationModal__lane_comparison } from '@/strings/messages/ModelSupportInvestigationModal__lane_comparison/pt-BR';
import { ModelSupportInvestigationModal__lane_continuity_failed } from '@/strings/messages/ModelSupportInvestigationModal__lane_continuity_failed/pt-BR';
import { ModelSupportInvestigationModal__lane_continuity_summary } from '@/strings/messages/ModelSupportInvestigationModal__lane_continuity_summary/pt-BR';
import { ModelSupportInvestigationModal__lane_failed } from '@/strings/messages/ModelSupportInvestigationModal__lane_failed/pt-BR';
import { ModelSupportInvestigationModal__lane_input_match } from '@/strings/messages/ModelSupportInvestigationModal__lane_input_match/pt-BR';
import { ModelSupportInvestigationModal__lane_input_mismatch } from '@/strings/messages/ModelSupportInvestigationModal__lane_input_mismatch/pt-BR';
import { ModelSupportInvestigationModal__lane_route_summary } from '@/strings/messages/ModelSupportInvestigationModal__lane_route_summary/pt-BR';
import { ModelSupportInvestigationModal__multimodal_failed } from '@/strings/messages/ModelSupportInvestigationModal__multimodal_failed/pt-BR';
import { ModelSupportInvestigationModal__multimodal_observed } from '@/strings/messages/ModelSupportInvestigationModal__multimodal_observed/pt-BR';
import { ModelSupportInvestigationModal__multimodal_unavailable } from '@/strings/messages/ModelSupportInvestigationModal__multimodal_unavailable/pt-BR';
import { ModelSupportInvestigationModal__reasoning_differential_failed } from '@/strings/messages/ModelSupportInvestigationModal__reasoning_differential_failed/pt-BR';
import { ModelSupportInvestigationModal__reasoning_differential_observed } from '@/strings/messages/ModelSupportInvestigationModal__reasoning_differential_observed/pt-BR';
import { ModelSupportInvestigationModal__reasoning_differential_unavailable } from '@/strings/messages/ModelSupportInvestigationModal__reasoning_differential_unavailable/pt-BR';
import { ModelSupportInvestigationModal__model_declarations } from '@/strings/messages/ModelSupportInvestigationModal__model_declarations/pt-BR';
import { ModelSupportInvestigationModal__model_support_investigation } from '@/strings/messages/ModelSupportInvestigationModal__model_support_investigation/pt-BR';
import { ModelSupportInvestigationModal__missing_model_type } from '@/strings/messages/ModelSupportInvestigationModal__missing_model_type/pt-BR';
import { ModelSupportInvestigationModal__model_type } from '@/strings/messages/ModelSupportInvestigationModal__model_type/pt-BR';
import { ModelSupportInvestigationModal__no_supported_auto_classes } from '@/strings/messages/ModelSupportInvestigationModal__no_supported_auto_classes/pt-BR';
import { ModelSupportInvestigationModal__not_run } from '@/strings/messages/ModelSupportInvestigationModal__not_run/pt-BR';
import { ModelSupportInvestigationModal__opfs_inventory } from '@/strings/messages/ModelSupportInvestigationModal__opfs_inventory/pt-BR';
import { ModelSupportInvestigationModal__opfs_inventory_summary } from '@/strings/messages/ModelSupportInvestigationModal__opfs_inventory_summary/pt-BR';
import { ModelSupportInvestigationModal__passed } from '@/strings/messages/ModelSupportInvestigationModal__passed/pt-BR';
import { ModelSupportInvestigationModal__repository } from '@/strings/messages/ModelSupportInvestigationModal__repository/pt-BR';
import { ModelSupportInvestigationModal__repository_information } from '@/strings/messages/ModelSupportInvestigationModal__repository_information/pt-BR';
import { ModelSupportInvestigationModal__repository_summary } from '@/strings/messages/ModelSupportInvestigationModal__repository_summary/pt-BR';
import { ModelSupportInvestigationModal__running } from '@/strings/messages/ModelSupportInvestigationModal__running/pt-BR';
import { ModelSupportInvestigationModal__runtime_assets } from '@/strings/messages/ModelSupportInvestigationModal__runtime_assets/pt-BR';
import { ModelSupportInvestigationModal__runtime_control_webgpu } from '@/strings/messages/ModelSupportInvestigationModal__runtime_control_webgpu/pt-BR';
import { ModelSupportInvestigationModal__runtime_no_output } from '@/strings/messages/ModelSupportInvestigationModal__runtime_no_output/pt-BR';
import { ModelSupportInvestigationModal__runtime_bytes } from '@/strings/messages/ModelSupportInvestigationModal__runtime_bytes/pt-BR';
import { ModelSupportInvestigationModal__runtime_control } from '@/strings/messages/ModelSupportInvestigationModal__runtime_control/pt-BR';
import { ModelSupportInvestigationModal__runtime_environment } from '@/strings/messages/ModelSupportInvestigationModal__runtime_environment/pt-BR';
import { ModelSupportInvestigationModal__runtime_environment_summary } from '@/strings/messages/ModelSupportInvestigationModal__runtime_environment_summary/pt-BR';
import { ModelSupportInvestigationModal__runtime_mjs } from '@/strings/messages/ModelSupportInvestigationModal__runtime_mjs/pt-BR';
import { ModelSupportInvestigationModal__runtime_variant } from '@/strings/messages/ModelSupportInvestigationModal__runtime_variant/pt-BR';
import { ModelSupportInvestigationModal__runtime_wasm } from '@/strings/messages/ModelSupportInvestigationModal__runtime_wasm/pt-BR';
import { ModelSupportInvestigationModal__supported_auto_classes } from '@/strings/messages/ModelSupportInvestigationModal__supported_auto_classes/pt-BR';
import { ModelSupportInvestigationModal__support_boundary } from '@/strings/messages/ModelSupportInvestigationModal__support_boundary/pt-BR';
import { ModelSupportInvestigationModal__support_boundary_summary } from '@/strings/messages/ModelSupportInvestigationModal__support_boundary_summary/pt-BR';
import { ModelSupportInvestigationModal__template_behavior } from '@/strings/messages/ModelSupportInvestigationModal__template_behavior/pt-BR';
import { ModelSupportInvestigationModal__template_behavior_summary } from '@/strings/messages/ModelSupportInvestigationModal__template_behavior_summary/pt-BR';
import { ModelSupportInvestigationModal__tool_protocol_probe_summary } from '@/strings/messages/ModelSupportInvestigationModal__tool_protocol_probe_summary/pt-BR';
import { ModelSupportInvestigationModal__tool_result_production_continuation_failed } from '@/strings/messages/ModelSupportInvestigationModal__tool_result_production_continuation_failed/pt-BR';
import { ModelSupportInvestigationModal__tool_result_production_continuation_passed } from '@/strings/messages/ModelSupportInvestigationModal__tool_result_production_continuation_passed/pt-BR';
import { ModelSupportInvestigationModal__tool_template_provenance_summary } from '@/strings/messages/ModelSupportInvestigationModal__tool_template_provenance_summary/pt-BR';
import { ModelSupportInvestigationModal__this_is_partial_evidence } from '@/strings/messages/ModelSupportInvestigationModal__this_is_partial_evidence/pt-BR';
import { TransformersJsManager__investigate } from '@/strings/messages/TransformersJsManager__investigate/pt-BR';
import { TransformersJsManager__active } from '@/strings/messages/TransformersJsManager__active/pt-BR';
import { TransformersJsManager__active_model } from '@/strings/messages/TransformersJsManager__active_model/pt-BR';
import { TransformersJsManager__add_new_models } from '@/strings/messages/TransformersJsManager__add_new_models/pt-BR';
import { TransformersJsManager__ai_engine_worker_restarted_successfully } from '@/strings/messages/TransformersJsManager__ai_engine_worker_restarted_successfully/pt-BR';
import { TransformersJsManager__asset_details } from '@/strings/messages/TransformersJsManager__asset_details/pt-BR';
import { TransformersJsManager__browsers_often_disable_the } from '@/strings/messages/TransformersJsManager__browsers_often_disable_the/pt-BR';
import { TransformersJsManager__cache_api } from '@/strings/messages/TransformersJsManager__cache_api/pt-BR';
import { TransformersJsManager__could_not_determine_a_valid_model_name_from_folder_structure } from '@/strings/messages/TransformersJsManager__could_not_determine_a_valid_model_name_from_folder_structure/pt-BR';
import { TransformersJsManager__delete } from '@/strings/messages/TransformersJsManager__delete/pt-BR';
import { TransformersJsManager__delete_downloaded_model } from '@/strings/messages/TransformersJsManager__delete_downloaded_model/pt-BR';
import { TransformersJsManager__delete_failed } from '@/strings/messages/TransformersJsManager__delete_failed/pt-BR';
import { TransformersJsManager__delete_model } from '@/strings/messages/TransformersJsManager__delete_model/pt-BR';
import { TransformersJsManager__delete_model_warning } from '@/strings/messages/TransformersJsManager__delete_model_warning/pt-BR';
import { TransformersJsManager__deleted_model } from '@/strings/messages/TransformersJsManager__deleted_model/pt-BR';
import { TransformersJsManager__download_failed } from '@/strings/messages/TransformersJsManager__download_failed/pt-BR';
import { TransformersJsManager__download_failed_check_details_in_the_section_below } from '@/strings/messages/TransformersJsManager__download_failed_check_details_in_the_section_below/pt-BR';
import { TransformersJsManager__download_from_hugging_face } from '@/strings/messages/TransformersJsManager__download_from_hugging_face/pt-BR';
import { TransformersJsManager__download_model } from '@/strings/messages/TransformersJsManager__download_model/pt-BR';
import { TransformersJsManager__downloaded_models } from '@/strings/messages/TransformersJsManager__downloaded_models/pt-BR';
import { TransformersJsManager__downloading_and_compiling } from '@/strings/messages/TransformersJsManager__downloading_and_compiling/pt-BR';
import { TransformersJsManager__engine_control } from '@/strings/messages/TransformersJsManager__engine_control/pt-BR';
import { TransformersJsManager__engine_idle } from '@/strings/messages/TransformersJsManager__engine_idle/pt-BR';
import { TransformersJsManager__engine_ready } from '@/strings/messages/TransformersJsManager__engine_ready/pt-BR';
import { TransformersJsManager__engine_unloaded_and_resources_released } from '@/strings/messages/TransformersJsManager__engine_unloaded_and_resources_released/pt-BR';
import { TransformersJsManager__enter_hugging_face_model_id_e_g_onnx_community_phi_4 } from '@/strings/messages/TransformersJsManager__enter_hugging_face_model_id_e_g_onnx_community_phi_4/pt-BR';
import { TransformersJsManager__error } from '@/strings/messages/TransformersJsManager__error/pt-BR';
import { TransformersJsManager__filter_downloaded_models } from '@/strings/messages/TransformersJsManager__filter_downloaded_models/pt-BR';
import { TransformersJsManager__find_more_models } from '@/strings/messages/TransformersJsManager__find_more_models/pt-BR';
import { TransformersJsManager__for_local_file_urls_to_avoid_downloading_models_on_every_reload_use_a_local_web_server_or_the_hosted_version } from '@/strings/messages/TransformersJsManager__for_local_file_urls_to_avoid_downloading_models_on_every_reload_use_a_local_web_server_or_the_hosted_version/pt-BR';
import { TransformersJsManager__get_hosted_version_github } from '@/strings/messages/TransformersJsManager__get_hosted_version_github/pt-BR';
import { TransformersJsManager__hard_restart_ai_worker_engine } from '@/strings/messages/TransformersJsManager__hard_restart_ai_worker_engine/pt-BR';
import { TransformersJsManager__import_failed } from '@/strings/messages/TransformersJsManager__import_failed/pt-BR';
import { TransformersJsManager__import_from_local_files } from '@/strings/messages/TransformersJsManager__import_from_local_files/pt-BR';
import { TransformersJsManager__importing_local_model } from '@/strings/messages/TransformersJsManager__importing_local_model/pt-BR';
import { TransformersJsManager__in_browser_ai_transformers_js_is_not_available_because_the_browser_does_not_support_or_allow_access_to } from '@/strings/messages/TransformersJsManager__in_browser_ai_transformers_js_is_not_available_because_the_browser_does_not_support_or_allow_access_to/pt-BR';
import { TransformersJsManager__in_browser_ai_transformers_js_is_not_available_in_the_standalone_build_due_to_browser_restrictions_on_web_workers_and_webassembly_when_running_from_a_local_file } from '@/strings/messages/TransformersJsManager__in_browser_ai_transformers_js_is_not_available_in_the_standalone_build_due_to_browser_restrictions_on_web_workers_and_webassembly_when_running_from_a_local_file/pt-BR';
import { TransformersJsManager__incomplete } from '@/strings/messages/TransformersJsManager__incomplete/pt-BR';
import { TransformersJsManager__initializing_engine } from '@/strings/messages/TransformersJsManager__initializing_engine/pt-BR';
import { TransformersJsManager__load } from '@/strings/messages/TransformersJsManager__load/pt-BR';
import { TransformersJsManager__load_a_model_from_the_list_below_to_start_in_browser_inference } from '@/strings/messages/TransformersJsManager__load_a_model_from_the_list_below_to_start_in_browser_inference/pt-BR';
import { TransformersJsManager__loading_from_local_storage } from '@/strings/messages/TransformersJsManager__loading_from_local_storage/pt-BR';
import { TransformersJsManager__local_cache } from '@/strings/messages/TransformersJsManager__local_cache/pt-BR';
import { TransformersJsManager__model_is_already_downloaded } from '@/strings/messages/TransformersJsManager__model_is_already_downloaded/pt-BR';
import { TransformersJsManager__models_are_cached_locally_in_the_browser_opfs_for_offline_use } from '@/strings/messages/TransformersJsManager__models_are_cached_locally_in_the_browser_opfs_for_offline_use/pt-BR';
import { TransformersJsManager__no_models_downloaded_yet } from '@/strings/messages/TransformersJsManager__no_models_downloaded_yet/pt-BR';
import { TransformersJsManager__no_models_match_your_filter } from '@/strings/messages/TransformersJsManager__no_models_match_your_filter/pt-BR';
import { TransformersJsManager__note } from '@/strings/messages/TransformersJsManager__note/pt-BR';
import { TransformersJsManager__origin_private_file_system_opfs } from '@/strings/messages/TransformersJsManager__origin_private_file_system_opfs/pt-BR';
import { TransformersJsManager__overall_progress } from '@/strings/messages/TransformersJsManager__overall_progress/pt-BR';
import { TransformersJsManager__preset_model_paths } from '@/strings/messages/TransformersJsManager__preset_model_paths/pt-BR';
import { TransformersJsManager__refresh } from '@/strings/messages/TransformersJsManager__refresh/pt-BR';
import { TransformersJsManager__restart } from '@/strings/messages/TransformersJsManager__restart/pt-BR';
import { TransformersJsManager__restart_ai_engine } from '@/strings/messages/TransformersJsManager__restart_ai_engine/pt-BR';
import { TransformersJsManager__resume } from '@/strings/messages/TransformersJsManager__resume/pt-BR';
import { TransformersJsManager__select_a_folder_containing_onnx_model_files_to_import_it_into_the_browsers_storage } from '@/strings/messages/TransformersJsManager__select_a_folder_containing_onnx_model_files_to_import_it_into_the_browsers_storage/pt-BR';
import { TransformersJsManager__select_model_folder } from '@/strings/messages/TransformersJsManager__select_model_folder/pt-BR';
import { TransformersJsManager__successfully_downloaded_model } from '@/strings/messages/TransformersJsManager__successfully_downloaded_model/pt-BR';
import { TransformersJsManager__successfully_imported_model } from '@/strings/messages/TransformersJsManager__successfully_imported_model/pt-BR';
import { TransformersJsManager__this_will_terminate_the_current_background_worker_and_start_a_fresh_one_use_this_if_the_engine_becomes_unresponsive_or_shows_fatal_errors } from '@/strings/messages/TransformersJsManager__this_will_terminate_the_current_background_worker_and_start_a_fresh_one_use_this_if_the_engine_becomes_unresponsive_or_shows_fatal_errors/pt-BR';
import { TransformersJsManager__unknown } from '@/strings/messages/TransformersJsManager__unknown/pt-BR';
import { TransformersJsManager__unload_model_and_release_resources } from '@/strings/messages/TransformersJsManager__unload_model_and_release_resources/pt-BR';
import { TransformersJsManager__use_custom_id } from '@/strings/messages/TransformersJsManager__use_custom_id/pt-BR';
import { TransformersJsManager__which_is_required_for_storing_model_files_this_often_happens_in_private_browsing_modes_or_insecure_contexts } from '@/strings/messages/TransformersJsManager__which_is_required_for_storing_model_files_this_often_happens_in_private_browsing_modes_or_insecure_contexts/pt-BR';
import { TransformersJsManager__writing_model_files_to_browser_local_storage_opfs } from '@/strings/messages/TransformersJsManager__writing_model_files_to_browser_local_storage_opfs/pt-BR';
import { TransformersJsUpsell__add_manage_models } from '@/strings/messages/TransformersJsUpsell__add_manage_models/pt-BR';
import { TransformersJsUpsell__local_browser_models } from '@/strings/messages/TransformersJsUpsell__local_browser_models/pt-BR';
import { TransformersJsUpsell__need_more_models_you_can_download_and_manage_local_llms_to_run_directly_in_your_browser } from '@/strings/messages/TransformersJsUpsell__need_more_models_you_can_download_and_manage_local_llms_to_run_directly_in_your_browser/pt-BR';
import { UnselectedChatPane__select_or_create_a_chat_to_start } from '@/strings/messages/UnselectedChatPane__select_or_create_a_chat_to_start/pt-BR';
import { WelcomeScreen__all_conversations_are_stored_locally } from '@/strings/messages/WelcomeScreen__all_conversations_are_stored_locally/pt-BR';
import { WelcomeScreen__brainstorm } from '@/strings/messages/WelcomeScreen__brainstorm/pt-BR';
import { WelcomeScreen__code_help } from '@/strings/messages/WelcomeScreen__code_help/pt-BR';
import { WelcomeScreen__conversations_are_stored_in_memory } from '@/strings/messages/WelcomeScreen__conversations_are_stored_in_memory/pt-BR';
import { WelcomeScreen__data_is_cleared_on_reload } from '@/strings/messages/WelcomeScreen__data_is_cleared_on_reload/pt-BR';
import { WelcomeScreen__download_portable_app } from '@/strings/messages/WelcomeScreen__download_portable_app/pt-BR';
import { WelcomeScreen__download_standalone_portable_version } from '@/strings/messages/WelcomeScreen__download_standalone_portable_version/pt-BR';
import { WelcomeScreen__explain_vue_composition_api } from '@/strings/messages/WelcomeScreen__explain_vue_composition_api/pt-BR';
import { WelcomeScreen__home_automation_project_ideas } from '@/strings/messages/WelcomeScreen__home_automation_project_ideas/pt-BR';
import { WelcomeScreen__summarize } from '@/strings/messages/WelcomeScreen__summarize/pt-BR';
import { WelcomeScreen__summarize_local_lm_architectures } from '@/strings/messages/WelcomeScreen__summarize_local_lm_architectures/pt-BR';
import { WelcomeScreen__write_a_story } from '@/strings/messages/WelcomeScreen__write_a_story/pt-BR';
import { WelcomeScreen__write_a_time_travel_detective_story } from '@/strings/messages/WelcomeScreen__write_a_time_travel_detective_story/pt-BR';
import { WelcomeScreen__your_data_stays_on_your_device } from '@/strings/messages/WelcomeScreen__your_data_stays_on_your_device/pt-BR';
import { WeshToolSettings__shell } from '@/strings/messages/WeshToolSettings__shell/pt-BR';
import { WeshToolSettings__shell_in_browser } from '@/strings/messages/WeshToolSettings__shell_in_browser/pt-BR';
import { WeshToolSettings__shell_settings } from '@/strings/messages/WeshToolSettings__shell_settings/pt-BR';
import { advancedTextEditor__aa } from '@/strings/messages/advancedTextEditor__aa/pt-BR';
import { advancedTextEditor__cancel_esc } from '@/strings/messages/advancedTextEditor__cancel_esc/pt-BR';
import { advancedTextEditor__chars } from '@/strings/messages/advancedTextEditor__chars/pt-BR';
import { advancedTextEditor__clear_all } from '@/strings/messages/advancedTextEditor__clear_all/pt-BR';
import { advancedTextEditor__close_editor_esc } from '@/strings/messages/advancedTextEditor__close_editor_esc/pt-BR';
import { advancedTextEditor__confirm_enter } from '@/strings/messages/advancedTextEditor__confirm_enter/pt-BR';
import { advancedTextEditor__copy_all } from '@/strings/messages/advancedTextEditor__copy_all/pt-BR';
import { advancedTextEditor__enter } from '@/strings/messages/advancedTextEditor__enter/pt-BR';
import { advancedTextEditor__enter_to_find_next } from '@/strings/messages/advancedTextEditor__enter_to_find_next/pt-BR';
import { advancedTextEditor__esc } from '@/strings/messages/advancedTextEditor__esc/pt-BR';
import { advancedTextEditor__find_and_replace_with_shortcut } from '@/strings/messages/advancedTextEditor__find_and_replace_with_shortcut/pt-BR';
import { advancedTextEditor__instance_count } from '@/strings/messages/advancedTextEditor__instance_count/pt-BR';
import { advancedTextEditor__lines } from '@/strings/messages/advancedTextEditor__lines/pt-BR';
import { advancedTextEditor__match_case } from '@/strings/messages/advancedTextEditor__match_case/pt-BR';
import { advancedTextEditor__multi_edit_mode } from '@/strings/messages/advancedTextEditor__multi_edit_mode/pt-BR';
import { advancedTextEditor__multi_edit_occurrence_with_shortcut } from '@/strings/messages/advancedTextEditor__multi_edit_occurrence_with_shortcut/pt-BR';
import { advancedTextEditor__redo_with_shortcut } from '@/strings/messages/advancedTextEditor__redo_with_shortcut/pt-BR';
import { advancedTextEditor__renaming_text } from '@/strings/messages/advancedTextEditor__renaming_text/pt-BR';
import { advancedTextEditor__replace } from '@/strings/messages/advancedTextEditor__replace/pt-BR';
import { advancedTextEditor__replace_all } from '@/strings/messages/advancedTextEditor__replace_all/pt-BR';
import { advancedTextEditor__replace_with } from '@/strings/messages/advancedTextEditor__replace_with/pt-BR';
import { advancedTextEditor__search } from '@/strings/messages/advancedTextEditor__search/pt-BR';
import { advancedTextEditor__selection } from '@/strings/messages/advancedTextEditor__selection/pt-BR';
import { advancedTextEditor__steps } from '@/strings/messages/advancedTextEditor__steps/pt-BR';
import { advancedTextEditor__switch_to_advanced_editor } from '@/strings/messages/advancedTextEditor__switch_to_advanced_editor/pt-BR';
import { advancedTextEditor__switch_to_normal_textarea } from '@/strings/messages/advancedTextEditor__switch_to_normal_textarea/pt-BR';
import { advancedTextEditor__to_apply } from '@/strings/messages/advancedTextEditor__to_apply/pt-BR';
import { advancedTextEditor__to_cancel } from '@/strings/messages/advancedTextEditor__to_cancel/pt-BR';
import { advancedTextEditor__toggle_stats } from '@/strings/messages/advancedTextEditor__toggle_stats/pt-BR';
import { advancedTextEditor__toggle_word_wrap } from '@/strings/messages/advancedTextEditor__toggle_word_wrap/pt-BR';
import { advancedTextEditor__type_to_rename_all } from '@/strings/messages/advancedTextEditor__type_to_rename_all/pt-BR';
import { advancedTextEditor__type_to_replace_all } from '@/strings/messages/advancedTextEditor__type_to_replace_all/pt-BR';
import { advancedTextEditor__undo_with_shortcut } from '@/strings/messages/advancedTextEditor__undo_with_shortcut/pt-BR';
import { advancedTextEditor__updating } from '@/strings/messages/advancedTextEditor__updating/pt-BR';
import { advancedTextEditor__use_regex } from '@/strings/messages/advancedTextEditor__use_regex/pt-BR';
import { advancedTextEditor__words } from '@/strings/messages/advancedTextEditor__words/pt-BR';
import { binaryObjects__binary_objects } from '@/strings/messages/binaryObjects__binary_objects/pt-BR';
import { binaryObjects__close_with_escape } from '@/strings/messages/binaryObjects__close_with_escape/pt-BR';
import { binaryObjects__copy_name } from '@/strings/messages/binaryObjects__copy_name/pt-BR';
import { binaryObjects__date } from '@/strings/messages/binaryObjects__date/pt-BR';
import { binaryObjects__delete } from '@/strings/messages/binaryObjects__delete/pt-BR';
import { binaryObjects__download } from '@/strings/messages/binaryObjects__download/pt-BR';
import { binaryObjects__file_type_cannot_be_previewed } from '@/strings/messages/binaryObjects__file_type_cannot_be_previewed/pt-BR';
import { binaryObjects__loading } from '@/strings/messages/binaryObjects__loading/pt-BR';
import { binaryObjects__loading_more } from '@/strings/messages/binaryObjects__loading_more/pt-BR';
import { binaryObjects__loading_objects } from '@/strings/messages/binaryObjects__loading_objects/pt-BR';
import { binaryObjects__manage_persisted_files } from '@/strings/messages/binaryObjects__manage_persisted_files/pt-BR';
import { binaryObjects__name } from '@/strings/messages/binaryObjects__name/pt-BR';
import { binaryObjects__no_objects_found } from '@/strings/messages/binaryObjects__no_objects_found/pt-BR';
import { binaryObjects__preview_unavailable } from '@/strings/messages/binaryObjects__preview_unavailable/pt-BR';
import { binaryObjects__reset_zoom } from '@/strings/messages/binaryObjects__reset_zoom/pt-BR';
import { binaryObjects__search_by_name_id_or_type } from '@/strings/messages/binaryObjects__search_by_name_id_or_type/pt-BR';
import { binaryObjects__size } from '@/strings/messages/binaryObjects__size/pt-BR';
import { binaryObjects__unnamed } from '@/strings/messages/binaryObjects__unnamed/pt-BR';
import { binaryObjects__zoom_in } from '@/strings/messages/binaryObjects__zoom_in/pt-BR';
import { binaryObjects__zoom_out } from '@/strings/messages/binaryObjects__zoom_out/pt-BR';
import { blockMarkdown__allow_all_external_images_in_this_session } from '@/strings/messages/blockMarkdown__allow_all_external_images_in_this_session/pt-BR';
import { blockMarkdown__code } from '@/strings/messages/blockMarkdown__code/pt-BR';
import { blockMarkdown__copied } from '@/strings/messages/blockMarkdown__copied/pt-BR';
import { blockMarkdown__copy_code } from '@/strings/messages/blockMarkdown__copy_code/pt-BR';
import { blockMarkdown__copy_source } from '@/strings/messages/blockMarkdown__copy_source/pt-BR';
import { blockMarkdown__external_image } from '@/strings/messages/blockMarkdown__external_image/pt-BR';
import { blockMarkdown__failed_to_embed_metadata_in_image } from '@/strings/messages/blockMarkdown__failed_to_embed_metadata_in_image/pt-BR';
import { blockMarkdown__failed_to_load_image } from '@/strings/messages/blockMarkdown__failed_to_load_image/pt-BR';
import { blockMarkdown__failed_to_render_mermaid_diagram } from '@/strings/messages/blockMarkdown__failed_to_render_mermaid_diagram/pt-BR';
import { blockMarkdown__image_not_found_in_storage } from '@/strings/messages/blockMarkdown__image_not_found_in_storage/pt-BR';
import { blockMarkdown__invalid_image_block_data } from '@/strings/messages/blockMarkdown__invalid_image_block_data/pt-BR';
import { blockMarkdown__preview } from '@/strings/messages/blockMarkdown__preview/pt-BR';
import { blockMarkdown__split_view } from '@/strings/messages/blockMarkdown__split_view/pt-BR';
import { blockMarkdown__toggle_line_wrap } from '@/strings/messages/blockMarkdown__toggle_line_wrap/pt-BR';
import { blockMarkdown__unknown_token_type } from '@/strings/messages/blockMarkdown__unknown_token_type/pt-BR';
import { chatApproval__allow_action } from '@/strings/messages/chatApproval__allow_action/pt-BR';
import { chatApproval__allow_for_this_chat } from '@/strings/messages/chatApproval__allow_for_this_chat/pt-BR';
import { chatApproval__allow_globally } from '@/strings/messages/chatApproval__allow_globally/pt-BR';
import { chatApproval__allow_once } from '@/strings/messages/chatApproval__allow_once/pt-BR';
import { chatApproval__deny } from '@/strings/messages/chatApproval__deny/pt-BR';
import { chatApproval__get_wikipedia_page } from '@/strings/messages/chatApproval__get_wikipedia_page/pt-BR';
import { chatApproval__keyword_label } from '@/strings/messages/chatApproval__keyword_label/pt-BR';
import { chatApproval__page_id_label } from '@/strings/messages/chatApproval__page_id_label/pt-BR';
import { chatApproval__search_wikipedia } from '@/strings/messages/chatApproval__search_wikipedia/pt-BR';
import { chatGenerationFlow__attachments_cannot_be_saved } from '@/strings/messages/chatGenerationFlow__attachments_cannot_be_saved/pt-BR';
import { chatGenerationFlow__cancel } from '@/strings/messages/chatGenerationFlow__cancel/pt-BR';
import { chatGenerationFlow__continue_anyway } from '@/strings/messages/chatGenerationFlow__continue_anyway/pt-BR';
import { chatGenerationFlow__generation_failed_in_chat } from '@/strings/messages/chatGenerationFlow__generation_failed_in_chat/pt-BR';
import { chatGenerationFlow__local_storage_attachments_are_only_available_during_this_session } from '@/strings/messages/chatGenerationFlow__local_storage_attachments_are_only_available_during_this_session/pt-BR';
import { chatGenerationFlow__no_image_generation_model_was_found } from '@/strings/messages/chatGenerationFlow__no_image_generation_model_was_found/pt-BR';
import { chatGenerationFlow__view } from '@/strings/messages/chatGenerationFlow__view/pt-BR';
import { chatHistoryFlow__fork_of_chat } from '@/strings/messages/chatHistoryFlow__fork_of_chat/pt-BR';
import { chatModelFetch__failed_to_fetch_models_for_resolution } from '@/strings/messages/chatModelFetch__failed_to_fetch_models_for_resolution/pt-BR';
import { contextCompact__aborted } from '@/strings/messages/contextCompact__aborted/pt-BR';
import { contextCompact__applying_compact_branch } from '@/strings/messages/contextCompact__applying_compact_branch/pt-BR';
import { contextCompact__balanced } from '@/strings/messages/contextCompact__balanced/pt-BR';
import { contextCompact__building_compact_request } from '@/strings/messages/contextCompact__building_compact_request/pt-BR';
import { contextCompact__cancel } from '@/strings/messages/contextCompact__cancel/pt-BR';
import { contextCompact__compact } from '@/strings/messages/contextCompact__compact/pt-BR';
import { contextCompact__compact_context } from '@/strings/messages/contextCompact__compact_context/pt-BR';
import { contextCompact__compact_now } from '@/strings/messages/contextCompact__compact_now/pt-BR';
import { contextCompact__compact_prompt } from '@/strings/messages/contextCompact__compact_prompt/pt-BR';
import { contextCompact__compacting_context } from '@/strings/messages/contextCompact__compacting_context/pt-BR';
import { contextCompact__compacting_context_failed } from '@/strings/messages/contextCompact__compacting_context_failed/pt-BR';
import { contextCompact__compacting_will_condense_messages_into_a_single_summary } from '@/strings/messages/contextCompact__compacting_will_condense_messages_into_a_single_summary/pt-BR';
import { contextCompact__complete } from '@/strings/messages/contextCompact__complete/pt-BR';
import { contextCompact__deep } from '@/strings/messages/contextCompact__deep/pt-BR';
import { contextCompact__editable_prompt } from '@/strings/messages/contextCompact__editable_prompt/pt-BR';
import { contextCompact__generating_compact_context_with_characters_received } from '@/strings/messages/contextCompact__generating_compact_context_with_characters_received/pt-BR';
import { contextCompact__memory_reconfiguration } from '@/strings/messages/contextCompact__memory_reconfiguration/pt-BR';
import { contextCompact__messages_to_keep } from '@/strings/messages/contextCompact__messages_to_keep/pt-BR';
import { contextCompact__more_context } from '@/strings/messages/contextCompact__more_context/pt-BR';
import { contextCompact__more_history } from '@/strings/messages/contextCompact__more_history/pt-BR';
import { contextCompact__preparing_messages_and_keeping_recent_messages } from '@/strings/messages/contextCompact__preparing_messages_and_keeping_recent_messages/pt-BR';
import { contextCompact__requires_a_configured_model_and_endpoint } from '@/strings/messages/contextCompact__requires_a_configured_model_and_endpoint/pt-BR';
import { contextCompact__response_was_empty } from '@/strings/messages/contextCompact__response_was_empty/pt-BR';
import { contextCompact__to_compact } from '@/strings/messages/contextCompact__to_compact/pt-BR';
import { contextCompact__to_keep } from '@/strings/messages/contextCompact__to_keep/pt-BR';
import { contextCompact__waiting_for_the_model } from '@/strings/messages/contextCompact__waiting_for_the_model/pt-BR';
import { dataDeletion__advanced_mode } from '@/strings/messages/dataDeletion__advanced_mode/pt-BR';
import { dataDeletion__checked_selectors_matching_entries } from '@/strings/messages/dataDeletion__checked_selectors_matching_entries/pt-BR';
import { dataDeletion__delete_application_data } from '@/strings/messages/dataDeletion__delete_application_data/pt-BR';
import { dataDeletion__delete_data_matched_by_selected_selectors } from '@/strings/messages/dataDeletion__delete_data_matched_by_selected_selectors/pt-BR';
import { dataDeletion__delete_selected_data } from '@/strings/messages/dataDeletion__delete_selected_data/pt-BR';
import { dataDeletion__delete_selected_data_and_reload } from '@/strings/messages/dataDeletion__delete_selected_data_and_reload/pt-BR';
import { dataDeletion__delete_selected_data_question } from '@/strings/messages/dataDeletion__delete_selected_data_question/pt-BR';
import { dataDeletion__deletion_preview } from '@/strings/messages/dataDeletion__deletion_preview/pt-BR';
import { dataDeletion__developer_focused_deletion_controls_for_naidan_storage_selectors } from '@/strings/messages/dataDeletion__developer_focused_deletion_controls_for_naidan_storage_selectors/pt-BR';
import { dataDeletion__factory_reset } from '@/strings/messages/dataDeletion__factory_reset/pt-BR';
import { dataDeletion__no_matching_entries } from '@/strings/messages/dataDeletion__no_matching_entries/pt-BR';
import { dataDeletion__not_available_in_this_runtime } from '@/strings/messages/dataDeletion__not_available_in_this_runtime/pt-BR';
import { dataDeletion__preview_entries } from '@/strings/messages/dataDeletion__preview_entries/pt-BR';
import { dataDeletion__scanning_storage } from '@/strings/messages/dataDeletion__scanning_storage/pt-BR';
import { dataDeletion__select_at_least_one_deletion_selector } from '@/strings/messages/dataDeletion__select_at_least_one_deletion_selector/pt-BR';
import { fileExplorer__add } from '@/strings/messages/fileExplorer__add/pt-BR';
import { fileExplorer__archive_name } from '@/strings/messages/fileExplorer__archive_name/pt-BR';
import { fileExplorer__binary_file } from '@/strings/messages/fileExplorer__binary_file/pt-BR';
import { fileExplorer__byte_count } from '@/strings/messages/fileExplorer__byte_count/pt-BR';
import { fileExplorer__close } from '@/strings/messages/fileExplorer__close/pt-BR';
import { fileExplorer__close_preview } from '@/strings/messages/fileExplorer__close_preview/pt-BR';
import { fileExplorer__column_view } from '@/strings/messages/fileExplorer__column_view/pt-BR';
import { fileExplorer__copy } from '@/strings/messages/fileExplorer__copy/pt-BR';
import { fileExplorer__create } from '@/strings/messages/fileExplorer__create/pt-BR';
import { fileExplorer__creating_archive } from '@/strings/messages/fileExplorer__creating_archive/pt-BR';
import { fileExplorer__cut } from '@/strings/messages/fileExplorer__cut/pt-BR';
import { fileExplorer__delete } from '@/strings/messages/fileExplorer__delete/pt-BR';
import { fileExplorer__delete_confirmation } from '@/strings/messages/fileExplorer__delete_confirmation/pt-BR';
import { fileExplorer__delete_file } from '@/strings/messages/fileExplorer__delete_file/pt-BR';
import { fileExplorer__delete_folder } from '@/strings/messages/fileExplorer__delete_folder/pt-BR';
import { fileExplorer__delete_items } from '@/strings/messages/fileExplorer__delete_items/pt-BR';
import { fileExplorer__download } from '@/strings/messages/fileExplorer__download/pt-BR';
import { fileExplorer__download_directory } from '@/strings/messages/fileExplorer__download_directory/pt-BR';
import { fileExplorer__empty } from '@/strings/messages/fileExplorer__empty/pt-BR';
import { fileExplorer__empty_folder } from '@/strings/messages/fileExplorer__empty_folder/pt-BR';
import { fileExplorer__enter_a_name_for_the_new_file } from '@/strings/messages/fileExplorer__enter_a_name_for_the_new_file/pt-BR';
import { fileExplorer__enter_a_name_for_the_new_folder } from '@/strings/messages/fileExplorer__enter_a_name_for_the_new_folder/pt-BR';
import { fileExplorer__entry_info } from '@/strings/messages/fileExplorer__entry_info/pt-BR';
import { fileExplorer__exclude_items } from '@/strings/messages/fileExplorer__exclude_items/pt-BR';
import { fileExplorer__exclude_items_help } from '@/strings/messages/fileExplorer__exclude_items_help/pt-BR';
import { fileExplorer__failed_to_copy_items } from '@/strings/messages/fileExplorer__failed_to_copy_items/pt-BR';
import { fileExplorer__failed_to_create_file } from '@/strings/messages/fileExplorer__failed_to_create_file/pt-BR';
import { fileExplorer__failed_to_create_folder } from '@/strings/messages/fileExplorer__failed_to_create_folder/pt-BR';
import { fileExplorer__failed_to_load_exclusion_suggestions } from '@/strings/messages/fileExplorer__failed_to_load_exclusion_suggestions/pt-BR';
import { fileExplorer__failed_to_delete } from '@/strings/messages/fileExplorer__failed_to_delete/pt-BR';
import { fileExplorer__failed_to_download } from '@/strings/messages/fileExplorer__failed_to_download/pt-BR';
import { fileExplorer__failed_to_load_directory } from '@/strings/messages/fileExplorer__failed_to_load_directory/pt-BR';
import { fileExplorer__failed_to_move_items } from '@/strings/messages/fileExplorer__failed_to_move_items/pt-BR';
import { fileExplorer__failed_to_rename } from '@/strings/messages/fileExplorer__failed_to_rename/pt-BR';
import { fileExplorer__failed_to_upload_files } from '@/strings/messages/fileExplorer__failed_to_upload_files/pt-BR';
import { fileExplorer__file } from '@/strings/messages/fileExplorer__file/pt-BR';
import { fileExplorer__file_explorer_opfs } from '@/strings/messages/fileExplorer__file_explorer_opfs/pt-BR';
import { fileExplorer__file_is_too_large_to_preview } from '@/strings/messages/fileExplorer__file_is_too_large_to_preview/pt-BR';
import { fileExplorer__files } from '@/strings/messages/fileExplorer__files/pt-BR';
import { fileExplorer__filter_by_name } from '@/strings/messages/fileExplorer__filter_by_name/pt-BR';
import { fileExplorer__folder } from '@/strings/messages/fileExplorer__folder/pt-BR';
import { fileExplorer__folder_is_no_longer_available } from '@/strings/messages/fileExplorer__folder_is_no_longer_available/pt-BR';
import { fileExplorer__format } from '@/strings/messages/fileExplorer__format/pt-BR';
import { fileExplorer__get_info } from '@/strings/messages/fileExplorer__get_info/pt-BR';
import { fileExplorer__go_back } from '@/strings/messages/fileExplorer__go_back/pt-BR';
import { fileExplorer__hide_preview } from '@/strings/messages/fileExplorer__hide_preview/pt-BR';
import { fileExplorer__icon_view } from '@/strings/messages/fileExplorer__icon_view/pt-BR';
import { fileExplorer__item_count_label } from '@/strings/messages/fileExplorer__item_count_label/pt-BR';
import { fileExplorer__list_view } from '@/strings/messages/fileExplorer__list_view/pt-BR';
import { fileExplorer__load_anyway } from '@/strings/messages/fileExplorer__load_anyway/pt-BR';
import { fileExplorer__locked_click_to_unlock } from '@/strings/messages/fileExplorer__locked_click_to_unlock/pt-BR';
import { fileExplorer__modified } from '@/strings/messages/fileExplorer__modified/pt-BR';
import { fileExplorer__modified_label } from '@/strings/messages/fileExplorer__modified_label/pt-BR';
import { fileExplorer__name } from '@/strings/messages/fileExplorer__name/pt-BR';
import { fileExplorer__new_file } from '@/strings/messages/fileExplorer__new_file/pt-BR';
import { fileExplorer__new_file_unlock_to_enable } from '@/strings/messages/fileExplorer__new_file_unlock_to_enable/pt-BR';
import { fileExplorer__new_folder } from '@/strings/messages/fileExplorer__new_folder/pt-BR';
import { fileExplorer__new_folder_unlock_to_enable } from '@/strings/messages/fileExplorer__new_folder_unlock_to_enable/pt-BR';
import { fileExplorer__no_matching_items } from '@/strings/messages/fileExplorer__no_matching_items/pt-BR';
import { fileExplorer__open } from '@/strings/messages/fileExplorer__open/pt-BR';
import { fileExplorer__optional } from '@/strings/messages/fileExplorer__optional/pt-BR';
import { fileExplorer__paste } from '@/strings/messages/fileExplorer__paste/pt-BR';
import { fileExplorer__preview } from '@/strings/messages/fileExplorer__preview/pt-BR';
import { fileExplorer__refresh } from '@/strings/messages/fileExplorer__refresh/pt-BR';
import { fileExplorer__relative_path } from '@/strings/messages/fileExplorer__relative_path/pt-BR';
import { fileExplorer__rename } from '@/strings/messages/fileExplorer__rename/pt-BR';
import { fileExplorer__search } from '@/strings/messages/fileExplorer__search/pt-BR';
import { fileExplorer__select_a_file } from '@/strings/messages/fileExplorer__select_a_file/pt-BR';
import { fileExplorer__select_all } from '@/strings/messages/fileExplorer__select_all/pt-BR';
import { fileExplorer__selected_count_label } from '@/strings/messages/fileExplorer__selected_count_label/pt-BR';
import { fileExplorer__show_preview } from '@/strings/messages/fileExplorer__show_preview/pt-BR';
import { fileExplorer__size } from '@/strings/messages/fileExplorer__size/pt-BR';
import { fileExplorer__size_label } from '@/strings/messages/fileExplorer__size_label/pt-BR';
import { fileExplorer__type } from '@/strings/messages/fileExplorer__type/pt-BR';
import { fileExplorer__type_to_narrow_results } from '@/strings/messages/fileExplorer__type_to_narrow_results/pt-BR';
import { fileExplorer__unlock_to_enable } from '@/strings/messages/fileExplorer__unlock_to_enable/pt-BR';
import { fileExplorer__unlocked_click_to_lock } from '@/strings/messages/fileExplorer__unlocked_click_to_lock/pt-BR';
import { fileExplorer__unsupported_items_were_skipped } from '@/strings/messages/fileExplorer__unsupported_items_were_skipped/pt-BR';
import { fileExplorer__upload_files } from '@/strings/messages/fileExplorer__upload_files/pt-BR';
import { fileExplorer__upload_files_unlock_to_enable } from '@/strings/messages/fileExplorer__upload_files_unlock_to_enable/pt-BR';
import { fileExplorer__addition_count } from '@/strings/messages/fileExplorer__addition_count/pt-BR';
import { fileExplorer__analyzing_zip } from '@/strings/messages/fileExplorer__analyzing_zip/pt-BR';
import { fileExplorer__blocked_count } from '@/strings/messages/fileExplorer__blocked_count/pt-BR';
import { fileExplorer__cannot_be_placed } from '@/strings/messages/fileExplorer__cannot_be_placed/pt-BR';
import { fileExplorer__existing } from '@/strings/messages/fileExplorer__existing/pt-BR';
import { fileExplorer__extract_and_place } from '@/strings/messages/fileExplorer__extract_and_place/pt-BR';
import { fileExplorer__extract_and_place_description } from '@/strings/messages/fileExplorer__extract_and_place_description/pt-BR';
import { fileExplorer__merge_count } from '@/strings/messages/fileExplorer__merge_count/pt-BR';
import { fileExplorer__next_zip } from '@/strings/messages/fileExplorer__next_zip/pt-BR';
import { fileExplorer__not_changed_yet } from '@/strings/messages/fileExplorer__not_changed_yet/pt-BR';
import { fileExplorer__overwrite_count } from '@/strings/messages/fileExplorer__overwrite_count/pt-BR';
import { fileExplorer__place_contents_here } from '@/strings/messages/fileExplorer__place_contents_here/pt-BR';
import { fileExplorer__place_contents_here_description } from '@/strings/messages/fileExplorer__place_contents_here_description/pt-BR';
import { fileExplorer__place_directory_itself } from '@/strings/messages/fileExplorer__place_directory_itself/pt-BR';
import { fileExplorer__place_directory_itself_description } from '@/strings/messages/fileExplorer__place_directory_itself_description/pt-BR';
import { fileExplorer__place_zip_file_as_is } from '@/strings/messages/fileExplorer__place_zip_file_as_is/pt-BR';
import { fileExplorer__place_zip_file_as_is_description } from '@/strings/messages/fileExplorer__place_zip_file_as_is_description/pt-BR';
import { fileExplorer__placement_method } from '@/strings/messages/fileExplorer__placement_method/pt-BR';
import { fileExplorer__placement_preview } from '@/strings/messages/fileExplorer__placement_preview/pt-BR';
import { fileExplorer__planned_addition } from '@/strings/messages/fileExplorer__planned_addition/pt-BR';
import { fileExplorer__planned_merge } from '@/strings/messages/fileExplorer__planned_merge/pt-BR';
import { fileExplorer__planned_overwrite } from '@/strings/messages/fileExplorer__planned_overwrite/pt-BR';
import { fileExplorer__root_directory_handling } from '@/strings/messages/fileExplorer__root_directory_handling/pt-BR';
import { fileExplorer__status } from '@/strings/messages/fileExplorer__status/pt-BR';
import { fileExplorer__uploading } from '@/strings/messages/fileExplorer__uploading/pt-BR';
import { fileExplorer__zip_archive } from '@/strings/messages/fileExplorer__zip_archive/pt-BR';
import { fileExplorer__zip_cannot_be_extracted } from '@/strings/messages/fileExplorer__zip_cannot_be_extracted/pt-BR';
import { fileExplorer__zip_file_upload } from '@/strings/messages/fileExplorer__zip_file_upload/pt-BR';
import { fileExplorer__zip_upload_preview_outdated } from '@/strings/messages/fileExplorer__zip_upload_preview_outdated/pt-BR';
import { formatSettingsSourceLabel__default } from '@/strings/messages/formatSettingsSourceLabel__default/pt-BR';
import { formatSettingsSourceLabel__value_from_chat } from '@/strings/messages/formatSettingsSourceLabel__value_from_chat/pt-BR';
import { formatSettingsSourceLabel__none } from '@/strings/messages/formatSettingsSourceLabel__none/pt-BR';
import { formatSettingsSourceLabel__value_from_global } from '@/strings/messages/formatSettingsSourceLabel__value_from_global/pt-BR';
import { formatSettingsSourceLabel__value_from_group } from '@/strings/messages/formatSettingsSourceLabel__value_from_group/pt-BR';
import { toolCall__arguments } from '@/strings/messages/toolCall__arguments/pt-BR';
import { toolCall__code } from '@/strings/messages/toolCall__code/pt-BR';
import { toolCall__disable_wrap } from '@/strings/messages/toolCall__disable_wrap/pt-BR';
import { toolCall__enable_wrap } from '@/strings/messages/toolCall__enable_wrap/pt-BR';
import { toolCall__error } from '@/strings/messages/toolCall__error/pt-BR';
import { toolCall__executing } from '@/strings/messages/toolCall__executing/pt-BR';
import { toolCall__hide_tool_executions } from '@/strings/messages/toolCall__hide_tool_executions/pt-BR';
import { toolCall__live_output } from '@/strings/messages/toolCall__live_output/pt-BR';
import { toolCall__loading_large_result } from '@/strings/messages/toolCall__loading_large_result/pt-BR';
import { toolCall__raw_json } from '@/strings/messages/toolCall__raw_json/pt-BR';
import { toolCall__result } from '@/strings/messages/toolCall__result/pt-BR';
import { toolCall__show_tools_count } from '@/strings/messages/toolCall__show_tools_count/pt-BR';
import { toolCall__tool_executions } from '@/strings/messages/toolCall__tool_executions/pt-BR';
import { useBinaryActions__delete_binary_object } from '@/strings/messages/useBinaryActions__delete_binary_object/pt-BR';
import { useBinaryActions__delete_binary_object_warning } from '@/strings/messages/useBinaryActions__delete_binary_object_warning/pt-BR';
import { useBinaryActions__delete_permanently } from '@/strings/messages/useBinaryActions__delete_permanently/pt-BR';
import { useChatLifecycle__chat_was_deleted } from '@/strings/messages/useChatLifecycle__chat_was_deleted/pt-BR';
import { useChatLifecycle__undo } from '@/strings/messages/useChatLifecycle__undo/pt-BR';
import { useChatOrganization__copy_of_chat_group } from '@/strings/messages/useChatOrganization__copy_of_chat_group/pt-BR';
import { useImageGeneration__failed_to_generate_image } from '@/strings/messages/useImageGeneration__failed_to_generate_image/pt-BR';
import { useImageGeneration__failed_to_reencode_image } from '@/strings/messages/useImageGeneration__failed_to_reencode_image/pt-BR';
import { useImageGeneration__no_suitable_image_generation_model_found } from '@/strings/messages/useImageGeneration__no_suitable_image_generation_model_found/pt-BR';
import { usePrompt__prompt } from '@/strings/messages/usePrompt__prompt/pt-BR';
import { useSettings__data_successfully_imported_from_url } from '@/strings/messages/useSettings__data_successfully_imported_from_url/pt-BR';
import { useSettings__failed_to_fetch_models_for_settings } from '@/strings/messages/useSettings__failed_to_fetch_models_for_settings/pt-BR';
import { useSettings__failed_to_import_data_from_url } from '@/strings/messages/useSettings__failed_to_import_data_from_url/pt-BR';
import { useSettings__invalid_storage_type_falling_back_to_default_detection } from '@/strings/messages/useSettings__invalid_storage_type_falling_back_to_default_detection/pt-BR';
import { useSettings__ok } from '@/strings/messages/useSettings__ok/pt-BR';
import { useSettings__request_to_use_storage_type_was_ignored } from '@/strings/messages/useSettings__request_to_use_storage_type_was_ignored/pt-BR';
import { useSettings__storage_already_initialized } from '@/strings/messages/useSettings__storage_already_initialized/pt-BR';
import { useSettings__storage_type_is_already_set_and_requested_type_was_ignored } from '@/strings/messages/useSettings__storage_type_is_already_set_and_requested_type_was_ignored/pt-BR';
import { volumes__access_mode } from '@/strings/messages/volumes__access_mode/pt-BR';
import { volumes__active_count } from '@/strings/messages/volumes__active_count/pt-BR';
import { volumes__add_folder } from '@/strings/messages/volumes__add_folder/pt-BR';
import { volumes__add_folder_requires_chromium } from '@/strings/messages/volumes__add_folder_requires_chromium/pt-BR';
import { volumes__add_or_copy_folder_into_browser_storage } from '@/strings/messages/volumes__add_or_copy_folder_into_browser_storage/pt-BR';
import { volumes__ai_can_read_and_modify_files } from '@/strings/messages/volumes__ai_can_read_and_modify_files/pt-BR';
import { volumes__ai_can_read_not_write } from '@/strings/messages/volumes__ai_can_read_not_write/pt-BR';
import { volumes__cancel } from '@/strings/messages/volumes__cancel/pt-BR';
import { volumes__change_access_later } from '@/strings/messages/volumes__change_access_later/pt-BR';
import { volumes__choose_access_level } from '@/strings/messages/volumes__choose_access_level/pt-BR';
import { volumes__chromium_browser_over_https } from '@/strings/messages/volumes__chromium_browser_over_https/pt-BR';
import { volumes__configure } from '@/strings/messages/volumes__configure/pt-BR';
import { volumes__copied } from '@/strings/messages/volumes__copied/pt-BR';
import { volumes__copied_folder } from '@/strings/messages/volumes__copied_folder/pt-BR';
import { volumes__copy_does_not_change_disk_files } from '@/strings/messages/volumes__copy_does_not_change_disk_files/pt-BR';
import { volumes__copy_folder } from '@/strings/messages/volumes__copy_folder/pt-BR';
import { volumes__copy_is_stored_in_browser_opfs } from '@/strings/messages/volumes__copy_is_stored_in_browser_opfs/pt-BR';
import { volumes__copy_single_file_instead } from '@/strings/messages/volumes__copy_single_file_instead/pt-BR';
import { volumes__copying_file_to_browser } from '@/strings/messages/volumes__copying_file_to_browser/pt-BR';
import { volumes__copying_folder_to_browser } from '@/strings/messages/volumes__copying_folder_to_browser/pt-BR';
import { volumes__delete } from '@/strings/messages/volumes__delete/pt-BR';
import { volumes__delete_folder } from '@/strings/messages/volumes__delete_folder/pt-BR';
import { volumes__delete_folder_warning } from '@/strings/messages/volumes__delete_folder_warning/pt-BR';
import { volumes__drop_to_copy_to_browser } from '@/strings/messages/volumes__drop_to_copy_to_browser/pt-BR';
import { volumes__failed_to_add_folder } from '@/strings/messages/volumes__failed_to_add_folder/pt-BR';
import { volumes__failed_to_add_folder_with_error } from '@/strings/messages/volumes__failed_to_add_folder_with_error/pt-BR';
import { volumes__failed_to_copy } from '@/strings/messages/volumes__failed_to_copy/pt-BR';
import { volumes__failed_to_copy_file } from '@/strings/messages/volumes__failed_to_copy_file/pt-BR';
import { volumes__failed_to_copy_folder } from '@/strings/messages/volumes__failed_to_copy_folder/pt-BR';
import { volumes__failed_to_delete_folder } from '@/strings/messages/volumes__failed_to_delete_folder/pt-BR';
import { volumes__failed_to_load_folders } from '@/strings/messages/volumes__failed_to_load_folders/pt-BR';
import { volumes__failed_to_remove_folder } from '@/strings/messages/volumes__failed_to_remove_folder/pt-BR';
import { volumes__failed_to_rename_folder } from '@/strings/messages/volumes__failed_to_rename_folder/pt-BR';
import { volumes__failed_to_update_path_settings } from '@/strings/messages/volumes__failed_to_update_path_settings/pt-BR';
import { volumes__file_copied_to_your_folders } from '@/strings/messages/volumes__file_copied_to_your_folders/pt-BR';
import { volumes__file_progress } from '@/strings/messages/volumes__file_progress/pt-BR';
import { volumes__folder_added_to_your_folders } from '@/strings/messages/volumes__folder_added_to_your_folders/pt-BR';
import { volumes__folder_deleted } from '@/strings/messages/volumes__folder_deleted/pt-BR';
import { volumes__folder_is_no_longer_in_use } from '@/strings/messages/volumes__folder_is_no_longer_in_use/pt-BR';
import { volumes__folder_is_now_in_use } from '@/strings/messages/volumes__folder_is_now_in_use/pt-BR';
import { volumes__folder_or_file } from '@/strings/messages/volumes__folder_or_file/pt-BR';
import { volumes__folder_removed } from '@/strings/messages/volumes__folder_removed/pt-BR';
import { volumes__folders } from '@/strings/messages/volumes__folders/pt-BR';
import { volumes__give_ai_access_to_files_in_your_folders } from '@/strings/messages/volumes__give_ai_access_to_files_in_your_folders/pt-BR';
import { volumes__imported_folder } from '@/strings/messages/volumes__imported_folder/pt-BR';
import { volumes__in_use } from '@/strings/messages/volumes__in_use/pt-BR';
import { volumes__in_use_globally } from '@/strings/messages/volumes__in_use_globally/pt-BR';
import { volumes__linked } from '@/strings/messages/volumes__linked/pt-BR';
import { volumes__linked_folder } from '@/strings/messages/volumes__linked_folder/pt-BR';
import { volumes__linking_external_folders_not_supported } from '@/strings/messages/volumes__linking_external_folders_not_supported/pt-BR';
import { volumes__more_actions } from '@/strings/messages/volumes__more_actions/pt-BR';
import { volumes__mount_path_already_in_use } from '@/strings/messages/volumes__mount_path_already_in_use/pt-BR';
import { volumes__name_cannot_be_empty } from '@/strings/messages/volumes__name_cannot_be_empty/pt-BR';
import { volumes__no_folders_configured } from '@/strings/messages/volumes__no_folders_configured/pt-BR';
import { volumes__not_in_use } from '@/strings/messages/volumes__not_in_use/pt-BR';
import { volumes__not_in_use_globally } from '@/strings/messages/volumes__not_in_use_globally/pt-BR';
import { volumes__not_supported_in_browser_or_context } from '@/strings/messages/volumes__not_supported_in_browser_or_context/pt-BR';
import { volumes__opfs_not_supported } from '@/strings/messages/volumes__opfs_not_supported/pt-BR';
import { volumes__original_folder_is_never_touched } from '@/strings/messages/volumes__original_folder_is_never_touched/pt-BR';
import { volumes__path } from '@/strings/messages/volumes__path/pt-BR';
import { volumes__path_settings_updated } from '@/strings/messages/volumes__path_settings_updated/pt-BR';
import { volumes__permission_denied_folder_may_not_be_accessible } from '@/strings/messages/volumes__permission_denied_folder_may_not_be_accessible/pt-BR';
import { volumes__read_only } from '@/strings/messages/volumes__read_only/pt-BR';
import { volumes__read_write } from '@/strings/messages/volumes__read_write/pt-BR';
import { volumes__remove } from '@/strings/messages/volumes__remove/pt-BR';
import { volumes__remove_folder } from '@/strings/messages/volumes__remove_folder/pt-BR';
import { volumes__remove_folder_warning } from '@/strings/messages/volumes__remove_folder_warning/pt-BR';
import { volumes__rename } from '@/strings/messages/volumes__rename/pt-BR';
import { volumes__save } from '@/strings/messages/volumes__save/pt-BR';
import { volumes__save_changes } from '@/strings/messages/volumes__save_changes/pt-BR';
import { volumes__stop_using } from '@/strings/messages/volumes__stop_using/pt-BR';
import { volumes__use } from '@/strings/messages/volumes__use/pt-BR';
import { volumes__what_is_copy_folder } from '@/strings/messages/volumes__what_is_copy_folder/pt-BR';
import { volumes__why_add_folder_disabled } from '@/strings/messages/volumes__why_add_folder_disabled/pt-BR';
import { weshTerminal__cancel } from '@/strings/messages/weshTerminal__cancel/pt-BR';
import { weshTerminal__close_session } from '@/strings/messages/weshTerminal__close_session/pt-BR';
import { weshTerminal__close_session_aria } from '@/strings/messages/weshTerminal__close_session_aria/pt-BR';
import { weshTerminal__close_session_question } from '@/strings/messages/weshTerminal__close_session_question/pt-BR';
import { weshTerminal__close_terminal } from '@/strings/messages/weshTerminal__close_terminal/pt-BR';
import { weshTerminal__debug_terminal } from '@/strings/messages/weshTerminal__debug_terminal/pt-BR';
import { weshTerminal__initializing_worker } from '@/strings/messages/weshTerminal__initializing_worker/pt-BR';
import { weshTerminal__new } from '@/strings/messages/weshTerminal__new/pt-BR';
import { weshTerminal__no_sessions_press_new_to_start_a_worker_backed_shell } from '@/strings/messages/weshTerminal__no_sessions_press_new_to_start_a_worker_backed_shell/pt-BR';
import { weshTerminal__session } from '@/strings/messages/weshTerminal__session/pt-BR';
import { weshTerminal__this_will_dispose_the_worker_and_lose_the_session_history_continue } from '@/strings/messages/weshTerminal__this_will_dispose_the_worker_and_lose_the_session_history_continue/pt-BR';
import { weshTerminal__wesh_terminal } from '@/strings/messages/weshTerminal__wesh_terminal/pt-BR';

import { OpfsEncryptionSettingsPanel__additional_conflicting_entries } from '@/strings/messages/OpfsEncryptionSettingsPanel__additional_conflicting_entries/pt-BR';
import { OpfsEncryptionSettingsPanel__conflict_changed } from '@/strings/messages/OpfsEncryptionSettingsPanel__conflict_changed/pt-BR';
import { OpfsEncryptionSettingsPanel__delete_conflicting_data_and_retry } from '@/strings/messages/OpfsEncryptionSettingsPanel__delete_conflicting_data_and_retry/pt-BR';
import { OpfsEncryptionSettingsPanel__encrypted_source_remains_authoritative } from '@/strings/messages/OpfsEncryptionSettingsPanel__encrypted_source_remains_authoritative/pt-BR';
import { OpfsEncryptionSettingsPanel__plain_target_conflict } from '@/strings/messages/OpfsEncryptionSettingsPanel__plain_target_conflict/pt-BR';
import { OpfsEncryptionSettingsPanel__plain_target_conflict_explanation } from '@/strings/messages/OpfsEncryptionSettingsPanel__plain_target_conflict_explanation/pt-BR';
import { OpfsEncryptionSettingsPanel__plain_target_conflict_loss_warning } from '@/strings/messages/OpfsEncryptionSettingsPanel__plain_target_conflict_loss_warning/pt-BR';
import { opfsEncryption__build_and_verify_separate_encrypted_store } from '@/strings/messages/opfsEncryption__build_and_verify_separate_encrypted_store/pt-BR';
import { opfsEncryption__cancel } from '@/strings/messages/opfsEncryption__cancel/pt-BR';
import { opfsEncryption__change_opfs_passphrase } from '@/strings/messages/opfsEncryption__change_opfs_passphrase/pt-BR';
import { opfsEncryption__change_passphrase } from '@/strings/messages/opfsEncryption__change_passphrase/pt-BR';
import { opfsEncryption__changing_raw_opfs_during_transition_can_prevent_recovery } from '@/strings/messages/opfsEncryption__changing_raw_opfs_during_transition_can_prevent_recovery/pt-BR';
import { opfsEncryption__confirm_new_passphrase } from '@/strings/messages/opfsEncryption__confirm_new_passphrase/pt-BR';
import { opfsEncryption__confirm_passphrase } from '@/strings/messages/opfsEncryption__confirm_passphrase/pt-BR';
import { opfsEncryption__copied } from '@/strings/messages/opfsEncryption__copied/pt-BR';
import { opfsEncryption__copy } from '@/strings/messages/opfsEncryption__copy/pt-BR';
import { opfsEncryption__copy_source } from '@/strings/messages/opfsEncryption__copy_source/pt-BR';
import { opfsEncryption__copying_and_verifying_complete_opfs_storage } from '@/strings/messages/opfsEncryption__copying_and_verifying_complete_opfs_storage/pt-BR';
import { opfsEncryption__could_not_read_encryption_control_state } from '@/strings/messages/opfsEncryption__could_not_read_encryption_control_state/pt-BR';
import { opfsEncryption__decrypt_storage } from '@/strings/messages/opfsEncryption__decrypt_storage/pt-BR';
import { opfsEncryption__decrypt_storage_explanation } from '@/strings/messages/opfsEncryption__decrypt_storage_explanation/pt-BR';
import { opfsEncryption__enable_opfs_encryption } from '@/strings/messages/opfsEncryption__enable_opfs_encryption/pt-BR';
import { opfsEncryption__encrypt_storage } from '@/strings/messages/opfsEncryption__encrypt_storage/pt-BR';
import { opfsEncryption__encrypted_storage_needs_recovery } from '@/strings/messages/opfsEncryption__encrypted_storage_needs_recovery/pt-BR';
import { opfsEncryption__encryption_control_state_cannot_be_read_safely } from '@/strings/messages/opfsEncryption__encryption_control_state_cannot_be_read_safely/pt-BR';
import { opfsEncryption__encryption_enabled } from '@/strings/messages/opfsEncryption__encryption_enabled/pt-BR';
import { opfsEncryption__encryption_state_is_unreadable } from '@/strings/messages/opfsEncryption__encryption_state_is_unreadable/pt-BR';
import { opfsEncryption__encryption_transition_must_finish_before_changing_this_setting } from '@/strings/messages/opfsEncryption__encryption_transition_must_finish_before_changing_this_setting/pt-BR';
import { opfsEncryption__enter_passphrase_for_opfs_storage } from '@/strings/messages/opfsEncryption__enter_passphrase_for_opfs_storage/pt-BR';
import { opfsEncryption__experimental } from '@/strings/messages/opfsEncryption__experimental/pt-BR';
import { opfsEncryption__experimental_format_may_change_incompatibly } from '@/strings/messages/opfsEncryption__experimental_format_may_change_incompatibly/pt-BR';
import { opfsEncryption__hide_passphrase } from '@/strings/messages/opfsEncryption__hide_passphrase/pt-BR';
import { opfsEncryption__interrupted_encryption_operation } from '@/strings/messages/opfsEncryption__interrupted_encryption_operation/pt-BR';
import { opfsEncryption__leading_or_trailing_whitespace_is_part_of_passphrase } from '@/strings/messages/opfsEncryption__leading_or_trailing_whitespace_is_part_of_passphrase/pt-BR';
import { opfsEncryption__loading_recovery_source } from '@/strings/messages/opfsEncryption__loading_recovery_source/pt-BR';
import { opfsEncryption__new_passphrase } from '@/strings/messages/opfsEncryption__new_passphrase/pt-BR';
import { opfsEncryption__only_passphrase_keyslot_is_replaced } from '@/strings/messages/opfsEncryption__only_passphrase_keyslot_is_replaced/pt-BR';
import { opfsEncryption__open_raw_opfs_explorer } from '@/strings/messages/opfsEncryption__open_raw_opfs_explorer/pt-BR';
import { opfsEncryption__opfs_encryption } from '@/strings/messages/opfsEncryption__opfs_encryption/pt-BR';
import { opfsEncryption__passphrase } from '@/strings/messages/opfsEncryption__passphrase/pt-BR';
import { opfsEncryption__passphrases_cannot_contain_line_breaks } from '@/strings/messages/opfsEncryption__passphrases_cannot_contain_line_breaks/pt-BR';
import { opfsEncryption__passphrases_do_not_match } from '@/strings/messages/opfsEncryption__passphrases_do_not_match/pt-BR';
import { opfsEncryption__naidan_could_not_finish_loading } from '@/strings/messages/opfsEncryption__naidan_could_not_finish_loading/pt-BR';
import { opfsEncryption__preparing_naidan } from '@/strings/messages/opfsEncryption__preparing_naidan/pt-BR';
import { opfsEncryption__raw_opfs_access_does_not_decrypt } from '@/strings/messages/opfsEncryption__raw_opfs_access_does_not_decrypt/pt-BR';
import { opfsEncryption__re_encrypt } from '@/strings/messages/opfsEncryption__re_encrypt/pt-BR';
import { opfsEncryption__re_encrypt_opfs_storage } from '@/strings/messages/opfsEncryption__re_encrypt_opfs_storage/pt-BR';
import { opfsEncryption__re_encrypt_storage } from '@/strings/messages/opfsEncryption__re_encrypt_storage/pt-BR';
import { opfsEncryption__re_encrypt_storage_explanation } from '@/strings/messages/opfsEncryption__re_encrypt_storage_explanation/pt-BR';
import { opfsEncryption__recovery_source } from '@/strings/messages/opfsEncryption__recovery_source/pt-BR';
import { opfsEncryption__resolve_interrupted_opfs_decryption } from '@/strings/messages/opfsEncryption__resolve_interrupted_opfs_decryption/pt-BR';
import { opfsEncryption__resolve_interrupted_opfs_encryption } from '@/strings/messages/opfsEncryption__resolve_interrupted_opfs_encryption/pt-BR';
import { opfsEncryption__resolve_interrupted_opfs_reencryption } from '@/strings/messages/opfsEncryption__resolve_interrupted_opfs_reencryption/pt-BR';
import { opfsEncryption__retry_after_recovery } from '@/strings/messages/opfsEncryption__retry_after_recovery/pt-BR';
import { opfsEncryption__save_file } from '@/strings/messages/opfsEncryption__save_file/pt-BR';
import { opfsEncryption__save_source } from '@/strings/messages/opfsEncryption__save_source/pt-BR';
import { opfsEncryption__select_opfs_as_active_storage_to_enable_encryption } from '@/strings/messages/opfsEncryption__select_opfs_as_active_storage_to_enable_encryption/pt-BR';
import { opfsEncryption__show_passphrase } from '@/strings/messages/opfsEncryption__show_passphrase/pt-BR';
import { opfsEncryption__source_remains_until_verified } from '@/strings/messages/opfsEncryption__source_remains_until_verified/pt-BR';
import { opfsEncryption__storage_unlocked_but_naidan_could_not_finish_loading } from '@/strings/messages/opfsEncryption__storage_unlocked_but_naidan_could_not_finish_loading/pt-BR';
import { opfsEncryption__storage_unlocked_preparing_application } from '@/strings/messages/opfsEncryption__storage_unlocked_preparing_application/pt-BR';
import { opfsEncryption__transparently_encrypt_naidan_opfs_data } from '@/strings/messages/opfsEncryption__transparently_encrypt_naidan_opfs_data/pt-BR';
import { opfsEncryption__turn_off_opfs_encryption } from '@/strings/messages/opfsEncryption__turn_off_opfs_encryption/pt-BR';
import { opfsEncryption__understand_experimental_storage_risk } from '@/strings/messages/opfsEncryption__understand_experimental_storage_risk/pt-BR';
import { opfsEncryption__unlock_and_resolve } from '@/strings/messages/opfsEncryption__unlock_and_resolve/pt-BR';
import { opfsEncryption__unlock_encrypted_storage } from '@/strings/messages/opfsEncryption__unlock_encrypted_storage/pt-BR';
import { opfsEncryption__unlock_storage } from '@/strings/messages/opfsEncryption__unlock_storage/pt-BR';
import { opfsEncryption__unlocked } from '@/strings/messages/opfsEncryption__unlocked/pt-BR';
import { opfsEncryption__updating_encrypted_storage } from '@/strings/messages/opfsEncryption__updating_encrypted_storage/pt-BR';
import { DeveloperOpfsEncryptionInterruptionPanel__after_authority_switch } from '@/strings/messages/DeveloperOpfsEncryptionInterruptionPanel__after_authority_switch/pt-BR';
import { DeveloperOpfsEncryptionInterruptionPanel__before_authority_switch } from '@/strings/messages/DeveloperOpfsEncryptionInterruptionPanel__before_authority_switch/pt-BR';
import { DeveloperOpfsEncryptionInterruptionPanel__confirm_passphrase } from '@/strings/messages/DeveloperOpfsEncryptionInterruptionPanel__confirm_passphrase/pt-BR';
import { DeveloperOpfsEncryptionInterruptionPanel__interrupt_and_reload } from '@/strings/messages/DeveloperOpfsEncryptionInterruptionPanel__interrupt_and_reload/pt-BR';
import { DeveloperOpfsEncryptionInterruptionPanel__interrupt_opfs_transition } from '@/strings/messages/DeveloperOpfsEncryptionInterruptionPanel__interrupt_opfs_transition/pt-BR';
import { DeveloperOpfsEncryptionInterruptionPanel__interruption_boundary } from '@/strings/messages/DeveloperOpfsEncryptionInterruptionPanel__interruption_boundary/pt-BR';
import { DeveloperOpfsEncryptionInterruptionPanel__interrupts_ordinary_transition } from '@/strings/messages/DeveloperOpfsEncryptionInterruptionPanel__interrupts_ordinary_transition/pt-BR';
import { DeveloperOpfsEncryptionInterruptionPanel__operation } from '@/strings/messages/DeveloperOpfsEncryptionInterruptionPanel__operation/pt-BR';
import { DeveloperOpfsEncryptionInterruptionPanel__opfs_only } from '@/strings/messages/DeveloperOpfsEncryptionInterruptionPanel__opfs_only/pt-BR';
import { DeveloperOpfsEncryptionInterruptionPanel__opfs_transition_interruption } from '@/strings/messages/DeveloperOpfsEncryptionInterruptionPanel__opfs_transition_interruption/pt-BR';
import { DeveloperOpfsEncryptionInterruptionPanel__ordinary_transition_warning } from '@/strings/messages/DeveloperOpfsEncryptionInterruptionPanel__ordinary_transition_warning/pt-BR';
import { DeveloperOpfsEncryptionInterruptionPanel__transition_in_progress } from '@/strings/messages/DeveloperOpfsEncryptionInterruptionPanel__transition_in_progress/pt-BR';
import { opfsEncryption__progress_bytes } from '@/strings/messages/opfsEncryption__progress_bytes/pt-BR';
import { opfsEncryption__progress_cleaning_source } from '@/strings/messages/opfsEncryption__progress_cleaning_source/pt-BR';
import { opfsEncryption__progress_copying } from '@/strings/messages/opfsEncryption__progress_copying/pt-BR';
import { opfsEncryption__progress_entries } from '@/strings/messages/opfsEncryption__progress_entries/pt-BR';
import { opfsEncryption__progress_finalizing } from '@/strings/messages/opfsEncryption__progress_finalizing/pt-BR';
import { opfsEncryption__progress_preparing } from '@/strings/messages/opfsEncryption__progress_preparing/pt-BR';
import { opfsEncryption__progress_switching_authority } from '@/strings/messages/opfsEncryption__progress_switching_authority/pt-BR';
import { opfsEncryption__progress_verifying } from '@/strings/messages/opfsEncryption__progress_verifying/pt-BR';
import { opfsEncryption__return_to_plain_after_authority_switch } from '@/strings/messages/opfsEncryption__return_to_plain_after_authority_switch/pt-BR';
import { opfsEncryption__return_to_plain_before_authority_switch } from '@/strings/messages/opfsEncryption__return_to_plain_before_authority_switch/pt-BR';
import { opfsEncryption__stop_encryption_and_return_to_plain } from '@/strings/messages/opfsEncryption__stop_encryption_and_return_to_plain/pt-BR';
import { opfsEncryption__returning_to_plain_storage } from '@/strings/messages/opfsEncryption__returning_to_plain_storage/pt-BR';

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
