export type ToolToggleDefinition = {
  name: string;
  displayName: string;
  subtitle: string;
  defaultEnabled: boolean;
};

export const TOOL_TOGGLES: ToolToggleDefinition[] = [
  {
    name: "set_workspace",
    displayName: "Set Workspace",
    subtitle: "Enable workspace root changes and workspace bootstrapping.",
    defaultEnabled: true,
  },
  {
    name: "explore_workspace",
    displayName: "Explore Workspace",
    subtitle: "Enable a shallow workspace inventory command without recursive search.",
    defaultEnabled: true,
  },
  {
    name: "get_config",
    displayName: "Get Config",
    subtitle: "Enable runtime config, prompt budget, and memory visibility.",
    defaultEnabled: true,
  },
  {
    name: "save_memory",
    displayName: "Save Memory",
    subtitle: "Enable saving scoped memories for later retrieval.",
    defaultEnabled: true,
  },
  {
    name: "compact_context",
    displayName: "Compact Context",
    subtitle: "Enable session compaction and handoff summaries.",
    defaultEnabled: true,
  },
  {
    name: "search_memory",
    displayName: "Search Memory",
    subtitle: "Enable scoped memory search across session, workspace, and research.",
    defaultEnabled: true,
  },
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
    name: "web_fetch",
    displayName: "Web Fetch",
    subtitle: "Enable fetching webpage text content.",
    defaultEnabled: true,
  },
  {
    name: "calculate",
    displayName: "Calculate",
    subtitle: "Enable calculator-style expression evaluation.",
    defaultEnabled: true,
  },
  {
    name: "get_current_datetime",
    displayName: "Get Current Datetime",
    subtitle: "Enable local time and date lookup.",
    defaultEnabled: true,
  },
  {
    name: "list_files",
    displayName: "List Files",
    subtitle: "Enable workspace directory listing.",
    defaultEnabled: true,
  },
  {
    name: "read_file",
    displayName: "Read File",
    subtitle: "Enable reading workspace files.",
    defaultEnabled: true,
  },
  {
    name: "write_file",
    displayName: "Write File",
    subtitle: "Enable writing new files or overwriting content.",
    defaultEnabled: true,
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
    name: "search_files",
    displayName: "Search Files",
    subtitle: "Enable searching file contents and paths.",
    defaultEnabled: true,
  },
  {
    name: "delete_file",
    displayName: "Delete File",
    subtitle: "Enable deleting workspace files.",
    defaultEnabled: false,
  },
  {
    name: "bash_terminal",
    displayName: "Bash Terminal",
    subtitle: "Enable running shell commands in the workspace.",
    defaultEnabled: true,
  },
  {
    name: "web_search",
    displayName: "Web Search",
    subtitle: "Enable web search via the configured search proxy.",
    defaultEnabled: true,
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
  {
    name: "vibe_bridge",
    displayName: "Vibe Bridge",
    subtitle: "Self-recalling autonomous loop for keep-alive sessions.",
    defaultEnabled: false,
  },
];

export const DEFAULT_ENABLED_TOOL_NAMES = TOOL_TOGGLES.filter((tool) => tool.defaultEnabled).map((tool) => tool.name);
