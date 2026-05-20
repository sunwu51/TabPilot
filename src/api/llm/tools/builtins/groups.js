/* global chrome */
import { _buildCapturedAt, _loadAllGroupSnapshots, _loadGroupSnapshot, _serializeTabMetadata } from "./_shared";

export async function _execGroupList() {
  const capturedAt = _buildCapturedAt();
  const groups = await _loadAllGroupSnapshots();
  return {
    capturedAt,
    count: groups.length,
    groups
  };
}

/**
 * Get info about a specific tab group.
 */
export async function _execGroupGet({ groupId }) {
  const group = await _loadGroupSnapshot(groupId);
  if (!group) return { error: `Tab group not found: ${groupId}` };
  return {
    capturedAt: _buildCapturedAt(),
    group
  };
}

/**
 * Update a tab group's title, color, or collapsed state.
 */
export async function _execGroupUpdate({ groupId, name, color, collapsed }) {
  const updateProps = {};
  if (name != null) updateProps.title = name;
  if (color != null) updateProps.color = color;
  if (collapsed != null) updateProps.collapsed = collapsed;

  if (Object.keys(updateProps).length === 0) {
    return { error: "Please provide at least one field to update: name, color, or collapsed" };
  }

  await chrome.tabGroups.update(groupId, updateProps);
  const group = await _loadGroupSnapshot(groupId);
  if (!group) return { error: `Tab group not found after update: ${groupId}` };
  return {
    success: true,
    capturedAt: _buildCapturedAt(),
    group
  };
}

/**
 * Add tabs to an existing tab group.
 */
export async function _execGroupAddTabs({ groupId, tabIds }) {
  const ids = Array.isArray(tabIds) ? tabIds : [tabIds];
  await chrome.tabs.group({ groupId, tabIds: ids });
  const group = await _loadGroupSnapshot(groupId);
  if (!group) return { error: `Tab group not found after adding tabs: ${groupId}` };
  return {
    success: true,
    capturedAt: _buildCapturedAt(),
    groupId,
    addedCount: ids.length,
    group
  };
}

/**
 * Remove tabs from their current tab groups.
 */
export async function _execGroupRemoveTabs({ tabIds }) {
  const ids = Array.isArray(tabIds) ? tabIds : [tabIds];
  const beforeTabs = [];

  for (const id of ids) {
    try {
      beforeTabs.push(await chrome.tabs.get(id));
    } catch (e) {
      beforeTabs.push({ id, error: "Tab not found" });
    }
  }

  const validTabIds = beforeTabs.filter(tab => !tab.error).map(tab => tab.id);
  if (validTabIds.length > 0) {
    await chrome.tabs.ungroup(validTabIds);
  }

  const afterTabs = await Promise.all(validTabIds.map(async (id) => {
    try {
      return await chrome.tabs.get(id);
    } catch (e) {
      return null;
    }
  }));

  return {
    success: true,
    capturedAt: _buildCapturedAt(),
    requestedCount: ids.length,
    updatedCount: afterTabs.filter(Boolean).length,
    tabs: afterTabs.filter(Boolean).map(tab => _serializeTabMetadata(tab)),
    missing: beforeTabs.filter(tab => tab.error).map(tab => ({ id: tab.id, error: tab.error }))
  };
}

/**
 * Dissolve an entire tab group.
 */
export async function _execGroupUngroup({ groupId }) {
  const group = await _loadGroupSnapshot(groupId);
  if (!group) return { error: `Tab group not found: ${groupId}` };

  const tabIds = group.tabs.map(tab => tab.id).filter(id => typeof id === "number");
  if (tabIds.length > 0) {
    await chrome.tabs.ungroup(tabIds);
  }

  const tabs = await Promise.all(tabIds.map(async (id) => {
    try {
      return await chrome.tabs.get(id);
    } catch (e) {
      return null;
    }
  }));

  return {
    success: true,
    capturedAt: _buildCapturedAt(),
    groupId,
    ungroupedCount: tabIds.length,
    group,
    tabs: tabs.filter(Boolean).map(tab => _serializeTabMetadata(tab))
  };
}
