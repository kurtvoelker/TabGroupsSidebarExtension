// popup.js — workspace switcher popup
// Depends on: permissions.js, storage.js, workspace.js (loaded first via popup.html)

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

/* ---------------- Switch ---------------- */

async function handleSwitch(targetId, targetName) {
  const list = document.getElementById('workspaceList');

  // Dim all items and show a switching indicator at the top.
  list.querySelectorAll('.ws-item').forEach(el => el.classList.add('switching'));

  const indicator = document.createElement('div');
  indicator.className = 'ws-item-switching-indicator';
  indicator.textContent = `Opening "${targetName}"…`;
  list.insertBefore(indicator, list.firstChild);

  try {
    // Pass empty accordion state — sidebar will re-render from live tabs on switch.
    await switchWorkspace(targetId, new Set(), false);
    window.close();
  } catch (e) {
    console.error('popup: switchWorkspace failed', e);
    list.innerHTML = '<div class="popup-state error">Switch failed — try again.</div>';
  }
}

/* ---------------- Init ---------------- */

document.addEventListener('DOMContentLoaded', async () => {
  const list = document.getElementById('workspaceList');
  list.innerHTML = '<div class="popup-state">Loading…</div>';

  try {
    await initPermissions();
    const [workspaces, activeId] = await Promise.all([
      getAllWorkspaces(),
      getActiveWorkspaceId()
    ]);
    renderList(workspaces, activeId);
  } catch (e) {
    console.error('popup: init failed', e);
    list.innerHTML = '<div class="popup-state error">Could not load workspaces.</div>';
  }
});
