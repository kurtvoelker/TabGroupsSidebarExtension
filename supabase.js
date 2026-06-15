// supabase.js — Supabase cloud sync for Pro users
// Depends on: nothing. Must be loaded before permissions.js and storage.js.
// Uses fetch directly — no SDK required.

const SUPABASE_URL     = 'https://hcymacchyhwqohmzlfgm.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_cG9XqANitUG8EzYDY38Uvg_akamGLyj';

// In-memory session cache. Backed by chrome.storage.local for persistence
// across service worker restarts.
let _sbSession = null; // { access_token, refresh_token, user_id, expires_at }

/* ---------------- Session management ---------------- */

async function _loadSession() {
  if (_sbSession) return _sbSession;
  const { _supabaseSession } = await chrome.storage.local.get('_supabaseSession');
  _sbSession = _supabaseSession || null;
  return _sbSession;
}

async function _saveSession(session) {
  _sbSession = session;
  await chrome.storage.local.set({ _supabaseSession: session });
}

async function _clearSession() {
  _sbSession = null;
  await chrome.storage.local.remove('_supabaseSession');
}

async function _refreshSession(refreshToken) {
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_ANON_KEY },
      body:    JSON.stringify({ refresh_token: refreshToken })
    });
    if (!res.ok) { await _clearSession(); return null; }
    const json = await res.json();
    const session = {
      access_token:  json.access_token,
      refresh_token: json.refresh_token,
      user_id:       json.user?.id || _sbSession?.user_id,
      expires_at:    Date.now() + (json.expires_in || 3600) * 1000
    };
    await _saveSession(session);
    return session;
  } catch (e) {
    console.warn('supabase: token refresh failed', e);
    return null;
  }
}

// Returns a valid session, refreshing the token if needed. Returns null if
// unauthenticated or if refresh fails.
async function _getValidSession() {
  let session = await _loadSession();
  if (!session) return null;
  if (Date.now() > session.expires_at - 60_000) {
    session = await _refreshSession(session.refresh_token);
  }
  return session;
}

/* ---------------- Auth ---------------- */

// Exchanges a license key for Supabase session tokens via an Edge Function.
// The Edge Function uses the admin API server-side, avoiding email format issues
// and keeping the service role key out of the extension.
async function supabaseSignIn(licenseKey) { // eslint-disable-line no-unused-vars
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/auth-with-license`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_ANON_KEY },
      body:    JSON.stringify({ license_key: licenseKey })
    });
    const json = await res.json();

    if (!res.ok || !json.access_token) {
      return { ok: false, error: json.error || 'Authentication failed.' };
    }

    await _saveSession({
      access_token:  json.access_token,
      refresh_token: json.refresh_token,
      user_id:       json.user_id,
      expires_at:    Date.now() + (json.expires_in || 3600) * 1000
    });
    return { ok: true };

  } catch (e) {
    console.error('supabase: sign-in error', e);
    return { ok: false, error: 'Could not connect to sync server. Check your connection.' };
  }
}

async function supabaseSignOut() { // eslint-disable-line no-unused-vars
  const session = await _loadSession();
  if (session?.access_token) {
    try {
      await fetch(`${SUPABASE_URL}/auth/v1/logout`, {
        method:  'POST',
        headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': `Bearer ${session.access_token}` }
      });
    } catch (e) {
      console.warn('supabase: sign-out request failed', e);
    }
  }
  await _clearSession();
}

/* ---------------- REST helpers ---------------- */

function _restHeaders(session) {
  return {
    'apikey':        SUPABASE_ANON_KEY,
    'Authorization': `Bearer ${session.access_token}`,
    'Content-Type':  'application/json'
  };
}

/* ---------------- Workspace sync operations ---------------- */

// Upsert one workspace row. Safe to fire-and-forget.
async function pushWorkspace(workspaceKey, data) { // eslint-disable-line no-unused-vars
  const session = await _getValidSession();
  if (!session) return;

  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/workspaces?on_conflict=user_id,workspace_key`, {
      method:  'POST',
      headers: { ..._restHeaders(session), 'Prefer': 'resolution=merge-duplicates' },
      body: JSON.stringify({
        user_id:       session.user_id,
        workspace_key: workspaceKey,
        data,
        updated_at:    new Date(data.updatedAt || Date.now()).toISOString()
      })
    });
    if (!res.ok) console.warn('supabase: pushWorkspace failed', res.status, await res.text());
  } catch (e) {
    console.warn('supabase: pushWorkspace network error', e);
  }
}

// Fetch all workspace rows for this user.
// Returns [{ workspace_key, data, updated_at }] or null on failure.
async function pullAllWorkspaces() { // eslint-disable-line no-unused-vars
  const session = await _getValidSession();
  if (!session) return null;

  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/workspaces?select=workspace_key,data,updated_at`,
      { headers: _restHeaders(session) }
    );
    if (!res.ok) { console.warn('supabase: pullAllWorkspaces failed', res.status); return null; }
    return await res.json();
  } catch (e) {
    console.warn('supabase: pullAllWorkspaces network error', e);
    return null;
  }
}

// Delete a workspace row by key. Safe to fire-and-forget.
async function deleteWorkspaceRemote(workspaceKey) { // eslint-disable-line no-unused-vars
  const session = await _getValidSession();
  if (!session) return;

  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/workspaces?workspace_key=eq.${encodeURIComponent(workspaceKey)}`,
      { method: 'DELETE', headers: _restHeaders(session) }
    );
    if (!res.ok) console.warn('supabase: deleteWorkspaceRemote failed', res.status);
  } catch (e) {
    console.warn('supabase: deleteWorkspaceRemote network error', e);
  }
}
