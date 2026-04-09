// workspace.js — Chrome API orchestration for workspace operations
// Depends on: storage.js (loaded first)

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

// Blocked during workspace switches to prevent partial mid-switch state
// from being written to the old workspace.
let _switchInProgress = false;

// Captures current Chrome state and persists it to the active workspace.
// expandedGroupIds and allOpenState are passed in from sidebar.js so this
// file doesn't need direct access to sidebar's module-level variables.
async function saveWorkspaceNow(expandedGroupIds, allOpenState) {
  if (_switchInProgress) return;
  try {
    const activeId = await getActiveWorkspaceId();
    const state = await captureCurrentState(expandedGroupIds, allOpenState);
    await saveWorkspace(activeId, state);
  } catch (e) {
    console.error('saveWorkspaceNow failed:', e);
  }
}

/* ---------------- Restore ---------------- */

// Opens all tabs from a saved workspace snapshot into `windowId`, recreating
// tab groups with their names, colors, and collapsed states.
async function restoreWorkspaceTabs(workspaceData, windowId) {
  const { pinnedTabs = [], groups = [], ungroupedTabs = [] } = workspaceData;

  // Pinned tabs first — they anchor to the left of the tab strip.
  for (const tabData of pinnedTabs) {
    try {
      await chrome.tabs.create({ url: tabData.url, windowId, pinned: true });
    } catch (e) {
      console.warn('restoreWorkspaceTabs: could not open pinned tab', tabData.url, e);
    }
  }

  // Named tab groups, in saved order.
  for (const group of groups) {
    if (!Array.isArray(group.tabs) || group.tabs.length === 0) continue;

    const tabIds = [];
    for (const tabData of group.tabs) {
      try {
        const tab = await chrome.tabs.create({ url: tabData.url, windowId });
        tabIds.push(tab.id);
      } catch (e) {
        console.warn('restoreWorkspaceTabs: could not open tab', tabData.url, e);
      }
    }

    if (tabIds.length === 0) continue;

    try {
      const groupId = await chrome.tabs.group({ tabIds, createProperties: { windowId } });
      await chrome.tabGroups.update(groupId, {
        title: group.name || '',
        color: group.color || 'grey',
        collapsed: group.collapsed || false
      });
    } catch (e) {
      console.warn('restoreWorkspaceTabs: could not create group', group.name, e);
    }
  }

  // Ungrouped tabs last.
  for (const tabData of ungroupedTabs) {
    try {
      await chrome.tabs.create({ url: tabData.url, windowId });
    } catch (e) {
      console.warn('restoreWorkspaceTabs: could not open ungrouped tab', tabData.url, e);
    }
  }
}

/* ---------------- Switch ---------------- */

async function switchWorkspace(targetId, expandedGroupIds, allOpenState) {
  if (_switchInProgress) {
    console.warn('switchWorkspace: already in progress, ignoring.');
    return;
  }

  const activeId = await getActiveWorkspaceId();
  if (targetId === activeId) return;

  _switchInProgress = true;
  try {
    // Identify the window the sidebar belongs to.
    const currentWindow = await chrome.windows.getCurrent({ populate: false });
    const windowId = currentWindow.id;

    // Save current state BEFORE touching any tabs.
    const currentState = await captureCurrentState(expandedGroupIds, allOpenState);
    await saveWorkspace(activeId, currentState);

    // Load the target workspace into memory BEFORE closing anything.
    // If this fails, we haven't destroyed the user's current session yet.
    const targetWorkspace = await getWorkspace(targetId);
    if (!targetWorkspace) throw new Error(`Workspace "${targetId}" not found.`);

    // Open a placeholder tab so the window survives while we close everything.
    const placeholder = await chrome.tabs.create({ windowId });

    // Close every tab except the placeholder across all windows.
    // Other windows will close automatically once their last tab is removed.
    const allTabs = await chrome.tabs.query({});
    const toClose = allTabs.map(t => t.id).filter(id => id !== placeholder.id);
    if (toClose.length > 0) {
      try {
        await chrome.tabs.remove(toClose);
      } catch (e) {
        // Individual tabs may already be gone — not fatal, continue restoring.
        console.warn('switchWorkspace: some tabs could not be closed', e);
      }
    }

    // Restore the target workspace into our window.
    await restoreWorkspaceTabs(targetWorkspace, windowId);

    // Remove the placeholder if the workspace opened any other tabs.
    const remaining = await chrome.tabs.query({ windowId });
    if (remaining.length > 1) {
      try { await chrome.tabs.remove(placeholder.id); } catch (e) { /* already gone */ }
    }

    // Commit — only update activeWorkspaceId after everything succeeds.
    await setActiveWorkspaceId(targetId);

  } finally {
    // Always release the lock, even if something threw.
    _switchInProgress = false;
  }
}
