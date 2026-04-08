// sidebar.js (tab close buttons only; ungrouped first; keeps bug fix + Chrome-like colors)

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
let allOpenState = false;
let expandedGroupIds = new Set();

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

/* ---------------- Data load & render ---------------- */

async function loadAndRender() {
  clearStatus();
  try {
    let tabs = [];
    try {
      tabs = await chrome.tabs.query({ currentWindow: true });
      if (!tabs || tabs.length === 0) {
        tabs = await chrome.tabs.query({});
        showStatus('Showing tabs from all windows (fallback).');
      }
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
  if (groupId === -1) return { id: -1, title: '(ungrouped)', color: 'default' };
  try {
    if (!chrome.tabGroups || !chrome.tabGroups.get) {
      return { id: groupId, title: `(group ${groupId})`, color: 'default' };
    }
    const info = await chrome.tabGroups.get(groupId);
    return { id: groupId, title: info.title || '(untitled)', color: info.color || 'default' };
  } catch (e) {
    console.warn('fetchGroupInfo failed for', groupId, e);
    return { id: groupId, title: `(group ${groupId})`, color: 'default' };
  }
}

async function renderFromTabs(tabs) {
  try {
    const { byId, pinned } = groupTabsByGroupId(tabs);
    const groups = [];

    // Put ungrouped first
    if (byId.has(-1)) {
      groups.push({
        groupId: -1,
        title: '(ungrouped)',
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

          tabsList.appendChild(tabRow);
        }
      }

      groupEl.appendChild(tabsList);
      container.appendChild(groupEl);

      const baseHex = chromeColorMap[g.color] || chromeColorMap.default;
      const uiHex = chromeifyGroupColor(baseHex);
      header.style.background = uiHex;

      const fg = getContrastColor(uiHex);
      header.style.color = fg;
      triangle.style.color = fg;
      count.style.color = fg;

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
    }

    restoreAccordionStateAfterRender();
    applySearchFilter();
  } catch (uiErr) {
    console.error('renderUI fatal error:', uiErr);
    showStatus('UI rendering error — see console.');
  }
}

/* ---------------- Search (tabs only; expand matches only when query non-empty) ---------------- */

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
    btn.textContent = '📁 Close all';
    btn.title = 'Close all accordions';
  } else {
    btn.textContent = '📂 Open all';
    btn.title = 'Open all accordions';
  }
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

/* ---------------- UI wiring ---------------- */

function wireUI() {
  try {
    $('refreshBtn')?.addEventListener('click', loadAndRender);
    $('search')?.addEventListener('input', applySearchFilter);

    $('sortBtn')?.addEventListener('click', async () => {
      sortAlpha = !sortAlpha;
      const sb = $('sortBtn');
      if (sb) sb.textContent = sortAlpha ? 'Sort: A→Z' : 'Sort: Default';
      renderUI(pinnedCache, groupsData);
      await loadAndRender();
    });

    $('openCloseBtn')?.addEventListener('click', () => {
      toggleAllAccordions(!allOpenState);
    });

    syncOpenCloseButtonLabel();
  } catch (e) {
    console.error('wireUI error:', e);
    showStatus('UI wiring error — see console.');
  }
}

/* ---------------- Init ---------------- */

document.addEventListener('DOMContentLoaded', () => {
  wireUI();
  loadAndRender();

  try {
    if (chrome && chrome.tabs) {
      chrome.tabs.onUpdated && chrome.tabs.onUpdated.addListener(() => loadAndRender());
      chrome.tabs.onCreated && chrome.tabs.onCreated.addListener(() => loadAndRender());
      chrome.tabs.onRemoved && chrome.tabs.onRemoved.addListener(() => loadAndRender());
      chrome.tabs.onMoved && chrome.tabs.onMoved.addListener(() => loadAndRender());
    }
    if (chrome && chrome.tabGroups && chrome.tabGroups.onChanged) {
      chrome.tabGroups.onChanged.addListener(() => loadAndRender());
    }
  } catch (attachErr) {
    console.warn('Could not attach listeners:', attachErr);
  }
});
