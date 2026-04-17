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

const LS_STORE_ID       = 341342;
const LS_URL_ANNUAL     = 'https://tabgroups.lemonsqueezy.com/checkout/buy/d68f5603-c188-4b51-a7f6-fa8140a53eff';
const LS_URL_LIFETIME   = 'https://tabgroups.lemonsqueezy.com/checkout/buy/c3af4842-c2c8-41c1-8743-6550f86423a8';

const LS_ACTIVATE_URL   = 'https://api.lemonsqueezy.com/v1/licenses/activate';
const LS_VALIDATE_URL   = 'https://api.lemonsqueezy.com/v1/licenses/validate';
const LS_DEACTIVATE_URL = 'https://api.lemonsqueezy.com/v1/licenses/deactivate';

// In-memory cache set by initPermissions(). Keeps canUseFeature() synchronous.
let _licenseStatus = 'inactive'; // 'active' | 'inactive'
let _licenseKey    = null;
let _instanceId    = null; // LemonSqueezy activation instance ID

/* ---------------- Public API ---------------- */

// Must be awaited once during DOMContentLoaded before any canUseFeature() call.
async function initPermissions() {
  try {
    const data = await _localGet(['licenseKey', 'licenseStatus', 'licenseValidatedAt', 'licenseInstanceId']);
    _licenseKey    = data.licenseKey        || null;
    _licenseStatus = data.licenseStatus     || 'inactive';
    _instanceId    = data.licenseInstanceId || null;

    // Re-validate against LemonSqueezy if the key is present but the cached
    // validation is older than 24 hours (catches refunds / chargebacks).
    const validatedAt = data.licenseValidatedAt || 0;
    const stale = (Date.now() - validatedAt) > 24 * 60 * 60 * 1000;
    if (_licenseKey && stale) {
      await _revalidate(_licenseKey, _instanceId);
    }
  } catch (e) {
    console.warn('initPermissions: could not read license data', e);
  }
}

// Synchronous — safe to call anywhere after initPermissions() has resolved.
function canUseFeature(feature) { // eslint-disable-line no-unused-vars
  return _licenseStatus === 'active';
}

// Activate a new license key. Returns { ok: true } or { ok: false, error: string }.
async function activateLicense(key) { // eslint-disable-line no-unused-vars
  const result = await _activateWithLemonSqueezy(key.trim());
  if (result.ok) {
    _licenseKey    = key.trim();
    _licenseStatus = 'active';
    _instanceId    = result.instanceId || null;
    await _localSet({
      licenseKey:          _licenseKey,
      licenseStatus:       'active',
      licenseValidatedAt:  Date.now(),
      licenseInstanceId:   _instanceId
    });
  }
  return result;
}

// Deactivate — frees the activation slot on LemonSqueezy, then clears local state.
async function deactivateLicense() { // eslint-disable-line no-unused-vars
  if (_licenseKey && _instanceId && LS_STORE_ID) {
    try {
      await fetch(LS_DEACTIVATE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ license_key: _licenseKey, instance_id: _instanceId })
      });
    } catch (e) {
      console.warn('permissions: deactivation API call failed (continuing anyway)', e);
    }
  }
  _licenseKey    = null;
  _licenseStatus = 'inactive';
  _instanceId    = null;
  await _localSet({ licenseKey: null, licenseStatus: 'inactive', licenseValidatedAt: 0, licenseInstanceId: null });
}

// Returns the stored license key masked for display, or null.
function getLicenseKeyDisplay() { // eslint-disable-line no-unused-vars
  if (!_licenseKey) return null;
  const k = _licenseKey;
  if (k.length <= 8) return k;
  return k.slice(0, 4) + '-••••-••••-' + k.slice(-4);
}

function getAnnualUrl()   { return LS_URL_ANNUAL;   } // eslint-disable-line no-unused-vars
function getLifetimeUrl() { return LS_URL_LIFETIME; } // eslint-disable-line no-unused-vars

/* ---------------- Internal ---------------- */

async function _revalidate(key, instanceId) {
  const result = await _validateWithLemonSqueezy(key, instanceId);
  _licenseStatus = result.ok ? 'active' : 'inactive';
  await _localSet({
    licenseStatus:      _licenseStatus,
    licenseValidatedAt: Date.now()
  });
}

// First-time activation — creates an instance so LemonSqueezy can track seats.
async function _activateWithLemonSqueezy(key) {
  if (!LS_STORE_ID) {
    console.warn('permissions: LS_STORE_ID not set — dev mode, accepting any key');
    return key.length > 0 ? { ok: true, instanceId: null } : { ok: false, error: 'No key provided.' };
  }

  try {
    const res = await fetch(LS_ACTIVATE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ license_key: key, instance_name: 'Chrome Extension' })
    });
    const json = await res.json();

    if (!res.ok || !json.activated) {
      return { ok: false, error: json.error || 'License key could not be activated.' };
    }
    return { ok: true, instanceId: json.instance?.id || null };
  } catch (e) {
    console.error('permissions: LemonSqueezy activate failed', e);
    return { ok: false, error: 'Could not reach the license server. Check your connection.' };
  }
}

// Periodic re-validation — checks the key is still active (catches refunds).
async function _validateWithLemonSqueezy(key, instanceId) {
  if (!LS_STORE_ID) {
    return key && key.length > 0 ? { ok: true } : { ok: false, error: 'No key.' };
  }

  try {
    const body = { license_key: key };
    if (instanceId) body.instance_id = instanceId;

    const res = await fetch(LS_VALIDATE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(body)
    });
    const json = await res.json();

    if (!res.ok || !json.valid) {
      return { ok: false, error: json.error || 'License key is no longer valid.' };
    }
    return { ok: true };
  } catch (e) {
    // Network failure — preserve cached status rather than revoking access.
    console.warn('permissions: LemonSqueezy validate failed, keeping cached status', e);
    return { ok: true };
  }
}

function _localGet(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}

function _localSet(data) {
  return new Promise((resolve) => chrome.storage.local.set(data, resolve));
}
