import { text, type PluginContext } from "@lmstudio/sdk";
import { toolsProvider } from "./toolsProvider";

const TOOL_LIST = [
  "web_fetch `url` - fetch a URL and return text content",
  "calculate `expression` - evaluate a math expression",
  "get_current_datetime - current date, time, timezone",
  "bash_terminal `command` - run a bash command",
  "web_search `query` - search the web via DuckDuckGo",
  "read_file `filePath` - read a file from workspace",
  "write_file `filePath` `content` - write a file",
  "append_file `filePath` `content` - append to a file",
  "rename_file `sourcePath` `destPath` - rename/move a file",
  "search_files `pattern` - search file contents",
  "delete_file `path` - delete a file or empty dir",
  "list_files `path` - list directory contents",
  "save_memory `content` `tags` - store info in knowledge base",
  "search_memory `tags?` `query?` - search knowledge base",
  "list_memories - list all memory tags",
  "update_memory `id` `content?` `tags?` - update memory",
  "delete_memory `id` - delete a memory entry",
  "clear_memories `tags?` - clear memories",
  "generate_uuid - generate a UUID v4",
  "generate_password `length?` - generate a password",
  "encode_base64 `text` - encode to base64",
  "decode_base64 `base64` - decode from base64",
  "set_workspace `path` - change workspace folder",
  "pick_workspace - macOS folder picker (macOS only)",
  "check_service `host` `port` - check if a TCP port is reachable",
  "ssh_exec `host` `user` `password` `command` - run command via SSH",
  "get_config - show current configuration",
  "consult_expert `task` `expertRole?` - delegate to specialist sub-agent",
];

export async function main(context: PluginContext) {
  context.withToolsProvider(toolsProvider);

  context.withPromptPreprocessor(async (_ctl, userMessage) => {
    const txt = userMessage.getText();
    const toolHint = `\n\nAvailable tools:\n${TOOL_LIST.map((t) => `  - ${t}`).join("\n")}\n\nUse them when appropriate for calculations, file ops, web, or info retrieval.`;
    return `${txt}${toolHint}`;
  });
}
