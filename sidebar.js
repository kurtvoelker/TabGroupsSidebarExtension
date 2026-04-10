// sidebar.js (tab close buttons + drag/drop between groups + ungrouped first)

/* ---------------- Toolbar SVG icons ---------------- */

const SVG_SORT = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="3" x2="12" y2="21"/><polyline points="6 9 12 3 18 9"/><polyline points="6 15 12 21 18 15"/></svg>`;

const SVG_FOLDER_CLOSED = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`;

const SVG_FOLDER_OPEN = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><line x1="2" y1="10" x2="22" y2="10"/></svg>`;

const SVG_REFRESH = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>`;

const chromeColorMap = {
  grey:   '#7A7D81',
  blue:   '#3B82F6',
  red:    '#EF4444',
  yellow: '#F59E0B',
  green:  '#22C55E',
  pink:   '#EC4899',
  purple: '#8B5CF6',
  cyan:   '#06B6D4',
  orange: '#F97316',
  teal:   '#14B8A6',
  default:'#9CA3AF'
};

const $ = id => document.getElementById(id);

let groupsData = [];
let pinnedCache = [];
let sortAlpha = false;
let sortMenuOpen = false;
let allOpenState = false;
let expandedGroupIds = new Set();
let draggedTabData = null;
let _saveDebounceTimer = null;

// Workspace UI state
let workspacesCache = {};
let activeWorkspaceIdCache = 'ws_default';
let wsDropdownOpen = false;
let wsGearMenuForId = null;  // id of the workspace whose gear menu is open
let wsRenamingId = null;     // id of the workspace currently being renamed inline
let wsCreateFormVisible = false;

// Footer / license UI state
let footerLicenseInputVisible = false;

function scheduleSave() {
  clearTimeout(_saveDebounceTimer);
  _saveDebounceTimer = setTimeout(async () => {
    try {
      await saveWorkspaceNow(expandedGroupIds, allOpenState);
    } catch (e) {
      if (e.name === 'StorageQuotaError') {
        showStatus('Storage quota exceeded. Your workspace could not be saved. Try removing some tabs or workspaces.');
      } else {
        console.error('scheduleSave: unexpected error', e);
      }
    }
  }, 500);
}

/* ---------------- Error/status helpers ---------------- */

function showStatus(msg) {
  let el = document.getElementById('statusMessage');
  if (!el) {
    el = document.createElement('div');
    el.id = 'statusMessage';
    el.style.padding = '8px';
    el.style.color = '#a00';
    el.style.fontSize = '12px';
    el.style.background = 'rgba(255,240,240,0.95)';
    el.style.borderRadius = '6px';
    el.style.marginBottom = '8px';
    const root = document.getElementById('root') || document.body;
    root.insertBefore(el, root.firstChild);
  }
  el.textContent = msg;
}

function clearStatus() {
  const el = document.getElementById('statusMessage');
  if (el) el.remove();
}

window.onerror = function (message, source, lineno, colno, error) {
  const text = `Error: ${message} at ${source || 'sidebar.js'}:${lineno}:${colno}\n${error && error.stack ? error.stack : ''}`;
  showStatus(text);
  console.error(text);
};

window.onunhandledrejection = function (ev) {
  const reason = ev?.reason;
  const text = `UnhandledRejection: ${reason && reason.message ? reason.message : JSON.stringify(reason)}`;
  showStatus(text);
  console.error('Unhandled promise rejection in sidebar', ev);
};

/* ---------------- Color helpers ---------------- */

function hexToRgb(hex) {
  hex = (hex || '').replace('#', '').trim();
  if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
  if (hex.length !== 6) return { r: 156, g: 163, b: 175 };
  return {
    r: parseInt(hex.slice(0, 2), 16),
    g: parseInt(hex.slice(2, 4), 16),
    b: parseInt(hex.slice(4, 6), 16)
  };
}

function rgbToHex({ r, g, b }) {
  const to = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return `#${to(r)}${to(g)}${to(b)}`;
}

function mix(a, b, t) {
  return {
    r: a.r + (b.r - a.r) * t,
    g: a.g + (b.g - a.g) * t,
    b: a.b + (b.b - a.b) * t
  };
}

function chromeifyGroupColor(baseHex) {
  const isDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  const base = hexToRgb(baseHex);
  const target = isDark ? { r: 28, g: 30, b: 33 } : { r: 255, g: 255, b: 255 };
  const t = isDark ? 0.58 : 0.72;
  const muted = mix(base, target, t);
  const nudge = isDark ? 0.18 : 0.10;
  const finalRgb = mix(muted, base, nudge);
  return rgbToHex(finalRgb);
}

function isDarkMode() {
  return getComputedStyle(document.documentElement).getPropertyValue('--color-scheme').trim() === 'dark';
}

function groupBgColor(baseHex) {
  const dark = isDarkMode();
  const base = hexToRgb(baseHex);
  const target = dark ? { r: 22, g: 24, b: 28 } : { r: 255, g: 255, b: 255 };
  const t = dark ? 0.78 : 0.88;
  return rgbToHex(mix(base, target, t));
}

function groupTitleColor(baseHex) {
  const dark = isDarkMode();
  const base = hexToRgb(baseHex);
  if (dark) {
    return rgbToHex(mix(base, { r: 255, g: 255, b: 255 }, 0.25));
  }
  return rgbToHex(mix(base, { r: 0, g: 0, b: 0 }, 0.35));
}

function getContrastColor(hex) {
  hex = (hex || '').replace('#', '').trim();
  if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
  if (hex.length !== 6) return '#000000';

  const r = parseInt(hex.slice(0, 2), 16) / 255;
  const g = parseInt(hex.slice(2, 4), 16) / 255;
  const b = parseInt(hex.slice(4, 6), 16) / 255;

  const srgbToLin = (c) => (c <= 0.03928) ? (c / 12.92) : Math.pow((c + 0.055) / 1.055, 2.4);
  const R = srgbToLin(r);
  const G = srgbToLin(g);
  const B = srgbToLin(b);
  const L = 0.2126 * R + 0.7152 * G + 0.0722 * B;

  return L > 0.60 ? '#000000' : '#ffffff';
}

/* ---------------- Accordion state helpers ---------------- */

function setGroupOpenState(groupEl, open) {
  const tabsList = groupEl.querySelector('.groupTabs');
  const triangle = groupEl.querySelector('.groupHeader .triangle');
  if (!tabsList) return;

  if (open) {
    tabsList.style.display = 'block';
    triangle && triangle.classList.add('expanded');
  } else {
    tabsList.style.display = 'none';
    triangle && triangle.classList.remove('expanded');
  }
}

function restoreAccordionStateAfterRender() {
  if (allOpenState) {
    document.querySelectorAll('.group').forEach(g => setGroupOpenState(g, true));
    return;
  }
  document.querySelectorAll('.group').forEach(g => {
    const id = Number(g.dataset.groupId);
    setGroupOpenState(g, expandedGroupIds.has(id));
  });
}

/* ---------------- Icons ---------------- */

function createCircleXIconSvg() {
  const span = document.createElement('span');
  span.innerHTML = `
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.8"></circle>
      <path d="M9 9l6 6M15 9l-6 6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"></path>
    </svg>
  `.trim();
  return span.firstElementChild;
}

/* ---------------- Drag/drop helpers ---------------- */

function clearDropTargets() {
  document.querySelectorAll('.drop-target').forEach(el => el.classList.remove('drop-target'));
  document.querySelectorAll('.dragging').forEach(el => el.classList.remove('dragging'));
}

async function moveTabToGroup(tabId, sourceGroupId, targetGroupId) {
  if (typeof tabId !== 'number') return;

  if (sourceGroupId === targetGroupId) return;

  try {
    if (targetGroupId === -1) {
      await chrome.tabs.ungroup(tabId);
    } else {
      await chrome.tabs.group({ groupId: targetGroupId, tabIds: [tabId] });
    }

    allOpenState = false;
    expandedGroupIds.add(targetGroupId);
    if (sourceGroupId !== -1) expandedGroupIds.add(sourceGroupId);
    syncOpenCloseButtonLabel();

    await loadAndRender();
  } catch (e) {
    console.error('Failed to move tab between groups', { tabId, sourceGroupId, targetGroupId, error: e });
    showStatus('Failed to move tab between groups.');
  }
}

function wireGroupDropTarget(groupEl, groupId) {
  const header = groupEl.querySelector('.groupHeader');
  const tabsList = groupEl.querySelector('.groupTabs');

  const onDragOver = (ev) => {
    if (!draggedTabData) return;
    ev.preventDefault();
    groupEl.classList.add('drop-target');
  };

  const onDragLeave = (ev) => {
    if (!groupEl.contains(ev.relatedTarget)) {
      groupEl.classList.remove('drop-target');
    }
  };

  const onDrop = async (ev) => {
    if (!draggedTabData) return;
    ev.preventDefault();
    ev.stopPropagation();

    const { tabId, sourceGroupId } = draggedTabData;
    draggedTabData = null;
    clearDropTargets();

    await moveTabToGroup(tabId, sourceGroupId, groupId);
  };

  header.addEventListener('dragover', onDragOver);
  header.addEventListener('dragleave', onDragLeave);
  header.addEventListener('drop', onDrop);

  tabsList.addEventListener('dragover', onDragOver);
  tabsList.addEventListener('dragleave', onDragLeave);
  tabsList.addEventListener('drop', onDrop);
}

/* ---------------- Data load & render ---------------- */

async function loadAndRender() {
  clearStatus();
  try {
    let tabs = [];
    try {
      tabs = await chrome.tabs.query({});
    } catch (apiErr) {
      console.error('chrome.tabs.query failed:', apiErr);
      try {
        tabs = await chrome.tabs.query({});
      } catch (err2) {
        showStatus('Unable to query tabs API. Confirm "tabs" permission.');
        return;
      }
    }

    await renderFromTabs(tabs || []);
  } catch (err) {
    console.error('loadAndRender fatal:', err);
    showStatus('Fatal: error loading tabs — see console.');
  }
}

function groupTabsByGroupId(tabs) {
  const byId = new Map();
  const pinned = [];

  for (const t of tabs) {
    try {
      if (t.pinned) {
        pinned.push(t);
        continue;
      }
      const gid = (typeof t.groupId === 'number' && t.groupId >= 0) ? t.groupId : -1;
      if (!byId.has(gid)) byId.set(gid, []);
      byId.get(gid).push(t);
    } catch (e) {
      console.warn('Skipping malformed tab while grouping:', e, t);
    }
  }
  return { byId, pinned };
}

async function fetchGroupInfo(groupId) {
  if (groupId === -1) return { id: -1, title: 'Ungrouped', color: 'default' };
  try {
    if (!chrome.tabGroups || !chrome.tabGroups.get) {
      return { id: groupId, title: `(group ${groupId})`, color: 'default' };
    }
    const info = await chrome.tabGroups.get(groupId);
    return { id: groupId, title: info.title || '(untitled)', color: info.color || 'default' };
  } catch (e) {
    console.debug('fetchGroupInfo: group', groupId, 'no longer exists (transient during switch)');
    return { id: groupId, title: `(group ${groupId})`, color: 'default' };
  }
}

async function renderFromTabs(tabs) {
  try {
    const { byId, pinned } = groupTabsByGroupId(tabs);
    const groups = [];

    if (byId.has(-1)) {
      groups.push({
        groupId: -1,
        title: 'Ungrouped',
        color: 'default',
        tabs: byId.get(-1) || []
      });
    }

    const groupIds = [...byId.keys()].filter(id => Number(id) !== -1);

    for (const id of groupIds) {
      const info = await fetchGroupInfo(Number(id));
      groups.push({
        groupId: Number(id),
        title: info.title,
        color: info.color,
        tabs: byId.get(Number(id)) || []
      });
    }

    groupsData = groups;
    pinnedCache = pinned;
    renderUI(pinned, groups);
  } catch (err) {
    console.error('renderFromTabs error:', err);
    showStatus('Error rendering tabs/groups — see console.');
  }
}

/* ---------------- UI render ---------------- */

function renderUI(pinnedTabs, groups) {
  try {
    const pinnedBar = $('pinnedBar');
    const pinnedSection = $('pinnedSection');
    if (!pinnedBar || !pinnedSection) return;

    pinnedBar.innerHTML = '';
    if (!pinnedTabs || pinnedTabs.length === 0) {
      pinnedSection.classList.add('hidden');
    } else {
      pinnedSection.classList.remove('hidden');
      for (const t of pinnedTabs) {
        const el = document.createElement('div');
        el.className = 'pinned-item';
        el.dataset.title = (t.title || '').toLowerCase();
        el.dataset.url = (t.url || '').toLowerCase();
        el.title = t.title || t.url;
        el.onclick = () => {
          try {
            chrome.tabs.update(t.id, { active: true });
          } catch (e) {}
        };

        const fav = document.createElement('img');
        fav.className = 'fav';
        fav.src = t.favIconUrl || '';
        fav.alt = '';
        fav.onerror = () => fav.style.display = 'none';
        el.appendChild(fav);

        pinnedBar.appendChild(el);
      }
    }

    const container = $('groupsContainer');
    if (!container) return;
    container.innerHTML = '';

    const groupsToRender = Array.isArray(groups) ? [...groups] : [];
    if (sortAlpha) {
      groupsToRender.sort((a, b) => {
        if (a.groupId === -1) return -1;
        if (b.groupId === -1) return 1;
        return (a.title || '').localeCompare(b.title || '', undefined, { sensitivity: 'base' });
      });
    }

    for (const g of groupsToRender) {
      const groupId = Number(g.groupId);

      const groupEl = document.createElement('div');
      groupEl.className = 'group';
      groupEl.dataset.groupId = groupId;

      const header = document.createElement('div');
      header.className = 'groupHeader';

      const left = document.createElement('div');
      left.className = 'left';

      const triangle = document.createElement('span');
      triangle.className = 'triangle';
      triangle.innerHTML = '&#9654;';
      left.appendChild(triangle);

      const title = document.createElement('div');
      title.className = 'groupTitle';
      title.textContent = g.title || '(untitled)';
      left.appendChild(title);

      const count = document.createElement('span');
      count.className = 'groupCount';
      count.textContent = ` ${Array.isArray(g.tabs) ? g.tabs.length : 0}`;

      header.appendChild(left);
      header.appendChild(count);
      groupEl.appendChild(header);

      const tabsList = document.createElement('div');
      tabsList.className = 'groupTabs';

      if (Array.isArray(g.tabs)) {
        for (const t of g.tabs) {
          const tabRow = document.createElement('div');
          tabRow.className = 'tabItem';
          tabRow.title = t.url || '';
          tabRow.dataset.title = (t.title || '').toLowerCase();
          tabRow.dataset.url = (t.url || '').toLowerCase();
          tabRow.dataset.tabId = String(t.id);
          tabRow.dataset.groupId = String(groupId);
          tabRow.draggable = true;

          const fav = document.createElement('img');
          fav.className = 'fav';
          fav.src = t.favIconUrl || '';
          fav.onerror = () => fav.style.display = 'none';
          tabRow.appendChild(fav);

          const tabTitle = document.createElement('div');
          tabTitle.className = 'tabTitle';
          tabTitle.textContent = t.title || t.url;
          tabRow.appendChild(tabTitle);

          const closeBtn = document.createElement('button');
          closeBtn.className = 'iconBtn';
          closeBtn.type = 'button';
          closeBtn.title = 'Close tab';
          closeBtn.setAttribute('aria-label', 'Close tab');
          closeBtn.appendChild(createCircleXIconSvg());

          closeBtn.addEventListener('click', async (ev) => {
            ev.stopPropagation();
            try {
              await chrome.tabs.remove(t.id);
            } catch (e) {
              console.error('Failed to close tab', t.id, e);
              showStatus('Failed to close tab (see console).');
            }
          });

          tabRow.appendChild(closeBtn);

          tabRow.addEventListener('click', (ev) => {
            ev.stopPropagation();
            allOpenState = false;
            expandedGroupIds = new Set([groupId]);
            syncOpenCloseButtonLabel();
            restoreAccordionStateAfterRender();

            try {
              chrome.tabs.update(t.id, { active: true });
            } catch (e) {
              console.error(e);
            }
          });

          tabRow.addEventListener('dragstart', (ev) => {
            draggedTabData = {
              tabId: t.id,
              sourceGroupId: groupId
            };
            tabRow.classList.add('dragging');
            if (ev.dataTransfer) {
              ev.dataTransfer.effectAllowed = 'move';
              ev.dataTransfer.setData('text/plain', String(t.id));
            }
          });

          tabRow.addEventListener('dragend', () => {
            draggedTabData = null;
            clearDropTargets();
          });

          tabsList.appendChild(tabRow);
        }
      }

      groupEl.appendChild(tabsList);
      container.appendChild(groupEl);

      const baseHex = chromeColorMap[g.color] || chromeColorMap.default;
      const bgHex = groupBgColor(baseHex);
      const textHex = groupTitleColor(baseHex);

      groupEl.style.background = bgHex;
      groupEl.style.borderLeft = `4px solid ${baseHex}`;

      title.style.color = textHex;
      count.style.color = textHex;
      triangle.style.color = textHex;

      header.addEventListener('click', () => {
        const isHidden = window.getComputedStyle(tabsList).display === 'none';

        if (isHidden) {
          setGroupOpenState(groupEl, true);
          expandedGroupIds.add(groupId);
        } else {
          setGroupOpenState(groupEl, false);
          expandedGroupIds.delete(groupId);
        }

        if (allOpenState) {
          allOpenState = false;
          syncOpenCloseButtonLabel();
        }
      });

      tabsList.style.display = 'none';
      triangle.classList.remove('expanded');

      wireGroupDropTarget(groupEl, groupId);
    }

    restoreAccordionStateAfterRender();
    applySearchFilter();
  } catch (uiErr) {
    console.error('renderUI fatal error:', uiErr);
    showStatus('UI rendering error — see console.');
  }
}

/* ---------------- Search ---------------- */

function applySearchFilter() {
  try {
    const q = ($('search')?.value || '').trim().toLowerCase();
    const isSearching = q.length > 0;

    const pinnedItems = document.querySelectorAll('.pinned-item');
    pinnedItems.forEach(pi => {
      const title = pi.dataset.title || '';
      const url = pi.dataset.url || '';
      const show = !isSearching || title.includes(q) || url.includes(q);
      pi.style.display = show ? '' : 'none';
    });

    const groups = document.querySelectorAll('.group');

    if (!isSearching) {
      groups.forEach(g => {
        g.style.display = '';
        g.querySelectorAll('.tabItem').forEach(ti => { ti.style.display = ''; });
      });
      restoreAccordionStateAfterRender();
      return;
    }

    groups.forEach(g => {
      const tabsList = g.querySelector('.groupTabs');
      const triangle = g.querySelector('.groupHeader .triangle');

      let anyVisible = false;
      g.querySelectorAll('.tabItem').forEach(ti => {
        const title = ti.dataset.title || '';
        const url = ti.dataset.url || '';
        const match = title.includes(q) || url.includes(q);
        ti.style.display = match ? '' : 'none';
        if (match) anyVisible = true;
      });

      if (anyVisible) {
        g.style.display = '';
        if (tabsList) {
          tabsList.style.display = 'block';
          triangle && triangle.classList.add('expanded');
        }
      } else {
        g.style.display = 'none';
      }
    });
  } catch (err) {
    console.error('applySearchFilter error:', err);
  }
}

/* ---------------- Open/Close All ---------------- */

function syncOpenCloseButtonLabel() {
  const btn = $('openCloseBtn');
  if (!btn) return;
  if (allOpenState) {
    btn.innerHTML = SVG_FOLDER_OPEN;
    btn.title = 'Collapse all';
  } else {
    btn.innerHTML = SVG_FOLDER_CLOSED;
    btn.title = 'Expand all';
  }
}

function updateSortBtnState() {
  const sortBtn = $('sortBtn');
  if (sortBtn) sortBtn.classList.toggle('active', sortAlpha);
  $('sortDefaultBtn')?.classList.toggle('active', !sortAlpha);
  $('sortAlphaBtn')?.classList.toggle('active', sortAlpha);
}

function toggleAllAccordions(open) {
  allOpenState = !!open;

  if (allOpenState) {
    expandedGroupIds = new Set();
    document.querySelectorAll('.group').forEach(g => setGroupOpenState(g, true));
  } else {
    expandedGroupIds = new Set();
    document.querySelectorAll('.group').forEach(g => setGroupOpenState(g, false));
  }

  syncOpenCloseButtonLabel();
}

/* ---------------- Workspace UI ---------------- */

async function refreshWorkspacesCache() {
  workspacesCache = await getAllWorkspaces();
  activeWorkspaceIdCache = await getActiveWorkspaceId();
}

function renderWorkspaceSwitcher() {
  const bar = $('workspaceBar');
  if (!bar) return;
  bar.innerHTML = '';

  const activeWs = workspacesCache[activeWorkspaceIdCache];

  // Header row: WORKSPACE label + add button
  const headerRow = document.createElement('div');
  headerRow.className = 'ws-header-row';

  const label = document.createElement('span');
  label.className = 'ws-section-label';
  label.textContent = 'WORKSPACE';

  const addBtn = document.createElement('button');
  addBtn.className = 'ws-add-btn';
  addBtn.title = 'New workspace';
  addBtn.textContent = '+';
  addBtn.addEventListener('click', () => {
    wsDropdownOpen = false;
    wsGearMenuForId = null;
    wsCreateFormVisible = true;
    renderWorkspaceSwitcher();
  });

  headerRow.appendChild(label);
  headerRow.appendChild(addBtn);
  bar.appendChild(headerRow);

  // Full-width active workspace dropdown button
  const activeBtn = document.createElement('button');
  activeBtn.className = 'ws-active-btn';

  const nameSpan = document.createElement('span');
  nameSpan.className = 'ws-name';
  nameSpan.textContent = activeWs ? activeWs.name : 'Workspace';

  const chevron = document.createElement('span');
  chevron.className = 'ws-chevron' + (wsDropdownOpen ? ' open' : '');
  chevron.textContent = '▾';

  activeBtn.appendChild(nameSpan);
  activeBtn.appendChild(chevron);
  activeBtn.addEventListener('click', () => {
    wsDropdownOpen = !wsDropdownOpen;
    wsGearMenuForId = null;
    renderWorkspaceSwitcher();
  });

  bar.appendChild(activeBtn);

  // Dropdown
  if (wsDropdownOpen) {
    const dropdown = document.createElement('div');
    dropdown.className = 'ws-dropdown';

    // Active workspace first, then rest alphabetically
    const sorted = Object.values(workspacesCache).sort((a, b) => {
      if (a.id === activeWorkspaceIdCache) return -1;
      if (b.id === activeWorkspaceIdCache) return 1;
      return a.name.localeCompare(b.name);
    });

    for (const ws of sorted) {
      const item = document.createElement('div');
      item.className = 'ws-dropdown-item';

      const check = document.createElement('span');
      check.className = 'ws-check';
      check.textContent = ws.id === activeWorkspaceIdCache ? '✓' : '';

      if (wsRenamingId === ws.id) {
        // Inline rename form replaces the name + gear
        const input = document.createElement('input');
        input.className = 'ws-rename-input';
        input.value = ws.name;
        input.placeholder = 'Workspace name...';

        const confirmBtn = document.createElement('button');
        confirmBtn.className = 'ws-rename-confirm';
        confirmBtn.textContent = '✓';

        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'ws-rename-cancel';
        cancelBtn.textContent = '✕';

        const submitRename = async () => {
          const newName = input.value.trim();
          if (newName) {
            await renameWorkspace(ws.id, newName);
            await refreshWorkspacesCache();
          }
          wsRenamingId = null;
          renderWorkspaceSwitcher();
        };
        const cancelRename = () => { wsRenamingId = null; renderWorkspaceSwitcher(); };

        confirmBtn.addEventListener('click', (e) => { e.stopPropagation(); submitRename(); });
        cancelBtn.addEventListener('click', (e) => { e.stopPropagation(); cancelRename(); });
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') submitRename();
          if (e.key === 'Escape') cancelRename();
        });
        input.addEventListener('click', (e) => e.stopPropagation());

        item.appendChild(check);
        item.appendChild(input);
        item.appendChild(confirmBtn);
        item.appendChild(cancelBtn);
        dropdown.appendChild(item);
        requestAnimationFrame(() => { input.focus(); input.select(); });
        continue;
      }

      // Normal item
      const wsName = document.createElement('span');
      wsName.className = 'ws-item-name' + (ws.id === activeWorkspaceIdCache ? ' active' : '');
      wsName.textContent = ws.name;

      const gearBtn = document.createElement('button');
      gearBtn.className = 'ws-gear-btn' + (wsGearMenuForId === ws.id ? ' open' : '');
      gearBtn.title = 'Options';
      gearBtn.textContent = '⚙';
      gearBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        wsGearMenuForId = wsGearMenuForId === ws.id ? null : ws.id;
        renderWorkspaceSwitcher();
      });

      item.appendChild(check);
      item.appendChild(wsName);
      item.appendChild(gearBtn);

      if (ws.id !== activeWorkspaceIdCache) {
        item.addEventListener('click', async () => {
          wsDropdownOpen = false;
          wsGearMenuForId = null;
          renderWorkspaceSwitcher();
          await doSwitchWorkspace(ws.id);
        });
      }

      // Gear context menu
      if (wsGearMenuForId === ws.id) {
        const gearMenu = document.createElement('div');
        gearMenu.className = 'ws-gear-menu';

        const renameOpt = document.createElement('button');
        renameOpt.textContent = 'Rename';
        renameOpt.addEventListener('click', (e) => {
          e.stopPropagation();
          wsGearMenuForId = null;
          wsRenamingId = ws.id;
          renderWorkspaceSwitcher();
        });
        gearMenu.appendChild(renameOpt);

        if (ws.id !== 'ws_default') {
          const deleteOpt = document.createElement('button');
          deleteOpt.textContent = 'Delete';
          deleteOpt.className = 'ws-delete';
          deleteOpt.addEventListener('click', async (e) => {
            e.stopPropagation();
            wsGearMenuForId = null;
            if (confirm(`Delete "${ws.name}"? This cannot be undone.`)) {
              try {
                await deleteWorkspace(ws.id);
                await refreshWorkspacesCache();
              } catch (err) {
                showStatus(err.message);
              }
            }
            renderWorkspaceSwitcher();
          });
          gearMenu.appendChild(deleteOpt);
        }

        item.appendChild(gearMenu);
      }

      dropdown.appendChild(item);
    }

    bar.appendChild(dropdown);
  }

  // New workspace create form
  if (wsCreateFormVisible) {
    const isPro = canUseFeature(FEATURES.MULTIPLE_WORKSPACES);
    const wsCount = Object.keys(workspacesCache).length;
    const atLimit = !isPro && wsCount >= FREE_WORKSPACE_LIMIT;

    const form = document.createElement('div');
    form.className = 'ws-create-form';

    if (atLimit) {
      // Limit reached — show upgrade nudge instead of input
      const limitMsg = document.createElement('p');
      limitMsg.className = 'ws-create-limit-msg';
      limitMsg.textContent = `Free plan includes up to ${FREE_WORKSPACE_LIMIT} workspaces.`;

      const btnRow = document.createElement('div');
      btnRow.className = 'ws-create-input-row';

      const upgradeBtn = document.createElement('button');
      upgradeBtn.className = 'ws-create-upgrade-btn';
      upgradeBtn.textContent = 'Get Pro for unlimited →';
      upgradeBtn.addEventListener('click', () => {
        const url = getStoreUrl();
        if (url) chrome.tabs.create({ url });
        wsCreateFormVisible = false;
        renderWorkspaceSwitcher();
      });

      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'ws-create-cancel';
      cancelBtn.textContent = '✕';
      cancelBtn.addEventListener('click', () => { wsCreateFormVisible = false; renderWorkspaceSwitcher(); });

      btnRow.appendChild(upgradeBtn);
      btnRow.appendChild(cancelBtn);
      form.appendChild(limitMsg);
      form.appendChild(btnRow);
    } else {
      // Normal create form
      const inputRow = document.createElement('div');
      inputRow.className = 'ws-create-input-row';

      const input = document.createElement('input');
      input.placeholder = 'Workspace name...';

      const confirmBtn = document.createElement('button');
      confirmBtn.className = 'ws-create-confirm';
      confirmBtn.textContent = '✓';

      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'ws-create-cancel';
      cancelBtn.textContent = '✕';

      const submitCreate = async () => {
        const name = input.value.trim();
        if (!name) { input.focus(); return; }
        await createWorkspace(name);
        await refreshWorkspacesCache();
        wsCreateFormVisible = false;
        renderWorkspaceSwitcher();
      };
      const cancelCreate = () => { wsCreateFormVisible = false; renderWorkspaceSwitcher(); };

      confirmBtn.addEventListener('click', submitCreate);
      cancelBtn.addEventListener('click', cancelCreate);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') submitCreate();
        if (e.key === 'Escape') cancelCreate();
      });

      inputRow.appendChild(input);
      inputRow.appendChild(confirmBtn);
      inputRow.appendChild(cancelBtn);
      form.appendChild(inputRow);

      // Usage indicator for free users
      if (!isPro) {
        const usage = document.createElement('div');
        usage.className = 'ws-create-usage';

        const usageText = document.createElement('span');
        usageText.textContent = `Using ${wsCount} of ${FREE_WORKSPACE_LIMIT} free workspaces`;

        const proLink = document.createElement('button');
        proLink.className = 'ws-create-pro-link';
        proLink.textContent = 'Get Pro';
        proLink.addEventListener('click', (e) => {
          e.stopPropagation();
          const url = getStoreUrl();
          if (url) chrome.tabs.create({ url });
        });

        usage.appendChild(usageText);
        usage.appendChild(proLink);
        form.appendChild(usage);
      }

      requestAnimationFrame(() => input.focus());
    }

    bar.appendChild(form);
  }
}

// Close sort menu and workspace UI panels when clicking outside
document.addEventListener('click', (e) => {
  // Close sort menu if click is outside .sort-wrap
  if (sortMenuOpen) {
    const sortWrap = document.querySelector('.sort-wrap');
    if (!sortWrap || !sortWrap.contains(e.target)) {
      sortMenuOpen = false;
      $('sortMenu')?.classList.add('hidden');
    }
  }

  // Close workspace panels if click is outside #workspaceBar
  const bar = $('workspaceBar');
  if (!bar || bar.contains(e.target)) return;
  if (wsDropdownOpen || wsGearMenuForId || wsCreateFormVisible || wsRenamingId) {
    wsDropdownOpen = false;
    wsGearMenuForId = null;
    wsRenamingId = null;
    wsCreateFormVisible = false;
    renderWorkspaceSwitcher();
  }
});

/* ---------------- Workspace switch ---------------- */

async function doSwitchWorkspace(targetId) {
  try {
    await switchWorkspace(targetId, expandedGroupIds, allOpenState);
    await refreshWorkspacesCache();
    renderWorkspaceSwitcher();
    await loadAndRender();
  } catch (e) {
    console.error('doSwitchWorkspace failed:', e);
    showStatus('Failed to switch workspace — see console.');
  }
}

/* ---------------- Footer / Pro panel ---------------- */

function renderFooter() {
  const footer = $('footer');
  if (!footer) return;
  footer.innerHTML = '';

  const isPro = canUseFeature(FEATURES.CLOUD_SYNC);
  const panel = document.createElement('div');
  panel.className = 'pro-panel';

  if (isPro) {
    _renderProActiveFooter(panel);
  } else if (footerLicenseInputVisible) {
    _renderLicenseInputFooter(panel);
  } else {
    _renderPromoFooter(panel);
  }

  footer.appendChild(panel);
}

function _renderPromoFooter(panel) {
  const header = document.createElement('div');
  header.className = 'pro-panel-header';

  const badge = document.createElement('span');
  badge.className = 'pro-badge';
  badge.textContent = 'PRO';

  const title = document.createElement('span');
  title.className = 'pro-panel-title';
  title.textContent = 'Tab Groups Pro';

  header.appendChild(badge);
  header.appendChild(title);
  panel.appendChild(header);

  const sub = document.createElement('p');
  sub.className = 'pro-panel-sub';
  sub.textContent = 'Cloud sync across devices + unlimited workspaces.';
  panel.appendChild(sub);

  const buttons = document.createElement('div');
  buttons.className = 'pro-panel-buttons';

  const upgradeBtn = document.createElement('button');
  upgradeBtn.className = 'pro-upgrade-btn';
  upgradeBtn.textContent = 'Upgrade →';
  upgradeBtn.addEventListener('click', () => {
    const url = getStoreUrl();
    if (url) {
      chrome.tabs.create({ url });
    } else {
      // Store URL not configured yet — do nothing in dev
      console.log('renderFooter: store URL not configured');
    }
  });

  const licenseBtn = document.createElement('button');
  licenseBtn.className = 'pro-license-btn';
  licenseBtn.textContent = 'Enter License';
  licenseBtn.addEventListener('click', () => {
    footerLicenseInputVisible = true;
    renderFooter();
  });

  buttons.appendChild(upgradeBtn);
  buttons.appendChild(licenseBtn);
  panel.appendChild(buttons);
}

function _renderLicenseInputFooter(panel) {
  const row = document.createElement('div');
  row.className = 'pro-key-row';

  const input = document.createElement('input');
  input.className = 'pro-key-input';
  input.placeholder = 'Paste license key…';
  input.type = 'text';
  input.spellcheck = false;

  const confirmBtn = document.createElement('button');
  confirmBtn.className = 'pro-key-confirm';
  confirmBtn.textContent = '✓';

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'pro-key-cancel';
  cancelBtn.textContent = '✕';

  row.appendChild(input);
  row.appendChild(confirmBtn);
  row.appendChild(cancelBtn);
  panel.appendChild(row);

  const hint = document.createElement('p');
  hint.className = 'pro-key-hint';
  hint.textContent = 'Paste the key from your purchase confirmation email.';
  panel.appendChild(hint);

  const submit = async () => {
    const key = input.value.trim();
    if (!key) { input.focus(); return; }

    confirmBtn.disabled = true;
    hint.textContent = 'Validating…';
    hint.classList.remove('error');

    const result = await activateLicense(key);
    if (result.ok) {
      footerLicenseInputVisible = false;
      // Migrate local workspaces into sync storage now that Pro is active.
      try { await migrateLocalToSync(); } catch (e) { console.warn('migrateLocalToSync failed', e); }
      renderFooter();
    } else {
      confirmBtn.disabled = false;
      hint.textContent = result.error || 'Invalid key. Please try again.';
      hint.classList.add('error');
      input.focus();
    }
  };

  const cancel = () => {
    footerLicenseInputVisible = false;
    renderFooter();
  };

  confirmBtn.addEventListener('click', submit);
  cancelBtn.addEventListener('click', cancel);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submit();
    if (e.key === 'Escape') cancel();
  });

  requestAnimationFrame(() => input.focus());
}

function _renderProActiveFooter(panel) {
  const row = document.createElement('div');
  row.className = 'pro-active-row';

  const badge = document.createElement('span');
  badge.className = 'pro-badge';
  badge.textContent = 'PRO';

  const keyDisplay = document.createElement('span');
  keyDisplay.className = 'pro-active-key';
  keyDisplay.textContent = getLicenseKeyDisplay() || 'Active';

  const deactivateBtn = document.createElement('button');
  deactivateBtn.className = 'pro-deactivate-btn';
  deactivateBtn.textContent = 'Deactivate';
  deactivateBtn.addEventListener('click', async () => {
    if (!confirm('Deactivate your Pro license on this device?')) return;
    await deactivateLicense();
    renderFooter();
  });

  row.appendChild(badge);
  row.appendChild(keyDisplay);
  row.appendChild(deactivateBtn);
  panel.appendChild(row);
}

/* ---------------- UI wiring ---------------- */

function wireUI() {
  try {
    // Stop all clicks inside the workspace bar from bubbling to the document
    // outside-click handler — prevents the handler from seeing clicks on
    // elements that were just removed from the DOM by a re-render.
    $('workspaceBar')?.addEventListener('click', (e) => e.stopPropagation());

    // Initialize toolbar icons
    const sortBtn = $('sortBtn');
    if (sortBtn) sortBtn.innerHTML = SVG_SORT;

    const refreshBtn = $('refreshBtn');
    if (refreshBtn) refreshBtn.innerHTML = SVG_REFRESH;

    // Sort button opens dropdown
    sortBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      sortMenuOpen = !sortMenuOpen;
      $('sortMenu')?.classList.toggle('hidden', !sortMenuOpen);
    });

    $('sortDefaultBtn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      sortAlpha = false;
      sortMenuOpen = false;
      $('sortMenu')?.classList.add('hidden');
      updateSortBtnState();
      loadAndRender();
    });

    $('sortAlphaBtn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      sortAlpha = true;
      sortMenuOpen = false;
      $('sortMenu')?.classList.add('hidden');
      updateSortBtnState();
      loadAndRender();
    });

    $('openCloseBtn')?.addEventListener('click', () => {
      toggleAllAccordions(!allOpenState);
    });

    refreshBtn?.addEventListener('click', loadAndRender);
    $('search')?.addEventListener('input', applySearchFilter);

    syncOpenCloseButtonLabel();
    updateSortBtnState();
  } catch (e) {
    console.error('wireUI error:', e);
    showStatus('UI wiring error — see console.');
  }
}

/* ---------------- Init ---------------- */

document.addEventListener('DOMContentLoaded', async () => {
  wireUI();

  try {
    await initPermissions();
  } catch (e) {
    console.error('initPermissions failed:', e);
  }

  try {
    await initWorkspaces();
    await refreshWorkspacesCache();
  } catch (e) {
    console.error('initWorkspaces failed:', e);
  }

  renderWorkspaceSwitcher();
  renderFooter();
  loadAndRender();

  try {
    if (chrome && chrome.tabs) {
      chrome.tabs.onUpdated && chrome.tabs.onUpdated.addListener(() => { loadAndRender(); scheduleSave(); });
      chrome.tabs.onCreated && chrome.tabs.onCreated.addListener(() => { loadAndRender(); scheduleSave(); });
      chrome.tabs.onRemoved && chrome.tabs.onRemoved.addListener(() => { loadAndRender(); scheduleSave(); });
      chrome.tabs.onMoved && chrome.tabs.onMoved.addListener(() => { loadAndRender(); scheduleSave(); });
      chrome.tabs.onAttached && chrome.tabs.onAttached.addListener(() => { loadAndRender(); scheduleSave(); });
      chrome.tabs.onDetached && chrome.tabs.onDetached.addListener(() => { loadAndRender(); scheduleSave(); });
    }
    if (chrome && chrome.tabGroups && chrome.tabGroups.onChanged) {
      chrome.tabGroups.onChanged.addListener(() => { loadAndRender(); scheduleSave(); });
    }
  } catch (attachErr) {
    console.warn('Could not attach listeners:', attachErr);
  }
});
