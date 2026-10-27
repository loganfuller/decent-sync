# Agent Instructions

Decent Sync is one repository containing the plugin, server and management interface. Milestones 1 to 3 are built in it, and released in v1.0.0.

## Before implementation

- Read `GLOSSARY.md` and ADRs 0001–0025 in `docs/adr/`, then the spec of the ticket's milestone ([milestone 5](https://github.com/loganfuller/decent-sync/issues/277), [milestone 4](https://github.com/loganfuller/decent-sync/issues/220), with the Live View's in [#258](https://github.com/loganfuller/decent-sync/issues/258), [milestone 3](https://github.com/loganfuller/decent-sync/issues/134), [milestone 2](https://github.com/loganfuller/decent-sync/issues/77) or [milestone 1](https://github.com/loganfuller/decent-sync/issues/1)) and the assigned ticket. ADR-0010 is superseded by ADR-0012, and ADR-0014 by ticket #190 (a Location shares no steam, hot water or flush settings; a Recipe holds them, ADR-0022); ADR-0005 and ADR-0022 are interim.
- For orientation or a task spanning files, read `docs/AI_REPO_MAP.md`. Open known files directly.
- Use the glossary's terms. Surface conflicts between a ticket, spec and ADR rather than silently choosing one. Inspect code to establish current behavior; use the spec and accepted ADRs for target behavior.

## Implementation rules

- Use the TypeScript, NestJS, Prisma, PostgreSQL, React/Vite and shadcn/ui stack in ADR-0011 and the plain npm workspace layout in ADR-0012.
- Define wire messages and runtime validators once in `protocol/`, shared by `plugin/` and `server/`. Update both ends together in this repo.
- Support only the versions ADR-0017 names: Decaid v0.9.0 and later, DYE2 v0.1.26 and later, streamline-js `main` from `cec5664` (an interim minimum, until a tagged release contains `ea04f83`), and the current release of the plugin and server with the previous one beside it (ADR-0025), with nothing for de1app. Write no code for older Decaid versions, for releases before the previous one, or for earlier commits. The server enforces the Decaid and protocol minimums at `hello`.
- Follow the model of the apps Decent Sync works with rather than building a parallel one. Where Decaid, Streamline or DYE2 already has a concept or protocol, such as the recipe DYE2 and Streamline name in the Workflow (`context.extras.dye.recipeId`) and DYE2's `record` call that saves a change into it (ADR-0022), take it as the source of truth and make the calls those apps make. Where it falls short, ask upstream. A workaround in the meantime needs an ADR that records it as interim and names the upstream ask it waits on, as ADR-0005, ADR-0021 and ADR-0022 do; otherwise accept the gap until it is fixed.
- Keep every change working beside the latest release (ADR-0025), which runs beside it during an upgrade:
  - **Only tagged releases count.** Anything added since the latest release (a column, message, field or route) may be changed or removed freely before the next release, since no release runs it: changing it needs no second form and no check of its own, and it stays behind the revision that brought it. Change a merged migration with a later one rather than editing it: staging and development databases have applied it.
  - **Database.**
    - A migration leaves the schema the latest release's code needs, and adds no constraint, `NOT NULL` column without a default, or narrower type its writes would break: a delivery it then failed to store would be set aside and lost.
    - Add a new form beside the old and write both. Read the old form, or both, while the latest release may still be writing it. Remove the old in a later release, filing an issue for that removal when adding the new form.
    - Migrations change the schema only, quickly: each wraps its statements in `BEGIN; SET LOCAL lock_timeout = '5s'; ... COMMIT;`. An index on a large table is built concurrently in a migration of its own, written as `SET lock_timeout = '5s'; DROP INDEX IF EXISTS "x"; CREATE INDEX CONCURRENTLY "x" ...;`. The plain drop removes an invalid index a failed attempt left. Prisma can't split out `DROP INDEX CONCURRENTLY`, and would run the file in one transaction, which those statements refuse.
    - A large change to data runs in the server, in batches in the background, and the migration that removes the old form checks that it is done.
  - **Wire.**
    - Any change the receiver can't ignore for good, a new field included, raises the wire revision: the first such change after a release raises it by one. What it adds goes only to a peer at that revision. A field the receiver may ignore for good raises nothing and needs no check, until a release relies on it, and then it relies on it only from a peer at the revision that reliance raises. Delete a check once the wire has moved past it.
    - The server closes the connection on a message type it doesn't know. The plugin logs and ignores one. The mixed-versions suite fails on either.
    - Until the wire revision exists (#279), make no change to the wire but fields the latest release may ignore for good.
  - **Between instances, on the tablet and to the browser.**
    - Read what the latest release writes, and write nothing it misreads: `NOTIFY` payloads, rows one release writes for the other to read or relay, the plugin's storage on the tablet and the records it writes there.
    - Keep the REST API serving the latest release's pages: add routes and fields, and change or remove one only in a later release.
  - **Releases.** No upgrade note asks to stop the server, recreate the database or redo anything. A change that can't keep this needs the owner's approval and the `breaking-release` label, which only the owner applies: never apply it yourself.
- Don't assume one server instance. Deployments run one for now, but state shared across connections or requests lives in PostgreSQL. Concurrent changes are decided with row or advisory locks, not in-process ones, and changes fan out with LISTEN/NOTIFY. In-memory state is fine only when it belongs to one connection or one request. Test such state with two instances on one database (`startTestServer({ sharing })`); see `docs/AI_REPO_MAP.md`. A limit that protects only one instance's own resources, such as its concurrent password checks or its connections awaiting `hello`, is counted in its memory too (ADR-0016).
- Store Decaid payloads as sent. Keep envelope validation separate from opaque Decaid data, accept unknown fields, and tolerate missing optional fields when extracting or displaying data. Machines may run different supported Decaid versions: write no fallbacks for older record layouts, and ignore a record missing what those versions always send.
- Keep capture handlers idempotent and acknowledge a logical message only after storage completes. A delivery set aside because storing it fails in a way that would repeat counts as stored (`docs/AI_PROTOCOL_NOTES.md`, Deliveries set aside). Follow the spec for chunking, reconnects and backfill.
- Resolve Machine identity using the token, reported hardware and aliases as specified in ADR-0004, ADR-0015 and milestone 1. Credit Shots by their recorded hardware, with Pending Machines and the inferred fallback of ADR-0015; Steam Records carry no hardware identity and go to the reporting Machine.
- Treat tokens as secrets: never log them or persist plaintext server-side. Store Machine token hashes; keep the plugin token in a secure setting.
- Verify behavior through the spec's testing seams. For plugin integration, run the built plugin in a simulated or real Decaid host. Report the commands, results and any verification limits. See `docs/AI_BUILD_NOTES.md` before using the test tablet.
- No emojis in comments or documentation.

## Working safely

- Preserve existing work and keep changes focused. Leave commits, pushes, tags, publication and PR creation to explicit user requests.
- Treat a configured database as user data. Use a scratch database for experiments; deleting or rewriting one needs explicit approval.
- Install or update code on the test tablet only when explicitly asked. Read-only `GET` requests to gather fixtures are allowed after confirming its identity; any write needs an explicit request. Use the simulated tablet for routine work.
- Keep notes current when a reusable constraint changes; remove stale instructions.

## External sources

References written `<name>:<path>` are relative to that checkout. Use an existing checkout or the corresponding environment variable; paths are not assumed. If a checkout is absent, read the linked GitHub repository instead. Read the version under investigation (`git show <tag>:<path>`), and cite files and symbols rather than line numbers.

| Name | Source | Use |
|---|---|---|
| `decaid` | [decentespresso/decaid](https://github.com/decentespresso/decaid), `$DECAID_DIR` | Verify host behavior in source at the oldest supported version (ADR-0017) and the version under investigation |
| `dye2` | [decentespresso/dye2](https://github.com/decentespresso/dye2), existing checkout | Verify recipe, equipment and basket storage shapes, record ids and `stripSlot`, how DYE2 applies a recipe and names it in the Workflow, when it clears it, and how it saves dial-in changes into it (`record`, `save-recipe`); milestone 3 writes them (ADR-0005, ADR-0022) |
| `streamline-js` | [decentespresso/streamline-js](https://github.com/decentespresso/streamline-js), existing checkout | Verify the settings Streamline remembers, and that it adopts a Workflow change made elsewhere (ADR-0021), and how its DYE strip places DYE2 recipes by `stripSlot`, applies them, names them in the Workflow and has DYE2 save into them (ADR-0005, ADR-0022), and its settings page's routes, ranges and restore of machine settings (ADR-0023) |
| `decent-sync-plugin` | [loganfuller/decent-sync-plugin](https://github.com/loganfuller/decent-sync-plugin), `$DECENT_SYNC_PLUGIN_DIR` | Archived prototype, read-only prior art only |

## Task references

- Plugin host, transport limits, events and upstream evidence: `docs/AI_RUNTIME_NOTES.md`.
- Protocol ownership and compatibility: `docs/AI_PROTOCOL_NOTES.md`.
- Capture storage, and writing a migration: `docs/AI_STORAGE_NOTES.md`.
- Verification and real-tablet rules: `docs/AI_BUILD_NOTES.md`.
- GitHub Issues, milestones and dependency conventions: `docs/agents/issue-tracker.md`.
- Pull request descriptions, and screenshots of management interface changes embedded in them: `docs/agents/pull-requests.md`.
- Triage label meanings: `docs/agents/triage-labels.md`.
- Glossary use and ADR conflicts: `docs/agents/domain.md`.
