# Agent Instructions

Decent Sync is one repository containing the plugin, server and management interface. Milestone 1 is built, and milestone 2 is being built in it.

## Before implementation

- Read `GLOSSARY.md` and ADRs 0001–0020 in `docs/adr/`, then the spec of the ticket's milestone ([milestone 2](https://github.com/loganfuller/decent-sync/issues/77), or [milestone 1](https://github.com/loganfuller/decent-sync/issues/1) for its hardening) and the assigned ticket. ADR-0010 is superseded by ADR-0012; ADR-0005 is interim and its writes belong to a later milestone.
- For orientation or a task spanning files, read `docs/AI_REPO_MAP.md`. Open known files directly.
- Use the glossary's terms. Surface conflicts between a ticket, spec and ADR rather than silently choosing one. Inspect code to establish current behavior; use the spec and accepted ADRs for target behavior.

## Implementation rules

- Use the TypeScript, NestJS, Prisma, PostgreSQL, React/Vite and shadcn/ui stack in ADR-0011 and the plain npm workspace layout in ADR-0012.
- Define wire messages and runtime validators once in `protocol/`, shared by `plugin/` and `server/`. Update both ends together in this repo.
- Support only the versions ADR-0017 names. Before v1 that is Decaid v0.8.7 and later and the current plugin and server only, with nothing for de1app. Write no code for older Decaid versions, older plugin or server versions, or earlier commits. The protocol version stays 1 until v1: a wire change needs only the current plugin and server, and raises no version. From v1, support the newest Decaid release tag and the two before it, and the current and previous plugin release. The server enforces both at `hello`.
- Don't assume one server instance. Deployments run one for now, but state shared across connections or requests lives in PostgreSQL. Concurrent changes are decided with row or advisory locks, not in-process ones, and changes fan out with LISTEN/NOTIFY. In-memory state is fine only when it belongs to one connection or one request. Test such state with two instances on one database (`startTestServer({ sharing })`); see `docs/AI_REPO_MAP.md`. A limit that protects only one instance's own resources, such as its concurrent password checks or its connections awaiting `hello`, is counted in its memory too (ADR-0016).
- Store Decaid payloads as sent. Keep envelope validation separate from opaque Decaid data, accept unknown fields, and tolerate missing optional fields when extracting or displaying data. Machines may run different supported Decaid versions: write no fallbacks for older record layouts, and ignore a record missing what those versions always send.
- Keep capture handlers idempotent and acknowledge a logical message only after storage completes. Follow the spec for chunking, reconnects and backfill.
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
| `dye2` | [decentespresso/dye2](https://github.com/decentespresso/dye2), existing checkout | Verify recipe, equipment and basket storage shapes; milestone 1 reads them only |
| `decent-sync-plugin` | [loganfuller/decent-sync-plugin](https://github.com/loganfuller/decent-sync-plugin), `$DECENT_SYNC_PLUGIN_DIR` | Archived prototype, read-only prior art only |

## Task references

- Plugin host, transport limits, events and upstream evidence: `docs/AI_RUNTIME_NOTES.md`.
- Protocol ownership and compatibility: `docs/AI_PROTOCOL_NOTES.md`.
- Capture storage: `docs/AI_STORAGE_NOTES.md`.
- Verification and real-tablet rules: `docs/AI_BUILD_NOTES.md`.
- GitHub Issues, milestones and dependency conventions: `docs/agents/issue-tracker.md`.
- Triage label meanings: `docs/agents/triage-labels.md`.
- Glossary use and ADR conflicts: `docs/agents/domain.md`.
