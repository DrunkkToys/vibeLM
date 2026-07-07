export type ToolToggleDefinition = {
  name: string;
  displayName: string;
  subtitle: string;
  defaultEnabled: boolean;
};

export const TOOL_TOGGLES: ToolToggleDefinition[] = [
  {
    name: "list_memories",
    displayName: "List Memories",
    subtitle: "Enable listing saved memories with scope filtering.",
    defaultEnabled: false,
  },
  {
    name: "update_memory",
    displayName: "Update Memory",
    subtitle: "Enable the update placeholder tool for memory maintenance workflows.",
    defaultEnabled: false,
  },
  {
    name: "delete_memory",
    displayName: "Delete Memory",
    subtitle: "Enable the delete placeholder tool for memory maintenance workflows.",
    defaultEnabled: false,
  },
  {
    name: "clear_memories",
    displayName: "Clear Memories",
    subtitle: "Enable clearing the memory store for a fresh start.",
    defaultEnabled: false,
  },
  {
    name: "ssh_exec",
    displayName: "SSH Exec",
    subtitle: "Enable SSH command execution on remote hosts.",
    defaultEnabled: false,
  },
  {
    name: "check_service",
    displayName: "Check Service",
    subtitle: "Enable TCP and HTTP service checks.",
    defaultEnabled: false,
  },
  {
    name: "append_file",
    displayName: "Append File",
    subtitle: "Enable appending content to workspace files.",
    defaultEnabled: false,
  },
  {
    name: "rename_file",
    displayName: "Rename File",
    subtitle: "Enable renaming workspace files and folders.",
    defaultEnabled: false,
  },
  {
    name: "delete_file",
    displayName: "Delete File",
    subtitle: "Enable deleting workspace files.",
    defaultEnabled: false,
  },
  {
    name: "generate_uuid",
    displayName: "Generate UUID",
    subtitle: "Enable UUID generation.",
    defaultEnabled: false,
  },
  {
    name: "generate_password",
    displayName: "Generate Password",
    subtitle: "Enable password generation.",
    defaultEnabled: false,
  },
  {
    name: "encode_base64",
    displayName: "Encode Base64",
    subtitle: "Enable base64 encoding.",
    defaultEnabled: false,
  },
  {
    name: "decode_base64",
    displayName: "Decode Base64",
    subtitle: "Enable base64 decoding.",
    defaultEnabled: false,
  },
];

export const DEFAULT_ENABLED_TOOL_NAMES = TOOL_TOGGLES.filter((tool) => tool.defaultEnabled).map((tool) => tool.name);
