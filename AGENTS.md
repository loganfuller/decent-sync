# Agent Instructions

Decent Sync is one repository containing the plugin, server and management interface.

## Before implementation

- Read `GLOSSARY.md`, the assigned ticket, the spec linked from the ticket's milestone, and the ADRs in `docs/adr/` that the Task routing of `docs/AI_REPO_MAP.md` names for the area you are changing.
- Scout first: for a task spanning files, send one Explore subagent for a file-and-symbol map where subagents are available to you, then batch independent lookups into a single turn. `docs/AI_REPO_MAP.md` maps the files; open known files directly.
- Use the glossary's terms. Surface conflicts between a ticket, spec and ADR rather than silently choosing one. Inspect code to establish current behavior; use the spec and accepted ADRs for target behavior.

## Implementation rules

- Use the TypeScript, NestJS, Prisma, PostgreSQL, React/Vite and shadcn/ui stack in ADR-0011 and the plain npm workspace layout in ADR-0012.
- Define wire messages and runtime validators once in `protocol/`, shared by `plugin/` and `server/`. Update both ends together in this repo.
- Make what a change adds or changes for people to read or do, in the management interface or the REST API, available through the MCP endpoint in the same change (ADR-0026): a new tool, or a change to one, which follows ADR-0025 as a REST route does. What grants access or destroys history stays out of it.
- Support only the versions ADR-0017 names: Decaid v0.9.2 and later, DYE2 v0.1.40 and later, Streamline v0.2.31 and later, and the current release of the plugin and server with the previous one beside it (ADR-0025), with nothing for de1app. Write no code for older Decaid, DYE2 or Streamline versions, or for releases before the previous one. The server enforces the Decaid and protocol minimums at `hello`.
- Follow the model of the apps Decent Sync works with rather than building a parallel one. Where Decaid, Streamline or DYE2 already has a concept or protocol, such as the recipe DYE2 and Streamline name in the Workflow (`context.extras.dye.recipeId`) and DYE2's `record` call that saves a change into it (ADR-0022), take it as the source of truth and make the calls those apps make. Where it falls short, ask upstream. A workaround in the meantime needs an ADR that records it as interim and names the upstream ask it waits on, as ADR-0005 and ADR-0022 do; otherwise accept the gap until it is fixed.
- Every change runs beside the latest tagged release during an upgrade (ADR-0025), and only tagged releases count. A change that can't needs the owner's approval and the `breaking-release` label, which only the owner applies: never apply it yourself.
  - Changing the schema or a migration: `docs/AI_STORAGE_NOTES.md`, Writing a migration.
  - Changing a wire message, a `NOTIFY` payload, a REST route, or what the plugin stores on the tablet: `docs/AI_PROTOCOL_NOTES.md`, Wire revision and Between releases.
- Write for several server instances on one database, with two releases side by side during a deploy (ADR-0025): state shared across connections or requests lives in PostgreSQL, concurrent changes are decided with row or advisory locks, and changes fan out with LISTEN/NOTIFY. In-memory state belongs to one connection or one request, or is a limit that protects only one instance's own resources, such as its concurrent password checks or its connections awaiting `hello` (ADR-0016). `docs/AI_SERVER_NOTES.md` has the rules and how to test with two instances.
- Store Decaid payloads as sent. Keep envelope validation separate from opaque Decaid data, accept unknown fields, and tolerate missing optional fields when extracting or displaying data. Machines may run different supported Decaid versions: write no fallbacks for older record layouts, and ignore a record missing what those versions always send.
- Keep capture handlers idempotent and acknowledge a logical message only after storage completes. A delivery set aside because storing it fails in a way that would repeat counts as stored (`docs/AI_PROTOCOL_NOTES.md`, Deliveries set aside). Follow the spec for chunking, reconnects and backfill.
- Resolve Machine identity using the token, reported hardware and aliases as specified in ADR-0004, ADR-0015 and milestone 1. Credit Shots by their recorded hardware, with Pending Machines and the inferred fallback of ADR-0015; Steam Records carry no hardware identity and go to the reporting Machine.
- Treat tokens as secrets: never log them or persist plaintext server-side. Store Machine token hashes; keep the plugin token in a secure setting.
- A change that alters what `README.md` describes or shows updates it in the same change: its text, and each image in `docs/images/` whose page the change redraws, regenerated with `npm run readme-images` (`scripts/readme-images/README.md`). It is done when every README image has been compared with the page as it now renders.
- Verify behavior through the spec's testing seams. For plugin integration, run the built plugin in a simulated or real Decaid host. Report the commands, results and any verification limits. See `docs/AI_BUILD_NOTES.md` before using the test tablet.
- Write comments and documentation in plain text, without emojis.

## Working safely

- Preserve existing work and keep changes focused. Leave commits, pushes, tags, publication and PR creation to explicit user requests. Asked to carry a change through to a pull request, push its branch to verify it rather than running the whole suite locally: CI is the full test run (`docs/AI_BUILD_NOTES.md`, Running a subset).
- Treat a configured database as user data. Use a scratch database for experiments; deleting or rewriting one needs explicit approval.
- Install or update code on the test tablet only when explicitly asked. Read-only `GET` requests to gather fixtures are allowed after confirming its identity; any write needs an explicit request. Use the simulated tablet for routine work.

## Keeping notes

- Update `docs/AI_REPO_MAP.md` only when a change adds, moves or removes a file or folder, or changes what one is for: one short line per entry, saying what lives there. Its Task routing changes when an ADR or topic doc is added.
- In the `docs/AI_*_NOTES.md` notes, write one fact per line under a heading naming its topic, and update or delete the line a change makes stale. Behaviour belongs in the topic docs, history in the ticket and git.

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
- Server access, clocks, locks and several instances: `docs/AI_SERVER_NOTES.md`.
- Management interface conventions: `docs/AI_WEB_NOTES.md`.
- Verification and real-tablet rules: `docs/AI_BUILD_NOTES.md`.
- GitHub Issues, milestones and dependency conventions: `docs/agents/issue-tracker.md`.
- Pull request descriptions, screenshots of management interface changes embedded in them, and a CI failure in a test the change doesn't touch: `docs/agents/pull-requests.md`.
- Triage label meanings: `docs/agents/triage-labels.md`.
- Glossary use and ADR conflicts: `docs/agents/domain.md`.
- What people read to run and use Decent Sync, kept current with what a change does for them: `docs/SELF-HOSTING.md` (deploying, configuration, upgrading), `docs/PLUGIN.md` (the tablet plugin) and `docs/DEVELOPMENT.md` (commands, tests, releasing).
