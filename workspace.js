// workspace.js — Chrome API orchestration for workspace operations
// Depends on: storage.js (loaded first)

/* ---------------- Helpers ---------------- */

// Returns true if a captured workspace state contains at least one tab with a
// real URL (not a new-tab page or blank). Used to distinguish a meaningful
// window from a freshly-opened Chrome window.
function _hasRealContent(state) {
  const isBlankUrl = url => !url ||
    url === 'chrome://newtab/' ||
    url === 'about:blank' ||
    url === 'about:newtab';
  const anyReal = tabs => (tabs || []).some(t => !isBlankUrl(t.url));
  return anyReal(state.pinnedTabs) ||
    anyReal(state.ungroupedTabs) ||
    (state.groups || []).some(g => anyReal(g.tabs));
}

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
// windowId: pass the sidebar's own window ID so saves are always scoped correctly.
async function saveWorkspaceNow(expandedGroupIds, allOpenState, windowId = null) {
  if (_switchInProgress) return;
  try {
    const wid = windowId ||
      (await chrome.windows.getLastFocused({ populate: false, windowTypes: ['normal'] })).id;
    const activeId = await getWindowWorkspaceId(wid);
    if (!activeId) return; // no workspace loaded in this window yet — nothing to save
    const state = await captureCurrentState(expandedGroupIds, allOpenState, wid);
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

// callerWindowId: the window performing the switch. If null, falls back to
// getLastFocused (background service worker context where getCurrent() is unavailable).
async function switchWorkspace(targetId, expandedGroupIds, allOpenState, callerWindowId = null) {
  if (_switchInProgress) {
    console.warn('switchWorkspace: already in progress, ignoring.');
    return;
  }

  // Resolve which window we're operating on.
  let windowId = callerWindowId;
  if (!windowId) {
    const currentWindow = await chrome.windows.getLastFocused({ populate: false, windowTypes: ['normal'] });
    windowId = currentWindow.id;
  }

  // Per-window check: is this workspace already loaded in this window?
  const activeId = await getWindowWorkspaceId(windowId);
  if (targetId === activeId) return;

  // Enforce exclusivity: a workspace can only be open in one window at a time.
  // If another window already has it, focus that window — the user is navigating
  // to the workspace, not moving it.
  const { _windowWorkspaceMap = {} } = await chrome.storage.session.get('_windowWorkspaceMap');
  const conflictEntry = Object.entries(_windowWorkspaceMap).find(
    ([wid, wsId]) => wsId === targetId && Number(wid) !== windowId
  );
  if (conflictEntry) {
    await chrome.windows.update(Number(conflictEntry[0]), { focused: true });
    return;
  }

  _switchInProgress = true;
  try {
    // Fetch the target workspace first — if it doesn't exist we bail before
    // touching any tabs, so nothing is destroyed.
    const targetWorkspace = await getWorkspace(targetId);
    if (!targetWorkspace) throw new Error(`Workspace "${targetId}" not found.`);

    if (activeId !== null) {
      // This window already has a workspace. Open a new window for the target
      // rather than replacing this window's tabs — each workspace lives in its
      // own window, so switching navigates between windows, not content.
      const currentState = await captureCurrentState(expandedGroupIds, allOpenState, windowId);
      await saveWorkspace(activeId, currentState);

      const newWin = await chrome.windows.create({ focused: true });
      const newWindowId = newWin.id;
      const initialTabId = newWin.tabs && newWin.tabs[0] ? newWin.tabs[0].id : null;

      await restoreWorkspaceTabs(targetWorkspace, newWindowId);

      // Remove the blank tab Chrome opened the new window with.
      if (initialTabId) {
        const remaining = await chrome.tabs.query({ windowId: newWindowId });
        if (remaining.length > 1) {
          try { await chrome.tabs.remove(initialTabId); } catch (e) { /* already gone */ }
        }
      }

      await setWindowWorkspaceId(newWindowId, targetId);
      return;

    } else {
      // No workspace assigned to this window yet.
      // Selecting a workspace means "claim it — this window IS now that workspace."
      // Save the current tabs into the workspace and assign; no tab manipulation.
      // Only fall through to load if the window is completely blank (fresh Chrome start),
      // since a blank window claiming a workspace would erase its saved content.
      const currentState = await captureCurrentState(expandedGroupIds, allOpenState, windowId);

      if (_hasRealContent(currentState)) {
        // Adopt: current tabs become this workspace's content.
        // Real URLs only — a window with only chrome://newtab/ is treated as blank
        // so it loads the saved workspace instead of overwriting it.
        await saveWorkspace(targetId, currentState);
        await setWindowWorkspaceId(windowId, targetId);
        return; // done — no tabs need to change
      }
      // Blank window: fall through to restore the workspace's saved content below.
    }

    // Close this window's tabs and restore the target workspace into it.
    const placeholder = await chrome.tabs.create({ windowId });

    const windowTabs = await chrome.tabs.query({ windowId });
    const toClose = windowTabs.map(t => t.id).filter(id => id !== placeholder.id);
    if (toClose.length > 0) {
      try {
        await chrome.tabs.remove(toClose);
      } catch (e) {
        console.warn('switchWorkspace: some tabs could not be closed', e);
      }
    }

    await restoreWorkspaceTabs(targetWorkspace, windowId);

    const remaining = await chrome.tabs.query({ windowId });
    if (remaining.length > 1) {
      try { await chrome.tabs.remove(placeholder.id); } catch (e) { /* already gone */ }
    }

    // Commit — record which workspace this window is now displaying.
    await setWindowWorkspaceId(windowId, targetId);

  } finally {
    _switchInProgress = false;
  }
}
