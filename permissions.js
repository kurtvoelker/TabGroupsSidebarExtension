// permissions.js — feature gating + license validation
// Depends on: nothing (loaded first, no DOM access)
//
// License data is always stored in chrome.storage.local (never synced).
// Call initPermissions() once at startup before canUseFeature() is used.

const FEATURES = {
  MULTIPLE_WORKSPACES: 'multiple_workspaces',
  CLOUD_SYNC:          'cloud_sync'
};

const FREE_WORKSPACE_LIMIT = 3; // eslint-disable-line no-unused-vars

// LemonSqueezy store — update these when the store is live.
const LS_API_URL   = 'https://api.lemonsqueezy.com/v1/licenses/validate';
const LS_STORE_ID  = null;  // e.g. 12345  — fill in before launch
const LS_STORE_URL = null;  // e.g. 'https://yourstore.lemonsqueezy.com/buy/...' — fill in before launch

// In-memory cache set by initPermissions(). Keeps canUseFeature() synchronous.
let _licenseStatus = 'inactive'; // 'active' | 'inactive'
let _licenseKey    = null;

/* ---------------- Public API ---------------- */

// Must be awaited once during DOMContentLoaded before any canUseFeature() call.
async function initPermissions() {
  try {
    const data = await _localGet(['licenseKey', 'licenseStatus', 'licenseValidatedAt']);
    _licenseKey    = data.licenseKey    || null;
    _licenseStatus = data.licenseStatus || 'inactive';

    // Re-validate against LemonSqueezy if the key is present but the cached
    // validation is older than 24 hours (catches refunds / chargebacks).
    const validatedAt = data.licenseValidatedAt || 0;
    const stale = (Date.now() - validatedAt) > 24 * 60 * 60 * 1000;
    if (_licenseKey && stale) {
      await _revalidate(_licenseKey);
    }
  } catch (e) {
    console.warn('initPermissions: could not read license data', e);
  }
}

// Synchronous — safe to call anywhere after initPermissions() has resolved.
function canUseFeature(feature) { // eslint-disable-line no-unused-vars
  if (_licenseStatus === 'active') return true;

  // Features available on the free tier:
  // (none currently — all gated behind Pro)
  return false;
}

// Activate a new license key. Returns { ok: true } or { ok: false, error: string }.
async function activateLicense(key) {
  const result = await _validateWithLemonSqueezy(key);
  if (result.ok) {
    _licenseKey    = key.trim();
    _licenseStatus = 'active';
    await _localSet({
      licenseKey:          _licenseKey,
      licenseStatus:       'active',
      licenseValidatedAt:  Date.now()
    });
  }
  return result;
}

// Deactivate (e.g. user wants to move key to another device).
async function deactivateLicense() {
  _licenseKey    = null;
  _licenseStatus = 'inactive';
  await _localSet({ licenseKey: null, licenseStatus: 'inactive', licenseValidatedAt: 0 });
}

// Returns the stored license key (masked for display), or null.
function getLicenseKeyDisplay() {
  if (!_licenseKey) return null;
  // Show first 4 and last 4 chars: XXXX-••••-••••-XXXX
  const k = _licenseKey;
  if (k.length <= 8) return k;
  return k.slice(0, 4) + '-••••-••••-' + k.slice(-4);
}

// Returns the upgrade store URL, or null if not yet configured.
function getStoreUrl() { // eslint-disable-line no-unused-vars
  return LS_STORE_URL;
}

/* ---------------- Internal ---------------- */

async function _revalidate(key) {
  const result = await _validateWithLemonSqueezy(key);
  _licenseStatus = result.ok ? 'active' : 'inactive';
  await _localSet({
    licenseStatus:      _licenseStatus,
    licenseValidatedAt: Date.now()
  });
}

// Calls the LemonSqueezy license validation API.
// Returns { ok: true } or { ok: false, error: string }.
async function _validateWithLemonSqueezy(key) {
  // Guard: if store ID isn't configured yet, treat any non-empty key as active
  // so development/testing works without a live LemonSqueezy account.
  if (!LS_STORE_ID) {
    console.warn('permissions: LS_STORE_ID not set — accepting key without API validation (dev mode)');
    return key && key.trim().length > 0
      ? { ok: true }
      : { ok: false, error: 'No key provided.' };
  }

  try {
    const res = await fetch(LS_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ license_key: key.trim() })
    });
    const json = await res.json();

    if (!res.ok || !json.valid) {
      return { ok: false, error: json.error || 'License key is not valid.' };
    }
    return { ok: true };
  } catch (e) {
    console.error('permissions: LemonSqueezy API call failed', e);
    return { ok: false, error: 'Could not reach the license server. Check your connection.' };
  }
}

function _localGet(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}

function _localSet(data) {
  return new Promise((resolve) => chrome.storage.local.set(data, resolve));
}
