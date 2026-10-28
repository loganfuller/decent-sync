---
status: accepted (amended by ADR-0024 and ADR-0025)
---

# Server instances share state only through PostgreSQL

An owner may run several server instances on one database, to survive a lost host or to scale, and Roux runs two, so no design may rely on there being one. During a deploy, instances of two releases share the database (ADR-0025). State that belongs to one WebSocket connection or one request may live in an instance's memory. Anything shared across connections or requests lives in PostgreSQL: which connection holds a Machine, online status, rate-limit counts, invite and reset redemption, and every record. Concurrent decisions are made under PostgreSQL row or advisory locks, never in-process locks, which hold only within one instance. A change other instances must act on, such as a revoked token, is announced with `NOTIFY` inside the transaction that makes it, so it is delivered only if that transaction commits.

We rejected Redis for presence, fan-out or locks. The server would then need a second store, against the promise that self-hosters run only PostgreSQL, and every change would be written to two systems: a crash between committing to PostgreSQL and publishing to Redis loses the announcement, which for a revoked token means a connection that should have been closed stays open. PostgreSQL's notifications are transactional, and at one owner's scale (ADR-0001) its write volume and notification rate are far from their limits.

This amends ADR-0011, which held that one server instance is enough for v1 and left `LISTEN/NOTIFY` for later; ADR-0007, which allowed Redis for caching, queues or presence; and ADR-0003, whose management-interface edits were timed by the server's clock.

## Consequences

- **Times compared across instances come from PostgreSQL's clock.** Instances' clocks drift apart, so last-seen times, the server-side edit times that ADR-0003's last-writer-wins compares, and anything else one instance writes and another judges use `now()` in the database. Tablet clocks remain a separate source of error that ADR-0003 already accepts.
- **The server needs only PostgreSQL.** No Redis, message broker or shared file system. An instance keeps only its own connections in memory.
- **Limits on an instance's own resources stay in its memory.** Caps on its concurrent password checks and on its connections awaiting `hello` protect that instance's CPU, memory and worker pool, and decide nothing shared, so each instance counts its own. Limits that must hold across instances, such as the per-email sign-in limit, live in PostgreSQL.
- **Instances connect directly or through a pooler in session mode.** Each instance holds one connection that listens for notifications, and transaction-mode pooling drops them. The server's connections send no settings at startup, which a pooler may refuse; settings the server needs, such as the idle-in-transaction timeout, are set on the database by a migration.
- **Upgrades.** Instances of two releases share the database while the newer replaces the older, so each release works beside the previous one, its migrations included, and none asks for the database to be recreated (ADR-0025).
- **Tests.** Behaviour that depends on shared state is tested with two instances on one database (`startTestServer({ sharing })`).
