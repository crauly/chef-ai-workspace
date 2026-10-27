# ADR-006: Hackathon demo without end-user login

Status: Accepted (2026-10-27). Applies to the 2026 Meta hackathon MVP.

## Decision
The hackathon app is a **single-workspace, no-signup/no-login demo**. Do not
build an account registration or login UX, user-management flows, test-account
onboarding or real-JWT E2E as a prerequisite for this submission. The essential
flow is: voice/text input -> Meta model intent/proposal -> server validation ->
deterministic recipe costing -> save -> library view/reopen.

Supabase Auth, RLS and the existing individual-owner schema remain in the
codebase as foundations for a **later production release**. Production
requires authenticated user accounts and access control before onboarding
multiple independent chefs. They are not hackathon deliverables.

## Security boundary of the no-login demo
"No login" does **not** mean public unauthenticated write access to a
service-role API. Use an isolated demo workspace and a server-side trusted
owner ID; restrict mutation and creation to an operator-controlled environment
or a separate guarded demo access mechanism. Keep service-role credentials
only server-side. A publicly readable showcase may expose a sanitized demo
recipe library, not private restaurant recipes. Never target the existing
`iwaka_project` Supabase instance.

## Scope / priorities
1. Basic recipe create, list, open, edit, version and deterministic costing.
2. Meta AI model's real proposal-processing path and text/voice first UX.
3. Mobile-friendly Next.js UI; photo optional, must be used if submitted.
4. Production signup, login, password resets, team management: **deferred**.
5. Preserve Nov 1 freeze and Nov 2–3 independent QA window.

Reconsidering any of these choices is a product-scope decision requiring
explicit user approval, not an implicit developer default.
