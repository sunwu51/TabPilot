/* global chrome */
import { createWebIdeProject, requireWebIdeProject } from "../../../../utils/webIdeProjects";

function buildWebIdeUrl(projectId) {
  const url = new URL(chrome.runtime.getURL("webide-host.html"));
  url.searchParams.set("id", projectId);
  return url.toString();
}

export async function _execWebIdeProject({ projectId, template = "vanilla", name, expireAt } = {}) {
  const project = projectId
    ? await requireWebIdeProject(projectId)
    : await createWebIdeProject({ template, name, expireAt });
  const url = buildWebIdeUrl(project.id);
  const tab = await chrome.tabs.create({ url, active: true });
  if (tab?.windowId != null) await chrome.windows.update(tab.windowId, { focused: true });
  return {
    success: true,
    projectId: project.id,
    template: project.template,
    rootPath: project.rootPath,
    entry: project.entry,
    files: Object.keys(project.files).sort().map(path => `${project.rootPath}/${path}`),
    expireAt: project.expireAt,
    tabId: tab?.id,
    url: tab?.pendingUrl || tab?.url || url
  };
}
