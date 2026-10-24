# Agent Instructions

Decent Sync is one repository containing the plugin, server and management interface. Milestones 1 to 3 are built in it, and released in v1.0.0.

## Before implementation

- Read `GLOSSARY.md` and ADRs 0001–0022 in `docs/adr/`, then the spec of the ticket's milestone ([milestone 3](https://github.com/loganfuller/decent-sync/issues/134), [milestone 2](https://github.com/loganfuller/decent-sync/issues/77) or [milestone 1](https://github.com/loganfuller/decent-sync/issues/1)) and the assigned ticket. ADR-0010 is superseded by ADR-0012, and ADR-0014 by ticket #190 (a Location shares no steam, hot water or flush settings; a Recipe holds them, ADR-0022); ADR-0005 and ADR-0022 are interim.
- For orientation or a task spanning files, read `docs/AI_REPO_MAP.md`. Open known files directly.
- Use the glossary's terms. Surface conflicts between a ticket, spec and ADR rather than silently choosing one. Inspect code to establish current behavior; use the spec and accepted ADRs for target behavior.

## Implementation rules

- Use the TypeScript, NestJS, Prisma, PostgreSQL, React/Vite and shadcn/ui stack in ADR-0011 and the plain npm workspace layout in ADR-0012.
- Define wire messages and runtime validators once in `protocol/`, shared by `plugin/` and `server/`. Update both ends together in this repo.
- Support only the versions ADR-0017 names: Decaid v0.9.0 and later, DYE2 v0.1.26 and later, streamline-js `main` from `cec5664` (an interim minimum, until a tagged release contains `ea04f83`), and the current plugin and server only, with nothing for de1app. Write no code for older Decaid versions, older plugin or server versions, or earlier commits. The protocol version stays 1: a wire change needs only the current plugin and server, and raises no version. The server enforces the Decaid and protocol minimums at `hello`.
- Follow the model of the apps Decent Sync works with rather than building a parallel one. Where Decaid, Streamline or DYE2 already has a concept or protocol, such as the recipe DYE2 and Streamline name in the Workflow (`context.extras.dye.recipeId`) and DYE2's `record` call that saves a change into it (ADR-0022), take it as the source of truth and make the calls those apps make. Where it falls short, ask upstream. A workaround in the meantime needs an ADR that records it as interim and names the upstream ask it waits on, as ADR-0005, ADR-0021 and ADR-0022 do; otherwise accept the gap until it is fixed.
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
| `streamline-js` | [decentespresso/streamline-js](https://github.com/decentespresso/streamline-js), existing checkout | Verify the settings Streamline remembers, and that it adopts a Workflow change made elsewhere (ADR-0021), and how its DYE strip places DYE2 recipes by `stripSlot`, applies them, names them in the Workflow and has DYE2 save into them (ADR-0005, ADR-0022) |
| `decent-sync-plugin` | [loganfuller/decent-sync-plugin](https://github.com/loganfuller/decent-sync-plugin), `$DECENT_SYNC_PLUGIN_DIR` | Archived prototype, read-only prior art only |

## Task references

- Plugin host, transport limits, events and upstream evidence: `docs/AI_RUNTIME_NOTES.md`.
- Protocol ownership and compatibility: `docs/AI_PROTOCOL_NOTES.md`.
- Capture storage: `docs/AI_STORAGE_NOTES.md`.
- Verification and real-tablet rules: `docs/AI_BUILD_NOTES.md`.
- GitHub Issues, milestones and dependency conventions: `docs/agents/issue-tracker.md`.
- Pull request descriptions, and screenshots of management interface changes embedded in them: `docs/agents/pull-requests.md`.
- Triage label meanings: `docs/agents/triage-labels.md`.
- Glossary use and ADR conflicts: `docs/agents/domain.md`.
