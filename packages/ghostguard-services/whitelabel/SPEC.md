# White-Label Trail Portal — Prototype Spec

**Status: PROTOTYPE, unpublished.** `portal.html` in this directory is a static,
no-server prototype built Oct 10, 2026 for internal review. It has not been
deployed, hosted, linked, or shown to any client or agency. The Agency tier
price it illustrates (**DRAFT $99/mo**, from `~/workspace/ghostguard/PLAN.md`
§4) is **DRAFT — not final, not published, not quoted to anyone.**

---

## 1. The idea (idea #20 from the GhostGuard more-ideas list)

Small AI agencies build agents for clients, and the client eventually asks:
*"What has this thing been doing?"* The agency's answer is a trail — every
action the agent proposed, the verdict it got, the rule that decided, and who
approved what. Agencies do not want to send clients to a dashboard branded
with someone else's product. The White-Label Trail Portal is the Agency-tier
feature that lets the agency put **its own name, logo text, and accent color**
on that trail view — with an honest, small **"Powered by GhostGuard"**
attribution line kept in place (visible, never hidden; it is a trust mark,
not a watermark to be ashamed of).

The portal is a *view over GhostGuard records*. It changes no verdicts and
certifies nothing: GhostGuard produces the records and gates the effects; the
portal renders them under the agency's brand.

## 2. What the prototype proves (`portal.html`)

- A gateway-record trail (JSONL shape, exactly what GhostGuard's recorder
  writes) renders as: verdict tallies, a **pending approvals** section
  (`ask` / `hand_off` records with no decision yet), and a searchable,
  verdict-filterable trail table with per-record payload detail.
- Branding is swappable without touching the layout: a `BRANDING` config
  object at the top of the file, overridable by query parameters
  (`?agency=…&logo=…&accent=…`) — demo it to an agency prospect with *their*
  name on it in ten seconds.
- A trail file can be loaded via file input (parsed locally in the browser —
  nothing is uploaded anywhere; there is no server).
- Approve/Deny buttons exist to show the approvals interaction; in the
  prototype they change **local page state only** and are labelled as such.
- It ships with an embedded **fictional** demo trail (the Copperline Support
  Co. worked example from `../audit/`) so it is screenshot-able immediately,
  clearly labelled FICTIONAL DEMO DATA on the page itself.

## 3. How this becomes the Agency tier feature (hosted version)

The prototype is the front-end shape only. The hosted version sits on
GhostGuard Cloud (M3/M3.1 skeleton today: hosted audit store + approvals
inbox, workspace-scoped keys, decision delivery) and needs, in build order:

1. **Per-agency subdomains** — `<agency>.guard.<domain>` (domain itself is
   Ryan-gated; nothing is registered) resolving to that agency's branding
   config: name, logo (uploaded image, not just text), accent, optional
   custom CSS accent only — layout stays GhostGuard's, so support stays sane.
2. **Client workspaces under an agency** — one agency account, many client
   workspaces (the Cloud skeleton is already workspace-scoped). Each client
   sees *only their own* trail and inbox; the agency sees all of its clients.
   Isolation is proven the same way the skeleton already proves it: another
   workspace's records return 404, never a leak.
3. **Real approvals, not page state** — Approve/Deny in the hosted portal
   appends a decision entry to the store (history never rewritten, exactly
   as the Cloud skeleton does today) and delivers it to the waiting agent
   (`waitForDecision` / future webhook). The prototype's local-only buttons
   are explicitly a mock of this.
4. **Approver identity** — named, authenticated approvers per workspace.
   A decision must be attributable to a verified person, not a string typed
   into a form (a known skeleton limit, unchanged by branding).
5. **Redaction before rendering** — the portal must never be a secrets leak:
   records are rendered through the same discipline the records were written
   with (a secret appears as type + length, never its value), payload fields
   configurable per workspace as hidden/masked, and client-facing views can
   suppress internal fields (actor internals, snapshot ids) by policy.
   Redaction happens **server-side**, before data reaches the browser —
   hiding in the UI is not redaction.
6. **Read-only client role** — the agency's client typically gets a
   view-only login: trail + reports, no decisions, no policy edits. Approver
   and admin roles are separate grants.
7. **Exports** — the client can download their own trail (JSONL/CSV) and the
   audit report generated from it; the data is theirs, the lock-in is
   convenience, not hostage-taking.
8. **Attribution that survives branding** — the "Powered by GhostGuard" line
   is part of the Agency tier terms: small, in the footer, always present.
   An agency that wants it gone entirely is asking for a different
   (enterprise) deal that does not exist yet and is Ryan's call to invent.

## 4. Boundaries (what the hosted portal is not)

- **Not a policy editor in v1.** Clients view trails and (if granted) decide
  approvals. Policy authoring stays with the agency/studio — an approval is
  an audit event, not a policy change (same stance as the Cloud skeleton).
- **Not a compliance product.** Branded or not, the portal presents records.
  No "compliant" badges, scores-as-certifications, or regulator language —
  ever. The Guard Score, if displayed, is a structural summary of a trail,
  labelled as such.
- **Not multi-tenant by spreadsheet.** No shared views across clients, no
  agency-wide search that can surface one client's payload to another.
  Isolation first, convenience second.
- **Not a new store.** The portal reads the Cloud audit store; it does not
  fork the record format. The JSONL record shape the prototype loads is the
  contract.

## 5. Ryan-gated before any of this ships

- Agency tier pricing (DRAFT $99/mo anchor — unapproved) and its limits
  (clients per agency, retention, records/month).
- The production domain/subdomain scheme, and any hosting spend.
- Branding terms (attribution requirement, what agencies may/may not
  customise) as actual license/terms text.
- Showing this prototype — even as a screenshot — to any agency or client.
