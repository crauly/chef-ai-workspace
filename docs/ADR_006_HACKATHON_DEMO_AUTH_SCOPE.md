# ADR-006: Production authentication and account ownership

Status: Accepted (2026-10-27)

## Decision
When Chef AI Workspace is released as a product, implement user registration,
sign-in and secure session management through Supabase Auth. Each chef owns
their recipes, saved versions, shared ingredients and ingredient images.
Authorization must be enforced at the API and database boundaries through
verified identity and row-level security.

## Architecture implications
- Derive the owner identifier from a verified session, never from AI output
  or client-provided ownership fields.
- Restrict recipe, ingredient, version and image access to their owner.
- Keep privileged Supabase credentials on the server only.
- Test cross-user isolation, session expiry, unauthorized access and
  revision-safe persistence before production release.

The existing owner-scoped database design and authentication integration
are foundations for this production requirement.
