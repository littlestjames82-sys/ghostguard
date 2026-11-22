# GhostGuard Gate — GitHub Action (local deliverable)

A composite GitHub Action that checks one workflow step against a
GhostGuard trail: the job **fails** unless the trail holds a record
for the required `action-id` with verdict `allow` or `pre_approved`
— and, with `require-approval: "true"`, a matching approval
(decision) entry for that same action.

> **Status: delivered as files only.** Not published to the
> Marketplace, not pushed anywhere. `simulate.mjs` proves the gate
> locally; using it for real means copying this folder into a repo
> Ryan controls — his separate call.

## Files
- `action.yml` — composite action: setup-node + run `gate.mjs`.
- `gate.mjs` — the gate itself (zero deps). Exit 0 pass, 1 gate
  failure, 2 usage/IO error (never a pass).
- `fixtures/` — sample trails (allow, deny, ask, cloud-style
  record+decision entries).
- `simulate.mjs` — local simulation: runs the gate against the
  fixtures and asserts exit codes (9 cases).

## Usage in a workflow (once copied into a repo)
```yaml
- uses: ./path/to/github-action
  with:
    trail: ghostguard-trail.jsonl
    action-id: deploy_prod_1
    require-approval: "true"
```

## Trail format
JSONL. Accepts gateway records (`{action_id, verdict, ...}`) and
GhostGuard Cloud store entries (`entry_type: "record"|"decision"`).
Unknown lines are ignored — the gate fails closed on absence, so an
unrecognised line can never grant a pass.

## Test
```sh
node simulate.mjs   # or the top-level: npm run verify
```
