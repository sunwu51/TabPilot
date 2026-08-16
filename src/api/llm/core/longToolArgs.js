export const LONG_TOOL_ARGUMENT_FIELDS = {
  exec: ["code"],
  stash_in_browser: ["info"],
  html_playground: ["html", "css", "js"],
  vfs_write_file: ["content"],
  vfs_edit_file: ["originalContent", "newContent"],
  download: ["content"]
};

export function getLongToolArgumentFields(toolName) {
  if (!toolName) return [];
  return LONG_TOOL_ARGUMENT_FIELDS[toolName] || [];
}

export function isLongToolArgumentName(toolName) {
  return getLongToolArgumentFields(toolName).length > 0;
}
