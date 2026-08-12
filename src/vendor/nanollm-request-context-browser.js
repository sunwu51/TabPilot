let customToolNames = new Set();

export function markResponsesCustomToolName(name) {
  customToolNames.add(name);
}

export function isResponsesCustomToolName(name) {
  return customToolNames.has(name);
}

export function resetResponsesCustomToolNames() {
  customToolNames = new Set();
}
