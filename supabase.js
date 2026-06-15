// supabase.js — Supabase cloud sync for Pro users
// Depends on: nothing. Must be loaded before permissions.js and storage.js.
// Uses fetch directly — no SDK required.

const SUPABASE_URL     = 'https://hcymacchyhwqohmzlfgm.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_cG9XqANitUG8EzYDY38Uvg_akamGLyj';

// In-memory session cache. Backed by chrome.storage.local for persistence
// across service worker restarts.
let _sbSession = null; // { access_token, refresh_token, user_id, expires_at }

/* ---------------- Credential derivation ---------------- */

// Derives a stable email + password pair from the license key using SHA-256.
// The raw key never leaves the device — only the hash is sent to Supabase.
async function _deriveCredentials(licenseKey) {
  const enc = new TextEncoder();
  const toHex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');

  const [emailBuf, pwBuf] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode('tgw-email:' + licenseKey)),
    crypto.subtle.digest('SHA-256', enc.encode('tgw-pwd:'   + licenseKey))
  ]);

  return {
    email:    toHex(emailBuf).slice(0, 40) + '@tabgroups-sync.app',
    password: toHex(pwBuf)
  };
}

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

// Signs in using credentials derived from the license key.
// Creates a Supabase account on first use (sign-up fallback).
// Requires "Confirm email" to be OFF in Supabase → Auth → Providers → Email.
async function supabaseSignIn(licenseKey) { // eslint-disable-line no-unused-vars
  const { email, password } = await _deriveCredentials(licenseKey);

  const authHeaders = { 'Content-Type': 'application/json', 'apikey': SUPABASE_ANON_KEY };

  try {
    // Attempt sign-in first.
    const signInRes = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: 'POST', headers: authHeaders,
      body: JSON.stringify({ email, password })
    });
    const signInJson = await signInRes.json();

    if (signInRes.ok && signInJson.access_token) {
      await _saveSession({
        access_token:  signInJson.access_token,
        refresh_token: signInJson.refresh_token,
        user_id:       signInJson.user?.id,
        expires_at:    Date.now() + (signInJson.expires_in || 3600) * 1000
      });
      return { ok: true };
    }

    // 400 = account doesn't exist yet — sign up.
    if (signInRes.status === 400) {
      const signUpRes = await fetch(`${SUPABASE_URL}/auth/v1/signup`, {
        method: 'POST', headers: authHeaders,
        body: JSON.stringify({ email, password })
      });
      const signUpJson = await signUpRes.json();

      if (signUpRes.ok && signUpJson.access_token) {
        await _saveSession({
          access_token:  signUpJson.access_token,
          refresh_token: signUpJson.refresh_token,
          user_id:       signUpJson.user?.id,
          expires_at:    Date.now() + (signUpJson.expires_in || 3600) * 1000
        });
        return { ok: true };
      }

      // Sign-up returned a user but no token — email confirmation is likely on.
      if (signUpRes.ok && signUpJson.id) {
        return { ok: false, error: 'Email confirmation is enabled in Supabase — please disable it under Auth → Providers → Email.' };
      }

      return { ok: false, error: signUpJson.msg || signUpJson.error_description || 'Account creation failed.' };
    }

    return { ok: false, error: signInJson.error_description || signInJson.msg || 'Authentication failed.' };

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
    const res = await fetch(`${SUPABASE_URL}/rest/v1/workspaces`, {
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
