// permissions.js — feature gating
// All features return true for now. Wire canUseFeature() to a real license
// check (LemonSqueezy) when premium tiers are introduced.

const FEATURES = {
  MULTIPLE_WORKSPACES: 'multiple_workspaces'
};

function canUseFeature(feature) { // eslint-disable-line no-unused-vars
  return true;
}
