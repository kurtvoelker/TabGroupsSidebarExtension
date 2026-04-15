// popup.js — workspace switcher popup
// Depends on: permissions.js, storage.js, workspace.js (loaded first via popup.html)

// The window this popup belongs to — resolved during DOMContentLoaded.
let focusedWindowId = null;

// The workspace currently assigned to focusedWindowId (null = unassigned).
// Used to detect the adopt case so we can show confirmation feedback.
let currentWindowWorkspaceId = null;

/* ---------------- Helpers ---------------- */

function countTabs(ws) {
  let n = (ws.pinnedTabs || []).length + (ws.ungroupedTabs || []).length;
  for (const g of (ws.groups || [])) n += (g.tabs || []).length;
  return n;
}

function countGroups(ws) {
  return (ws.groups || []).filter(g => g.tabs && g.tabs.length > 0).length;
}

/* ---------------- Render ---------------- */

function renderList(workspaces, activeId) {
  const list = document.getElementById('workspaceList');
  list.innerHTML = '';

  const sorted = Object.values(workspaces).sort((a, b) => {
    if (a.id === activeId) return -1;
    if (b.id === activeId) return 1;
    return a.name.localeCompare(b.name);
  });

  if (sorted.length === 0) {
    list.innerHTML = '<div class="popup-state">No workspaces found.</div>';
    return;
  }

  for (const ws of sorted) {
    const isActive = ws.id === activeId;
    const tabs   = countTabs(ws);
    const groups = countGroups(ws);

    const item = document.createElement('div');
    item.className = 'ws-item' + (isActive ? ' active' : '');
    item.dataset.id = ws.id;

    const check = document.createElement('span');
    check.className = 'ws-check';
    check.textContent = isActive ? '✓' : '';

    const name = document.createElement('span');
    name.className = 'ws-name';
    name.textContent = ws.name;

    const meta = document.createElement('div');
    meta.className = 'ws-meta';

    if (tabs > 0) {
      const countEl = document.createElement('span');
      countEl.className = 'ws-count';
      countEl.textContent = `${tabs} tab${tabs !== 1 ? 's' : ''}`;
      meta.appendChild(countEl);
    }

    if (groups > 0) {
      const groupEl = document.createElement('span');
      groupEl.className = 'ws-groups';
      groupEl.textContent = `${groups} group${groups !== 1 ? 's' : ''}`;
      meta.appendChild(groupEl);
    }

    item.appendChild(check);
    item.appendChild(name);
    item.appendChild(meta);

    if (!isActive) {
      item.addEventListener('click', () => handleSwitch(ws.id, ws.name));
    }

    list.appendChild(item);
  }
}

/* ---------------- Promo footer ---------------- */

function renderPromo(workspaceCount, isPro) {
  const footer = document.getElementById('popupFooter');
  if (!footer) return;

  if (isPro) {
    footer.innerHTML = '';
    return;
  }

  const used  = Math.min(workspaceCount, FREE_WORKSPACE_LIMIT);
  const limit = FREE_WORKSPACE_LIMIT;

  const sep = document.createElement('div');
  sep.className = 'popup-sep';

  const row = document.createElement('div');
  row.className = 'popup-promo';

  const text = document.createElement('span');
  text.className = 'popup-promo-text';
  text.textContent = `Using ${used} of ${limit} free workspaces`;

  const btn = document.createElement('button');
  btn.className = 'popup-pro-btn';
  btn.textContent = 'Get Pro';
  btn.addEventListener('click', () => { chrome.tabs.create({ url: getAnnualUrl() }); window.close(); });

  row.appendChild(text);
  row.appendChild(btn);
  footer.appendChild(sep);
  footer.appendChild(row);
}

/* ---------------- Switch ---------------- */

function handleSwitch(targetId, targetName) {
  // Signal the background service worker via storage instead of sendMessage.
  // Storage writes are handled by the browser process and complete even if the
  // popup closes immediately — unlike sendMessage which can be lost when the
  // service worker is waking up for the first time.
  chrome.storage.local.set({ _requestSwitchToWorkspace: { targetId, windowId: focusedWindowId } });

  if (currentWindowWorkspaceId === null) {
    // Adopt case: this window is unassigned, so its current tabs will be saved
    // as the workspace — nothing visually changes. Show a brief confirmation so
    // the user knows the click did something before the popup closes.
    const list = document.getElementById('workspaceList');
    list.innerHTML = `<div class="popup-adopt-confirm">✓ Current tabs saved as<br><strong>${targetName}</strong></div>`;
    setTimeout(() => window.close(), 1600);
  } else {
    // Normal switch or focus-window: the tab changes (or window focus change)
    // are their own feedback — close immediately.
    window.close();
  }
}

/* ---------------- Init ---------------- */

document.addEventListener('DOMContentLoaded', async () => {
  // Resolve the window this popup belongs to. Must happen before any workspace
  // operations or sidebar ping — every per-window lookup depends on this.
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab) focusedWindowId = tab.windowId;
  } catch (e) {
    console.warn('popup: could not resolve focused window', e);
  }

  // Sidebar toggle button — open if closed, close if open
  const sidebarBtn = document.getElementById('openSidebarBtn');
  if (sidebarBtn) {
    // Ping the sidebar to check if it's currently open IN THIS WINDOW.
    // The response includes windowId so we can confirm it's the right sidebar.
    let sidebarOpen = false;
    try {
      const response = await chrome.runtime.sendMessage({ action: 'pingSidebar' });
      sidebarOpen = !!(response && response.alive && response.windowId === focusedWindowId);
    } catch (e) { /* no response means sidebar is not open */ }

    // Update button label to reflect state
    const label = sidebarBtn.querySelector('.sidebar-btn-label');
    if (label) label.textContent = sidebarOpen ? 'Close' : 'Sidebar';

    sidebarBtn.addEventListener('click', async () => {
      if (sidebarOpen) {
        // Fire-and-forget: the sidebar closes itself on receipt, which kills the
        // message port before a response arrives — awaiting would always throw.
        chrome.runtime.sendMessage({ action: 'closeSidebar' }).catch(() => {});
      } else {
        try {
          if (focusedWindowId) {
            await chrome.sidePanel.open({ windowId: focusedWindowId });
          }
        } catch (e) {
          console.error('popup: could not open sidebar', e);
        }
      }
      window.close();
    });
  }

  // Load workspace list
  const list = document.getElementById('workspaceList');
  list.innerHTML = '<div class="popup-state">Loading…</div>';

  try {
    await initPermissions();
    const [workspaces, activeId] = await Promise.all([
      getAllWorkspaces(),
      focusedWindowId ? getWindowWorkspaceId(focusedWindowId) : Promise.resolve(null)
    ]);
    currentWindowWorkspaceId = activeId;
    renderList(workspaces, activeId);
    renderPromo(Object.keys(workspaces).length, canUseFeature(FEATURES.CLOUD_SYNC));
  } catch (e) {
    console.error('popup: init failed', e);
    list.innerHTML = '<div class="popup-state error">Could not load workspaces.</div>';
  }
});
