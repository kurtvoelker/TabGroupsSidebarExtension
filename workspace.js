// workspace.js — Chrome API orchestration for workspace operations
// Depends on: storage.js (loaded first)

/* ---------------- Capture ---------------- */

// Reads open tabs and tab groups for a specific window and returns a
// workspace-shaped snapshot. Does NOT store favIconUrl — see architecture notes.
//
// expandedGroupIds: the Set<number> from sidebar.js tracking open accordions.
// allOpen: true when "expand all" is active, meaning every group is expanded.
// windowId: the browser window to capture (required — workspaces map 1:1 to windows).
async function captureCurrentState(expandedGroupIds = new Set(), allOpen = false, windowId = null) {
  const query = windowId ? { windowId } : {};
  const allTabs = await chrome.tabs.query(query);

  // Identify the active tab in the window so we can restore focus when next loaded.
  let activeTabId = null;
  try {
    const activeQuery = windowId ? { active: true, windowId } : { active: true, lastFocusedWindow: true };
    const [activeTab] = await chrome.tabs.query(activeQuery);
    if (activeTab) activeTabId = activeTab.id;
  } catch (e) {
    console.warn('captureCurrentState: could not determine active tab', e);
  }

  const pinnedTabs = [];
  const tabsByGroupId = new Map(); // groupId (number) → [{url, title}]
  const ungroupedTabs = [];

  for (const tab of allTabs) {
    const entry = { url: tab.url || '', title: tab.title || tab.url || '' };
    if (tab.id === activeTabId) entry.active = true;

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
    if (!activeId) return; // no workspace loaded yet — nothing to save
    const win = await chrome.windows.getLastFocused({ populate: false, windowTypes: ['normal'] });
    const state = await captureCurrentState(expandedGroupIds, allOpenState, win.id);
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

  // All tabs are created with active:false. We track which tab should receive
  // focus (the one saved with entry.active === true) and activate it at the end.
  // Falls back to the first non-pinned tab for old snapshots without the flag.
  let activeTabId    = null; // the tab to focus after restore
  let firstNonPinned = null; // fallback if no active flag found

  const openTab = async (tabData, opts = {}) => {
    try {
      const tab = await chrome.tabs.create({ url: tabData.url, windowId, active: false, ...opts });
      if (!opts.pinned) {
        if (!firstNonPinned) firstNonPinned = tab.id;
        if (tabData.active)  activeTabId   = tab.id;
      }
      return tab;
    } catch (e) {
      console.warn('restoreWorkspaceTabs: could not open tab', tabData.url, e);
      return null;
    }
  };

  // Pinned tabs first — they anchor to the left of the tab strip.
  for (const tabData of pinnedTabs) {
    await openTab(tabData, { pinned: true });
  }

  // Named tab groups, in saved order.
  for (const group of groups) {
    if (!Array.isArray(group.tabs) || group.tabs.length === 0) continue;

    const tabIds = [];
    for (const tabData of group.tabs) {
      const tab = await openTab(tabData);
      if (tab) tabIds.push(tab.id);
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
    await openTab(tabData);
  }

  // Activate the previously focused tab (or the first non-pinned tab as fallback).
  const toActivate = activeTabId || firstNonPinned;
  if (toActivate) {
    try { await chrome.tabs.update(toActivate, { active: true }); } catch (e) {}
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
    // getLastFocused with windowTypes:'normal' works from any extension context
    // (sidebar, popup, background). getCurrent() would return the popup window
    // itself when called from a popup, which is wrong.
    const currentWindow = await chrome.windows.getLastFocused({ populate: false, windowTypes: ['normal'] });
    const windowId = currentWindow.id;

    // Save current state BEFORE touching any tabs — but only if a workspace is
    // actually active. If activeId is null (fresh Chrome start, user hasn't
    // loaded any workspace yet) there is nothing worth preserving, and saving
    // would overwrite the workspace's stored tabs with a blank window.
    if (activeId !== null) {
      const currentState = await captureCurrentState(expandedGroupIds, allOpenState, windowId);
      await saveWorkspace(activeId, currentState);
    }

    // Load the target workspace into memory BEFORE closing anything.
    // If this fails, we haven't destroyed the user's current session yet.
    const targetWorkspace = await getWorkspace(targetId);
    if (!targetWorkspace) throw new Error(`Workspace "${targetId}" not found.`);

    // Open a placeholder tab so the window survives while we close its tabs.
    const placeholder = await chrome.tabs.create({ windowId });

    // Close only tabs in the current window — other windows are untouched.
    const windowTabs = await chrome.tabs.query({ windowId });
    const toClose = windowTabs.map(t => t.id).filter(id => id !== placeholder.id);
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
