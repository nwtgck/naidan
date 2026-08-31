// SHARED__ keys intentionally couple every call site to one product-wide copy decision.
// Do not use this scope for deduplication or unclear ownership; follow messages/AGENTS.md.
import { SHARED__all_chats } from '@/strings/messages/SHARED__all_chats/ko';
import { SHARED__assistant } from '@/strings/messages/SHARED__assistant/ko';
import { SHARED__browser_provided } from '@/strings/messages/SHARED__browser_provided/ko';
import { SHARED__cancel } from '@/strings/messages/SHARED__cancel/ko';
import { SHARED__choose_which_chats_are_visible_to_the_shell } from '@/strings/messages/SHARED__choose_which_chats_are_visible_to_the_shell/ko';
import { SHARED__configure_browser_based_shell_access } from '@/strings/messages/SHARED__configure_browser_based_shell_access/ko';
import { SHARED__confirm } from '@/strings/messages/SHARED__confirm/ko';
import { SHARED__connection_failed_check_url_or_provider } from '@/strings/messages/SHARED__connection_failed_check_url_or_provider/ko';
import { SHARED__current_chat } from '@/strings/messages/SHARED__current_chat/ko';
import { SHARED__current_chat_plus_chat_group } from '@/strings/messages/SHARED__current_chat_plus_chat_group/ko';
import { SHARED__expose_chat_discovery_paths } from '@/strings/messages/SHARED__expose_chat_discovery_paths/ko';
import { SHARED__generated_image } from '@/strings/messages/SHARED__generated_image/ko';
import { SHARED__local_and_memory_storage_expose_wesh_as_read_only_without_tmp } from '@/strings/messages/SHARED__local_and_memory_storage_expose_wesh_as_read_only_without_tmp/ko';
import { SHARED__mount } from '@/strings/messages/SHARED__mount/ko';
import { SHARED__new_chat } from '@/strings/messages/SHARED__new_chat/ko';
import { SHARED__no_models_found_at_this_endpoint } from '@/strings/messages/SHARED__no_models_found_at_this_endpoint/ko';
import { SHARED__unsupported_experimental_endpoint } from '@/strings/messages/SHARED__unsupported_experimental_endpoint/ko';
import { SHARED__uses_a_language_model_provided_and_managed_by_the_browser } from '@/strings/messages/SHARED__uses_a_language_model_provided_and_managed_by_the_browser/ko';
import { SHARED__visibility } from '@/strings/messages/SHARED__visibility/ko';
import { SHARED__writable_tmp_is_available_with_opfs_storage } from '@/strings/messages/SHARED__writable_tmp_is_available_with_opfs_storage/ko';

import { AboutTab__about_naidan } from '@/strings/messages/AboutTab__about_naidan/ko';
import { AboutTab__built_with_open_source_software } from '@/strings/messages/AboutTab__built_with_open_source_software/ko';
import { AboutTab__github_repository } from '@/strings/messages/AboutTab__github_repository/ko';
import { AboutTab__loading_licenses } from '@/strings/messages/AboutTab__loading_licenses/ko';
import { AboutTab__open_source_licenses } from '@/strings/messages/AboutTab__open_source_licenses/ko';
import { AboutTab__privacy_focused_local_lm_interface } from '@/strings/messages/AboutTab__privacy_focused_local_lm_interface/ko';
import { AboutTab__runs_locally_via_file_protocol } from '@/strings/messages/AboutTab__runs_locally_via_file_protocol/ko';
import { AboutTab__standalone_app } from '@/strings/messages/AboutTab__standalone_app/ko';
import { AboutTab__unknown_package } from '@/strings/messages/AboutTab__unknown_package/ko';
import { AboutTab__version } from '@/strings/messages/AboutTab__version/ko';
import { AboutTab__view_license_text } from '@/strings/messages/AboutTab__view_license_text/ko';
import { AboutTab__view_source_code_and_contribute } from '@/strings/messages/AboutTab__view_source_code_and_contribute/ko';
import { AssistantProcessSequence__and_more } from '@/strings/messages/AssistantProcessSequence__and_more/ko';
import { AssistantProcessSequence__less } from '@/strings/messages/AssistantProcessSequence__less/ko';
import { AssistantProcessSequence__process_details } from '@/strings/messages/AssistantProcessSequence__process_details/ko';
import { AssistantProcessSequence__show } from '@/strings/messages/AssistantProcessSequence__show/ko';
import { AssistantProcessSequence__thinking_steps } from '@/strings/messages/AssistantProcessSequence__thinking_steps/ko';
import { AssistantProcessSequence__tool_executions } from '@/strings/messages/AssistantProcessSequence__tool_executions/ko';
import { AssistantProcessSequence__used_tools } from '@/strings/messages/AssistantProcessSequence__used_tools/ko';
import { AssistantWaitingIndicator__waiting_for_response } from '@/strings/messages/AssistantWaitingIndicator__waiting_for_response/ko';
import { ChatAttachMenu__a_private_copy_is_saved_in_your_browser } from '@/strings/messages/ChatAttachMenu__a_private_copy_is_saved_in_your_browser/ko';
import { ChatAttachMenu__attach_files_or_folder } from '@/strings/messages/ChatAttachMenu__attach_files_or_folder/ko';
import { ChatAttachMenu__chrome_edge_brave_opera_over_https_links_your_folder_directly_without_copying } from '@/strings/messages/ChatAttachMenu__chrome_edge_brave_opera_over_https_links_your_folder_directly_without_copying/ko';
import { ChatAttachMenu__files } from '@/strings/messages/ChatAttachMenu__files/ko';
import { ChatAttachMenu__folder_copy } from '@/strings/messages/ChatAttachMenu__folder_copy/ko';
import { ChatAttachMenu__folder_link } from '@/strings/messages/ChatAttachMenu__folder_link/ko';
import { ChatAttachMenu__naidan_works_from_the_copy_your_original_files_on_disk_stay_safe_and_intact } from '@/strings/messages/ChatAttachMenu__naidan_works_from_the_copy_your_original_files_on_disk_stay_safe_and_intact/ko';
import { ChatAttachMenu__requires_a_chromium_based_browser } from '@/strings/messages/ChatAttachMenu__requires_a_chromium_based_browser/ko';
import { ChatAttachMenu__what_is_folder_copy } from '@/strings/messages/ChatAttachMenu__what_is_folder_copy/ko';
import { ChatAttachMenu__what_is_folder_link } from '@/strings/messages/ChatAttachMenu__what_is_folder_link/ko';
import { ChatAttachMenu__why_is_folder_link_unavailable } from '@/strings/messages/ChatAttachMenu__why_is_folder_link_unavailable/ko';
import { ChatDebugInspector__active } from '@/strings/messages/ChatDebugInspector__active/ko';
import { ChatDebugInspector__chat_inspector } from '@/strings/messages/ChatDebugInspector__chat_inspector/ko';
import { ChatDebugInspector__collapse_tree } from '@/strings/messages/ChatDebugInspector__collapse_tree/ko';
import { ChatDebugInspector__context_path } from '@/strings/messages/ChatDebugInspector__context_path/ko';
import { ChatDebugInspector__data_explorer } from '@/strings/messages/ChatDebugInspector__data_explorer/ko';
import { ChatDebugInspector__expand_tree } from '@/strings/messages/ChatDebugInspector__expand_tree/ko';
import { ChatDebugInspector__failed_to_parse_image_metadata_during_preview_collection } from '@/strings/messages/ChatDebugInspector__failed_to_parse_image_metadata_during_preview_collection/ko';
import { ChatDebugInspector__fake_lm } from '@/strings/messages/ChatDebugInspector__fake_lm/ko';
import { ChatDebugInspector__fake_lm_is_only_available_in_hosted_builds } from '@/strings/messages/ChatDebugInspector__fake_lm_is_only_available_in_hosted_builds/ko';
import { ChatDebugInspector__full_json } from '@/strings/messages/ChatDebugInspector__full_json/ko';
import { ChatDebugInspector__on } from '@/strings/messages/ChatDebugInspector__on/ko';
import { ChatDebugInspector__open_at_this_message } from '@/strings/messages/ChatDebugInspector__open_at_this_message/ko';
import { ChatDebugInspector__select_a_node_to_inspect } from '@/strings/messages/ChatDebugInspector__select_a_node_to_inspect/ko';
import { ChatDebugInspector__set_this_chat_to_ollama_and_enable_global_fake_lm_debug_mode } from '@/strings/messages/ChatDebugInspector__set_this_chat_to_ollama_and_enable_global_fake_lm_debug_mode/ko';
import { ChatDebugInspector__toggle_content_collapse } from '@/strings/messages/ChatDebugInspector__toggle_content_collapse/ko';
import { ChatDebugInspector__toggle_highlighting } from '@/strings/messages/ChatDebugInspector__toggle_highlighting/ko';
import { ChatDebugInspector__tree } from '@/strings/messages/ChatDebugInspector__tree/ko';
import { ChatDebugTreeNode__collapse_content } from '@/strings/messages/ChatDebugTreeNode__collapse_content/ko';
import { ChatDebugTreeNode__error } from '@/strings/messages/ChatDebugTreeNode__error/ko';
import { ChatDebugTreeNode__generated_image_reference } from '@/strings/messages/ChatDebugTreeNode__generated_image_reference/ko';
import { ChatDebugTreeNode__show_content } from '@/strings/messages/ChatDebugTreeNode__show_content/ko';
import { ChatDebugTreeNode__text_content_hidden } from '@/strings/messages/ChatDebugTreeNode__text_content_hidden/ko';
import { ChatDebugTreeNode__thinking_process } from '@/strings/messages/ChatDebugTreeNode__thinking_process/ko';
import { ChatGroupActions__delete_group } from '@/strings/messages/ChatGroupActions__delete_group/ko';
import { ChatGroupActions__duplicate_group } from '@/strings/messages/ChatGroupActions__duplicate_group/ko';
import { ChatGroupActions__more_actions } from '@/strings/messages/ChatGroupActions__more_actions/ko';
import { ChatGroupActions__search_in_group } from '@/strings/messages/ChatGroupActions__search_in_group/ko';
import { ChatGroupSearchPreview__chat_count } from '@/strings/messages/ChatGroupSearchPreview__chat_count/ko';
import { ChatGroupSearchPreview__empty_group } from '@/strings/messages/ChatGroupSearchPreview__empty_group/ko';
import { ChatGroupSearchPreview__group_preview } from '@/strings/messages/ChatGroupSearchPreview__group_preview/ko';
import { ChatGroupSearchPreview__open_chat } from '@/strings/messages/ChatGroupSearchPreview__open_chat/ko';
import { ChatGroupSearchPreview__select_a_chat_to_preview } from '@/strings/messages/ChatGroupSearchPreview__select_a_chat_to_preview/ko';
import { ChatGroupSettingsPanel__active_overrides } from '@/strings/messages/ChatGroupSettingsPanel__active_overrides/ko';
import { ChatGroupSettingsPanel__add_header } from '@/strings/messages/ChatGroupSettingsPanel__add_header/ko';
import { ChatGroupSettingsPanel__added_after_global_instructions } from '@/strings/messages/ChatGroupSettingsPanel__added_after_global_instructions/ko';
import { ChatGroupSettingsPanel__append } from '@/strings/messages/ChatGroupSettingsPanel__append/ko';
import { ChatGroupSettingsPanel__appending } from '@/strings/messages/ChatGroupSettingsPanel__appending/ko';
import { ChatGroupSettingsPanel__automatic_title } from '@/strings/messages/ChatGroupSettingsPanel__automatic_title/ko';
import { ChatGroupSettingsPanel__clear } from '@/strings/messages/ChatGroupSettingsPanel__clear/ko';
import { ChatGroupSettingsPanel__cleared } from '@/strings/messages/ChatGroupSettingsPanel__cleared/ko';
import { ChatGroupSettingsPanel__completely_replaces_global_instructions } from '@/strings/messages/ChatGroupSettingsPanel__completely_replaces_global_instructions/ko';
import { ChatGroupSettingsPanel__configure_how_chats_in_this_group_are_automatically_named } from '@/strings/messages/ChatGroupSettingsPanel__configure_how_chats_in_this_group_are_automatically_named/ko';
import { ChatGroupSettingsPanel__create_recipe } from '@/strings/messages/ChatGroupSettingsPanel__create_recipe/ko';
import { ChatGroupSettingsPanel__custom_http_headers } from '@/strings/messages/ChatGroupSettingsPanel__custom_http_headers/ko';
import { ChatGroupSettingsPanel__disabled } from '@/strings/messages/ChatGroupSettingsPanel__disabled/ko';
import { ChatGroupSettingsPanel__enabled } from '@/strings/messages/ChatGroupSettingsPanel__enabled/ko';
import { ChatGroupSettingsPanel__endpoint_type } from '@/strings/messages/ChatGroupSettingsPanel__endpoint_type/ko';
import { ChatGroupSettingsPanel__endpoint_url } from '@/strings/messages/ChatGroupSettingsPanel__endpoint_url/ko';
import { ChatGroupSettingsPanel__failed_to_save_chat_group_settings } from '@/strings/messages/ChatGroupSettingsPanel__failed_to_save_chat_group_settings/ko';
import { ChatGroupSettingsPanel__files } from '@/strings/messages/ChatGroupSettingsPanel__files/ko';
import { ChatGroupSettingsPanel__folders } from '@/strings/messages/ChatGroupSettingsPanel__folders/ko';
import { ChatGroupSettingsPanel__global_default } from '@/strings/messages/ChatGroupSettingsPanel__global_default/ko';
import { ChatGroupSettingsPanel__global_endpoint_type } from '@/strings/messages/ChatGroupSettingsPanel__global_endpoint_type/ko';
import { ChatGroupSettingsPanel__global_model } from '@/strings/messages/ChatGroupSettingsPanel__global_model/ko';
import { ChatGroupSettingsPanel__global_prompt_cleared } from '@/strings/messages/ChatGroupSettingsPanel__global_prompt_cleared/ko';
import { ChatGroupSettingsPanel__group_level } from '@/strings/messages/ChatGroupSettingsPanel__group_level/ko';
import { ChatGroupSettingsPanel__group_overrides } from '@/strings/messages/ChatGroupSettingsPanel__group_overrides/ko';
import { ChatGroupSettingsPanel__group_settings_take_precedence_over_global_settings_but_can_be_overridden_by_individual_chats } from '@/strings/messages/ChatGroupSettingsPanel__group_settings_take_precedence_over_global_settings_but_can_be_overridden_by_individual_chats/ko';
import { ChatGroupSettingsPanel__group_settings_title } from '@/strings/messages/ChatGroupSettingsPanel__group_settings_title/ko';
import { ChatGroupSettingsPanel__group_system_prompt } from '@/strings/messages/ChatGroupSettingsPanel__group_system_prompt/ko';
import { ChatGroupSettingsPanel__global } from '@/strings/messages/ChatGroupSettingsPanel__global/ko';
import { ChatGroupSettingsPanel__no_prompt } from '@/strings/messages/ChatGroupSettingsPanel__no_prompt/ko';
import { ChatGroupSettingsPanel__system_prompt_global_set } from '@/strings/messages/ChatGroupSettingsPanel__system_prompt_global_set/ko';
import { ChatGroupSettingsPanel__system_prompt_global_not_set } from '@/strings/messages/ChatGroupSettingsPanel__system_prompt_global_not_set/ko';
import { ChatGroupSettingsPanel__system_prompt_no_prompt } from '@/strings/messages/ChatGroupSettingsPanel__system_prompt_no_prompt/ko';
import { ChatGroupSettingsPanel__instructions_for_this_chat_group } from '@/strings/messages/ChatGroupSettingsPanel__instructions_for_this_chat_group/ko';
import { ChatGroupSettingsPanel__instructions_to_append } from '@/strings/messages/ChatGroupSettingsPanel__instructions_to_append/ko';
import { ChatGroupSettingsPanel__start_typing_to_override } from '@/strings/messages/ChatGroupSettingsPanel__start_typing_to_override/ko';
import { ChatGroupSettingsPanel__enter_instructions_for_this_chat_group } from '@/strings/messages/ChatGroupSettingsPanel__enter_instructions_for_this_chat_group/ko';
import { ChatGroupSettingsPanel__start_typing_to_replace } from '@/strings/messages/ChatGroupSettingsPanel__start_typing_to_replace/ko';
import { ChatGroupSettingsPanel__replace } from '@/strings/messages/ChatGroupSettingsPanel__replace/ko';
import { ChatGroupSettingsPanel__enter_instructions_that_replace_the_parent_setting } from '@/strings/messages/ChatGroupSettingsPanel__enter_instructions_that_replace_the_parent_setting/ko';
import { ChatGroupSettingsPanel__enter_instructions_to_append } from '@/strings/messages/ChatGroupSettingsPanel__enter_instructions_to_append/ko';
import { ChatGroupSettingsPanel__inherit } from '@/strings/messages/ChatGroupSettingsPanel__inherit/ko';
import { ChatGroupSettingsPanel__inherit_global_settings_or_override_individual_tools_for_this_chat_group } from '@/strings/messages/ChatGroupSettingsPanel__inherit_global_settings_or_override_individual_tools_for_this_chat_group/ko';
import { ChatGroupSettingsPanel__inherited } from '@/strings/messages/ChatGroupSettingsPanel__inherited/ko';
import { ChatGroupSettingsPanel__inherited_instructions } from '@/strings/messages/ChatGroupSettingsPanel__inherited_instructions/ko';
import { ChatGroupSettingsPanel__load_from_saved_profiles } from '@/strings/messages/ChatGroupSettingsPanel__load_from_saved_profiles/ko';
import { ChatGroupSettingsPanel__local_overrides } from '@/strings/messages/ChatGroupSettingsPanel__local_overrides/ko';
import { ChatGroupSettingsPanel__model_id_override } from '@/strings/messages/ChatGroupSettingsPanel__model_id_override/ko';
import { ChatGroupSettingsPanel__name } from '@/strings/messages/ChatGroupSettingsPanel__name/ko';
import { ChatGroupSettingsPanel__no_custom_headers } from '@/strings/messages/ChatGroupSettingsPanel__no_custom_headers/ko';
import { ChatGroupSettingsPanel__no_global_instructions_defined } from '@/strings/messages/ChatGroupSettingsPanel__no_global_instructions_defined/ko';
import { ChatGroupSettingsPanel__none } from '@/strings/messages/ChatGroupSettingsPanel__none/ko';
import { ChatGroupSettingsPanel__ollama } from '@/strings/messages/ChatGroupSettingsPanel__ollama/ko';
import { ChatGroupSettingsPanel__openai_compatible } from '@/strings/messages/ChatGroupSettingsPanel__openai_compatible/ko';
import { ChatGroupSettingsPanel__override } from '@/strings/messages/ChatGroupSettingsPanel__override/ko';
import { ChatGroupSettingsPanel__overriding } from '@/strings/messages/ChatGroupSettingsPanel__overriding/ko';
import { ChatGroupSettingsPanel__parameters } from '@/strings/messages/ChatGroupSettingsPanel__parameters/ko';
import { ChatGroupSettingsPanel__quick_endpoint_presets } from '@/strings/messages/ChatGroupSettingsPanel__quick_endpoint_presets/ko';
import { ChatGroupSettingsPanel__quick_profile_switcher } from '@/strings/messages/ChatGroupSettingsPanel__quick_profile_switcher/ko';
import { ChatGroupSettingsPanel__restore_defaults } from '@/strings/messages/ChatGroupSettingsPanel__restore_defaults/ko';
import { ChatGroupSettingsPanel__search_group } from '@/strings/messages/ChatGroupSettingsPanel__search_group/ko';
import { ChatGroupSettingsPanel__search_messages } from '@/strings/messages/ChatGroupSettingsPanel__search_messages/ko';
import { ChatGroupSettingsPanel__set_group_name } from '@/strings/messages/ChatGroupSettingsPanel__set_group_name/ko';
import { ChatGroupSettingsPanel__settings_resolution } from '@/strings/messages/ChatGroupSettingsPanel__settings_resolution/ko';
import { ChatGroupSettingsPanel__share_settings } from '@/strings/messages/ChatGroupSettingsPanel__share_settings/ko';
import { ChatGroupSettingsPanel__system_prompt } from '@/strings/messages/ChatGroupSettingsPanel__system_prompt/ko';
import { ChatGroupSettingsPanel__these_settings_only_apply_to_this_group } from '@/strings/messages/ChatGroupSettingsPanel__these_settings_only_apply_to_this_group/ko';
import { ChatGroupSettingsPanel__these_settings_will_apply_to_all_chats_within_this_group_unless_overridden_by_a_specific_chat } from '@/strings/messages/ChatGroupSettingsPanel__these_settings_will_apply_to_all_chats_within_this_group_unless_overridden_by_a_specific_chat/ko';
import { ChatGroupSettingsPanel__this_group_will_not_use_any_system_instructions } from '@/strings/messages/ChatGroupSettingsPanel__this_group_will_not_use_any_system_instructions/ko';
import { ChatGroupSettingsPanel__title_model_explanation } from '@/strings/messages/ChatGroupSettingsPanel__title_model_explanation/ko';
import { ChatGroupSettingsPanel__use_global_setting } from '@/strings/messages/ChatGroupSettingsPanel__use_global_setting/ko';
import { ChatGroupSettingsPanel__title_model_override } from '@/strings/messages/ChatGroupSettingsPanel__title_model_override/ko';
import { ChatGroupSettingsPanel__same_as_group_chat_endpoint } from '@/strings/messages/ChatGroupSettingsPanel__same_as_group_chat_endpoint/ko';
import { ChatGroupSettingsPanel__title_endpoint_type } from '@/strings/messages/ChatGroupSettingsPanel__title_endpoint_type/ko';
import { ChatGroupSettingsPanel__tools } from '@/strings/messages/ChatGroupSettingsPanel__tools/ko';
import { ChatGroupSettingsPanel__transformers_js } from '@/strings/messages/ChatGroupSettingsPanel__transformers_js/ko';
import { ChatGroupSettingsPanel__transformers_js_experimental } from '@/strings/messages/ChatGroupSettingsPanel__transformers_js_experimental/ko';
import { ChatGroupSettingsPanel__value } from '@/strings/messages/ChatGroupSettingsPanel__value/ko';
import { ChatGroupSettingsPanel__title_reasoning } from '@/strings/messages/ChatGroupSettingsPanel__title_reasoning/ko';
import { ChatInput__cancel } from '@/strings/messages/ChatInput__cancel/ko';
import { ChatInput__copying_name } from '@/strings/messages/ChatInput__copying_name/ko';
import { ChatInput__edit_image } from '@/strings/messages/ChatInput__edit_image/ko';
import { ChatInput__failed_to_copy } from '@/strings/messages/ChatInput__failed_to_copy/ko';
import { ChatInput__failed_to_link_folder } from '@/strings/messages/ChatInput__failed_to_link_folder/ko';
import { ChatInput__hide_input } from '@/strings/messages/ChatInput__hide_input/ko';
import { ChatInput__maximize_input } from '@/strings/messages/ChatInput__maximize_input/ko';
import { ChatInput__minimize_input } from '@/strings/messages/ChatInput__minimize_input/ko';
import { ChatInput__open_advanced_editor } from '@/strings/messages/ChatInput__open_advanced_editor/ko';
import { ChatInput__remove } from '@/strings/messages/ChatInput__remove/ko';
import { ChatInput__remove_folder } from '@/strings/messages/ChatInput__remove_folder/ko';
import { ChatInput__send_message_with_shortcut } from '@/strings/messages/ChatInput__send_message_with_shortcut/ko';
import { ChatInput__show_input } from '@/strings/messages/ChatInput__show_input/ko';
import { ChatInput__stop_generating_with_shortcut } from '@/strings/messages/ChatInput__stop_generating_with_shortcut/ko';
import { ChatInput__stop_using_folder } from '@/strings/messages/ChatInput__stop_using_folder/ko';
import { ChatInput__type_a_message } from '@/strings/messages/ChatInput__type_a_message/ko';
import { ChatInput__unlink } from '@/strings/messages/ChatInput__unlink/ko';
import { ChatInput__unlink_folder } from '@/strings/messages/ChatInput__unlink_folder/ko';
import { ChatMediaShelf__click_to_copy_prompt } from '@/strings/messages/ChatMediaShelf__click_to_copy_prompt/ko';
import { ChatMediaShelf__close_shelf } from '@/strings/messages/ChatMediaShelf__close_shelf/ko';
import { ChatMediaShelf__copied } from '@/strings/messages/ChatMediaShelf__copied/ko';
import { ChatMediaShelf__currently_forward_1_n_first } from '@/strings/messages/ChatMediaShelf__currently_forward_1_n_first/ko';
import { ChatMediaShelf__currently_reverse_n_n_first } from '@/strings/messages/ChatMediaShelf__currently_reverse_n_n_first/ko';
import { ChatMediaShelf__failed_to_embed_metadata_in_image } from '@/strings/messages/ChatMediaShelf__failed_to_embed_metadata_in_image/ko';
import { ChatMediaShelf__forward } from '@/strings/messages/ChatMediaShelf__forward/ko';
import { ChatMediaShelf__generated_image } from '@/strings/messages/ChatMediaShelf__generated_image/ko';
import { ChatMediaShelf__jump } from '@/strings/messages/ChatMediaShelf__jump/ko';
import { ChatMediaShelf__jump_to_this_message_in_chat } from '@/strings/messages/ChatMediaShelf__jump_to_this_message_in_chat/ko';
import { ChatMediaShelf__manual_attachment } from '@/strings/messages/ChatMediaShelf__manual_attachment/ko';
import { ChatMediaShelf__media_shelf } from '@/strings/messages/ChatMediaShelf__media_shelf/ko';
import { ChatMediaShelf__model } from '@/strings/messages/ChatMediaShelf__model/ko';
import { ChatMediaShelf__no_images_in_this_chat_yet } from '@/strings/messages/ChatMediaShelf__no_images_in_this_chat_yet/ko';
import { ChatMediaShelf__not_available } from '@/strings/messages/ChatMediaShelf__not_available/ko';
import { ChatMediaShelf__parameters } from '@/strings/messages/ChatMediaShelf__parameters/ko';
import { ChatMediaShelf__reverse } from '@/strings/messages/ChatMediaShelf__reverse/ko';
import { ChatMediaShelf__seed } from '@/strings/messages/ChatMediaShelf__seed/ko';
import { ChatMediaShelf__steps } from '@/strings/messages/ChatMediaShelf__steps/ko';
import { ChatMediaShelf__view_details_and_copy_parameters } from '@/strings/messages/ChatMediaShelf__view_details_and_copy_parameters/ko';
import { ChatPaneHeader__chat_settings_and_model_override } from '@/strings/messages/ChatPaneHeader__chat_settings_and_model_override/ko';
import { ChatPaneHeader__conversation_outline } from '@/strings/messages/ChatPaneHeader__conversation_outline/ko';
import { ChatPaneHeader__copy_shareable_chat_url } from '@/strings/messages/ChatPaneHeader__copy_shareable_chat_url/ko';
import { ChatPaneHeader__custom_overrides_active } from '@/strings/messages/ChatPaneHeader__custom_overrides_active/ko';
import { ChatPaneHeader__debug_mode } from '@/strings/messages/ChatPaneHeader__debug_mode/ko';
import { ChatPaneHeader__delete_chat } from '@/strings/messages/ChatPaneHeader__delete_chat/ko';
import { ChatPaneHeader__edit_chat_title } from '@/strings/messages/ChatPaneHeader__edit_chat_title/ko';
import { ChatPaneHeader__export_as_markdown } from '@/strings/messages/ChatPaneHeader__export_as_markdown/ko';
import { ChatPaneHeader__export_as_url } from '@/strings/messages/ChatPaneHeader__export_as_url/ko';
import { ChatPaneHeader__export_markdown } from '@/strings/messages/ChatPaneHeader__export_markdown/ko';
import { ChatPaneHeader__file_explorer } from '@/strings/messages/ChatPaneHeader__file_explorer/ko';
import { ChatPaneHeader__fork_chat_from_last_message } from '@/strings/messages/ChatPaneHeader__fork_chat_from_last_message/ko';
import { ChatPaneHeader__group_name } from '@/strings/messages/ChatPaneHeader__group_name/ko';
import { ChatPaneHeader__jump_to_original_chat } from '@/strings/messages/ChatPaneHeader__jump_to_original_chat/ko';
import { ChatPaneHeader__media_gallery } from '@/strings/messages/ChatPaneHeader__media_gallery/ko';
import { ChatPaneHeader__more_actions } from '@/strings/messages/ChatPaneHeader__more_actions/ko';
import { ChatPaneHeader__move_to_group } from '@/strings/messages/ChatPaneHeader__move_to_group/ko';
import { ChatPaneHeader__open_print_dialog } from '@/strings/messages/ChatPaneHeader__open_print_dialog/ko';
import { ChatPaneHeader__print } from '@/strings/messages/ChatPaneHeader__print/ko';
import { ChatPaneHeader__search_in_chat } from '@/strings/messages/ChatPaneHeader__search_in_chat/ko';
import { ChatPaneHeader__super_edit } from '@/strings/messages/ChatPaneHeader__super_edit/ko';
import { ChatPaneHeader__super_edit_full_history } from '@/strings/messages/ChatPaneHeader__super_edit_full_history/ko';
import { ChatPaneHeader__top_level } from '@/strings/messages/ChatPaneHeader__top_level/ko';
import { ChatPaneHeader__wesh_terminal } from '@/strings/messages/ChatPaneHeader__wesh_terminal/ko';
import { ChatPane__ai } from '@/strings/messages/ChatPane__ai/ko';
import { ChatPane__arguments } from '@/strings/messages/ChatPane__arguments/ko';
import { ChatPane__binary_error_detail_missing } from '@/strings/messages/ChatPane__binary_error_detail_missing/ko';
import { ChatPane__binary_object_missing } from '@/strings/messages/ChatPane__binary_object_missing/ko';
import { ChatPane__chat } from '@/strings/messages/ChatPane__chat/ko';
import { ChatPane__drop_files_or_folders_to_attach } from '@/strings/messages/ChatPane__drop_files_or_folders_to_attach/ko';
import { ChatPane__failed_to_generate_share_url } from '@/strings/messages/ChatPane__failed_to_generate_share_url/ko';
import { ChatPane__fake_lm_enabled_for_this_chat_via } from '@/strings/messages/ChatPane__fake_lm_enabled_for_this_chat_via/ko';
import { ChatPane__process_sequence } from '@/strings/messages/ChatPane__process_sequence/ko';
import { ChatPane__result } from '@/strings/messages/ChatPane__result/ko';
import { ChatPane__share_url_copied_to_clipboard } from '@/strings/messages/ChatPane__share_url_copied_to_clipboard/ko';
import { ChatPane__system } from '@/strings/messages/ChatPane__system/ko';
import { ChatPane__thought } from '@/strings/messages/ChatPane__thought/ko';
import { ChatPane__tool } from '@/strings/messages/ChatPane__tool/ko';
import { ChatPane__tool_executions } from '@/strings/messages/ChatPane__tool_executions/ko';
import { ChatPane__tool_still_executing } from '@/strings/messages/ChatPane__tool_still_executing/ko';
import { ChatPane__user } from '@/strings/messages/ChatPane__user/ko';
import { ChatPrintContent__chat_history } from '@/strings/messages/ChatPrintContent__chat_history/ko';
import { ChatPrintContent__chat_id } from '@/strings/messages/ChatPrintContent__chat_id/ko';
import { ChatSettingsPanel__active_overrides } from '@/strings/messages/ChatSettingsPanel__active_overrides/ko';
import { ChatSettingsPanel__add_header } from '@/strings/messages/ChatSettingsPanel__add_header/ko';
import { ChatSettingsPanel__added_after_global_instructions } from '@/strings/messages/ChatSettingsPanel__added_after_global_instructions/ko';
import { ChatSettingsPanel__append } from '@/strings/messages/ChatSettingsPanel__append/ko';
import { ChatSettingsPanel__appending } from '@/strings/messages/ChatSettingsPanel__appending/ko';
import { ChatSettingsPanel__auto_check } from '@/strings/messages/ChatSettingsPanel__auto_check/ko';
import { ChatSettingsPanel__automatic_title } from '@/strings/messages/ChatSettingsPanel__automatic_title/ko';
import { ChatSettingsPanel__chat_overrides } from '@/strings/messages/ChatSettingsPanel__chat_overrides/ko';
import { ChatSettingsPanel__chat_settings_take_precedence_over_provider_profiles_which_take_precedence_over_group_settings_which_take_precedence_over_global_settings } from '@/strings/messages/ChatSettingsPanel__chat_settings_take_precedence_over_provider_profiles_which_take_precedence_over_group_settings_which_take_precedence_over_global_settings/ko';
import { ChatSettingsPanel__chat_specific_overrides } from '@/strings/messages/ChatSettingsPanel__chat_specific_overrides/ko';
import { ChatSettingsPanel__chat_system_prompt } from '@/strings/messages/ChatSettingsPanel__chat_system_prompt/ko';
import { ChatSettingsPanel__clear } from '@/strings/messages/ChatSettingsPanel__clear/ko';
import { ChatSettingsPanel__cleared } from '@/strings/messages/ChatSettingsPanel__cleared/ko';
import { ChatSettingsPanel__completely_replaces_global_instructions } from '@/strings/messages/ChatSettingsPanel__completely_replaces_global_instructions/ko';
import { ChatSettingsPanel__configure_how_this_chat_is_automatically_named } from '@/strings/messages/ChatSettingsPanel__configure_how_this_chat_is_automatically_named/ko';
import { ChatSettingsPanel__connection_check_is_automatically_performed_only_for_localhost_urls } from '@/strings/messages/ChatSettingsPanel__connection_check_is_automatically_performed_only_for_localhost_urls/ko';
import { ChatSettingsPanel__custom_http_headers } from '@/strings/messages/ChatSettingsPanel__custom_http_headers/ko';
import { ChatSettingsPanel__disabled } from '@/strings/messages/ChatSettingsPanel__disabled/ko';
import { ChatSettingsPanel__enabled } from '@/strings/messages/ChatSettingsPanel__enabled/ko';
import { ChatSettingsPanel__endpoint_type } from '@/strings/messages/ChatSettingsPanel__endpoint_type/ko';
import { ChatSettingsPanel__endpoint_url } from '@/strings/messages/ChatSettingsPanel__endpoint_url/ko';
import { ChatSettingsPanel__failed_to_save_chat_settings } from '@/strings/messages/ChatSettingsPanel__failed_to_save_chat_settings/ko';
import { ChatSettingsPanel__group_global_default } from '@/strings/messages/ChatSettingsPanel__group_global_default/ko';
import { ChatSettingsPanel__chat_group } from '@/strings/messages/ChatSettingsPanel__chat_group/ko';
import { ChatSettingsPanel__no_prompt } from '@/strings/messages/ChatSettingsPanel__no_prompt/ko';
import { ChatSettingsPanel__system_prompt_chat_group_set } from '@/strings/messages/ChatSettingsPanel__system_prompt_chat_group_set/ko';
import { ChatSettingsPanel__system_prompt_chat_group_not_set } from '@/strings/messages/ChatSettingsPanel__system_prompt_chat_group_not_set/ko';
import { ChatSettingsPanel__system_prompt_no_prompt } from '@/strings/messages/ChatSettingsPanel__system_prompt_no_prompt/ko';
import { ChatSettingsPanel__instructions_for_this_chat } from '@/strings/messages/ChatSettingsPanel__instructions_for_this_chat/ko';
import { ChatSettingsPanel__instructions_to_append } from '@/strings/messages/ChatSettingsPanel__instructions_to_append/ko';
import { ChatSettingsPanel__start_typing_to_override } from '@/strings/messages/ChatSettingsPanel__start_typing_to_override/ko';
import { ChatSettingsPanel__enter_instructions_for_this_chat } from '@/strings/messages/ChatSettingsPanel__enter_instructions_for_this_chat/ko';
import { ChatSettingsPanel__start_typing_to_replace } from '@/strings/messages/ChatSettingsPanel__start_typing_to_replace/ko';
import { ChatSettingsPanel__replace } from '@/strings/messages/ChatSettingsPanel__replace/ko';
import { ChatSettingsPanel__enter_instructions_that_replace_the_parent_setting } from '@/strings/messages/ChatSettingsPanel__enter_instructions_that_replace_the_parent_setting/ko';
import { ChatSettingsPanel__enter_instructions_to_append } from '@/strings/messages/ChatSettingsPanel__enter_instructions_to_append/ko';
import { ChatSettingsPanel__inherit } from '@/strings/messages/ChatSettingsPanel__inherit/ko';
import { ChatSettingsPanel__inherited } from '@/strings/messages/ChatSettingsPanel__inherited/ko';
import { ChatSettingsPanel__inherited_instructions } from '@/strings/messages/ChatSettingsPanel__inherited_instructions/ko';
import { ChatSettingsPanel__load_from_saved_profiles } from '@/strings/messages/ChatSettingsPanel__load_from_saved_profiles/ko';
import { ChatSettingsPanel__local_overrides } from '@/strings/messages/ChatSettingsPanel__local_overrides/ko';
import { ChatSettingsPanel__model_override } from '@/strings/messages/ChatSettingsPanel__model_override/ko';
import { ChatSettingsPanel__name } from '@/strings/messages/ChatSettingsPanel__name/ko';
import { ChatSettingsPanel__no_custom_headers } from '@/strings/messages/ChatSettingsPanel__no_custom_headers/ko';
import { ChatSettingsPanel__no_instructions_inherited } from '@/strings/messages/ChatSettingsPanel__no_instructions_inherited/ko';
import { ChatSettingsPanel__ollama } from '@/strings/messages/ChatSettingsPanel__ollama/ko';
import { ChatSettingsPanel__openai_compatible } from '@/strings/messages/ChatSettingsPanel__openai_compatible/ko';
import { ChatSettingsPanel__override } from '@/strings/messages/ChatSettingsPanel__override/ko';
import { ChatSettingsPanel__overriding } from '@/strings/messages/ChatSettingsPanel__overriding/ko';
import { ChatSettingsPanel__parameters } from '@/strings/messages/ChatSettingsPanel__parameters/ko';
import { ChatSettingsPanel__parent_prompt_cleared } from '@/strings/messages/ChatSettingsPanel__parent_prompt_cleared/ko';
import { ChatSettingsPanel__quick_endpoint_presets } from '@/strings/messages/ChatSettingsPanel__quick_endpoint_presets/ko';
import { ChatSettingsPanel__quick_profile_switcher } from '@/strings/messages/ChatSettingsPanel__quick_profile_switcher/ko';
import { ChatSettingsPanel__restore_defaults } from '@/strings/messages/ChatSettingsPanel__restore_defaults/ko';
import { ChatSettingsPanel__settings_resolution } from '@/strings/messages/ChatSettingsPanel__settings_resolution/ko';
import { ChatSettingsPanel__system_prompt } from '@/strings/messages/ChatSettingsPanel__system_prompt/ko';
import { ChatSettingsPanel__these_settings_only_apply_to_this_chat } from '@/strings/messages/ChatSettingsPanel__these_settings_only_apply_to_this_chat/ko';
import { ChatSettingsPanel__this_chat_will_not_use_any_system_instructions } from '@/strings/messages/ChatSettingsPanel__this_chat_will_not_use_any_system_instructions/ko';
import { ChatSettingsPanel__title_model_explanation } from '@/strings/messages/ChatSettingsPanel__title_model_explanation/ko';
import { ChatSettingsPanel__use_chat_group_setting } from '@/strings/messages/ChatSettingsPanel__use_chat_group_setting/ko';
import { ChatSettingsPanel__title_model_override } from '@/strings/messages/ChatSettingsPanel__title_model_override/ko';
import { ChatSettingsPanel__same_as_chat_endpoint } from '@/strings/messages/ChatSettingsPanel__same_as_chat_endpoint/ko';
import { ChatSettingsPanel__title_endpoint_type } from '@/strings/messages/ChatSettingsPanel__title_endpoint_type/ko';
import { ChatSettingsPanel__transformers_js } from '@/strings/messages/ChatSettingsPanel__transformers_js/ko';
import { ChatSettingsPanel__transformers_js_experimental } from '@/strings/messages/ChatSettingsPanel__transformers_js_experimental/ko';
import { ChatSettingsPanel__value } from '@/strings/messages/ChatSettingsPanel__value/ko';
import { ChatSettingsPanel__title_reasoning } from '@/strings/messages/ChatSettingsPanel__title_reasoning/ko';
import { ChatTitleDialog__chat_override } from '@/strings/messages/ChatTitleDialog__chat_override/ko';
import { ChatTitleDialog__chat_title } from '@/strings/messages/ChatTitleDialog__chat_title/ko';
import { ChatTitleDialog__close } from '@/strings/messages/ChatTitleDialog__close/ko';
import { ChatTitleDialog__edit_the_title_directly_or_generate_a_new_one_from_the_conversation } from '@/strings/messages/ChatTitleDialog__edit_the_title_directly_or_generate_a_new_one_from_the_conversation/ko';
import { ChatTitleDialog__editing_source_because_that_is_the_active_source_for_this_chat } from '@/strings/messages/ChatTitleDialog__editing_source_because_that_is_the_active_source_for_this_chat/ko';
import { ChatTitleDialog__generate } from '@/strings/messages/ChatTitleDialog__generate/ko';
import { ChatTitleDialog__generated_in_this_dialog } from '@/strings/messages/ChatTitleDialog__generated_in_this_dialog/ko';
import { ChatTitleDialog__generated_titles_will_appear_here } from '@/strings/messages/ChatTitleDialog__generated_titles_will_appear_here/ko';
import { ChatTitleDialog__global_default } from '@/strings/messages/ChatTitleDialog__global_default/ko';
import { ChatTitleDialog__group_override } from '@/strings/messages/ChatTitleDialog__group_override/ko';
import { ChatTitleDialog__hide } from '@/strings/messages/ChatTitleDialog__hide/ko';
import { ChatTitleDialog__options_and_history } from '@/strings/messages/ChatTitleDialog__options_and_history/ko';
import { ChatTitleDialog__show } from '@/strings/messages/ChatTitleDialog__show/ko';
import { ChatTitleDialog__stop } from '@/strings/messages/ChatTitleDialog__stop/ko';
import { ChatTitleDialog__title } from '@/strings/messages/ChatTitleDialog__title/ko';
import { ChatTitleDialog__title_model } from '@/strings/messages/ChatTitleDialog__title_model/ko';
import { ChatTitleDialog__use } from '@/strings/messages/ChatTitleDialog__use/ko';
import { ChatTitleDialog__use_chat_model } from '@/strings/messages/ChatTitleDialog__use_chat_model/ko';
import { ChatToolsMenu__close_menu } from '@/strings/messages/ChatToolsMenu__close_menu/ko';
import { ChatToolsMenu__options_tools } from '@/strings/messages/ChatToolsMenu__options_tools/ko';
import { ChatToolsMenu__tools } from '@/strings/messages/ChatToolsMenu__tools/ko';
import { ConnectionTab__add_header } from '@/strings/messages/ConnectionTab__add_header/ko';
import { ConnectionTab__api_provider } from '@/strings/messages/ConnectionTab__api_provider/ko';
import { ConnectionTab__applied_to_all_new_chats } from '@/strings/messages/ConnectionTab__applied_to_all_new_chats/ko';
import { ConnectionTab__auto_title_generation } from '@/strings/messages/ConnectionTab__auto_title_generation/ko';
import { ConnectionTab__check_connection } from '@/strings/messages/ConnectionTab__check_connection/ko';
import { ConnectionTab__connected } from '@/strings/messages/ConnectionTab__connected/ko';
import { ConnectionTab__connection_check_for_localhost_only } from '@/strings/messages/ConnectionTab__connection_check_for_localhost_only/ko';
import { ConnectionTab__copy_setup_url } from '@/strings/messages/ConnectionTab__copy_setup_url/ko';
import { ConnectionTab__copy_url_with_current_settings } from '@/strings/messages/ConnectionTab__copy_url_with_current_settings/ko';
import { ConnectionTab__create } from '@/strings/messages/ConnectionTab__create/ko';
import { ConnectionTab__create_new_profile } from '@/strings/messages/ConnectionTab__create_new_profile/ko';
import { ConnectionTab__custom_http_headers } from '@/strings/messages/ConnectionTab__custom_http_headers/ko';
import { ConnectionTab__default } from '@/strings/messages/ConnectionTab__default/ko';
import { ConnectionTab__default_model } from '@/strings/messages/ConnectionTab__default_model/ko';
import { ConnectionTab__endpoint_configuration } from '@/strings/messages/ConnectionTab__endpoint_configuration/ko';
import { ConnectionTab__endpoint_url } from '@/strings/messages/ConnectionTab__endpoint_url/ko';
import { ConnectionTab__failed_to_save_settings } from '@/strings/messages/ConnectionTab__failed_to_save_settings/ko';
import { ConnectionTab__give_configuration_a_name } from '@/strings/messages/ConnectionTab__give_configuration_a_name/ko';
import { ConnectionTab__global_context_and_parameters } from '@/strings/messages/ConnectionTab__global_context_and_parameters/ko';
import { ConnectionTab__global_system_prompt } from '@/strings/messages/ConnectionTab__global_system_prompt/ko';
import { ConnectionTab__header_name_example } from '@/strings/messages/ConnectionTab__header_name_example/ko';
import { ConnectionTab__helpful_ai_assistant_placeholder } from '@/strings/messages/ConnectionTab__helpful_ai_assistant_placeholder/ko';
import { ConnectionTab__load_saved_profile } from '@/strings/messages/ConnectionTab__load_saved_profile/ko';
import { ConnectionTab__model_selection } from '@/strings/messages/ConnectionTab__model_selection/ko';
import { ConnectionTab__no_custom_headers } from '@/strings/messages/ConnectionTab__no_custom_headers/ko';
import { ConnectionTab__none } from '@/strings/messages/ConnectionTab__none/ko';
import { ConnectionTab__ollama } from '@/strings/messages/ConnectionTab__ollama/ko';
import { ConnectionTab__openai_compatible } from '@/strings/messages/ConnectionTab__openai_compatible/ko';
import { ConnectionTab__profile_created } from '@/strings/messages/ConnectionTab__profile_created/ko';
import { ConnectionTab__quick_profile_switcher } from '@/strings/messages/ConnectionTab__quick_profile_switcher/ko';
import { ConnectionTab__save_as_new_profile } from '@/strings/messages/ConnectionTab__save_as_new_profile/ko';
import { ConnectionTab__save_changes } from '@/strings/messages/ConnectionTab__save_changes/ko';
import { ConnectionTab__save_failed } from '@/strings/messages/ConnectionTab__save_failed/ko';
import { ConnectionTab__settings_saved } from '@/strings/messages/ConnectionTab__settings_saved/ko';
import { ConnectionTab__setup_url_copied } from '@/strings/messages/ConnectionTab__setup_url_copied/ko';
import { ConnectionTab__title_generation_model } from '@/strings/messages/ConnectionTab__title_generation_model/ko';
import { ConnectionTab__transformers_js_experimental } from '@/strings/messages/ConnectionTab__transformers_js_experimental/ko';
import { ConnectionTab__use_current_chat_endpoint } from '@/strings/messages/ConnectionTab__use_current_chat_endpoint/ko';
import { ConnectionTab__title_endpoint } from '@/strings/messages/ConnectionTab__title_endpoint/ko';
import { ConnectionTab__unavailable_in_standalone_due_to_worker_wasm_restrictions } from '@/strings/messages/ConnectionTab__unavailable_in_standalone_due_to_worker_wasm_restrictions/ko';
import { ConnectionTab__understand } from '@/strings/messages/ConnectionTab__understand/ko';
import { ConnectionTab__url_copied } from '@/strings/messages/ConnectionTab__url_copied/ko';
import { ConnectionTab__use_current_chat_model } from '@/strings/messages/ConnectionTab__use_current_chat_model/ko';
import { ConnectionTab__used_for_new_conversations } from '@/strings/messages/ConnectionTab__used_for_new_conversations/ko';
import { ConnectionTab__value } from '@/strings/messages/ConnectionTab__value/ko';
import { ConnectionTab__view_profiles } from '@/strings/messages/ConnectionTab__view_profiles/ko';
import { ConnectionTab__title_reasoning } from '@/strings/messages/ConnectionTab__title_reasoning/ko';
import { ConnectionTab__use_current_chat_reasoning } from '@/strings/messages/ConnectionTab__use_current_chat_reasoning/ko';
import { ContextCompactProgressStrip__abort_compact } from '@/strings/messages/ContextCompactProgressStrip__abort_compact/ko';
import { ContextCompactProgressStrip__hide_request } from '@/strings/messages/ContextCompactProgressStrip__hide_request/ko';
import { ContextCompactProgressStrip__live_output } from '@/strings/messages/ContextCompactProgressStrip__live_output/ko';
import { ContextCompactProgressStrip__show_request } from '@/strings/messages/ContextCompactProgressStrip__show_request/ko';
import { ConversationOutlineOverlay__ai } from '@/strings/messages/ConversationOutlineOverlay__ai/ko';
import { ConversationOutlineOverlay__close_conversation_outline } from '@/strings/messages/ConversationOutlineOverlay__close_conversation_outline/ko';
import { ConversationOutlineOverlay__conversation_outline } from '@/strings/messages/ConversationOutlineOverlay__conversation_outline/ko';
import { ConversationOutlineOverlay__empty_message } from '@/strings/messages/ConversationOutlineOverlay__empty_message/ko';
import { ConversationOutlineOverlay__peek } from '@/strings/messages/ConversationOutlineOverlay__peek/ko';
import { ConversationOutlineOverlay__system } from '@/strings/messages/ConversationOutlineOverlay__system/ko';
import { ConversationOutlineOverlay__tool } from '@/strings/messages/ConversationOutlineOverlay__tool/ko';
import { ConversationOutlineOverlay__you } from '@/strings/messages/ConversationOutlineOverlay__you/ko';
import { CustomDialog__dialog } from '@/strings/messages/CustomDialog__dialog/ko';
import { DebugIndexPage__debug } from '@/strings/messages/DebugIndexPage__debug/ko';
import { DebugIndexPage__debug_tools } from '@/strings/messages/DebugIndexPage__debug_tools/ko';
import { DebugIndexPage__file_protocol_standalone_verification } from '@/strings/messages/DebugIndexPage__file_protocol_standalone_verification/ko';
import { DebugIndexPage__open_an_isolated_diagnostic_page_without_adding_debug_only_behavior_to_the_normal_application_flow } from '@/strings/messages/DebugIndexPage__open_an_isolated_diagnostic_page_without_adding_debug_only_behavior_to_the_normal_application_flow/ko';
import { DebugIndexPage__verify_generated_scripts_routing_lazy_styles_systemjs_recovery_and_the_reusable_worker_factory } from '@/strings/messages/DebugIndexPage__verify_generated_scripts_routing_lazy_styles_systemjs_recovery_and_the_reusable_worker_factory/ko';
import { DebugPanel__application_state_synchronized } from '@/strings/messages/DebugPanel__application_state_synchronized/ko';
import { DebugPanel__clear_logs } from '@/strings/messages/DebugPanel__clear_logs/ko';
import { DebugPanel__close_panel } from '@/strings/messages/DebugPanel__close_panel/ko';
import { DebugPanel__development_tools } from '@/strings/messages/DebugPanel__development_tools/ko';
import { DebugPanel__error_count } from '@/strings/messages/DebugPanel__error_count/ko';
import { DebugPanel__explore_opfs } from '@/strings/messages/DebugPanel__explore_opfs/ko';
import { DebugPanel__intentional_test_error_triggered_by_user } from '@/strings/messages/DebugPanel__intentional_test_error_triggered_by_user/ko';
import { DebugPanel__no_events_recorded } from '@/strings/messages/DebugPanel__no_events_recorded/ko';
import { DebugPanel__system_events } from '@/strings/messages/DebugPanel__system_events/ko';
import { DebugPanel__this_is_used_to_verify_the_error_event_system_ui } from '@/strings/messages/DebugPanel__this_is_used_to_verify_the_error_event_system_ui/ko';
import { DebugPanel__total_count } from '@/strings/messages/DebugPanel__total_count/ko';
import { DebugPanel__trigger_test_error } from '@/strings/messages/DebugPanel__trigger_test_error/ko';
import { DebugPanel__trigger_test_info } from '@/strings/messages/DebugPanel__trigger_test_info/ko';
import { DeveloperOpenStateLinks__choose_data_to_omit } from '@/strings/messages/DeveloperOpenStateLinks__choose_data_to_omit/ko';
import { DeveloperOpenStateLinks__copied_url_for_host } from '@/strings/messages/DeveloperOpenStateLinks__copied_url_for_host/ko';
import { DeveloperOpenStateLinks__copy_url_for_host } from '@/strings/messages/DeveloperOpenStateLinks__copy_url_for_host/ko';
import { DeveloperOpenStateLinks__curated } from '@/strings/messages/DeveloperOpenStateLinks__curated/ko';
import { DeveloperOpenStateLinks__develop_branch } from '@/strings/messages/DeveloperOpenStateLinks__develop_branch/ko';
import { DeveloperOpenStateLinks__exclude_attachments } from '@/strings/messages/DeveloperOpenStateLinks__exclude_attachments/ko';
import { DeveloperOpenStateLinks__exclude_chat_history } from '@/strings/messages/DeveloperOpenStateLinks__exclude_chat_history/ko';
import { DeveloperOpenStateLinks__exclude_chats } from '@/strings/messages/DeveloperOpenStateLinks__exclude_chats/ko';
import { DeveloperOpenStateLinks__excluded_data } from '@/strings/messages/DeveloperOpenStateLinks__excluded_data/ko';
import { DeveloperOpenStateLinks__failed_to_copy_state_url } from '@/strings/messages/DeveloperOpenStateLinks__failed_to_copy_state_url/ko';
import { DeveloperOpenStateLinks__failed_to_open_state_url } from '@/strings/messages/DeveloperOpenStateLinks__failed_to_open_state_url/ko';
import { DeveloperOpenStateLinks__local_only } from '@/strings/messages/DeveloperOpenStateLinks__local_only/ko';
import { DeveloperOpenStateLinks__open_current_state } from '@/strings/messages/DeveloperOpenStateLinks__open_current_state/ko';
import { DeveloperOpenStateLinks__open_host } from '@/strings/messages/DeveloperOpenStateLinks__open_host/ko';
import { DeveloperOpenStateLinks__open_state_description } from '@/strings/messages/DeveloperOpenStateLinks__open_state_description/ko';
import { DeveloperOpenStateLinks__production } from '@/strings/messages/DeveloperOpenStateLinks__production/ko';
import { DeveloperOpenStateLinks__standard } from '@/strings/messages/DeveloperOpenStateLinks__standard/ko';
import { DeveloperOpenStateLinks__state_contents } from '@/strings/messages/DeveloperOpenStateLinks__state_contents/ko';
import { DeveloperTab__clear_all } from '@/strings/messages/DeveloperTab__clear_all/ko';
import { DeveloperTab__clear_all_cache_storage } from '@/strings/messages/DeveloperTab__clear_all_cache_storage/ko';
import { DeveloperTab__clear_cache_storage_warning } from '@/strings/messages/DeveloperTab__clear_cache_storage_warning/ko';
import { DeveloperTab__confirm_data_reset } from '@/strings/messages/DeveloperTab__confirm_data_reset/ko';
import { DeveloperTab__create_long_sample_chat } from '@/strings/messages/DeveloperTab__create_long_sample_chat/ko';
import { DeveloperTab__create_sample_chat } from '@/strings/messages/DeveloperTab__create_sample_chat/ko';
import { DeveloperTab__danger_zone } from '@/strings/messages/DeveloperTab__danger_zone/ko';
import { DeveloperTab__debug_and_testing } from '@/strings/messages/DeveloperTab__debug_and_testing/ko';
import { DeveloperTab__deletes_cache_storage_entries } from '@/strings/messages/DeveloperTab__deletes_cache_storage_entries/ko';
import { DeveloperTab__developer_tools } from '@/strings/messages/DeveloperTab__developer_tools/ko';
import { DeveloperTab__execute_reset } from '@/strings/messages/DeveloperTab__execute_reset/ko';
import { DeveloperTab__experimental_features } from '@/strings/messages/DeveloperTab__experimental_features/ko';
import { DeveloperTab__perform_window_reload } from '@/strings/messages/DeveloperTab__perform_window_reload/ko';
import { DeveloperTab__reload_application } from '@/strings/messages/DeveloperTab__reload_application/ko';
import { DeveloperTab__reset } from '@/strings/messages/DeveloperTab__reset/ko';
import { DeveloperTab__reset_all_app_data_warning } from '@/strings/messages/DeveloperTab__reset_all_app_data_warning/ko';
import { DeveloperTab__reset_all_application_data } from '@/strings/messages/DeveloperTab__reset_all_application_data/ko';
import { DeveloperTab__reset_data_provider_warning } from '@/strings/messages/DeveloperTab__reset_data_provider_warning/ko';
import { DeveloperTab__sample_conversations_description } from '@/strings/messages/DeveloperTab__sample_conversations_description/ko';
import { DeveloperTab__simulate_pwa_update } from '@/strings/messages/DeveloperTab__simulate_pwa_update/ko';
import { DeveloperTab__toggle_update_notification } from '@/strings/messages/DeveloperTab__toggle_update_notification/ko';
import { ExperimentalFeatureRow__details } from '@/strings/messages/ExperimentalFeatureRow__details/ko';
import { ExperimentalFeatureRow__details_for } from '@/strings/messages/ExperimentalFeatureRow__details_for/ko';
import { ExperimentalFeatureRow__disabled } from '@/strings/messages/ExperimentalFeatureRow__disabled/ko';
import { ExperimentalFeatureRow__enabled } from '@/strings/messages/ExperimentalFeatureRow__enabled/ko';
import { FeatureFlagsSettings__cancel } from '@/strings/messages/FeatureFlagsSettings__cancel/ko';
import { FeatureFlagsSettings__disable_fake_lm } from '@/strings/messages/FeatureFlagsSettings__disable_fake_lm/ko';
import { FeatureFlagsSettings__disable_folders } from '@/strings/messages/FeatureFlagsSettings__disable_folders/ko';
import { FeatureFlagsSettings__disable_move_chat_on_send } from '@/strings/messages/FeatureFlagsSettings__disable_move_chat_on_send/ko';
import { FeatureFlagsSettings__disable_shell } from '@/strings/messages/FeatureFlagsSettings__disable_shell/ko';
import { FeatureFlagsSettings__disable_tool_config_persistence } from '@/strings/messages/FeatureFlagsSettings__disable_tool_config_persistence/ko';
import { FeatureFlagsSettings__enable } from '@/strings/messages/FeatureFlagsSettings__enable/ko';
import { FeatureFlagsSettings__enable_experimental_feature } from '@/strings/messages/FeatureFlagsSettings__enable_experimental_feature/ko';
import { FeatureFlagsSettings__enable_fake_lm } from '@/strings/messages/FeatureFlagsSettings__enable_fake_lm/ko';
import { FeatureFlagsSettings__enable_folders } from '@/strings/messages/FeatureFlagsSettings__enable_folders/ko';
import { FeatureFlagsSettings__enable_move_chat_on_send } from '@/strings/messages/FeatureFlagsSettings__enable_move_chat_on_send/ko';
import { FeatureFlagsSettings__enable_shell } from '@/strings/messages/FeatureFlagsSettings__enable_shell/ko';
import { FeatureFlagsSettings__enable_tool_config_persistence } from '@/strings/messages/FeatureFlagsSettings__enable_tool_config_persistence/ko';
import { FeatureFlagsSettings__experimental_feature_warning } from '@/strings/messages/FeatureFlagsSettings__experimental_feature_warning/ko';
import { FeatureFlagsSettings__fake_lm_debug_mode } from '@/strings/messages/FeatureFlagsSettings__fake_lm_debug_mode/ko';
import { FeatureFlagsSettings__features_may_change } from '@/strings/messages/FeatureFlagsSettings__features_may_change/ko';
import { FeatureFlagsSettings__folders } from '@/strings/messages/FeatureFlagsSettings__folders/ko';
import { FeatureFlagsSettings__folders_disabled_details } from '@/strings/messages/FeatureFlagsSettings__folders_disabled_details/ko';
import { FeatureFlagsSettings__folders_enabled_details } from '@/strings/messages/FeatureFlagsSettings__folders_enabled_details/ko';
import { FeatureFlagsSettings__hosted_build_only } from '@/strings/messages/FeatureFlagsSettings__hosted_build_only/ko';
import { FeatureFlagsSettings__move_chat_disabled_details } from '@/strings/messages/FeatureFlagsSettings__move_chat_disabled_details/ko';
import { FeatureFlagsSettings__move_chat_enabled_details } from '@/strings/messages/FeatureFlagsSettings__move_chat_enabled_details/ko';
import { FeatureFlagsSettings__move_chat_on_send } from '@/strings/messages/FeatureFlagsSettings__move_chat_on_send/ko';
import { FeatureFlagsSettings__moves_active_chat_after_send } from '@/strings/messages/FeatureFlagsSettings__moves_active_chat_after_send/ko';
import { FeatureFlagsSettings__saves_tool_settings } from '@/strings/messages/FeatureFlagsSettings__saves_tool_settings/ko';
import { FeatureFlagsSettings__shell_disabled_details } from '@/strings/messages/FeatureFlagsSettings__shell_disabled_details/ko';
import { FeatureFlagsSettings__shell_enabled_details } from '@/strings/messages/FeatureFlagsSettings__shell_enabled_details/ko';
import { FeatureFlagsSettings__shell_in_browser } from '@/strings/messages/FeatureFlagsSettings__shell_in_browser/ko';
import { FeatureFlagsSettings__shows_folders_tab } from '@/strings/messages/FeatureFlagsSettings__shows_folders_tab/ko';
import { FeatureFlagsSettings__shows_shell_in_chat_tools } from '@/strings/messages/FeatureFlagsSettings__shows_shell_in_chat_tools/ko';
import { FeatureFlagsSettings__tool_config_persistence } from '@/strings/messages/FeatureFlagsSettings__tool_config_persistence/ko';
import { FeatureFlagsSettings__tool_persistence_disabled_details } from '@/strings/messages/FeatureFlagsSettings__tool_persistence_disabled_details/ko';
import { FeatureFlagsSettings__tool_persistence_enabled_details } from '@/strings/messages/FeatureFlagsSettings__tool_persistence_enabled_details/ko';
import { FeatureFlagsSettings__use_fake_lm_endpoint } from '@/strings/messages/FeatureFlagsSettings__use_fake_lm_endpoint/ko';
import { FeatureFlagsSettings__uses_bundled_fake_lm } from '@/strings/messages/FeatureFlagsSettings__uses_bundled_fake_lm/ko';
import { GlobalSearchModal__all } from '@/strings/messages/GlobalSearchModal__all/ko';
import { GlobalSearchModal__alt_branch } from '@/strings/messages/GlobalSearchModal__alt_branch/ko';
import { GlobalSearchModal__assistant } from '@/strings/messages/GlobalSearchModal__assistant/ko';
import { GlobalSearchModal__chat } from '@/strings/messages/GlobalSearchModal__chat/ko';
import { GlobalSearchModal__chat_count } from '@/strings/messages/GlobalSearchModal__chat_count/ko';
import { GlobalSearchModal__chats_found } from '@/strings/messages/GlobalSearchModal__chats_found/ko';
import { GlobalSearchModal__clear_all_filters } from '@/strings/messages/GlobalSearchModal__clear_all_filters/ko';
import { GlobalSearchModal__context } from '@/strings/messages/GlobalSearchModal__context/ko';
import { GlobalSearchModal__current_thread } from '@/strings/messages/GlobalSearchModal__current_thread/ko';
import { GlobalSearchModal__filter_by_group } from '@/strings/messages/GlobalSearchModal__filter_by_group/ko';
import { GlobalSearchModal__filtered_chat } from '@/strings/messages/GlobalSearchModal__filtered_chat/ko';
import { GlobalSearchModal__full } from '@/strings/messages/GlobalSearchModal__full/ko';
import { GlobalSearchModal__groups } from '@/strings/messages/GlobalSearchModal__groups/ko';
import { GlobalSearchModal__navigate } from '@/strings/messages/GlobalSearchModal__navigate/ko';
import { GlobalSearchModal__no_groups_available } from '@/strings/messages/GlobalSearchModal__no_groups_available/ko';
import { GlobalSearchModal__no_results_for } from '@/strings/messages/GlobalSearchModal__no_results_for/ko';
import { GlobalSearchModal__off } from '@/strings/messages/GlobalSearchModal__off/ko';
import { GlobalSearchModal__on } from '@/strings/messages/GlobalSearchModal__on/ko';
import { GlobalSearchModal__peek } from '@/strings/messages/GlobalSearchModal__peek/ko';
import { GlobalSearchModal__preview } from '@/strings/messages/GlobalSearchModal__preview/ko';
import { GlobalSearchModal__role } from '@/strings/messages/GlobalSearchModal__role/ko';
import { GlobalSearchModal__scanning_content } from '@/strings/messages/GlobalSearchModal__scanning_content/ko';
import { GlobalSearchModal__search } from '@/strings/messages/GlobalSearchModal__search/ko';
import { GlobalSearchModal__search_chats_and_messages } from '@/strings/messages/GlobalSearchModal__search_chats_and_messages/ko';
import { GlobalSearchModal__select } from '@/strings/messages/GlobalSearchModal__select/ko';
import { GlobalSearchModal__title_only } from '@/strings/messages/GlobalSearchModal__title_only/ko';
import { GlobalSearchModal__total_matches } from '@/strings/messages/GlobalSearchModal__total_matches/ko';
import { GlobalSearchModal__type_to_search } from '@/strings/messages/GlobalSearchModal__type_to_search/ko';
import { GlobalSearchModal__user } from '@/strings/messages/GlobalSearchModal__user/ko';
import { GlobalToolsSettings__global_settings } from '@/strings/messages/GlobalToolsSettings__global_settings/ko';
import { GlobalToolsSettings__tool_defaults_can_be_overridden } from '@/strings/messages/GlobalToolsSettings__tool_defaults_can_be_overridden/ko';
import { GlobalToolsSettings__tools } from '@/strings/messages/GlobalToolsSettings__tools/ko';
import { HistoryManipulationModal__add_first_message } from '@/strings/messages/HistoryManipulationModal__add_first_message/ko';
import { HistoryManipulationModal__add_message_after } from '@/strings/messages/HistoryManipulationModal__add_message_after/ko';
import { HistoryManipulationModal__append_message } from '@/strings/messages/HistoryManipulationModal__append_message/ko';
import { HistoryManipulationModal__apply_changes } from '@/strings/messages/HistoryManipulationModal__apply_changes/ko';
import { HistoryManipulationModal__applying_changes_creates_a } from '@/strings/messages/HistoryManipulationModal__applying_changes_creates_a/ko';
import { HistoryManipulationModal__attach_media } from '@/strings/messages/HistoryManipulationModal__attach_media/ko';
import { HistoryManipulationModal__chat_system_prompt } from '@/strings/messages/HistoryManipulationModal__chat_system_prompt/ko';
import { HistoryManipulationModal__copy_message } from '@/strings/messages/HistoryManipulationModal__copy_message/ko';
import { HistoryManipulationModal__discard } from '@/strings/messages/HistoryManipulationModal__discard/ko';
import { HistoryManipulationModal__enter_system_prompt_content } from '@/strings/messages/HistoryManipulationModal__enter_system_prompt_content/ko';
import { HistoryManipulationModal__forge_empty_history } from '@/strings/messages/HistoryManipulationModal__forge_empty_history/ko';
import { HistoryManipulationModal__from_the_root_the_original_conversation_remains_preserved } from '@/strings/messages/HistoryManipulationModal__from_the_root_the_original_conversation_remains_preserved/ko';
import { HistoryManipulationModal__inherited } from '@/strings/messages/HistoryManipulationModal__inherited/ko';
import { HistoryManipulationModal__manipulate_full_chat_history_a_new_branch_will_be_created } from '@/strings/messages/HistoryManipulationModal__manipulate_full_chat_history_a_new_branch_will_be_created/ko';
import { HistoryManipulationModal__message_list } from '@/strings/messages/HistoryManipulationModal__message_list/ko';
import { HistoryManipulationModal__new_branch } from '@/strings/messages/HistoryManipulationModal__new_branch/ko';
import { HistoryManipulationModal__no_system_prompt_inherited } from '@/strings/messages/HistoryManipulationModal__no_system_prompt_inherited/ko';
import { HistoryManipulationModal__parent_prompt_cleared } from '@/strings/messages/HistoryManipulationModal__parent_prompt_cleared/ko';
import { HistoryManipulationModal__remove_message } from '@/strings/messages/HistoryManipulationModal__remove_message/ko';
import { HistoryManipulationModal__super_edit } from '@/strings/messages/HistoryManipulationModal__super_edit/ko';
import { HistoryManipulationModal__switch_role } from '@/strings/messages/HistoryManipulationModal__switch_role/ko';
import { HistoryManipulationModal__system_prompt_resolution } from '@/strings/messages/HistoryManipulationModal__system_prompt_resolution/ko';
import { HistoryManipulationModal__this_chat_will_not_use_any_system_instructions } from '@/strings/messages/HistoryManipulationModal__this_chat_will_not_use_any_system_instructions/ko';
import { HistoryManipulationModal__thoughts } from '@/strings/messages/HistoryManipulationModal__thoughts/ko';
import { HistoryManipulationModal__type_message_content } from '@/strings/messages/HistoryManipulationModal__type_message_content/ko';
import { ImageConjuringLoader__generating_image } from '@/strings/messages/ImageConjuringLoader__generating_image/ko';
import { ImageConjuringLoader__generating_images } from '@/strings/messages/ImageConjuringLoader__generating_images/ko';
import { ImageConjuringLoader__image_count } from '@/strings/messages/ImageConjuringLoader__image_count/ko';
import { ImageConjuringLoader__steps } from '@/strings/messages/ImageConjuringLoader__steps/ko';
import { ImageDownloadButton__download_image } from '@/strings/messages/ImageDownloadButton__download_image/ko';
import { ImageDownloadButton__embed_prompt_seed_etc } from '@/strings/messages/ImageDownloadButton__embed_prompt_seed_etc/ko';
import { ImageDownloadButton__more_options } from '@/strings/messages/ImageDownloadButton__more_options/ko';
import { ImageDownloadButton__not_supported_for_this_format } from '@/strings/messages/ImageDownloadButton__not_supported_for_this_format/ko';
import { ImageDownloadButton__with_metadata } from '@/strings/messages/ImageDownloadButton__with_metadata/ko';
import { ImageEditor__apply_resize } from '@/strings/messages/ImageEditor__apply_resize/ko';
import { ImageEditor__black } from '@/strings/messages/ImageEditor__black/ko';
import { ImageEditor__close } from '@/strings/messages/ImageEditor__close/ko';
import { ImageEditor__close_and_discard_unsaved_changes } from '@/strings/messages/ImageEditor__close_and_discard_unsaved_changes/ko';
import { ImageEditor__crop } from '@/strings/messages/ImageEditor__crop/ko';
import { ImageEditor__crop_to_selection } from '@/strings/messages/ImageEditor__crop_to_selection/ko';
import { ImageEditor__discard } from '@/strings/messages/ImageEditor__discard/ko';
import { ImageEditor__discard_changes } from '@/strings/messages/ImageEditor__discard_changes/ko';
import { ImageEditor__elliptical_selection } from '@/strings/messages/ImageEditor__elliptical_selection/ko';
import { ImageEditor__fill_everything_outside_selection } from '@/strings/messages/ImageEditor__fill_everything_outside_selection/ko';
import { ImageEditor__fill_selection_area } from '@/strings/messages/ImageEditor__fill_selection_area/ko';
import { ImageEditor__finish } from '@/strings/messages/ImageEditor__finish/ko';
import { ImageEditor__flip_horizontal } from '@/strings/messages/ImageEditor__flip_horizontal/ko';
import { ImageEditor__flip_vertical } from '@/strings/messages/ImageEditor__flip_vertical/ko';
import { ImageEditor__free_resizing } from '@/strings/messages/ImageEditor__free_resizing/ko';
import { ImageEditor__image_editor } from '@/strings/messages/ImageEditor__image_editor/ko';
import { ImageEditor__maintain_aspect_ratio } from '@/strings/messages/ImageEditor__maintain_aspect_ratio/ko';
import { ImageEditor__mask_in } from '@/strings/messages/ImageEditor__mask_in/ko';
import { ImageEditor__mask_out } from '@/strings/messages/ImageEditor__mask_out/ko';
import { ImageEditor__original } from '@/strings/messages/ImageEditor__original/ko';
import { ImageEditor__output_format } from '@/strings/messages/ImageEditor__output_format/ko';
import { ImageEditor__pick_color_from_canvas } from '@/strings/messages/ImageEditor__pick_color_from_canvas/ko';
import { ImageEditor__recent } from '@/strings/messages/ImageEditor__recent/ko';
import { ImageEditor__rectangular_selection } from '@/strings/messages/ImageEditor__rectangular_selection/ko';
import { ImageEditor__redo } from '@/strings/messages/ImageEditor__redo/ko';
import { ImageEditor__reset } from '@/strings/messages/ImageEditor__reset/ko';
import { ImageEditor__reset_image } from '@/strings/messages/ImageEditor__reset_image/ko';
import { ImageEditor__reset_zoom } from '@/strings/messages/ImageEditor__reset_zoom/ko';
import { ImageEditor__resize_px } from '@/strings/messages/ImageEditor__resize_px/ko';
import { ImageEditor__rotate_left } from '@/strings/messages/ImageEditor__rotate_left/ko';
import { ImageEditor__rotate_right } from '@/strings/messages/ImageEditor__rotate_right/ko';
import { ImageEditor__selection } from '@/strings/messages/ImageEditor__selection/ko';
import { ImageEditor__toggle_tools_sidebar } from '@/strings/messages/ImageEditor__toggle_tools_sidebar/ko';
import { ImageEditor__tools } from '@/strings/messages/ImageEditor__tools/ko';
import { ImageEditor__transform } from '@/strings/messages/ImageEditor__transform/ko';
import { ImageEditor__transparent } from '@/strings/messages/ImageEditor__transparent/ko';
import { ImageEditor__undo } from '@/strings/messages/ImageEditor__undo/ko';
import { ImageEditor__wheel_to_zoom_middle_click_or_alt_plus_drag_to_pan } from '@/strings/messages/ImageEditor__wheel_to_zoom_middle_click_or_alt_plus_drag_to_pan/ko';
import { ImageEditor__white } from '@/strings/messages/ImageEditor__white/ko';
import { ImageEditor__zoom } from '@/strings/messages/ImageEditor__zoom/ko';
import { ImageEditor__zoom_in } from '@/strings/messages/ImageEditor__zoom_in/ko';
import { ImageEditor__zoom_out } from '@/strings/messages/ImageEditor__zoom_out/ko';
import { ImageGenerationSettings__auto } from '@/strings/messages/ImageGenerationSettings__auto/ko';
import { ImageGenerationSettings__click_to_enter_specific_seed } from '@/strings/messages/ImageGenerationSettings__click_to_enter_specific_seed/ko';
import { ImageGenerationSettings__create_image_experimental } from '@/strings/messages/ImageGenerationSettings__create_image_experimental/ko';
import { ImageGenerationSettings__explicitly_generate_random_seed_in_browser_for_each_image } from '@/strings/messages/ImageGenerationSettings__explicitly_generate_random_seed_in_browser_for_each_image/ko';
import { ImageGenerationSettings__height } from '@/strings/messages/ImageGenerationSettings__height/ko';
import { ImageGenerationSettings__image_model } from '@/strings/messages/ImageGenerationSettings__image_model/ko';
import { ImageGenerationSettings__jpeg } from '@/strings/messages/ImageGenerationSettings__jpeg/ko';
import { ImageGenerationSettings__no_tools_available_for_this_provider } from '@/strings/messages/ImageGenerationSettings__no_tools_available_for_this_provider/ko';
import { ImageGenerationSettings__number_of_images } from '@/strings/messages/ImageGenerationSettings__number_of_images/ko';
import { ImageGenerationSettings__original } from '@/strings/messages/ImageGenerationSettings__original/ko';
import { ImageGenerationSettings__png } from '@/strings/messages/ImageGenerationSettings__png/ko';
import { ImageGenerationSettings__qty } from '@/strings/messages/ImageGenerationSettings__qty/ko';
import { ImageGenerationSettings__resolution } from '@/strings/messages/ImageGenerationSettings__resolution/ko';
import { ImageGenerationSettings__save_format } from '@/strings/messages/ImageGenerationSettings__save_format/ko';
import { ImageGenerationSettings__seed } from '@/strings/messages/ImageGenerationSettings__seed/ko';
import { ImageGenerationSettings__select_image_model } from '@/strings/messages/ImageGenerationSettings__select_image_model/ko';
import { ImageGenerationSettings__steps } from '@/strings/messages/ImageGenerationSettings__steps/ko';
import { ImageGenerationSettings__swap_width_and_height } from '@/strings/messages/ImageGenerationSettings__swap_width_and_height/ko';
import { ImageGenerationSettings__webp } from '@/strings/messages/ImageGenerationSettings__webp/ko';
import { ImageGenerationSettings__width } from '@/strings/messages/ImageGenerationSettings__width/ko';
import { ImageInfoDisplay__copy_prompt } from '@/strings/messages/ImageInfoDisplay__copy_prompt/ko';
import { ImageInfoDisplay__copy_seed } from '@/strings/messages/ImageInfoDisplay__copy_seed/ko';
import { ImageInfoDisplay__image_info } from '@/strings/messages/ImageInfoDisplay__image_info/ko';
import { ImageInfoDisplay__prompt } from '@/strings/messages/ImageInfoDisplay__prompt/ko';
import { ImageInfoDisplay__seed } from '@/strings/messages/ImageInfoDisplay__seed/ko';
import { ImageInfoDisplay__size } from '@/strings/messages/ImageInfoDisplay__size/ko';
import { ImageInfoDisplay__steps } from '@/strings/messages/ImageInfoDisplay__steps/ko';
import { ImportExportModal__add_new } from '@/strings/messages/ImportExportModal__add_new/ko';
import { ImportExportModal__analyzing_file } from '@/strings/messages/ImportExportModal__analyzing_file/ko';
import { ImportExportModal__append_keeps_current_data } from '@/strings/messages/ImportExportModal__append_keeps_current_data/ko';
import { ImportExportModal__append_merge } from '@/strings/messages/ImportExportModal__append_merge/ko';
import { ImportExportModal__append_preset } from '@/strings/messages/ImportExportModal__append_preset/ko';
import { ImportExportModal__back } from '@/strings/messages/ImportExportModal__back/ko';
import { ImportExportModal__back_to_menu } from '@/strings/messages/ImportExportModal__back_to_menu/ko';
import { ImportExportModal__cancel } from '@/strings/messages/ImportExportModal__cancel/ko';
import { ImportExportModal__chat_count } from '@/strings/messages/ImportExportModal__chat_count/ko';
import { ImportExportModal__chat_title_prefix } from '@/strings/messages/ImportExportModal__chat_title_prefix/ko';
import { ImportExportModal__chats } from '@/strings/messages/ImportExportModal__chats/ko';
import { ImportExportModal__compressing_data } from '@/strings/messages/ImportExportModal__compressing_data/ko';
import { ImportExportModal__content_preview } from '@/strings/messages/ImportExportModal__content_preview/ko';
import { ImportExportModal__custom_click_to_reset } from '@/strings/messages/ImportExportModal__custom_click_to_reset/ko';
import { ImportExportModal__default_marker } from '@/strings/messages/ImportExportModal__default_marker/ko';
import { ImportExportModal__default_model } from '@/strings/messages/ImportExportModal__default_model/ko';
import { ImportExportModal__download_full_backup } from '@/strings/messages/ImportExportModal__download_full_backup/ko';
import { ImportExportModal__error } from '@/strings/messages/ImportExportModal__error/ko';
import { ImportExportModal__exclude_attachments } from '@/strings/messages/ImportExportModal__exclude_attachments/ko';
import { ImportExportModal__exclude_chat_history } from '@/strings/messages/ImportExportModal__exclude_chat_history/ko';
import { ImportExportModal__exclude_chats } from '@/strings/messages/ImportExportModal__exclude_chats/ko';
import { ImportExportModal__experimental } from '@/strings/messages/ImportExportModal__experimental/ko';
import { ImportExportModal__export } from '@/strings/messages/ImportExportModal__export/ko';
import { ImportExportModal__export_failed } from '@/strings/messages/ImportExportModal__export_failed/ko';
import { ImportExportModal__export_now } from '@/strings/messages/ImportExportModal__export_now/ko';
import { ImportExportModal__export_successful } from '@/strings/messages/ImportExportModal__export_successful/ko';
import { ImportExportModal__failed_to_analyze_file } from '@/strings/messages/ImportExportModal__failed_to_analyze_file/ko';
import { ImportExportModal__filename_tag_example } from '@/strings/messages/ImportExportModal__filename_tag_example/ko';
import { ImportExportModal__filename_tag_optional } from '@/strings/messages/ImportExportModal__filename_tag_optional/ko';
import { ImportExportModal__files } from '@/strings/messages/ImportExportModal__files/ko';
import { ImportExportModal__global_system_prompt } from '@/strings/messages/ImportExportModal__global_system_prompt/ko';
import { ImportExportModal__group_name_prefix } from '@/strings/messages/ImportExportModal__group_name_prefix/ko';
import { ImportExportModal__groups } from '@/strings/messages/ImportExportModal__groups/ko';
import { ImportExportModal__ignore } from '@/strings/messages/ImportExportModal__ignore/ko';
import { ImportExportModal__import } from '@/strings/messages/ImportExportModal__import/ko';
import { ImportExportModal__import_export } from '@/strings/messages/ImportExportModal__import_export/ko';
import { ImportExportModal__import_failed } from '@/strings/messages/ImportExportModal__import_failed/ko';
import { ImportExportModal__import_successful } from '@/strings/messages/ImportExportModal__import_successful/ko';
import { ImportExportModal__importing_data } from '@/strings/messages/ImportExportModal__importing_data/ko';
import { ImportExportModal__keep_current } from '@/strings/messages/ImportExportModal__keep_current/ko';
import { ImportExportModal__lm_parameters } from '@/strings/messages/ImportExportModal__lm_parameters/ko';
import { ImportExportModal__mode_and_data_strategy } from '@/strings/messages/ImportExportModal__mode_and_data_strategy/ko';
import { ImportExportModal__next } from '@/strings/messages/ImportExportModal__next/ko';
import { ImportExportModal__no_settings_or_profiles } from '@/strings/messages/ImportExportModal__no_settings_or_profiles/ko';
import { ImportExportModal__output_filename } from '@/strings/messages/ImportExportModal__output_filename/ko';
import { ImportExportModal__overwrite } from '@/strings/messages/ImportExportModal__overwrite/ko';
import { ImportExportModal__portable_data } from '@/strings/messages/ImportExportModal__portable_data/ko';
import { ImportExportModal__profiles } from '@/strings/messages/ImportExportModal__profiles/ko';
import { ImportExportModal__provider_profiles } from '@/strings/messages/ImportExportModal__provider_profiles/ko';
import { ImportExportModal__ready_to_export } from '@/strings/messages/ImportExportModal__ready_to_export/ko';
import { ImportExportModal__replace_clears_current_data } from '@/strings/messages/ImportExportModal__replace_clears_current_data/ko';
import { ImportExportModal__replace_restore } from '@/strings/messages/ImportExportModal__replace_restore/ko';
import { ImportExportModal__restore_preset } from '@/strings/messages/ImportExportModal__restore_preset/ko';
import { ImportExportModal__settings_and_profiles } from '@/strings/messages/ImportExportModal__settings_and_profiles/ko';
import { ImportExportModal__title_generation_model } from '@/strings/messages/ImportExportModal__title_generation_model/ko';
import { ImportExportModal__untitled_chat } from '@/strings/messages/ImportExportModal__untitled_chat/ko';
import { ImportExportModal__upload_backup_to_restore_or_merge } from '@/strings/messages/ImportExportModal__upload_backup_to_restore_or_merge/ko';
import { ImportExportModal__url_and_http_headers } from '@/strings/messages/ImportExportModal__url_and_http_headers/ko';
import { ImportExportModal__verifying_integrity } from '@/strings/messages/ImportExportModal__verifying_integrity/ko';
import { ImportExportModal__zip_contains_all_data_by_default } from '@/strings/messages/ImportExportModal__zip_contains_all_data_by_default/ko';
import { ImportExportService__export_dump_failed } from '@/strings/messages/ImportExportService__export_dump_failed/ko';
import { ImportExportService__invalid_zip_file } from '@/strings/messages/ImportExportService__invalid_zip_file/ko';
import { LanguageSelector__language } from '@/strings/messages/LanguageSelector__language/ko';
import { LmParametersEditor__default } from '@/strings/messages/LmParametersEditor__default/ko';
import { LmParametersEditor__empty_fields_use_provider_defaults } from '@/strings/messages/LmParametersEditor__empty_fields_use_provider_defaults/ko';
import { LmParametersEditor__invalid_json } from '@/strings/messages/LmParametersEditor__invalid_json/ko';
import { LmParametersEditor__lm_parameters } from '@/strings/messages/LmParametersEditor__lm_parameters/ko';
import { LmParametersEditor__max_tokens } from '@/strings/messages/LmParametersEditor__max_tokens/ko';
import { LmParametersEditor__must_be_an_array_of_strings } from '@/strings/messages/LmParametersEditor__must_be_an_array_of_strings/ko';
import { LmParametersEditor__presence_penalty } from '@/strings/messages/LmParametersEditor__presence_penalty/ko';
import { LmParametersEditor__reset_all } from '@/strings/messages/LmParametersEditor__reset_all/ko';
import { LmParametersEditor__reset_to_default } from '@/strings/messages/LmParametersEditor__reset_to_default/ko';
import { LmParametersEditor__stop_sequences_json_array } from '@/strings/messages/LmParametersEditor__stop_sequences_json_array/ko';
import { LmParametersEditor__temperature } from '@/strings/messages/LmParametersEditor__temperature/ko';
import { LmParametersEditor__top_p } from '@/strings/messages/LmParametersEditor__top_p/ko';
import { LmToolsSettings__changes_apply_to_this_browser_session_only_while_tool_config_persistence_is_disabled } from '@/strings/messages/LmToolsSettings__changes_apply_to_this_browser_session_only_while_tool_config_persistence_is_disabled/ko';
import { LmToolsSettings__failed_to_save_chat_tool_settings } from '@/strings/messages/LmToolsSettings__failed_to_save_chat_tool_settings/ko';
import { Logo__naidan_logo } from '@/strings/messages/Logo__naidan_logo/ko';
import { MessageActions__compare_versions } from '@/strings/messages/MessageActions__compare_versions/ko';
import { MessageActions__copied } from '@/strings/messages/MessageActions__copied/ko';
import { MessageActions__copy_link } from '@/strings/messages/MessageActions__copy_link/ko';
import { MessageActions__copy_message } from '@/strings/messages/MessageActions__copy_message/ko';
import { MessageActions__copy_raw } from '@/strings/messages/MessageActions__copy_raw/ko';
import { MessageActions__edit_message } from '@/strings/messages/MessageActions__edit_message/ko';
import { MessageActions__failed_to_copy_message_link } from '@/strings/messages/MessageActions__failed_to_copy_message_link/ko';
import { MessageActions__fork_chat } from '@/strings/messages/MessageActions__fork_chat/ko';
import { MessageActions__message_link_copied } from '@/strings/messages/MessageActions__message_link_copied/ko';
import { MessageActions__more_actions } from '@/strings/messages/MessageActions__more_actions/ko';
import { MessageActions__more_message_tools } from '@/strings/messages/MessageActions__more_message_tools/ko';
import { MessageActions__regenerate_response } from '@/strings/messages/MessageActions__regenerate_response/ko';
import { MessageActions__resend_message } from '@/strings/messages/MessageActions__resend_message/ko';
import { MessageDiffModal__base } from '@/strings/messages/MessageDiffModal__base/ko';
import { MessageDiffModal__comparing_base_version } from '@/strings/messages/MessageDiffModal__comparing_base_version/ko';
import { MessageDiffModal__copied } from '@/strings/messages/MessageDiffModal__copied/ko';
import { MessageDiffModal__copy_result } from '@/strings/messages/MessageDiffModal__copy_result/ko';
import { MessageDiffModal__copy_this_version } from '@/strings/messages/MessageDiffModal__copy_this_version/ko';
import { MessageDiffModal__diff_on } from '@/strings/messages/MessageDiffModal__diff_on/ko';
import { MessageDiffModal__exclude_from_diff } from '@/strings/messages/MessageDiffModal__exclude_from_diff/ko';
import { MessageDiffModal__include } from '@/strings/messages/MessageDiffModal__include/ko';
import { MessageDiffModal__include_in_diff } from '@/strings/messages/MessageDiffModal__include_in_diff/ko';
import { MessageDiffModal__loading_more_versions } from '@/strings/messages/MessageDiffModal__loading_more_versions/ko';
import { MessageDiffModal__message_history_and_compare } from '@/strings/messages/MessageDiffModal__message_history_and_compare/ko';
import { MessageDiffModal__off } from '@/strings/messages/MessageDiffModal__off/ko';
import { MessageDiffModal__reset_selection } from '@/strings/messages/MessageDiffModal__reset_selection/ko';
import { MessageDiffModal__select_versions_to_compare_differences } from '@/strings/messages/MessageDiffModal__select_versions_to_compare_differences/ko';
import { MessageDiffModal__skip } from '@/strings/messages/MessageDiffModal__skip/ko';
import { MessageDiffModal__target } from '@/strings/messages/MessageDiffModal__target/ko';
import { MessageDiffModal__target_version } from '@/strings/messages/MessageDiffModal__target_version/ko';
import { MessageItem__cancel } from '@/strings/messages/MessageItem__cancel/ko';
import { MessageItem__clear } from '@/strings/messages/MessageItem__clear/ko';
import { MessageItem__clear_all_text } from '@/strings/messages/MessageItem__clear_all_text/ko';
import { MessageItem__download_image } from '@/strings/messages/MessageItem__download_image/ko';
import { MessageItem__generation_failed } from '@/strings/messages/MessageItem__generation_failed/ko';
import { MessageItem__high } from '@/strings/messages/MessageItem__high/ko';
import { MessageItem__image_generated } from '@/strings/messages/MessageItem__image_generated/ko';
import { MessageItem__image_missing } from '@/strings/messages/MessageItem__image_missing/ko';
import { MessageItem__low } from '@/strings/messages/MessageItem__low/ko';
import { MessageItem__medium } from '@/strings/messages/MessageItem__medium/ko';
import { MessageItem__more_message_tools } from '@/strings/messages/MessageItem__more_message_tools/ko';
import { MessageItem__off } from '@/strings/messages/MessageItem__off/ko';
import { MessageItem__open_advanced_editor } from '@/strings/messages/MessageItem__open_advanced_editor/ko';
import { MessageItem__options_tools } from '@/strings/messages/MessageItem__options_tools/ko';
import { MessageItem__retry } from '@/strings/messages/MessageItem__retry/ko';
import { MessageItem__send_and_branch } from '@/strings/messages/MessageItem__send_and_branch/ko';
import { MessageItem__stop_generation } from '@/strings/messages/MessageItem__stop_generation/ko';
import { MessageItem__think } from '@/strings/messages/MessageItem__think/ko';
import { MessageItem__think_disabled } from '@/strings/messages/MessageItem__think_disabled/ko';
import { MessageItem__think_effort_note } from '@/strings/messages/MessageItem__think_effort_note/ko';
import { MessageItem__tools } from '@/strings/messages/MessageItem__tools/ko';
import { MessageItem__update_and_branch } from '@/strings/messages/MessageItem__update_and_branch/ko';
import { MessageItem__you } from '@/strings/messages/MessageItem__you/ko';
import { MessageThinking__hide_thought_process } from '@/strings/messages/MessageThinking__hide_thought_process/ko';
import { MessageThinking__show_thought_process } from '@/strings/messages/MessageThinking__show_thought_process/ko';
import { MessageThinking__thinking } from '@/strings/messages/MessageThinking__thinking/ko';
import { MessageThinking__thought_process } from '@/strings/messages/MessageThinking__thought_process/ko';
import { ModelSelector__filter_models } from '@/strings/messages/ModelSelector__filter_models/ko';
import { ModelSelector__inherit } from '@/strings/messages/ModelSelector__inherit/ko';
import { ModelSelector__no_models_found } from '@/strings/messages/ModelSelector__no_models_found/ko';
import { ModelSelector__refresh_model_list } from '@/strings/messages/ModelSelector__refresh_model_list/ko';
import { ModelSelector__select_a_model } from '@/strings/messages/ModelSelector__select_a_model/ko';
import { MountBadgeList__browse_path } from '@/strings/messages/MountBadgeList__browse_path/ko';
import { MountBadgeList__read_and_write_click_to_restrict } from '@/strings/messages/MountBadgeList__read_and_write_click_to_restrict/ko';
import { MountBadgeList__read_only_click_to_allow_write } from '@/strings/messages/MountBadgeList__read_only_click_to_allow_write/ko';
import { MountBadgeList__remove } from '@/strings/messages/MountBadgeList__remove/ko';
import { OllamaManagementView__ollama_runtime } from '@/strings/messages/OllamaManagementView__ollama_runtime/ko';
import { OllamaManagementView__view_and_unload_models_currently_held_in_memory_by_this_ollama_server } from '@/strings/messages/OllamaManagementView__view_and_unload_models_currently_held_in_memory_by_this_ollama_server/ko';
import { OllamaPsView__checking } from '@/strings/messages/OllamaPsView__checking/ko';
import { OllamaPsView__context_length } from '@/strings/messages/OllamaPsView__context_length/ko';
import { OllamaPsView__could_not_load_running_models } from '@/strings/messages/OllamaPsView__could_not_load_running_models/ko';
import { OllamaPsView__digest } from '@/strings/messages/OllamaPsView__digest/ko';
import { OllamaPsView__enter_an_ollama_endpoint_url_to_view_running_models } from '@/strings/messages/OllamaPsView__enter_an_ollama_endpoint_url_to_view_running_models/ko';
import { OllamaPsView__expires_at } from '@/strings/messages/OllamaPsView__expires_at/ko';
import { OllamaPsView__expires_in_minutes } from '@/strings/messages/OllamaPsView__expires_in_minutes/ko';
import { OllamaPsView__expires_soon } from '@/strings/messages/OllamaPsView__expires_soon/ko';
import { OllamaPsView__families } from '@/strings/messages/OllamaPsView__families/ko';
import { OllamaPsView__family } from '@/strings/messages/OllamaPsView__family/ko';
import { OllamaPsView__format } from '@/strings/messages/OllamaPsView__format/ko';
import { OllamaPsView__kept_indefinitely } from '@/strings/messages/OllamaPsView__kept_indefinitely/ko';
import { OllamaPsView__loaded_count } from '@/strings/messages/OllamaPsView__loaded_count/ko';
import { OllamaPsView__loaded_models_remain_available_until_their_keep_alive_period_expires } from '@/strings/messages/OllamaPsView__loaded_models_remain_available_until_their_keep_alive_period_expires/ko';
import { OllamaPsView__loading_models } from '@/strings/messages/OllamaPsView__loading_models/ko';
import { OllamaPsView__memory_size } from '@/strings/messages/OllamaPsView__memory_size/ko';
import { OllamaPsView__model } from '@/strings/messages/OllamaPsView__model/ko';
import { OllamaPsView__model_details } from '@/strings/messages/OllamaPsView__model_details/ko';
import { OllamaPsView__model_details_aria } from '@/strings/messages/OllamaPsView__model_details_aria/ko';
import { OllamaPsView__model_unload_requested } from '@/strings/messages/OllamaPsView__model_unload_requested/ko';
import { OllamaPsView__model_unloaded } from '@/strings/messages/OllamaPsView__model_unloaded/ko';
import { OllamaPsView__models_appear_here_after_ollama_loads_them_for_a_request } from '@/strings/messages/OllamaPsView__models_appear_here_after_ollama_loads_them_for_a_request/ko';
import { OllamaPsView__models_currently_using_system_or_video_memory } from '@/strings/messages/OllamaPsView__models_currently_using_system_or_video_memory/ko';
import { OllamaPsView__no_models_are_currently_loaded } from '@/strings/messages/OllamaPsView__no_models_are_currently_loaded/ko';
import { OllamaPsView__not_checked } from '@/strings/messages/OllamaPsView__not_checked/ko';
import { OllamaPsView__parent_model } from '@/strings/messages/OllamaPsView__parent_model/ko';
import { OllamaPsView__refresh } from '@/strings/messages/OllamaPsView__refresh/ko';
import { OllamaPsView__refresh_to_check_this_ollama_server } from '@/strings/messages/OllamaPsView__refresh_to_check_this_ollama_server/ko';
import { OllamaPsView__refreshing } from '@/strings/messages/OllamaPsView__refreshing/ko';
import { OllamaPsView__running_models } from '@/strings/messages/OllamaPsView__running_models/ko';
import { OllamaPsView__running_ollama_models } from '@/strings/messages/OllamaPsView__running_ollama_models/ko';
import { OllamaPsView__try_again } from '@/strings/messages/OllamaPsView__try_again/ko';
import { OllamaPsView__unavailable } from '@/strings/messages/OllamaPsView__unavailable/ko';
import { OllamaPsView__unload } from '@/strings/messages/OllamaPsView__unload/ko';
import { OllamaPsView__unload_requested } from '@/strings/messages/OllamaPsView__unload_requested/ko';
import { OllamaPsView__unload_requested_ollama_may_keep_showing_this_model_until_active_requests_finish_refresh_to_check_again } from '@/strings/messages/OllamaPsView__unload_requested_ollama_may_keep_showing_this_model_until_active_requests_finish_refresh_to_check_again/ko';
import { OllamaPsView__unloading } from '@/strings/messages/OllamaPsView__unloading/ko';
import { OllamaPsView__vram_size } from '@/strings/messages/OllamaPsView__vram_size/ko';
import { OnboardingModal__add_header } from '@/strings/messages/OnboardingModal__add_header/ko';
import { OnboardingModal__back } from '@/strings/messages/OnboardingModal__back/ko';
import { OnboardingModal__cancel } from '@/strings/messages/OnboardingModal__cancel/ko';
import { OnboardingModal__check_connection } from '@/strings/messages/OnboardingModal__check_connection/ko';
import { OnboardingModal__connecting } from '@/strings/messages/OnboardingModal__connecting/ko';
import { OnboardingModal__connection_attempt_cancelled } from '@/strings/messages/OnboardingModal__connection_attempt_cancelled/ko';
import { OnboardingModal__custom_http_headers } from '@/strings/messages/OnboardingModal__custom_http_headers/ko';
import { OnboardingModal__default_model } from '@/strings/messages/OnboardingModal__default_model/ko';
import { OnboardingModal__do_not_have_a_server } from '@/strings/messages/OnboardingModal__do_not_have_a_server/ko';
import { OnboardingModal__endpoint_configuration } from '@/strings/messages/OnboardingModal__endpoint_configuration/ko';
import { OnboardingModal__enter_existing_server_url } from '@/strings/messages/OnboardingModal__enter_existing_server_url/ko';
import { OnboardingModal__enter_valid_url } from '@/strings/messages/OnboardingModal__enter_valid_url/ko';
import { OnboardingModal__experimental } from '@/strings/messages/OnboardingModal__experimental/ko';
import { OnboardingModal__failed_to_connect } from '@/strings/messages/OnboardingModal__failed_to_connect/ko';
import { OnboardingModal__failed_to_save_settings } from '@/strings/messages/OnboardingModal__failed_to_save_settings/ko';
import { OnboardingModal__get_started } from '@/strings/messages/OnboardingModal__get_started/ko';
import { OnboardingModal__help_and_guide } from '@/strings/messages/OnboardingModal__help_and_guide/ko';
import { OnboardingModal__in_browser_ai } from '@/strings/messages/OnboardingModal__in_browser_ai/ko';
import { OnboardingModal__name } from '@/strings/messages/OnboardingModal__name/ko';
import { OnboardingModal__ollama } from '@/strings/messages/OnboardingModal__ollama/ko';
import { OnboardingModal__openai_compatible } from '@/strings/messages/OnboardingModal__openai_compatible/ko';
import { OnboardingModal__quick_presets } from '@/strings/messages/OnboardingModal__quick_presets/ko';
import { OnboardingModal__run_models_in_browser } from '@/strings/messages/OnboardingModal__run_models_in_browser/ko';
import { OnboardingModal__select_a_model } from '@/strings/messages/OnboardingModal__select_a_model/ko';
import { OnboardingModal__settings_can_be_changed_later } from '@/strings/messages/OnboardingModal__settings_can_be_changed_later/ko';
import { OnboardingModal__settings_saved_for_local_inference } from '@/strings/messages/OnboardingModal__settings_saved_for_local_inference/ko';
import { OnboardingModal__setup_endpoint } from '@/strings/messages/OnboardingModal__setup_endpoint/ko';
import { OnboardingModal__setup_endpoint_description } from '@/strings/messages/OnboardingModal__setup_endpoint_description/ko';
import { OnboardingModal__successfully_connected } from '@/strings/messages/OnboardingModal__successfully_connected/ko';
import { OnboardingModal__transformers_js } from '@/strings/messages/OnboardingModal__transformers_js/ko';
import { OnboardingModal__value } from '@/strings/messages/OnboardingModal__value/ko';
import { PWAManager__app_ready_to_work_offline } from '@/strings/messages/PWAManager__app_ready_to_work_offline/ko';
import { PWAUpdateNotification__reload_to_update } from '@/strings/messages/PWAUpdateNotification__reload_to_update/ko';
import { PromptApiStatus__browser_provided_language_models_are_not_available_in_this_browser } from '@/strings/messages/PromptApiStatus__browser_provided_language_models_are_not_available_in_this_browser/ko';
import { PromptApiStatus__browser_provided_model_is_not_available_on_this_device } from '@/strings/messages/PromptApiStatus__browser_provided_model_is_not_available_on_this_device/ko';
import { PromptApiStatus__browser_provided_model_is_ready } from '@/strings/messages/PromptApiStatus__browser_provided_model_is_ready/ko';
import { PromptApiStatus__browser_reported_model_unavailable } from '@/strings/messages/PromptApiStatus__browser_reported_model_unavailable/ko';
import { PromptApiStatus__browser_returned_an_error_while_checking_availability } from '@/strings/messages/PromptApiStatus__browser_returned_an_error_while_checking_availability/ko';
import { PromptApiStatus__browser_returned_an_error_while_preparing_model } from '@/strings/messages/PromptApiStatus__browser_returned_an_error_while_preparing_model/ko';
import { PromptApiStatus__checking_browser_provided_language_model_availability } from '@/strings/messages/PromptApiStatus__checking_browser_provided_language_model_availability/ko';
import { PromptApiStatus__chrome_148_or_later_desktop } from '@/strings/messages/PromptApiStatus__chrome_148_or_later_desktop/ko';
import { PromptApiStatus__chrome_gpu_with_4_gb_vram_or_less } from '@/strings/messages/PromptApiStatus__chrome_gpu_with_4_gb_vram_or_less/ko';
import { PromptApiStatus__common_reasons_include } from '@/strings/messages/PromptApiStatus__common_reasons_include/ko';
import { PromptApiStatus__could_not_check_browser_provided_model_availability } from '@/strings/messages/PromptApiStatus__could_not_check_browser_provided_model_availability/ko';
import { PromptApiStatus__downloading_browser_provided_model } from '@/strings/messages/PromptApiStatus__downloading_browser_provided_model/ko';
import { PromptApiStatus__downloading_browser_provided_model_progress } from '@/strings/messages/PromptApiStatus__downloading_browser_provided_model_progress/ko';
import { PromptApiStatus__edge_canary_or_dev_138_or_later_with_prompt_api_flag } from '@/strings/messages/PromptApiStatus__edge_canary_or_dev_138_or_later_with_prompt_api_flag/ko';
import { PromptApiStatus__edge_gpu_with_less_than_5_5_gb_vram_for_phi_4_mini } from '@/strings/messages/PromptApiStatus__edge_gpu_with_less_than_5_5_gb_vram_for_phi_4_mini/ko';
import { PromptApiStatus__if_unavailable_in_a_supported_browser } from '@/strings/messages/PromptApiStatus__if_unavailable_in_a_supported_browser/ko';
import { PromptApiStatus__language_model_api_was_not_detected } from '@/strings/messages/PromptApiStatus__language_model_api_was_not_detected/ko';
import { PromptApiStatus__less_than_16_gb_ram_or_fewer_than_4_cpu_cores_for_cpu_inference } from '@/strings/messages/PromptApiStatus__less_than_16_gb_ram_or_fewer_than_4_cpu_cores_for_cpu_inference/ko';
import { PromptApiStatus__less_than_required_free_space_on_browser_profile_volume } from '@/strings/messages/PromptApiStatus__less_than_required_free_space_on_browser_profile_volume/ko';
import { PromptApiStatus__metered_or_unavailable_network_during_initial_download } from '@/strings/messages/PromptApiStatus__metered_or_unavailable_network_during_initial_download/ko';
import { PromptApiStatus__model_download_may_require_an_unmetered_network } from '@/strings/messages/PromptApiStatus__model_download_may_require_an_unmetered_network/ko';
import { PromptApiStatus__model_download_may_require_more_free_space } from '@/strings/messages/PromptApiStatus__model_download_may_require_more_free_space/ko';
import { PromptApiStatus__model_preparation_failed } from '@/strings/messages/PromptApiStatus__model_preparation_failed/ko';
import { PromptApiStatus__operating_system_or_hardware_requirements_may_not_be_met } from '@/strings/messages/PromptApiStatus__operating_system_or_hardware_requirements_may_not_be_met/ko';
import { PromptApiStatus__prepare_browser_provided_model } from '@/strings/messages/PromptApiStatus__prepare_browser_provided_model/ko';
import { PromptApiStatus__preparing_browser_provided_model } from '@/strings/messages/PromptApiStatus__preparing_browser_provided_model/ko';
import { PromptApiStatus__prompt_api_may_be_disabled_by_browser_settings_flags_or_policy } from '@/strings/messages/PromptApiStatus__prompt_api_may_be_disabled_by_browser_settings_flags_or_policy/ko';
import { PromptApiStatus__required_edge_experimental_flags_are_not_enabled } from '@/strings/messages/PromptApiStatus__required_edge_experimental_flags_are_not_enabled/ko';
import { PromptApiStatus__supported_browsers } from '@/strings/messages/PromptApiStatus__supported_browsers/ko';
import { PromptApiStatus__supported_browsers_and_requirements } from '@/strings/messages/PromptApiStatus__supported_browsers_and_requirements/ko';
import { PromptApiStatus__technical_details } from '@/strings/messages/PromptApiStatus__technical_details/ko';
import { PromptApiStatus__try_again } from '@/strings/messages/PromptApiStatus__try_again/ko';
import { PromptApiStatus__unsupported_operating_system_or_device } from '@/strings/messages/PromptApiStatus__unsupported_operating_system_or_device/ko';
import { PromptApiStatus__unsupported_operating_system_or_device_performance_class } from '@/strings/messages/PromptApiStatus__unsupported_operating_system_or_device_performance_class/ko';
import { ProviderProfilePreview__configuration_preview } from '@/strings/messages/ProviderProfilePreview__configuration_preview/ko';
import { ProviderProfilePreview__endpoint_url } from '@/strings/messages/ProviderProfilePreview__endpoint_url/ko';
import { ProviderProfilePreview__headers } from '@/strings/messages/ProviderProfilePreview__headers/ko';
import { ProviderProfilePreview__lm_params } from '@/strings/messages/ProviderProfilePreview__lm_params/ko';
import { ProviderProfilePreview__none } from '@/strings/messages/ProviderProfilePreview__none/ko';
import { ProviderProfilePreview__provider_and_model } from '@/strings/messages/ProviderProfilePreview__provider_and_model/ko';
import { ProviderProfilePreview__system_prompt } from '@/strings/messages/ProviderProfilePreview__system_prompt/ko';
import { ProviderProfilesTab__delete_profile } from '@/strings/messages/ProviderProfilesTab__delete_profile/ko';
import { ProviderProfilesTab__go_to_connection_to_create_one } from '@/strings/messages/ProviderProfilesTab__go_to_connection_to_create_one/ko';
import { ProviderProfilesTab__no_default_model } from '@/strings/messages/ProviderProfilesTab__no_default_model/ko';
import { ProviderProfilesTab__no_profiles_saved_yet } from '@/strings/messages/ProviderProfilesTab__no_profiles_saved_yet/ko';
import { ProviderProfilesTab__profile_was_deleted } from '@/strings/messages/ProviderProfilesTab__profile_was_deleted/ko';
import { ProviderProfilesTab__provider_profiles } from '@/strings/messages/ProviderProfilesTab__provider_profiles/ko';
import { ProviderProfilesTab__rename_profile } from '@/strings/messages/ProviderProfilesTab__rename_profile/ko';
import { ProviderProfilesTab__save_and_switch_provider_configurations } from '@/strings/messages/ProviderProfilesTab__save_and_switch_provider_configurations/ko';
import { ProviderProfilesTab__title_model } from '@/strings/messages/ProviderProfilesTab__title_model/ko';
import { ProviderProfilesTab__undo } from '@/strings/messages/ProviderProfilesTab__undo/ko';
import { ReasoningSettings__default } from '@/strings/messages/ReasoningSettings__default/ko';
import { ReasoningSettings__effort_levels_may_be_ignored_by_some_models } from '@/strings/messages/ReasoningSettings__effort_levels_may_be_ignored_by_some_models/ko';
import { ReasoningSettings__high } from '@/strings/messages/ReasoningSettings__high/ko';
import { ReasoningSettings__low } from '@/strings/messages/ReasoningSettings__low/ko';
import { ReasoningSettings__med } from '@/strings/messages/ReasoningSettings__med/ko';
import { ReasoningSettings__medium } from '@/strings/messages/ReasoningSettings__medium/ko';
import { ReasoningSettings__off } from '@/strings/messages/ReasoningSettings__off/ko';
import { ReasoningSettings__think } from '@/strings/messages/ReasoningSettings__think/ko';
import { RecentChatsModal__filter } from '@/strings/messages/RecentChatsModal__filter/ko';
import { RecentChatsModal__filter_recent_chats } from '@/strings/messages/RecentChatsModal__filter_recent_chats/ko';
import { RecentChatsModal__navigate } from '@/strings/messages/RecentChatsModal__navigate/ko';
import { RecentChatsModal__no_chats_match_filter } from '@/strings/messages/RecentChatsModal__no_chats_match_filter/ko';
import { RecentChatsModal__no_recent_chats } from '@/strings/messages/RecentChatsModal__no_recent_chats/ko';
import { RecentChatsModal__off } from '@/strings/messages/RecentChatsModal__off/ko';
import { RecentChatsModal__on } from '@/strings/messages/RecentChatsModal__on/ko';
import { RecentChatsModal__peek } from '@/strings/messages/RecentChatsModal__peek/ko';
import { RecentChatsModal__preview } from '@/strings/messages/RecentChatsModal__preview/ko';
import { RecentChatsModal__select } from '@/strings/messages/RecentChatsModal__select/ko';
import { RecipeExportModal__aa } from '@/strings/messages/RecipeExportModal__aa/ko';
import { RecipeExportModal__add_rule } from '@/strings/messages/RecipeExportModal__add_rule/ko';
import { RecipeExportModal__append } from '@/strings/messages/RecipeExportModal__append/ko';
import { RecipeExportModal__clear } from '@/strings/messages/RecipeExportModal__clear/ko';
import { RecipeExportModal__copied_to_clipboard } from '@/strings/messages/RecipeExportModal__copied_to_clipboard/ko';
import { RecipeExportModal__copy_recipe_json } from '@/strings/messages/RecipeExportModal__copy_recipe_json/ko';
import { RecipeExportModal__description } from '@/strings/messages/RecipeExportModal__description/ko';
import { RecipeExportModal__include_custom_instructions_in_the_recipe } from '@/strings/messages/RecipeExportModal__include_custom_instructions_in_the_recipe/ko';
import { RecipeExportModal__invalid_regular_expression } from '@/strings/messages/RecipeExportModal__invalid_regular_expression/ko';
import { RecipeExportModal__live_recipe_preview } from '@/strings/messages/RecipeExportModal__live_recipe_preview/ko';
import { RecipeExportModal__model_matching_rules_regex } from '@/strings/messages/RecipeExportModal__model_matching_rules_regex/ko';
import { RecipeExportModal__no_matching_rules_recipe_will_use_the_default_model } from '@/strings/messages/RecipeExportModal__no_matching_rules_recipe_will_use_the_default_model/ko';
import { RecipeExportModal__override } from '@/strings/messages/RecipeExportModal__override/ko';
import { RecipeExportModal__parent_prompt_cleared } from '@/strings/messages/RecipeExportModal__parent_prompt_cleared/ko';
import { RecipeExportModal__recipe_editor } from '@/strings/messages/RecipeExportModal__recipe_editor/ko';
import { RecipeExportModal__recipe_name } from '@/strings/messages/RecipeExportModal__recipe_name/ko';
import { RecipeExportModal__recipe_system_prompt } from '@/strings/messages/RecipeExportModal__recipe_system_prompt/ko';
import { RecipeExportModal__regex } from '@/strings/messages/RecipeExportModal__regex/ko';
import { RecipeExportModal__temperature_top_p_and_other_lm_parameters_are_automatically_included_from_your_current_group_overrides } from '@/strings/messages/RecipeExportModal__temperature_top_p_and_other_lm_parameters_are_automatically_included_from_your_current_group_overrides/ko';
import { RecipeExportModal__this_recipe_will_explicitly_clear_any_inherited_system_instructions } from '@/strings/messages/RecipeExportModal__this_recipe_will_explicitly_clear_any_inherited_system_instructions/ko';
import { RecipeExportModal__toggle_case_sensitivity } from '@/strings/messages/RecipeExportModal__toggle_case_sensitivity/ko';
import { RecipeExportModal__what_makes_this_recipe_special } from '@/strings/messages/RecipeExportModal__what_makes_this_recipe_special/ko';
import { RecipeImportTab__chat_group_name } from '@/strings/messages/RecipeImportTab__chat_group_name/ko';
import { RecipeImportTab__detected_recipes } from '@/strings/messages/RecipeImportTab__detected_recipes/ko';
import { RecipeImportTab__import_chat_group_recipes } from '@/strings/messages/RecipeImportTab__import_chat_group_recipes/ko';
import { RecipeImportTab__import_selected } from '@/strings/messages/RecipeImportTab__import_selected/ko';
import { RecipeImportTab__model_selection } from '@/strings/messages/RecipeImportTab__model_selection/ko';
import { RecipeImportTab__paste_recipe_json_concatenated_json_objects_supported } from '@/strings/messages/RecipeImportTab__paste_recipe_json_concatenated_json_objects_supported/ko';
import { RecipeImportTab__recipes } from '@/strings/messages/RecipeImportTab__recipes/ko';
import { RecipeImportTab__system_prompt } from '@/strings/messages/RecipeImportTab__system_prompt/ko';
import { RecipeImportTab__use_default_model } from '@/strings/messages/RecipeImportTab__use_default_model/ko';
import { RelativeTime__days_ago } from '@/strings/messages/RelativeTime__days_ago/ko';
import { RelativeTime__hours_ago } from '@/strings/messages/RelativeTime__hours_ago/ko';
import { RelativeTime__just_now } from '@/strings/messages/RelativeTime__just_now/ko';
import { RelativeTime__minutes_ago } from '@/strings/messages/RelativeTime__minutes_ago/ko';
import { RelativeTime__seconds_ago } from '@/strings/messages/RelativeTime__seconds_ago/ko';
import { SearchPreview__alt_branch } from '@/strings/messages/SearchPreview__alt_branch/ko';
import { SearchPreview__conversation_match } from '@/strings/messages/SearchPreview__conversation_match/ko';
import { SearchPreview__following_messages } from '@/strings/messages/SearchPreview__following_messages/ko';
import { SearchPreview__message_count } from '@/strings/messages/SearchPreview__message_count/ko';
import { SearchPreview__previous_messages } from '@/strings/messages/SearchPreview__previous_messages/ko';
import { SearchPreview__recent_history } from '@/strings/messages/SearchPreview__recent_history/ko';
import { SearchPreview__select_an_item_to_preview } from '@/strings/messages/SearchPreview__select_an_item_to_preview/ko';
import { ServerSetupGuide__download_the_installer_from_the_official_website } from '@/strings/messages/ServerSetupGuide__download_the_installer_from_the_official_website/ko';
import { ServerSetupGuide__download_the_latest_binary_or_build_from_source } from '@/strings/messages/ServerSetupGuide__download_the_latest_binary_or_build_from_source/ko';
import { ServerSetupGuide__external } from '@/strings/messages/ServerSetupGuide__external/ko';
import { ServerSetupGuide__install_using_homebrew } from '@/strings/messages/ServerSetupGuide__install_using_homebrew/ko';
import { ServerSetupGuide__releases } from '@/strings/messages/ServerSetupGuide__releases/ko';
import { ServerSetupGuide__run_gemma_3n } from '@/strings/messages/ServerSetupGuide__run_gemma_3n/ko';
import { ServerSetupGuide__run_the_installation_script } from '@/strings/messages/ServerSetupGuide__run_the_installation_script/ko';
import { ServerSetupGuide__start_server } from '@/strings/messages/ServerSetupGuide__start_server/ko';
import { SettingsModal__about } from '@/strings/messages/SettingsModal__about/ko';
import { SettingsModal__connection } from '@/strings/messages/SettingsModal__connection/ko';
import { SettingsModal__developer } from '@/strings/messages/SettingsModal__developer/ko';
import { SettingsModal__discard } from '@/strings/messages/SettingsModal__discard/ko';
import { SettingsModal__discard_unsaved_changes } from '@/strings/messages/SettingsModal__discard_unsaved_changes/ko';
import { SettingsModal__discard_unsaved_connection_changes } from '@/strings/messages/SettingsModal__discard_unsaved_connection_changes/ko';
import { SettingsModal__failed_to_import_recipes } from '@/strings/messages/SettingsModal__failed_to_import_recipes/ko';
import { SettingsModal__files } from '@/strings/messages/SettingsModal__files/ko';
import { SettingsModal__folders } from '@/strings/messages/SettingsModal__folders/ko';
import { SettingsModal__keep_editing } from '@/strings/messages/SettingsModal__keep_editing/ko';
import { SettingsModal__provider_profiles } from '@/strings/messages/SettingsModal__provider_profiles/ko';
import { SettingsModal__recipes } from '@/strings/messages/SettingsModal__recipes/ko';
import { SettingsModal__settings } from '@/strings/messages/SettingsModal__settings/ko';
import { SettingsModal__standalone } from '@/strings/messages/SettingsModal__standalone/ko';
import { SettingsModal__storage } from '@/strings/messages/SettingsModal__storage/ko';
import { SettingsModal__successfully_imported_recipes_as_chat_groups } from '@/strings/messages/SettingsModal__successfully_imported_recipes_as_chat_groups/ko';
import { SettingsModal__tools } from '@/strings/messages/SettingsModal__tools/ko';
import { SettingsModal__transformers_js } from '@/strings/messages/SettingsModal__transformers_js/ko';
import { SidebarDebugControls__debug_events } from '@/strings/messages/SidebarDebugControls__debug_events/ko';
import { SidebarDebugControls__file_explorer } from '@/strings/messages/SidebarDebugControls__file_explorer/ko';
import { SidebarDebugControls__more_actions } from '@/strings/messages/SidebarDebugControls__more_actions/ko';
import { SidebarDebugControls__quick_access } from '@/strings/messages/SidebarDebugControls__quick_access/ko';
import { SidebarDebugControls__recent_chats } from '@/strings/messages/SidebarDebugControls__recent_chats/ko';
import { SidebarDebugControls__wesh_terminal } from '@/strings/messages/SidebarDebugControls__wesh_terminal/ko';
import { Sidebar__add_chat } from '@/strings/messages/Sidebar__add_chat/ko';
import { Sidebar__cancel } from '@/strings/messages/Sidebar__cancel/ko';
import { Sidebar__close_sidebar } from '@/strings/messages/Sidebar__close_sidebar/ko';
import { Sidebar__create_chat_group } from '@/strings/messages/Sidebar__create_chat_group/ko';
import { Sidebar__current_group } from '@/strings/messages/Sidebar__current_group/ko';
import { Sidebar__default_model } from '@/strings/messages/Sidebar__default_model/ko';
import { Sidebar__delete_group } from '@/strings/messages/Sidebar__delete_group/ko';
import { Sidebar__delete_group_question } from '@/strings/messages/Sidebar__delete_group_question/ko';
import { Sidebar__delete_group_warning } from '@/strings/messages/Sidebar__delete_group_warning/ko';
import { Sidebar__ephemeral_session } from '@/strings/messages/Sidebar__ephemeral_session/ko';
import { Sidebar__group_name } from '@/strings/messages/Sidebar__group_name/ko';
import { Sidebar__new_chat_in_group } from '@/strings/messages/Sidebar__new_chat_in_group/ko';
import { Sidebar__none } from '@/strings/messages/Sidebar__none/ko';
import { Sidebar__open_sidebar } from '@/strings/messages/Sidebar__open_sidebar/ko';
import { Sidebar__rename_group } from '@/strings/messages/Sidebar__rename_group/ko';
import { Sidebar__search_cmd_k } from '@/strings/messages/Sidebar__search_cmd_k/ko';
import { Sidebar__select_default_model } from '@/strings/messages/Sidebar__select_default_model/ko';
import { Sidebar__settings } from '@/strings/messages/Sidebar__settings/ko';
import { Sidebar__show_less } from '@/strings/messages/Sidebar__show_less/ko';
import { Sidebar__show_more } from '@/strings/messages/Sidebar__show_more/ko';
import { SpeechControl__pause } from '@/strings/messages/SpeechControl__pause/ko';
import { SpeechControl__read_aloud } from '@/strings/messages/SpeechControl__read_aloud/ko';
import { SpeechControl__restart } from '@/strings/messages/SpeechControl__restart/ko';
import { SpeechControl__resume } from '@/strings/messages/SpeechControl__resume/ko';
import { SpeechControl__stop } from '@/strings/messages/SpeechControl__stop/ko';
import { SpeechLanguageSelector__auto } from '@/strings/messages/SpeechLanguageSelector__auto/ko';
import { SpeechLanguageSelector__auto_detect } from '@/strings/messages/SpeechLanguageSelector__auto_detect/ko';
import { SpeechLanguageSelector__auto_detect_with_language } from '@/strings/messages/SpeechLanguageSelector__auto_detect_with_language/ko';
import { SpeechLanguageSelector__english } from '@/strings/messages/SpeechLanguageSelector__english/ko';
import { SpeechLanguageSelector__language } from '@/strings/messages/SpeechLanguageSelector__language/ko';
import { SpeechLanguageSelector__redetect_language } from '@/strings/messages/SpeechLanguageSelector__redetect_language/ko';
import { StandaloneVerificationPage__checks_file_protocol_startup_routing_styles_lazy_chunks_systemjs_and_repeated_worker_creation_without_changing_chats_or_settings } from '@/strings/messages/StandaloneVerificationPage__checks_file_protocol_startup_routing_styles_lazy_chunks_systemjs_and_repeated_worker_creation_without_changing_chats_or_settings/ko';
import { StandaloneVerificationPage__copied_diagnostics_may_contain_local_file_paths_in_browser_provided_error_stacks_or_resource_timing_entries } from '@/strings/messages/StandaloneVerificationPage__copied_diagnostics_may_contain_local_file_paths_in_browser_provided_error_stacks_or_resource_timing_entries/ko';
import { StandaloneVerificationPage__copy_json } from '@/strings/messages/StandaloneVerificationPage__copy_json/ko';
import { StandaloneVerificationPage__failed_to_copy_verification_json } from '@/strings/messages/StandaloneVerificationPage__failed_to_copy_verification_json/ko';
import { StandaloneVerificationPage__run_standalone_verification } from '@/strings/messages/StandaloneVerificationPage__run_standalone_verification/ko';
import { StandaloneVerificationPage__running } from '@/strings/messages/StandaloneVerificationPage__running/ko';
import { StandaloneVerificationPage__standalone_verification } from '@/strings/messages/StandaloneVerificationPage__standalone_verification/ko';
import { StandaloneVerificationPage__standalone_verification_json_copied } from '@/strings/messages/StandaloneVerificationPage__standalone_verification_json_copied/ko';
import { StandaloneVerificationPage__these_checks_require_a_standalone_build_opened_through_file } from '@/strings/messages/StandaloneVerificationPage__these_checks_require_a_standalone_build_opened_through_file/ko';
import { StandaloneVerificationPage__verification_failed_to_run } from '@/strings/messages/StandaloneVerificationPage__verification_failed_to_run/ko';
import { StandaloneVerificationPage__verification_summary } from '@/strings/messages/StandaloneVerificationPage__verification_summary/ko';
import { StorageService__an_error_occurred_during_a_storage_operation } from '@/strings/messages/StorageService__an_error_occurred_during_a_storage_operation/ko';
import { StorageTab__active } from '@/strings/messages/StorageTab__active/ko';
import { StorageTab__active_storage_provider } from '@/strings/messages/StorageTab__active_storage_provider/ko';
import { StorageTab__attachments_will_be_inaccessible } from '@/strings/messages/StorageTab__attachments_will_be_inaccessible/ko';
import { StorageTab__backup_and_restore } from '@/strings/messages/StorageTab__backup_and_restore/ko';
import { StorageTab__backup_restore_description } from '@/strings/messages/StorageTab__backup_restore_description/ko';
import { StorageTab__best_effort } from '@/strings/messages/StorageTab__best_effort/ko';
import { StorageTab__browser_declined_persistence } from '@/strings/messages/StorageTab__browser_declined_persistence/ko';
import { StorageTab__checking } from '@/strings/messages/StorageTab__checking/ko';
import { StorageTab__clear_all } from '@/strings/messages/StorageTab__clear_all/ko';
import { StorageTab__clear_all_conversation_history } from '@/strings/messages/StorageTab__clear_all_conversation_history/ko';
import { StorageTab__clear_conversation_history } from '@/strings/messages/StorageTab__clear_conversation_history/ko';
import { StorageTab__clear_history } from '@/strings/messages/StorageTab__clear_history/ko';
import { StorageTab__clear_history_description } from '@/strings/messages/StorageTab__clear_history_description/ko';
import { StorageTab__confirm_storage_switch } from '@/strings/messages/StorageTab__confirm_storage_switch/ko';
import { StorageTab__confirm_switch_to_storage } from '@/strings/messages/StorageTab__confirm_switch_to_storage/ko';
import { StorageTab__copy_link } from '@/strings/messages/StorageTab__copy_link/ko';
import { StorageTab__data_cleanup } from '@/strings/messages/StorageTab__data_cleanup/ko';
import { StorageTab__data_durability } from '@/strings/messages/StorageTab__data_durability/ko';
import { StorageTab__delete_all_chats_warning } from '@/strings/messages/StorageTab__delete_all_chats_warning/ko';
import { StorageTab__enable } from '@/strings/messages/StorageTab__enable/ko';
import { StorageTab__ephemeral } from '@/strings/messages/StorageTab__ephemeral/ko';
import { StorageTab__ephemeral_description } from '@/strings/messages/StorageTab__ephemeral_description/ko';
import { StorageTab__error } from '@/strings/messages/StorageTab__error/ko';
import { StorageTab__exclude_attachments } from '@/strings/messages/StorageTab__exclude_attachments/ko';
import { StorageTab__exclude_chat_history } from '@/strings/messages/StorageTab__exclude_chat_history/ko';
import { StorageTab__exclude_chats } from '@/strings/messages/StorageTab__exclude_chats/ko';
import { StorageTab__experimental } from '@/strings/messages/StorageTab__experimental/ko';
import { StorageTab__export_import } from '@/strings/messages/StorageTab__export_import/ko';
import { StorageTab__export_url_copied } from '@/strings/messages/StorageTab__export_url_copied/ko';
import { StorageTab__failed_to_enable_persistence } from '@/strings/messages/StorageTab__failed_to_enable_persistence/ko';
import { StorageTab__failed_to_generate_export_url } from '@/strings/messages/StorageTab__failed_to_generate_export_url/ko';
import { StorageTab__failed_to_migrate_data } from '@/strings/messages/StorageTab__failed_to_migrate_data/ko';
import { StorageTab__generating } from '@/strings/messages/StorageTab__generating/ko';
import { StorageTab__large_storage_link_warning } from '@/strings/messages/StorageTab__large_storage_link_warning/ko';
import { StorageTab__local_storage } from '@/strings/messages/StorageTab__local_storage/ko';
import { StorageTab__local_storage_description } from '@/strings/messages/StorageTab__local_storage_description/ko';
import { StorageTab__local_storage_loses_attachments } from '@/strings/messages/StorageTab__local_storage_loses_attachments/ko';
import { StorageTab__manage_data } from '@/strings/messages/StorageTab__manage_data/ko';
import { StorageTab__migration_failed } from '@/strings/messages/StorageTab__migration_failed/ko';
import { StorageTab__not_supported } from '@/strings/messages/StorageTab__not_supported/ko';
import { StorageTab__opfs_description } from '@/strings/messages/StorageTab__opfs_description/ko';
import { StorageTab__origin_private_file_system } from '@/strings/messages/StorageTab__origin_private_file_system/ko';
import { StorageTab__persistence_denied } from '@/strings/messages/StorageTab__persistence_denied/ko';
import { StorageTab__persistent_storage } from '@/strings/messages/StorageTab__persistent_storage/ko';
import { StorageTab__persistent_storage_description } from '@/strings/messages/StorageTab__persistent_storage_description/ko';
import { StorageTab__persistent_storage_not_supported } from '@/strings/messages/StorageTab__persistent_storage_not_supported/ko';
import { StorageTab__protected } from '@/strings/messages/StorageTab__protected/ko';
import { StorageTab__recommended } from '@/strings/messages/StorageTab__recommended/ko';
import { StorageTab__share_url_description } from '@/strings/messages/StorageTab__share_url_description/ko';
import { StorageTab__share_via_url } from '@/strings/messages/StorageTab__share_via_url/ko';
import { StorageTab__storage_management } from '@/strings/messages/StorageTab__storage_management/ko';
import { StorageTab__storage_migration_description } from '@/strings/messages/StorageTab__storage_migration_description/ko';
import { StorageTab__switch_and_lose_attachments } from '@/strings/messages/StorageTab__switch_and_lose_attachments/ko';
import { StorageTab__switch_and_migrate } from '@/strings/messages/StorageTab__switch_and_migrate/ko';
import { StorageTab__understand } from '@/strings/messages/StorageTab__understand/ko';
import { StorageTab__unsupported } from '@/strings/messages/StorageTab__unsupported/ko';
import { ThemeToggle__dark_mode } from '@/strings/messages/ThemeToggle__dark_mode/ko';
import { ThemeToggle__light_mode } from '@/strings/messages/ThemeToggle__light_mode/ko';
import { ThemeToggle__system_mode } from '@/strings/messages/ThemeToggle__system_mode/ko';
import { ToolCallGroupItem__used_tools } from '@/strings/messages/ToolCallGroupItem__used_tools/ko';
import { ToolConfigHierarchySettings__access_global_knowledge } from '@/strings/messages/ToolConfigHierarchySettings__access_global_knowledge/ko';
import { ToolConfigHierarchySettings__calculator } from '@/strings/messages/ToolConfigHierarchySettings__calculator/ko';
import { ToolConfigHierarchySettings__choices } from '@/strings/messages/ToolConfigHierarchySettings__choices/ko';
import { ToolConfigHierarchySettings__choose_from_model_provided_options } from '@/strings/messages/ToolConfigHierarchySettings__choose_from_model_provided_options/ko';
import { ToolConfigHierarchySettings__off } from '@/strings/messages/ToolConfigHierarchySettings__off/ko';
import { ToolConfigHierarchySettings__on } from '@/strings/messages/ToolConfigHierarchySettings__on/ko';
import { ToolConfigHierarchySettings__reset_to_defaults } from '@/strings/messages/ToolConfigHierarchySettings__reset_to_defaults/ko';
import { ToolConfigHierarchySettings__shell } from '@/strings/messages/ToolConfigHierarchySettings__shell/ko';
import { ToolConfigHierarchySettings__shell_in_browser } from '@/strings/messages/ToolConfigHierarchySettings__shell_in_browser/ko';
import { ToolConfigHierarchySettings__shell_settings } from '@/strings/messages/ToolConfigHierarchySettings__shell_settings/ko';
import { ToolConfigHierarchySettings__solve_math_expressions } from '@/strings/messages/ToolConfigHierarchySettings__solve_math_expressions/ko';
import { ToolConfigHierarchySettings__tool_config_persistence_is_disabled_saved_settings_remain_active_but_changes_cannot_be_saved_here } from '@/strings/messages/ToolConfigHierarchySettings__tool_config_persistence_is_disabled_saved_settings_remain_active_but_changes_cannot_be_saved_here/ko';
import { ToolConfigHierarchySettings__turn_off_tool } from '@/strings/messages/ToolConfigHierarchySettings__turn_off_tool/ko';
import { ToolConfigHierarchySettings__turn_on_tool } from '@/strings/messages/ToolConfigHierarchySettings__turn_on_tool/ko';
import { ToolConfigHierarchySettings__use_global } from '@/strings/messages/ToolConfigHierarchySettings__use_global/ko';
import { ToolConfigHierarchySettings__use_group } from '@/strings/messages/ToolConfigHierarchySettings__use_group/ko';
import { ToolConfigHierarchySettings__wikipedia } from '@/strings/messages/ToolConfigHierarchySettings__wikipedia/ko';
import { TransformersJsLoadingIndicator__downloading_model } from '@/strings/messages/TransformersJsLoadingIndicator__downloading_model/ko';
import { TransformersJsLoadingIndicator__downloading_model_weights_from_hugging_face_this_only_happens_once_per_model } from '@/strings/messages/TransformersJsLoadingIndicator__downloading_model_weights_from_hugging_face_this_only_happens_once_per_model/ko';
import { TransformersJsLoadingIndicator__initializing_model } from '@/strings/messages/TransformersJsLoadingIndicator__initializing_model/ko';
import { TransformersJsLoadingIndicator__loading_model_progress } from '@/strings/messages/TransformersJsLoadingIndicator__loading_model_progress/ko';
import { TransformersJsLoadingIndicator__loading_model_weights_into_browser_memory_for_local_inference } from '@/strings/messages/TransformersJsLoadingIndicator__loading_model_weights_into_browser_memory_for_local_inference/ko';
import { TransformersJsLoadingIndicator__model } from '@/strings/messages/TransformersJsLoadingIndicator__model/ko';
import { TransformersJsLoadingIndicator__on_device_execution } from '@/strings/messages/TransformersJsLoadingIndicator__on_device_execution/ko';
import { TransformersJsLoadingIndicator__transformers_js_error } from '@/strings/messages/TransformersJsLoadingIndicator__transformers_js_error/ko';
import { ModelSupportInvestigationModal__blocked } from '@/strings/messages/ModelSupportInvestigationModal__blocked/ko';
import { ModelSupportInvestigationModal__candidate_eligible } from '@/strings/messages/ModelSupportInvestigationModal__candidate_eligible/ko';
import { ModelSupportInvestigationModal__candidate_ineligible } from '@/strings/messages/ModelSupportInvestigationModal__candidate_ineligible/ko';
import { ModelSupportInvestigationModal__candidate_plan_summary } from '@/strings/messages/ModelSupportInvestigationModal__candidate_plan_summary/ko';
import { ModelSupportInvestigationModal__candidate_registry_failed } from '@/strings/messages/ModelSupportInvestigationModal__candidate_registry_failed/ko';
import { ModelSupportInvestigationModal__model_file_plan } from '@/strings/messages/ModelSupportInvestigationModal__model_file_plan/ko';
import { ModelSupportInvestigationModal__model_file_plan_summary } from '@/strings/messages/ModelSupportInvestigationModal__model_file_plan_summary/ko';
import { ModelSupportInvestigationModal__cache_revision_unknown } from '@/strings/messages/ModelSupportInvestigationModal__cache_revision_unknown/ko';
import { ModelSupportInvestigationModal__checking_same_origin_runtime_assets } from '@/strings/messages/ModelSupportInvestigationModal__checking_same_origin_runtime_assets/ko';
import { ModelSupportInvestigationModal__close } from '@/strings/messages/ModelSupportInvestigationModal__close/ko';
import { ModelSupportInvestigationModal__current_operation } from '@/strings/messages/ModelSupportInvestigationModal__current_operation/ko';
import { ModelSupportInvestigationModal__declaration_files_summary } from '@/strings/messages/ModelSupportInvestigationModal__declaration_files_summary/ko';
import { ModelSupportInvestigationModal__download_partial_evidence } from '@/strings/messages/ModelSupportInvestigationModal__download_partial_evidence/ko';
import { ModelSupportInvestigationModal__evidence_export } from '@/strings/messages/ModelSupportInvestigationModal__evidence_export/ko';
import { ModelSupportInvestigationModal__environment_evidence_disclosure } from '@/strings/messages/ModelSupportInvestigationModal__environment_evidence_disclosure/ko';
import { ModelSupportInvestigationModal__evidence_readiness } from '@/strings/messages/ModelSupportInvestigationModal__evidence_readiness/ko';
import { ModelSupportInvestigationModal__evidence_readiness_summary } from '@/strings/messages/ModelSupportInvestigationModal__evidence_readiness_summary/ko';
import { ModelSupportInvestigationModal__existing_model_data } from '@/strings/messages/ModelSupportInvestigationModal__existing_model_data/ko';
import { ModelSupportInvestigationModal__failed } from '@/strings/messages/ModelSupportInvestigationModal__failed/ko';
import { ModelSupportInvestigationModal__findings } from '@/strings/messages/ModelSupportInvestigationModal__findings/ko';
import { ModelSupportInvestigationModal__loading_investigation } from '@/strings/messages/ModelSupportInvestigationModal__loading_investigation/ko';
import { ModelSupportInvestigationModal__lane_comparison } from '@/strings/messages/ModelSupportInvestigationModal__lane_comparison/ko';
import { ModelSupportInvestigationModal__lane_continuity_failed } from '@/strings/messages/ModelSupportInvestigationModal__lane_continuity_failed/ko';
import { ModelSupportInvestigationModal__lane_continuity_summary } from '@/strings/messages/ModelSupportInvestigationModal__lane_continuity_summary/ko';
import { ModelSupportInvestigationModal__lane_failed } from '@/strings/messages/ModelSupportInvestigationModal__lane_failed/ko';
import { ModelSupportInvestigationModal__lane_input_match } from '@/strings/messages/ModelSupportInvestigationModal__lane_input_match/ko';
import { ModelSupportInvestigationModal__lane_input_mismatch } from '@/strings/messages/ModelSupportInvestigationModal__lane_input_mismatch/ko';
import { ModelSupportInvestigationModal__lane_route_summary } from '@/strings/messages/ModelSupportInvestigationModal__lane_route_summary/ko';
import { ModelSupportInvestigationModal__multimodal_failed } from '@/strings/messages/ModelSupportInvestigationModal__multimodal_failed/ko';
import { ModelSupportInvestigationModal__multimodal_observed } from '@/strings/messages/ModelSupportInvestigationModal__multimodal_observed/ko';
import { ModelSupportInvestigationModal__multimodal_unavailable } from '@/strings/messages/ModelSupportInvestigationModal__multimodal_unavailable/ko';
import { ModelSupportInvestigationModal__reasoning_differential_failed } from '@/strings/messages/ModelSupportInvestigationModal__reasoning_differential_failed/ko';
import { ModelSupportInvestigationModal__reasoning_differential_observed } from '@/strings/messages/ModelSupportInvestigationModal__reasoning_differential_observed/ko';
import { ModelSupportInvestigationModal__reasoning_differential_unavailable } from '@/strings/messages/ModelSupportInvestigationModal__reasoning_differential_unavailable/ko';
import { ModelSupportInvestigationModal__model_declarations } from '@/strings/messages/ModelSupportInvestigationModal__model_declarations/ko';
import { ModelSupportInvestigationModal__model_support_investigation } from '@/strings/messages/ModelSupportInvestigationModal__model_support_investigation/ko';
import { ModelSupportInvestigationModal__missing_model_type } from '@/strings/messages/ModelSupportInvestigationModal__missing_model_type/ko';
import { ModelSupportInvestigationModal__model_type } from '@/strings/messages/ModelSupportInvestigationModal__model_type/ko';
import { ModelSupportInvestigationModal__no_supported_auto_classes } from '@/strings/messages/ModelSupportInvestigationModal__no_supported_auto_classes/ko';
import { ModelSupportInvestigationModal__not_run } from '@/strings/messages/ModelSupportInvestigationModal__not_run/ko';
import { ModelSupportInvestigationModal__opfs_inventory } from '@/strings/messages/ModelSupportInvestigationModal__opfs_inventory/ko';
import { ModelSupportInvestigationModal__opfs_inventory_summary } from '@/strings/messages/ModelSupportInvestigationModal__opfs_inventory_summary/ko';
import { ModelSupportInvestigationModal__persistence_roundtrip_summary } from '@/strings/messages/ModelSupportInvestigationModal__persistence_roundtrip_summary/ko';
import { ModelSupportInvestigationModal__passed } from '@/strings/messages/ModelSupportInvestigationModal__passed/ko';
import { ModelSupportInvestigationModal__repository } from '@/strings/messages/ModelSupportInvestigationModal__repository/ko';
import { ModelSupportInvestigationModal__repository_information } from '@/strings/messages/ModelSupportInvestigationModal__repository_information/ko';
import { ModelSupportInvestigationModal__repository_summary } from '@/strings/messages/ModelSupportInvestigationModal__repository_summary/ko';
import { ModelSupportInvestigationModal__running } from '@/strings/messages/ModelSupportInvestigationModal__running/ko';
import { ModelSupportInvestigationModal__stop_investigation } from '@/strings/messages/ModelSupportInvestigationModal__stop_investigation/ko';
import { ModelSupportInvestigationModal__runtime_assets } from '@/strings/messages/ModelSupportInvestigationModal__runtime_assets/ko';
import { ModelSupportInvestigationModal__runtime_control_webgpu } from '@/strings/messages/ModelSupportInvestigationModal__runtime_control_webgpu/ko';
import { ModelSupportInvestigationModal__runtime_no_output } from '@/strings/messages/ModelSupportInvestigationModal__runtime_no_output/ko';
import { ModelSupportInvestigationModal__runtime_bytes } from '@/strings/messages/ModelSupportInvestigationModal__runtime_bytes/ko';
import { ModelSupportInvestigationModal__runtime_control } from '@/strings/messages/ModelSupportInvestigationModal__runtime_control/ko';
import { ModelSupportInvestigationModal__runtime_environment } from '@/strings/messages/ModelSupportInvestigationModal__runtime_environment/ko';
import { ModelSupportInvestigationModal__runtime_environment_summary } from '@/strings/messages/ModelSupportInvestigationModal__runtime_environment_summary/ko';
import { ModelSupportInvestigationModal__runtime_mjs } from '@/strings/messages/ModelSupportInvestigationModal__runtime_mjs/ko';
import { ModelSupportInvestigationModal__runtime_variant } from '@/strings/messages/ModelSupportInvestigationModal__runtime_variant/ko';
import { ModelSupportInvestigationModal__runtime_wasm } from '@/strings/messages/ModelSupportInvestigationModal__runtime_wasm/ko';
import { ModelSupportInvestigationModal__supported_auto_classes } from '@/strings/messages/ModelSupportInvestigationModal__supported_auto_classes/ko';
import { ModelSupportInvestigationModal__support_boundary } from '@/strings/messages/ModelSupportInvestigationModal__support_boundary/ko';
import { ModelSupportInvestigationModal__support_boundary_summary } from '@/strings/messages/ModelSupportInvestigationModal__support_boundary_summary/ko';
import { ModelSupportInvestigationModal__template_behavior } from '@/strings/messages/ModelSupportInvestigationModal__template_behavior/ko';
import { ModelSupportInvestigationModal__template_behavior_summary } from '@/strings/messages/ModelSupportInvestigationModal__template_behavior_summary/ko';
import { ModelSupportInvestigationModal__tool_protocol_probe_summary } from '@/strings/messages/ModelSupportInvestigationModal__tool_protocol_probe_summary/ko';
import { ModelSupportInvestigationModal__tool_result_production_continuation_failed } from '@/strings/messages/ModelSupportInvestigationModal__tool_result_production_continuation_failed/ko';
import { ModelSupportInvestigationModal__tool_result_production_continuation_passed } from '@/strings/messages/ModelSupportInvestigationModal__tool_result_production_continuation_passed/ko';
import { ModelSupportInvestigationModal__tool_template_provenance_summary } from '@/strings/messages/ModelSupportInvestigationModal__tool_template_provenance_summary/ko';
import { ModelSupportInvestigationModal__this_is_partial_evidence } from '@/strings/messages/ModelSupportInvestigationModal__this_is_partial_evidence/ko';
import { TransformersJsManager__investigate } from '@/strings/messages/TransformersJsManager__investigate/ko';
import { TransformersJsManager__active } from '@/strings/messages/TransformersJsManager__active/ko';
import { TransformersJsManager__active_model } from '@/strings/messages/TransformersJsManager__active_model/ko';
import { TransformersJsManager__add_new_models } from '@/strings/messages/TransformersJsManager__add_new_models/ko';
import { TransformersJsManager__ai_engine_worker_restarted_successfully } from '@/strings/messages/TransformersJsManager__ai_engine_worker_restarted_successfully/ko';
import { TransformersJsManager__asset_details } from '@/strings/messages/TransformersJsManager__asset_details/ko';
import { TransformersJsManager__browsers_often_disable_the } from '@/strings/messages/TransformersJsManager__browsers_often_disable_the/ko';
import { TransformersJsManager__cache_api } from '@/strings/messages/TransformersJsManager__cache_api/ko';
import { TransformersJsManager__could_not_determine_a_valid_model_name_from_folder_structure } from '@/strings/messages/TransformersJsManager__could_not_determine_a_valid_model_name_from_folder_structure/ko';
import { TransformersJsManager__delete } from '@/strings/messages/TransformersJsManager__delete/ko';
import { TransformersJsManager__delete_downloaded_model } from '@/strings/messages/TransformersJsManager__delete_downloaded_model/ko';
import { TransformersJsManager__delete_failed } from '@/strings/messages/TransformersJsManager__delete_failed/ko';
import { TransformersJsManager__delete_model } from '@/strings/messages/TransformersJsManager__delete_model/ko';
import { TransformersJsManager__delete_model_warning } from '@/strings/messages/TransformersJsManager__delete_model_warning/ko';
import { TransformersJsManager__deleted_model } from '@/strings/messages/TransformersJsManager__deleted_model/ko';
import { TransformersJsManager__download_failed } from '@/strings/messages/TransformersJsManager__download_failed/ko';
import { TransformersJsManager__download_failed_check_details_in_the_section_below } from '@/strings/messages/TransformersJsManager__download_failed_check_details_in_the_section_below/ko';
import { TransformersJsManager__download_from_hugging_face } from '@/strings/messages/TransformersJsManager__download_from_hugging_face/ko';
import { TransformersJsManager__download_model } from '@/strings/messages/TransformersJsManager__download_model/ko';
import { TransformersJsManager__downloaded_models } from '@/strings/messages/TransformersJsManager__downloaded_models/ko';
import { TransformersJsManager__downloading_and_compiling } from '@/strings/messages/TransformersJsManager__downloading_and_compiling/ko';
import { TransformersJsManager__engine_control } from '@/strings/messages/TransformersJsManager__engine_control/ko';
import { TransformersJsManager__engine_idle } from '@/strings/messages/TransformersJsManager__engine_idle/ko';
import { TransformersJsManager__engine_ready } from '@/strings/messages/TransformersJsManager__engine_ready/ko';
import { TransformersJsManager__engine_unloaded_and_resources_released } from '@/strings/messages/TransformersJsManager__engine_unloaded_and_resources_released/ko';
import { TransformersJsManager__enter_hugging_face_model_id_e_g_onnx_community_phi_4 } from '@/strings/messages/TransformersJsManager__enter_hugging_face_model_id_e_g_onnx_community_phi_4/ko';
import { TransformersJsManager__error } from '@/strings/messages/TransformersJsManager__error/ko';
import { TransformersJsManager__filter_downloaded_models } from '@/strings/messages/TransformersJsManager__filter_downloaded_models/ko';
import { TransformersJsManager__find_more_models } from '@/strings/messages/TransformersJsManager__find_more_models/ko';
import { TransformersJsManager__for_local_file_urls_to_avoid_downloading_models_on_every_reload_use_a_local_web_server_or_the_hosted_version } from '@/strings/messages/TransformersJsManager__for_local_file_urls_to_avoid_downloading_models_on_every_reload_use_a_local_web_server_or_the_hosted_version/ko';
import { TransformersJsManager__get_hosted_version_github } from '@/strings/messages/TransformersJsManager__get_hosted_version_github/ko';
import { TransformersJsManager__hard_restart_ai_worker_engine } from '@/strings/messages/TransformersJsManager__hard_restart_ai_worker_engine/ko';
import { TransformersJsManager__import_failed } from '@/strings/messages/TransformersJsManager__import_failed/ko';
import { TransformersJsManager__import_from_local_files } from '@/strings/messages/TransformersJsManager__import_from_local_files/ko';
import { TransformersJsManager__importing_local_model } from '@/strings/messages/TransformersJsManager__importing_local_model/ko';
import { TransformersJsManager__in_browser_ai_transformers_js_is_not_available_because_the_browser_does_not_support_or_allow_access_to } from '@/strings/messages/TransformersJsManager__in_browser_ai_transformers_js_is_not_available_because_the_browser_does_not_support_or_allow_access_to/ko';
import { TransformersJsManager__in_browser_ai_transformers_js_is_not_available_in_the_standalone_build_due_to_browser_restrictions_on_web_workers_and_webassembly_when_running_from_a_local_file } from '@/strings/messages/TransformersJsManager__in_browser_ai_transformers_js_is_not_available_in_the_standalone_build_due_to_browser_restrictions_on_web_workers_and_webassembly_when_running_from_a_local_file/ko';
import { TransformersJsManager__incomplete } from '@/strings/messages/TransformersJsManager__incomplete/ko';
import { TransformersJsManager__initializing_engine } from '@/strings/messages/TransformersJsManager__initializing_engine/ko';
import { TransformersJsManager__load } from '@/strings/messages/TransformersJsManager__load/ko';
import { TransformersJsManager__load_a_model_from_the_list_below_to_start_in_browser_inference } from '@/strings/messages/TransformersJsManager__load_a_model_from_the_list_below_to_start_in_browser_inference/ko';
import { TransformersJsManager__loading_from_local_storage } from '@/strings/messages/TransformersJsManager__loading_from_local_storage/ko';
import { TransformersJsManager__local_cache } from '@/strings/messages/TransformersJsManager__local_cache/ko';
import { TransformersJsManager__model_is_already_downloaded } from '@/strings/messages/TransformersJsManager__model_is_already_downloaded/ko';
import { TransformersJsManager__models_are_cached_locally_in_the_browser_opfs_for_offline_use } from '@/strings/messages/TransformersJsManager__models_are_cached_locally_in_the_browser_opfs_for_offline_use/ko';
import { TransformersJsManager__no_models_downloaded_yet } from '@/strings/messages/TransformersJsManager__no_models_downloaded_yet/ko';
import { TransformersJsManager__no_models_match_your_filter } from '@/strings/messages/TransformersJsManager__no_models_match_your_filter/ko';
import { TransformersJsManager__note } from '@/strings/messages/TransformersJsManager__note/ko';
import { TransformersJsManager__origin_private_file_system_opfs } from '@/strings/messages/TransformersJsManager__origin_private_file_system_opfs/ko';
import { TransformersJsManager__overall_progress } from '@/strings/messages/TransformersJsManager__overall_progress/ko';
import { TransformersJsManager__preset_model_paths } from '@/strings/messages/TransformersJsManager__preset_model_paths/ko';
import { TransformersJsManager__refresh } from '@/strings/messages/TransformersJsManager__refresh/ko';
import { TransformersJsManager__restart } from '@/strings/messages/TransformersJsManager__restart/ko';
import { TransformersJsManager__restart_ai_engine } from '@/strings/messages/TransformersJsManager__restart_ai_engine/ko';
import { TransformersJsManager__resume } from '@/strings/messages/TransformersJsManager__resume/ko';
import { TransformersJsManager__select_a_folder_containing_onnx_model_files_to_import_it_into_the_browsers_storage } from '@/strings/messages/TransformersJsManager__select_a_folder_containing_onnx_model_files_to_import_it_into_the_browsers_storage/ko';
import { TransformersJsManager__select_model_folder } from '@/strings/messages/TransformersJsManager__select_model_folder/ko';
import { TransformersJsManager__successfully_downloaded_model } from '@/strings/messages/TransformersJsManager__successfully_downloaded_model/ko';
import { TransformersJsManager__successfully_imported_model } from '@/strings/messages/TransformersJsManager__successfully_imported_model/ko';
import { TransformersJsManager__this_will_terminate_the_current_background_worker_and_start_a_fresh_one_use_this_if_the_engine_becomes_unresponsive_or_shows_fatal_errors } from '@/strings/messages/TransformersJsManager__this_will_terminate_the_current_background_worker_and_start_a_fresh_one_use_this_if_the_engine_becomes_unresponsive_or_shows_fatal_errors/ko';
import { TransformersJsManager__unknown } from '@/strings/messages/TransformersJsManager__unknown/ko';
import { TransformersJsManager__unload_model_and_release_resources } from '@/strings/messages/TransformersJsManager__unload_model_and_release_resources/ko';
import { TransformersJsManager__use_custom_id } from '@/strings/messages/TransformersJsManager__use_custom_id/ko';
import { TransformersJsManager__which_is_required_for_storing_model_files_this_often_happens_in_private_browsing_modes_or_insecure_contexts } from '@/strings/messages/TransformersJsManager__which_is_required_for_storing_model_files_this_often_happens_in_private_browsing_modes_or_insecure_contexts/ko';
import { TransformersJsManager__writing_model_files_to_browser_local_storage_opfs } from '@/strings/messages/TransformersJsManager__writing_model_files_to_browser_local_storage_opfs/ko';
import { TransformersJsUpsell__add_manage_models } from '@/strings/messages/TransformersJsUpsell__add_manage_models/ko';
import { TransformersJsUpsell__local_browser_models } from '@/strings/messages/TransformersJsUpsell__local_browser_models/ko';
import { TransformersJsUpsell__need_more_models_you_can_download_and_manage_local_llms_to_run_directly_in_your_browser } from '@/strings/messages/TransformersJsUpsell__need_more_models_you_can_download_and_manage_local_llms_to_run_directly_in_your_browser/ko';
import { UnselectedChatPane__select_or_create_a_chat_to_start } from '@/strings/messages/UnselectedChatPane__select_or_create_a_chat_to_start/ko';
import { WelcomeScreen__all_conversations_are_stored_locally } from '@/strings/messages/WelcomeScreen__all_conversations_are_stored_locally/ko';
import { WelcomeScreen__brainstorm } from '@/strings/messages/WelcomeScreen__brainstorm/ko';
import { WelcomeScreen__code_help } from '@/strings/messages/WelcomeScreen__code_help/ko';
import { WelcomeScreen__conversations_are_stored_in_memory } from '@/strings/messages/WelcomeScreen__conversations_are_stored_in_memory/ko';
import { WelcomeScreen__data_is_cleared_on_reload } from '@/strings/messages/WelcomeScreen__data_is_cleared_on_reload/ko';
import { WelcomeScreen__download_portable_app } from '@/strings/messages/WelcomeScreen__download_portable_app/ko';
import { WelcomeScreen__download_standalone_portable_version } from '@/strings/messages/WelcomeScreen__download_standalone_portable_version/ko';
import { WelcomeScreen__explain_vue_composition_api } from '@/strings/messages/WelcomeScreen__explain_vue_composition_api/ko';
import { WelcomeScreen__home_automation_project_ideas } from '@/strings/messages/WelcomeScreen__home_automation_project_ideas/ko';
import { WelcomeScreen__summarize } from '@/strings/messages/WelcomeScreen__summarize/ko';
import { WelcomeScreen__summarize_local_lm_architectures } from '@/strings/messages/WelcomeScreen__summarize_local_lm_architectures/ko';
import { WelcomeScreen__write_a_story } from '@/strings/messages/WelcomeScreen__write_a_story/ko';
import { WelcomeScreen__write_a_time_travel_detective_story } from '@/strings/messages/WelcomeScreen__write_a_time_travel_detective_story/ko';
import { WelcomeScreen__your_data_stays_on_your_device } from '@/strings/messages/WelcomeScreen__your_data_stays_on_your_device/ko';
import { WeshToolSettings__shell } from '@/strings/messages/WeshToolSettings__shell/ko';
import { WeshToolSettings__shell_in_browser } from '@/strings/messages/WeshToolSettings__shell_in_browser/ko';
import { WeshToolSettings__shell_settings } from '@/strings/messages/WeshToolSettings__shell_settings/ko';
import { advancedTextEditor__aa } from '@/strings/messages/advancedTextEditor__aa/ko';
import { advancedTextEditor__cancel_esc } from '@/strings/messages/advancedTextEditor__cancel_esc/ko';
import { advancedTextEditor__chars } from '@/strings/messages/advancedTextEditor__chars/ko';
import { advancedTextEditor__clear_all } from '@/strings/messages/advancedTextEditor__clear_all/ko';
import { advancedTextEditor__close_editor_esc } from '@/strings/messages/advancedTextEditor__close_editor_esc/ko';
import { advancedTextEditor__confirm_enter } from '@/strings/messages/advancedTextEditor__confirm_enter/ko';
import { advancedTextEditor__copy_all } from '@/strings/messages/advancedTextEditor__copy_all/ko';
import { advancedTextEditor__enter } from '@/strings/messages/advancedTextEditor__enter/ko';
import { advancedTextEditor__enter_to_find_next } from '@/strings/messages/advancedTextEditor__enter_to_find_next/ko';
import { advancedTextEditor__esc } from '@/strings/messages/advancedTextEditor__esc/ko';
import { advancedTextEditor__find_and_replace_with_shortcut } from '@/strings/messages/advancedTextEditor__find_and_replace_with_shortcut/ko';
import { advancedTextEditor__instance_count } from '@/strings/messages/advancedTextEditor__instance_count/ko';
import { advancedTextEditor__lines } from '@/strings/messages/advancedTextEditor__lines/ko';
import { advancedTextEditor__match_case } from '@/strings/messages/advancedTextEditor__match_case/ko';
import { advancedTextEditor__multi_edit_mode } from '@/strings/messages/advancedTextEditor__multi_edit_mode/ko';
import { advancedTextEditor__multi_edit_occurrence_with_shortcut } from '@/strings/messages/advancedTextEditor__multi_edit_occurrence_with_shortcut/ko';
import { advancedTextEditor__redo_with_shortcut } from '@/strings/messages/advancedTextEditor__redo_with_shortcut/ko';
import { advancedTextEditor__renaming_text } from '@/strings/messages/advancedTextEditor__renaming_text/ko';
import { advancedTextEditor__replace } from '@/strings/messages/advancedTextEditor__replace/ko';
import { advancedTextEditor__replace_all } from '@/strings/messages/advancedTextEditor__replace_all/ko';
import { advancedTextEditor__replace_with } from '@/strings/messages/advancedTextEditor__replace_with/ko';
import { advancedTextEditor__search } from '@/strings/messages/advancedTextEditor__search/ko';
import { advancedTextEditor__selection } from '@/strings/messages/advancedTextEditor__selection/ko';
import { advancedTextEditor__steps } from '@/strings/messages/advancedTextEditor__steps/ko';
import { advancedTextEditor__switch_to_advanced_editor } from '@/strings/messages/advancedTextEditor__switch_to_advanced_editor/ko';
import { advancedTextEditor__switch_to_normal_textarea } from '@/strings/messages/advancedTextEditor__switch_to_normal_textarea/ko';
import { advancedTextEditor__to_apply } from '@/strings/messages/advancedTextEditor__to_apply/ko';
import { advancedTextEditor__to_cancel } from '@/strings/messages/advancedTextEditor__to_cancel/ko';
import { advancedTextEditor__toggle_stats } from '@/strings/messages/advancedTextEditor__toggle_stats/ko';
import { advancedTextEditor__toggle_word_wrap } from '@/strings/messages/advancedTextEditor__toggle_word_wrap/ko';
import { advancedTextEditor__type_to_rename_all } from '@/strings/messages/advancedTextEditor__type_to_rename_all/ko';
import { advancedTextEditor__type_to_replace_all } from '@/strings/messages/advancedTextEditor__type_to_replace_all/ko';
import { advancedTextEditor__undo_with_shortcut } from '@/strings/messages/advancedTextEditor__undo_with_shortcut/ko';
import { advancedTextEditor__updating } from '@/strings/messages/advancedTextEditor__updating/ko';
import { advancedTextEditor__use_regex } from '@/strings/messages/advancedTextEditor__use_regex/ko';
import { advancedTextEditor__words } from '@/strings/messages/advancedTextEditor__words/ko';
import { binaryObjects__binary_objects } from '@/strings/messages/binaryObjects__binary_objects/ko';
import { binaryObjects__close_with_escape } from '@/strings/messages/binaryObjects__close_with_escape/ko';
import { binaryObjects__copy_name } from '@/strings/messages/binaryObjects__copy_name/ko';
import { binaryObjects__date } from '@/strings/messages/binaryObjects__date/ko';
import { binaryObjects__delete } from '@/strings/messages/binaryObjects__delete/ko';
import { binaryObjects__download } from '@/strings/messages/binaryObjects__download/ko';
import { binaryObjects__file_type_cannot_be_previewed } from '@/strings/messages/binaryObjects__file_type_cannot_be_previewed/ko';
import { binaryObjects__loading } from '@/strings/messages/binaryObjects__loading/ko';
import { binaryObjects__loading_more } from '@/strings/messages/binaryObjects__loading_more/ko';
import { binaryObjects__loading_objects } from '@/strings/messages/binaryObjects__loading_objects/ko';
import { binaryObjects__manage_persisted_files } from '@/strings/messages/binaryObjects__manage_persisted_files/ko';
import { binaryObjects__name } from '@/strings/messages/binaryObjects__name/ko';
import { binaryObjects__no_objects_found } from '@/strings/messages/binaryObjects__no_objects_found/ko';
import { binaryObjects__preview_unavailable } from '@/strings/messages/binaryObjects__preview_unavailable/ko';
import { binaryObjects__reset_zoom } from '@/strings/messages/binaryObjects__reset_zoom/ko';
import { binaryObjects__search_by_name_id_or_type } from '@/strings/messages/binaryObjects__search_by_name_id_or_type/ko';
import { binaryObjects__size } from '@/strings/messages/binaryObjects__size/ko';
import { binaryObjects__unnamed } from '@/strings/messages/binaryObjects__unnamed/ko';
import { binaryObjects__zoom_in } from '@/strings/messages/binaryObjects__zoom_in/ko';
import { binaryObjects__zoom_out } from '@/strings/messages/binaryObjects__zoom_out/ko';
import { blockMarkdown__allow_all_external_images_in_this_session } from '@/strings/messages/blockMarkdown__allow_all_external_images_in_this_session/ko';
import { blockMarkdown__code } from '@/strings/messages/blockMarkdown__code/ko';
import { blockMarkdown__copied } from '@/strings/messages/blockMarkdown__copied/ko';
import { blockMarkdown__copy_code } from '@/strings/messages/blockMarkdown__copy_code/ko';
import { blockMarkdown__copy_source } from '@/strings/messages/blockMarkdown__copy_source/ko';
import { blockMarkdown__external_image } from '@/strings/messages/blockMarkdown__external_image/ko';
import { blockMarkdown__failed_to_embed_metadata_in_image } from '@/strings/messages/blockMarkdown__failed_to_embed_metadata_in_image/ko';
import { blockMarkdown__failed_to_load_image } from '@/strings/messages/blockMarkdown__failed_to_load_image/ko';
import { blockMarkdown__failed_to_render_mermaid_diagram } from '@/strings/messages/blockMarkdown__failed_to_render_mermaid_diagram/ko';
import { blockMarkdown__image_not_found_in_storage } from '@/strings/messages/blockMarkdown__image_not_found_in_storage/ko';
import { blockMarkdown__invalid_image_block_data } from '@/strings/messages/blockMarkdown__invalid_image_block_data/ko';
import { blockMarkdown__preview } from '@/strings/messages/blockMarkdown__preview/ko';
import { blockMarkdown__split_view } from '@/strings/messages/blockMarkdown__split_view/ko';
import { blockMarkdown__toggle_line_wrap } from '@/strings/messages/blockMarkdown__toggle_line_wrap/ko';
import { blockMarkdown__unknown_token_type } from '@/strings/messages/blockMarkdown__unknown_token_type/ko';
import { chatApproval__allow_action } from '@/strings/messages/chatApproval__allow_action/ko';
import { chatApproval__allow_for_this_chat } from '@/strings/messages/chatApproval__allow_for_this_chat/ko';
import { chatApproval__allow_globally } from '@/strings/messages/chatApproval__allow_globally/ko';
import { chatApproval__allow_once } from '@/strings/messages/chatApproval__allow_once/ko';
import { chatApproval__deny } from '@/strings/messages/chatApproval__deny/ko';
import { chatApproval__get_wikipedia_page } from '@/strings/messages/chatApproval__get_wikipedia_page/ko';
import { chatApproval__keyword_label } from '@/strings/messages/chatApproval__keyword_label/ko';
import { chatApproval__page_id_label } from '@/strings/messages/chatApproval__page_id_label/ko';
import { chatApproval__search_wikipedia } from '@/strings/messages/chatApproval__search_wikipedia/ko';
import { chatGenerationFlow__attachments_cannot_be_saved } from '@/strings/messages/chatGenerationFlow__attachments_cannot_be_saved/ko';
import { chatGenerationFlow__cancel } from '@/strings/messages/chatGenerationFlow__cancel/ko';
import { chatGenerationFlow__continue_anyway } from '@/strings/messages/chatGenerationFlow__continue_anyway/ko';
import { chatGenerationFlow__generation_failed_in_chat } from '@/strings/messages/chatGenerationFlow__generation_failed_in_chat/ko';
import { chatGenerationFlow__local_storage_attachments_are_only_available_during_this_session } from '@/strings/messages/chatGenerationFlow__local_storage_attachments_are_only_available_during_this_session/ko';
import { chatGenerationFlow__no_image_generation_model_was_found } from '@/strings/messages/chatGenerationFlow__no_image_generation_model_was_found/ko';
import { chatGenerationFlow__view } from '@/strings/messages/chatGenerationFlow__view/ko';
import { chatHistoryFlow__fork_of_chat } from '@/strings/messages/chatHistoryFlow__fork_of_chat/ko';
import { chatModelFetch__failed_to_fetch_models_for_resolution } from '@/strings/messages/chatModelFetch__failed_to_fetch_models_for_resolution/ko';
import { contextCompact__aborted } from '@/strings/messages/contextCompact__aborted/ko';
import { contextCompact__applying_compact_branch } from '@/strings/messages/contextCompact__applying_compact_branch/ko';
import { contextCompact__balanced } from '@/strings/messages/contextCompact__balanced/ko';
import { contextCompact__building_compact_request } from '@/strings/messages/contextCompact__building_compact_request/ko';
import { contextCompact__cancel } from '@/strings/messages/contextCompact__cancel/ko';
import { contextCompact__compact } from '@/strings/messages/contextCompact__compact/ko';
import { contextCompact__compact_context } from '@/strings/messages/contextCompact__compact_context/ko';
import { contextCompact__compact_now } from '@/strings/messages/contextCompact__compact_now/ko';
import { contextCompact__compact_prompt } from '@/strings/messages/contextCompact__compact_prompt/ko';
import { contextCompact__compacting_context } from '@/strings/messages/contextCompact__compacting_context/ko';
import { contextCompact__compacting_context_failed } from '@/strings/messages/contextCompact__compacting_context_failed/ko';
import { contextCompact__compacting_will_condense_messages_into_a_single_summary } from '@/strings/messages/contextCompact__compacting_will_condense_messages_into_a_single_summary/ko';
import { contextCompact__complete } from '@/strings/messages/contextCompact__complete/ko';
import { contextCompact__deep } from '@/strings/messages/contextCompact__deep/ko';
import { contextCompact__editable_prompt } from '@/strings/messages/contextCompact__editable_prompt/ko';
import { contextCompact__generating_compact_context_with_characters_received } from '@/strings/messages/contextCompact__generating_compact_context_with_characters_received/ko';
import { contextCompact__memory_reconfiguration } from '@/strings/messages/contextCompact__memory_reconfiguration/ko';
import { contextCompact__messages_to_keep } from '@/strings/messages/contextCompact__messages_to_keep/ko';
import { contextCompact__more_context } from '@/strings/messages/contextCompact__more_context/ko';
import { contextCompact__more_history } from '@/strings/messages/contextCompact__more_history/ko';
import { contextCompact__preparing_messages_and_keeping_recent_messages } from '@/strings/messages/contextCompact__preparing_messages_and_keeping_recent_messages/ko';
import { contextCompact__requires_a_configured_model_and_endpoint } from '@/strings/messages/contextCompact__requires_a_configured_model_and_endpoint/ko';
import { contextCompact__response_was_empty } from '@/strings/messages/contextCompact__response_was_empty/ko';
import { contextCompact__to_compact } from '@/strings/messages/contextCompact__to_compact/ko';
import { contextCompact__to_keep } from '@/strings/messages/contextCompact__to_keep/ko';
import { contextCompact__waiting_for_the_model } from '@/strings/messages/contextCompact__waiting_for_the_model/ko';
import { dataDeletion__advanced_mode } from '@/strings/messages/dataDeletion__advanced_mode/ko';
import { dataDeletion__checked_selectors_matching_entries } from '@/strings/messages/dataDeletion__checked_selectors_matching_entries/ko';
import { dataDeletion__delete_application_data } from '@/strings/messages/dataDeletion__delete_application_data/ko';
import { dataDeletion__delete_data_matched_by_selected_selectors } from '@/strings/messages/dataDeletion__delete_data_matched_by_selected_selectors/ko';
import { dataDeletion__delete_selected_data } from '@/strings/messages/dataDeletion__delete_selected_data/ko';
import { dataDeletion__delete_selected_data_and_reload } from '@/strings/messages/dataDeletion__delete_selected_data_and_reload/ko';
import { dataDeletion__delete_selected_data_question } from '@/strings/messages/dataDeletion__delete_selected_data_question/ko';
import { dataDeletion__deletion_preview } from '@/strings/messages/dataDeletion__deletion_preview/ko';
import { dataDeletion__developer_focused_deletion_controls_for_naidan_storage_selectors } from '@/strings/messages/dataDeletion__developer_focused_deletion_controls_for_naidan_storage_selectors/ko';
import { dataDeletion__factory_reset } from '@/strings/messages/dataDeletion__factory_reset/ko';
import { dataDeletion__no_matching_entries } from '@/strings/messages/dataDeletion__no_matching_entries/ko';
import { dataDeletion__not_available_in_this_runtime } from '@/strings/messages/dataDeletion__not_available_in_this_runtime/ko';
import { dataDeletion__preview_entries } from '@/strings/messages/dataDeletion__preview_entries/ko';
import { dataDeletion__scanning_storage } from '@/strings/messages/dataDeletion__scanning_storage/ko';
import { dataDeletion__select_at_least_one_deletion_selector } from '@/strings/messages/dataDeletion__select_at_least_one_deletion_selector/ko';
import { fileExplorer__add } from '@/strings/messages/fileExplorer__add/ko';
import { fileExplorer__archive_name } from '@/strings/messages/fileExplorer__archive_name/ko';
import { fileExplorer__binary_file } from '@/strings/messages/fileExplorer__binary_file/ko';
import { fileExplorer__byte_count } from '@/strings/messages/fileExplorer__byte_count/ko';
import { fileExplorer__close } from '@/strings/messages/fileExplorer__close/ko';
import { fileExplorer__close_preview } from '@/strings/messages/fileExplorer__close_preview/ko';
import { fileExplorer__column_view } from '@/strings/messages/fileExplorer__column_view/ko';
import { fileExplorer__copy } from '@/strings/messages/fileExplorer__copy/ko';
import { fileExplorer__create } from '@/strings/messages/fileExplorer__create/ko';
import { fileExplorer__creating_archive } from '@/strings/messages/fileExplorer__creating_archive/ko';
import { fileExplorer__cut } from '@/strings/messages/fileExplorer__cut/ko';
import { fileExplorer__delete } from '@/strings/messages/fileExplorer__delete/ko';
import { fileExplorer__delete_confirmation } from '@/strings/messages/fileExplorer__delete_confirmation/ko';
import { fileExplorer__delete_file } from '@/strings/messages/fileExplorer__delete_file/ko';
import { fileExplorer__delete_folder } from '@/strings/messages/fileExplorer__delete_folder/ko';
import { fileExplorer__delete_items } from '@/strings/messages/fileExplorer__delete_items/ko';
import { fileExplorer__download } from '@/strings/messages/fileExplorer__download/ko';
import { fileExplorer__download_directory } from '@/strings/messages/fileExplorer__download_directory/ko';
import { fileExplorer__empty } from '@/strings/messages/fileExplorer__empty/ko';
import { fileExplorer__empty_folder } from '@/strings/messages/fileExplorer__empty_folder/ko';
import { fileExplorer__enter_a_name_for_the_new_file } from '@/strings/messages/fileExplorer__enter_a_name_for_the_new_file/ko';
import { fileExplorer__enter_a_name_for_the_new_folder } from '@/strings/messages/fileExplorer__enter_a_name_for_the_new_folder/ko';
import { fileExplorer__entry_info } from '@/strings/messages/fileExplorer__entry_info/ko';
import { fileExplorer__exclude_items } from '@/strings/messages/fileExplorer__exclude_items/ko';
import { fileExplorer__exclude_items_help } from '@/strings/messages/fileExplorer__exclude_items_help/ko';
import { fileExplorer__failed_to_copy_items } from '@/strings/messages/fileExplorer__failed_to_copy_items/ko';
import { fileExplorer__failed_to_create_file } from '@/strings/messages/fileExplorer__failed_to_create_file/ko';
import { fileExplorer__failed_to_create_folder } from '@/strings/messages/fileExplorer__failed_to_create_folder/ko';
import { fileExplorer__failed_to_load_exclusion_suggestions } from '@/strings/messages/fileExplorer__failed_to_load_exclusion_suggestions/ko';
import { fileExplorer__failed_to_delete } from '@/strings/messages/fileExplorer__failed_to_delete/ko';
import { fileExplorer__failed_to_download } from '@/strings/messages/fileExplorer__failed_to_download/ko';
import { fileExplorer__failed_to_load_directory } from '@/strings/messages/fileExplorer__failed_to_load_directory/ko';
import { fileExplorer__failed_to_move_items } from '@/strings/messages/fileExplorer__failed_to_move_items/ko';
import { fileExplorer__failed_to_rename } from '@/strings/messages/fileExplorer__failed_to_rename/ko';
import { fileExplorer__failed_to_upload_files } from '@/strings/messages/fileExplorer__failed_to_upload_files/ko';
import { fileExplorer__file } from '@/strings/messages/fileExplorer__file/ko';
import { fileExplorer__file_explorer_opfs } from '@/strings/messages/fileExplorer__file_explorer_opfs/ko';
import { fileExplorer__file_is_too_large_to_preview } from '@/strings/messages/fileExplorer__file_is_too_large_to_preview/ko';
import { fileExplorer__files } from '@/strings/messages/fileExplorer__files/ko';
import { fileExplorer__filter_by_name } from '@/strings/messages/fileExplorer__filter_by_name/ko';
import { fileExplorer__folder } from '@/strings/messages/fileExplorer__folder/ko';
import { fileExplorer__folder_is_no_longer_available } from '@/strings/messages/fileExplorer__folder_is_no_longer_available/ko';
import { fileExplorer__format } from '@/strings/messages/fileExplorer__format/ko';
import { fileExplorer__get_info } from '@/strings/messages/fileExplorer__get_info/ko';
import { fileExplorer__go_back } from '@/strings/messages/fileExplorer__go_back/ko';
import { fileExplorer__hide_preview } from '@/strings/messages/fileExplorer__hide_preview/ko';
import { fileExplorer__icon_view } from '@/strings/messages/fileExplorer__icon_view/ko';
import { fileExplorer__item_count_label } from '@/strings/messages/fileExplorer__item_count_label/ko';
import { fileExplorer__list_view } from '@/strings/messages/fileExplorer__list_view/ko';
import { fileExplorer__load_anyway } from '@/strings/messages/fileExplorer__load_anyway/ko';
import { fileExplorer__locked_click_to_unlock } from '@/strings/messages/fileExplorer__locked_click_to_unlock/ko';
import { fileExplorer__modified } from '@/strings/messages/fileExplorer__modified/ko';
import { fileExplorer__modified_label } from '@/strings/messages/fileExplorer__modified_label/ko';
import { fileExplorer__name } from '@/strings/messages/fileExplorer__name/ko';
import { fileExplorer__new_file } from '@/strings/messages/fileExplorer__new_file/ko';
import { fileExplorer__new_file_unlock_to_enable } from '@/strings/messages/fileExplorer__new_file_unlock_to_enable/ko';
import { fileExplorer__new_folder } from '@/strings/messages/fileExplorer__new_folder/ko';
import { fileExplorer__new_folder_unlock_to_enable } from '@/strings/messages/fileExplorer__new_folder_unlock_to_enable/ko';
import { fileExplorer__no_matching_items } from '@/strings/messages/fileExplorer__no_matching_items/ko';
import { fileExplorer__open } from '@/strings/messages/fileExplorer__open/ko';
import { fileExplorer__optional } from '@/strings/messages/fileExplorer__optional/ko';
import { fileExplorer__paste } from '@/strings/messages/fileExplorer__paste/ko';
import { fileExplorer__preview } from '@/strings/messages/fileExplorer__preview/ko';
import { fileExplorer__refresh } from '@/strings/messages/fileExplorer__refresh/ko';
import { fileExplorer__relative_path } from '@/strings/messages/fileExplorer__relative_path/ko';
import { fileExplorer__rename } from '@/strings/messages/fileExplorer__rename/ko';
import { fileExplorer__search } from '@/strings/messages/fileExplorer__search/ko';
import { fileExplorer__select_a_file } from '@/strings/messages/fileExplorer__select_a_file/ko';
import { fileExplorer__select_all } from '@/strings/messages/fileExplorer__select_all/ko';
import { fileExplorer__selected_count_label } from '@/strings/messages/fileExplorer__selected_count_label/ko';
import { fileExplorer__show_preview } from '@/strings/messages/fileExplorer__show_preview/ko';
import { fileExplorer__size } from '@/strings/messages/fileExplorer__size/ko';
import { fileExplorer__size_label } from '@/strings/messages/fileExplorer__size_label/ko';
import { fileExplorer__type } from '@/strings/messages/fileExplorer__type/ko';
import { fileExplorer__type_to_narrow_results } from '@/strings/messages/fileExplorer__type_to_narrow_results/ko';
import { fileExplorer__unlock_to_enable } from '@/strings/messages/fileExplorer__unlock_to_enable/ko';
import { fileExplorer__unlocked_click_to_lock } from '@/strings/messages/fileExplorer__unlocked_click_to_lock/ko';
import { fileExplorer__unsupported_items_were_skipped } from '@/strings/messages/fileExplorer__unsupported_items_were_skipped/ko';
import { fileExplorer__upload_files } from '@/strings/messages/fileExplorer__upload_files/ko';
import { fileExplorer__upload_files_unlock_to_enable } from '@/strings/messages/fileExplorer__upload_files_unlock_to_enable/ko';
import { fileExplorer__addition_count } from '@/strings/messages/fileExplorer__addition_count/ko';
import { fileExplorer__analyzing_zip } from '@/strings/messages/fileExplorer__analyzing_zip/ko';
import { fileExplorer__blocked_count } from '@/strings/messages/fileExplorer__blocked_count/ko';
import { fileExplorer__cannot_be_placed } from '@/strings/messages/fileExplorer__cannot_be_placed/ko';
import { fileExplorer__existing } from '@/strings/messages/fileExplorer__existing/ko';
import { fileExplorer__extract_and_place } from '@/strings/messages/fileExplorer__extract_and_place/ko';
import { fileExplorer__extract_and_place_description } from '@/strings/messages/fileExplorer__extract_and_place_description/ko';
import { fileExplorer__merge_count } from '@/strings/messages/fileExplorer__merge_count/ko';
import { fileExplorer__next_zip } from '@/strings/messages/fileExplorer__next_zip/ko';
import { fileExplorer__not_changed_yet } from '@/strings/messages/fileExplorer__not_changed_yet/ko';
import { fileExplorer__overwrite_count } from '@/strings/messages/fileExplorer__overwrite_count/ko';
import { fileExplorer__place_contents_here } from '@/strings/messages/fileExplorer__place_contents_here/ko';
import { fileExplorer__place_contents_here_description } from '@/strings/messages/fileExplorer__place_contents_here_description/ko';
import { fileExplorer__place_directory_itself } from '@/strings/messages/fileExplorer__place_directory_itself/ko';
import { fileExplorer__place_directory_itself_description } from '@/strings/messages/fileExplorer__place_directory_itself_description/ko';
import { fileExplorer__place_zip_file_as_is } from '@/strings/messages/fileExplorer__place_zip_file_as_is/ko';
import { fileExplorer__place_zip_file_as_is_description } from '@/strings/messages/fileExplorer__place_zip_file_as_is_description/ko';
import { fileExplorer__placement_method } from '@/strings/messages/fileExplorer__placement_method/ko';
import { fileExplorer__placement_preview } from '@/strings/messages/fileExplorer__placement_preview/ko';
import { fileExplorer__planned_addition } from '@/strings/messages/fileExplorer__planned_addition/ko';
import { fileExplorer__planned_merge } from '@/strings/messages/fileExplorer__planned_merge/ko';
import { fileExplorer__planned_overwrite } from '@/strings/messages/fileExplorer__planned_overwrite/ko';
import { fileExplorer__root_directory_handling } from '@/strings/messages/fileExplorer__root_directory_handling/ko';
import { fileExplorer__status } from '@/strings/messages/fileExplorer__status/ko';
import { fileExplorer__uploading } from '@/strings/messages/fileExplorer__uploading/ko';
import { fileExplorer__zip_archive } from '@/strings/messages/fileExplorer__zip_archive/ko';
import { fileExplorer__zip_cannot_be_extracted } from '@/strings/messages/fileExplorer__zip_cannot_be_extracted/ko';
import { fileExplorer__zip_file_upload } from '@/strings/messages/fileExplorer__zip_file_upload/ko';
import { fileExplorer__zip_upload_preview_outdated } from '@/strings/messages/fileExplorer__zip_upload_preview_outdated/ko';
import { formatSettingsSourceLabel__default } from '@/strings/messages/formatSettingsSourceLabel__default/ko';
import { formatSettingsSourceLabel__value_from_chat } from '@/strings/messages/formatSettingsSourceLabel__value_from_chat/ko';
import { formatSettingsSourceLabel__none } from '@/strings/messages/formatSettingsSourceLabel__none/ko';
import { formatSettingsSourceLabel__value_from_global } from '@/strings/messages/formatSettingsSourceLabel__value_from_global/ko';
import { formatSettingsSourceLabel__value_from_group } from '@/strings/messages/formatSettingsSourceLabel__value_from_group/ko';
import { toolCall__arguments } from '@/strings/messages/toolCall__arguments/ko';
import { toolCall__code } from '@/strings/messages/toolCall__code/ko';
import { toolCall__disable_wrap } from '@/strings/messages/toolCall__disable_wrap/ko';
import { toolCall__enable_wrap } from '@/strings/messages/toolCall__enable_wrap/ko';
import { toolCall__error } from '@/strings/messages/toolCall__error/ko';
import { toolCall__executing } from '@/strings/messages/toolCall__executing/ko';
import { toolCall__hide_tool_executions } from '@/strings/messages/toolCall__hide_tool_executions/ko';
import { toolCall__live_output } from '@/strings/messages/toolCall__live_output/ko';
import { toolCall__loading_large_result } from '@/strings/messages/toolCall__loading_large_result/ko';
import { toolCall__raw_json } from '@/strings/messages/toolCall__raw_json/ko';
import { toolCall__result } from '@/strings/messages/toolCall__result/ko';
import { toolCall__show_tools_count } from '@/strings/messages/toolCall__show_tools_count/ko';
import { toolCall__tool_executions } from '@/strings/messages/toolCall__tool_executions/ko';
import { useBinaryActions__delete_binary_object } from '@/strings/messages/useBinaryActions__delete_binary_object/ko';
import { useBinaryActions__delete_binary_object_warning } from '@/strings/messages/useBinaryActions__delete_binary_object_warning/ko';
import { useBinaryActions__delete_permanently } from '@/strings/messages/useBinaryActions__delete_permanently/ko';
import { useChatLifecycle__chat_was_deleted } from '@/strings/messages/useChatLifecycle__chat_was_deleted/ko';
import { useChatLifecycle__undo } from '@/strings/messages/useChatLifecycle__undo/ko';
import { useChatOrganization__copy_of_chat_group } from '@/strings/messages/useChatOrganization__copy_of_chat_group/ko';
import { useImageGeneration__failed_to_generate_image } from '@/strings/messages/useImageGeneration__failed_to_generate_image/ko';
import { useImageGeneration__failed_to_reencode_image } from '@/strings/messages/useImageGeneration__failed_to_reencode_image/ko';
import { useImageGeneration__no_suitable_image_generation_model_found } from '@/strings/messages/useImageGeneration__no_suitable_image_generation_model_found/ko';
import { usePrompt__prompt } from '@/strings/messages/usePrompt__prompt/ko';
import { useSettings__data_successfully_imported_from_url } from '@/strings/messages/useSettings__data_successfully_imported_from_url/ko';
import { useSettings__failed_to_fetch_models_for_settings } from '@/strings/messages/useSettings__failed_to_fetch_models_for_settings/ko';
import { useSettings__failed_to_import_data_from_url } from '@/strings/messages/useSettings__failed_to_import_data_from_url/ko';
import { useSettings__invalid_storage_type_falling_back_to_default_detection } from '@/strings/messages/useSettings__invalid_storage_type_falling_back_to_default_detection/ko';
import { useSettings__ok } from '@/strings/messages/useSettings__ok/ko';
import { useSettings__request_to_use_storage_type_was_ignored } from '@/strings/messages/useSettings__request_to_use_storage_type_was_ignored/ko';
import { useSettings__storage_already_initialized } from '@/strings/messages/useSettings__storage_already_initialized/ko';
import { useSettings__storage_type_is_already_set_and_requested_type_was_ignored } from '@/strings/messages/useSettings__storage_type_is_already_set_and_requested_type_was_ignored/ko';
import { volumes__access_mode } from '@/strings/messages/volumes__access_mode/ko';
import { volumes__active_count } from '@/strings/messages/volumes__active_count/ko';
import { volumes__add_folder } from '@/strings/messages/volumes__add_folder/ko';
import { volumes__add_folder_requires_chromium } from '@/strings/messages/volumes__add_folder_requires_chromium/ko';
import { volumes__add_or_copy_folder_into_browser_storage } from '@/strings/messages/volumes__add_or_copy_folder_into_browser_storage/ko';
import { volumes__ai_can_read_and_modify_files } from '@/strings/messages/volumes__ai_can_read_and_modify_files/ko';
import { volumes__ai_can_read_not_write } from '@/strings/messages/volumes__ai_can_read_not_write/ko';
import { volumes__cancel } from '@/strings/messages/volumes__cancel/ko';
import { volumes__change_access_later } from '@/strings/messages/volumes__change_access_later/ko';
import { volumes__choose_access_level } from '@/strings/messages/volumes__choose_access_level/ko';
import { volumes__chromium_browser_over_https } from '@/strings/messages/volumes__chromium_browser_over_https/ko';
import { volumes__configure } from '@/strings/messages/volumes__configure/ko';
import { volumes__copied } from '@/strings/messages/volumes__copied/ko';
import { volumes__copied_folder } from '@/strings/messages/volumes__copied_folder/ko';
import { volumes__copy_does_not_change_disk_files } from '@/strings/messages/volumes__copy_does_not_change_disk_files/ko';
import { volumes__copy_folder } from '@/strings/messages/volumes__copy_folder/ko';
import { volumes__copy_is_stored_in_browser_opfs } from '@/strings/messages/volumes__copy_is_stored_in_browser_opfs/ko';
import { volumes__copy_single_file_instead } from '@/strings/messages/volumes__copy_single_file_instead/ko';
import { volumes__copying_file_to_browser } from '@/strings/messages/volumes__copying_file_to_browser/ko';
import { volumes__copying_folder_to_browser } from '@/strings/messages/volumes__copying_folder_to_browser/ko';
import { volumes__delete } from '@/strings/messages/volumes__delete/ko';
import { volumes__delete_folder } from '@/strings/messages/volumes__delete_folder/ko';
import { volumes__delete_folder_warning } from '@/strings/messages/volumes__delete_folder_warning/ko';
import { volumes__drop_to_copy_to_browser } from '@/strings/messages/volumes__drop_to_copy_to_browser/ko';
import { volumes__failed_to_add_folder } from '@/strings/messages/volumes__failed_to_add_folder/ko';
import { volumes__failed_to_add_folder_with_error } from '@/strings/messages/volumes__failed_to_add_folder_with_error/ko';
import { volumes__failed_to_copy } from '@/strings/messages/volumes__failed_to_copy/ko';
import { volumes__failed_to_copy_file } from '@/strings/messages/volumes__failed_to_copy_file/ko';
import { volumes__failed_to_copy_folder } from '@/strings/messages/volumes__failed_to_copy_folder/ko';
import { volumes__failed_to_delete_folder } from '@/strings/messages/volumes__failed_to_delete_folder/ko';
import { volumes__failed_to_load_folders } from '@/strings/messages/volumes__failed_to_load_folders/ko';
import { volumes__failed_to_remove_folder } from '@/strings/messages/volumes__failed_to_remove_folder/ko';
import { volumes__failed_to_rename_folder } from '@/strings/messages/volumes__failed_to_rename_folder/ko';
import { volumes__failed_to_update_path_settings } from '@/strings/messages/volumes__failed_to_update_path_settings/ko';
import { volumes__file_copied_to_your_folders } from '@/strings/messages/volumes__file_copied_to_your_folders/ko';
import { volumes__file_progress } from '@/strings/messages/volumes__file_progress/ko';
import { volumes__folder_added_to_your_folders } from '@/strings/messages/volumes__folder_added_to_your_folders/ko';
import { volumes__folder_deleted } from '@/strings/messages/volumes__folder_deleted/ko';
import { volumes__folder_is_no_longer_in_use } from '@/strings/messages/volumes__folder_is_no_longer_in_use/ko';
import { volumes__folder_is_now_in_use } from '@/strings/messages/volumes__folder_is_now_in_use/ko';
import { volumes__folder_or_file } from '@/strings/messages/volumes__folder_or_file/ko';
import { volumes__folder_removed } from '@/strings/messages/volumes__folder_removed/ko';
import { volumes__folders } from '@/strings/messages/volumes__folders/ko';
import { volumes__give_ai_access_to_files_in_your_folders } from '@/strings/messages/volumes__give_ai_access_to_files_in_your_folders/ko';
import { volumes__imported_folder } from '@/strings/messages/volumes__imported_folder/ko';
import { volumes__in_use } from '@/strings/messages/volumes__in_use/ko';
import { volumes__in_use_globally } from '@/strings/messages/volumes__in_use_globally/ko';
import { volumes__linked } from '@/strings/messages/volumes__linked/ko';
import { volumes__linked_folder } from '@/strings/messages/volumes__linked_folder/ko';
import { volumes__linking_external_folders_not_supported } from '@/strings/messages/volumes__linking_external_folders_not_supported/ko';
import { volumes__more_actions } from '@/strings/messages/volumes__more_actions/ko';
import { volumes__mount_path_already_in_use } from '@/strings/messages/volumes__mount_path_already_in_use/ko';
import { volumes__name_cannot_be_empty } from '@/strings/messages/volumes__name_cannot_be_empty/ko';
import { volumes__no_folders_configured } from '@/strings/messages/volumes__no_folders_configured/ko';
import { volumes__not_in_use } from '@/strings/messages/volumes__not_in_use/ko';
import { volumes__not_in_use_globally } from '@/strings/messages/volumes__not_in_use_globally/ko';
import { volumes__not_supported_in_browser_or_context } from '@/strings/messages/volumes__not_supported_in_browser_or_context/ko';
import { volumes__opfs_not_supported } from '@/strings/messages/volumes__opfs_not_supported/ko';
import { volumes__original_folder_is_never_touched } from '@/strings/messages/volumes__original_folder_is_never_touched/ko';
import { volumes__path } from '@/strings/messages/volumes__path/ko';
import { volumes__path_settings_updated } from '@/strings/messages/volumes__path_settings_updated/ko';
import { volumes__permission_denied_folder_may_not_be_accessible } from '@/strings/messages/volumes__permission_denied_folder_may_not_be_accessible/ko';
import { volumes__read_only } from '@/strings/messages/volumes__read_only/ko';
import { volumes__read_write } from '@/strings/messages/volumes__read_write/ko';
import { volumes__remove } from '@/strings/messages/volumes__remove/ko';
import { volumes__remove_folder } from '@/strings/messages/volumes__remove_folder/ko';
import { volumes__remove_folder_warning } from '@/strings/messages/volumes__remove_folder_warning/ko';
import { volumes__rename } from '@/strings/messages/volumes__rename/ko';
import { volumes__save } from '@/strings/messages/volumes__save/ko';
import { volumes__save_changes } from '@/strings/messages/volumes__save_changes/ko';
import { volumes__stop_using } from '@/strings/messages/volumes__stop_using/ko';
import { volumes__use } from '@/strings/messages/volumes__use/ko';
import { volumes__what_is_copy_folder } from '@/strings/messages/volumes__what_is_copy_folder/ko';
import { volumes__why_add_folder_disabled } from '@/strings/messages/volumes__why_add_folder_disabled/ko';
import { weshTerminal__cancel } from '@/strings/messages/weshTerminal__cancel/ko';
import { weshTerminal__close_session } from '@/strings/messages/weshTerminal__close_session/ko';
import { weshTerminal__close_session_aria } from '@/strings/messages/weshTerminal__close_session_aria/ko';
import { weshTerminal__close_session_question } from '@/strings/messages/weshTerminal__close_session_question/ko';
import { weshTerminal__close_terminal } from '@/strings/messages/weshTerminal__close_terminal/ko';
import { weshTerminal__debug_terminal } from '@/strings/messages/weshTerminal__debug_terminal/ko';
import { weshTerminal__initializing_worker } from '@/strings/messages/weshTerminal__initializing_worker/ko';
import { weshTerminal__new } from '@/strings/messages/weshTerminal__new/ko';
import { weshTerminal__no_sessions_press_new_to_start_a_worker_backed_shell } from '@/strings/messages/weshTerminal__no_sessions_press_new_to_start_a_worker_backed_shell/ko';
import { weshTerminal__session } from '@/strings/messages/weshTerminal__session/ko';
import { weshTerminal__this_will_dispose_the_worker_and_lose_the_session_history_continue } from '@/strings/messages/weshTerminal__this_will_dispose_the_worker_and_lose_the_session_history_continue/ko';
import { weshTerminal__wesh_terminal } from '@/strings/messages/weshTerminal__wesh_terminal/ko';

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
  ModelSupportInvestigationModal__persistence_roundtrip_summary,
  ModelSupportInvestigationModal__passed,
  ModelSupportInvestigationModal__repository,
  ModelSupportInvestigationModal__repository_information,
  ModelSupportInvestigationModal__repository_summary,
  ModelSupportInvestigationModal__running,
  ModelSupportInvestigationModal__stop_investigation,
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
} satisfies Strings;
