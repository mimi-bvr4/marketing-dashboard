# agent-platform (ORDER #2963)

The shared agent-team module. A department's app supplies a config, its agent
folders and its skill files; the module supplies the runner, team page, review
queue, edit chain, Producer and the reviewer watch.

**Where this lives for now:** `marketing-dashboard/packages/agent-platform/`, until the
`mimi-bvr4/agent-platform` repo exists. Then `git subtree split --prefix packages/agent-platform`
gives the new repo this folder's full history, and each app pins it as
`"agent-platform": "github:mimi-bvr4/agent-platform#<sha>"`.

## Slice status
- [x] 1. Department config (`lib/config.js`), the fence in code (`lib/fence.js`), department column migration (`lib/schema.js`)
- [ ] 2. Storage (`agent-store`) takes a department; reads and writes filter on it
- [ ] 3. Runner + jobs take a department argument
- [ ] 4. Routers: team page, review, Producer, reviewer watch; mounted by marketing-dashboard at today's paths
- [ ] 5. Edit chain + build route (replaces `kh_route`)
- [ ] 6. Parity proof live, demo department boots, HR mounts inside infinity-dispatch

## Example config (Marketing)
```js
const { defineDepartment } = require('agent-platform');
module.exports = defineDepartment({
  id: 'marketing', name: 'Marketing',
  head: { name: 'Katherine Howe', emails: ['katherine@infinityhospitality.net'] },
  instruction_approver: { name: 'Mimi Beaver', emails: ['mimi@infinityhospitality.net'] },
  agents_dir: __dirname + '/../agents', skills_dir: __dirname + '/../agents',
  review_gate: ['exec', 'head'], copy_checks: true,
  laws: ['finance read-only', 'compensation never'],
  producer: { weekly_cap: 25, waiting_hold: 15 }, voices: true,
  build_route: { order_tag: 'KH' },
});
```

## The fence (code, not config)
Drafts only (no send, post, pay or sign); suggest-approve-act; copy checks always run;
secrets from the Box Keychain only; the reviewer watch reads agent tables only, never
compensation or an HR record, even for HR. A config that names any fence key is refused.
