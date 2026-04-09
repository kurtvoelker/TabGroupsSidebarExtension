// workspace.js — Chrome API orchestration for workspace operations
// Depends on: storage.js (loaded first)
// Phase 1: capture + auto-save. Phase 2 will add switchWorkspace + restoreWorkspaceTabs.

/* ---------------- Capture ---------------- */

// Reads all open tabs and tab groups across all windows and returns a
// workspace-shaped snapshot. Does NOT store favIconUrl — see architecture notes.
//
// expandedGroupIds: the Set<number> from sidebar.js tracking open accordions.
// allOpen: true when "expand all" is active, meaning every group is expanded.
async function captureCurrentState(expandedGroupIds = new Set(), allOpen = false) {
  const allTabs = await chrome.tabs.query({});

  const pinnedTabs = [];
  const tabsByGroupId = new Map(); // groupId (number) → [{url, title}]
  const ungroupedTabs = [];

  for (const tab of allTabs) {
    const entry = { url: tab.url || '', title: tab.title || tab.url || '' };

    if (tab.pinned) {
      pinnedTabs.push(entry);
      continue;
    }

    const gid = (typeof tab.groupId === 'number' && tab.groupId >= 0) ? tab.groupId : -1;
    if (gid === -1) {
      ungroupedTabs.push(entry);
    } else {
      if (!tabsByGroupId.has(gid)) tabsByGroupId.set(gid, []);
      tabsByGroupId.get(gid).push(entry);
    }
  }

  // Fetch group metadata for each group ID encountered.
  const groups = [];
  for (const [groupId, tabs] of tabsByGroupId.entries()) {
    let name = '';
    let color = 'grey';
    // collapsed: a group is collapsed if it's not in expandedGroupIds
    // (unless allOpen overrides, in which case nothing is collapsed).
    const collapsed = allOpen ? false : !expandedGroupIds.has(groupId);

    try {
      if (chrome.tabGroups && chrome.tabGroups.get) {
        const info = await chrome.tabGroups.get(groupId);
        name = info.title || '';
        color = info.color || 'grey';
      }
    } catch (e) {
      console.warn('captureCurrentState: could not fetch group', groupId, e);
    }

    groups.push({ name, color, collapsed, tabs });
  }

  return { pinnedTabs, groups, ungroupedTabs };
}

/* ---------------- Save ---------------- */

// Captures current Chrome state and persists it to the active workspace.
// expandedGroupIds and allOpenState are passed in from sidebar.js so this
// file doesn't need direct access to sidebar's module-level variables.
async function saveWorkspaceNow(expandedGroupIds, allOpenState) {
  try {
    const activeId = await getActiveWorkspaceId();
    const state = await captureCurrentState(expandedGroupIds, allOpenState);
    await saveWorkspace(activeId, state);
  } catch (e) {
    console.error('saveWorkspaceNow failed:', e);
  }
}
