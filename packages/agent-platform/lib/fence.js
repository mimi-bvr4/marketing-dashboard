// ORDER #2963 build step 6: the fence lives in code, not in config.
//
// Every department's agent team runs inside these limits. No department
// config can turn one off: defineDepartment() refuses a config that names any
// of these keys, and the object below is frozen.
'use strict';

const FENCE = Object.freeze({
  // Agents write DRAFTS. A person approves; nothing is sent, posted, paid or signed by an agent.
  drafts_only: true,
  forbidden_actions: Object.freeze(['send', 'post', 'pay', 'sign']),
  // Suggest, a person approves, then act. No silent writes to a live system.
  suggest_approve_act: true,
  // Every draft is run through the department's copy checks before a person can approve it.
  // A department may add checks; it may not remove the check step itself.
  copy_checks_step: true,
  // Secrets come from the Box Keychain (via the app's env at launch), never from a config file.
  secrets_from_keychain_only: true,
  // The master agent (reviewer watch) reads agent tables only: never a compensation
  // field and never an HR record, even when the department IS HR.
  reviewer_reads_agent_tables_only: true,
});

// Config keys that would switch a fence off. A config carrying any of them is refused.
const FENCE_KEYS = Object.freeze([
  ...Object.keys(FENCE),
  'allow_send', 'allow_post', 'allow_pay', 'allow_sign', 'auto_approve', 'skip_copy_checks',
  'secrets', 'api_key', 'api_keys', 'token', 'password',
]);

// True when an action an agent is about to take is one the fence forbids.
function forbidden(action) {
  return FENCE.forbidden_actions.includes(String(action || '').trim().toLowerCase());
}

module.exports = { FENCE, FENCE_KEYS, forbidden };
