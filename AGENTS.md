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
- Support only the versions ADR-0017 names: Decaid v0.9.3 and later, DYE2 v0.1.42 and later, Streamline v0.2.31 and later, and the current release of the plugin and server with the previous one beside it (ADR-0025), with nothing for de1app. Write no code for older Decaid, DYE2 or Streamline versions, or for releases before the previous one. The server enforces the Decaid and protocol minimums at `hello`.
- Follow the model of the apps Decent Sync works with rather than building a parallel one. Where Decaid, Streamline or DYE2 already has a concept or protocol, such as the recipe DYE2 and Streamline name in the Workflow (`context.extras.dye.recipeId`) and DYE2's `record` call that saves a change into it (ADR-0022), take it as the source of truth and make the calls those apps make. Where it falls short, ask upstream. A workaround in the meantime needs an ADR that records it as interim and names the upstream ask it waits on, as ADR-0005 and ADR-0022 do; otherwise accept the gap until it is fixed.
- Every change runs beside the latest tagged release during an upgrade (ADR-0025), and only tagged releases count. A change that can't needs the owner's approval and the `breaking-release` label, which only the owner applies: never apply it yourself.
  - Changing the schema or a migration: `docs/AI_STORAGE_NOTES.md`, Writing a migration.
  - Changing a wire message, a `NOTIFY` payload, a REST route, or what the plugin stores on the tablet: `docs/AI_PROTOCOL_NOTES.md`, Wire revision and Between releases.
- Write for several server instances on one database, with two releases side by side during a deploy (ADR-0025): state shared across connections or requests lives in PostgreSQL, concurrent changes are decided with row or advisory locks, and changes fan out with LISTEN/NOTIFY. In-memory state belongs to one connection or one request, or is a limit that protects only one instance's own resources, such as its concurrent password checks or its connections awaiting `hello` (ADR-0016). `docs/AI_SERVER_NOTES.md` has the rules and how to test with two instances.
- Store Decaid payloads as sent. Keep envelope validation separate from opaque Decaid data, accept unknown fields, and tolerate missing optional fields when extracting or displaying data. Machines may run different supported Decaid versions: write no fallbacks for older record layouts, and ignore a record missing what those versions always send.
- Keep capture handlers idempotent and acknowledge a logical message only after storage completes. A delivery set aside because storing it fails in a way that would repeat counts as stored (`docs/AI_PROTOCOL_NOTES.md`, Deliveries set aside). Follow the spec for chunking, reconnects and backfill.
- Resolve Machine identity using the token, reported hardware and aliases as specified in ADR-0004, ADR-0015 and milestone 1. Credit Shots by their recorded hardware, with Pending Machines and the inferred fallback of ADR-0015; Steam Records carry no hardware identity and go to the reporting Machine.
- Treat tokens as secrets: never log them or persist plaintext server-side. Store Machine token hashes; keep the plugin token in a secure setting.
- Verify behavior through the spec's testing seams. For plugin integration, run the built plugin in a simulated or real Decaid host. Report the commands, results and any verification limits. See `docs/AI_BUILD_NOTES.md` before using the test tablet.
- Write comments and documentation in plain text, without emojis.

## Working safely

- Preserve existing work and keep changes focused. Leave commits, pushes, tags, publication and PR creation to explicit user requests. Asked to carry a change through to a pull request, push its branch to verify it rather than running the whole suite locally: CI is the full test run (`docs/AI_BUILD_NOTES.md`, Running a subset).
- Treat a configured database as user data. Use a scratch database for experiments; deleting or rewriting one needs explicit approval.
- Install or update code on the test tablet only when explicitly asked. Read-only `GET` requests to gather fixtures are allowed after confirming its identity; any write needs an explicit request. Use the simulated tablet for routine work.

## Documentation

Keeping the documentation true is part of every change, as its tests are: it is updated in the same change, never left for later, and a change is not done while a page still says what Decent Sync no longer does. There are three layers, each with one reader:

- The documentation site, `site/src/content/docs/`, is for the people who run and use Decent Sync.
- `README.md` is the pitch, for someone deciding whether to try it.
- The topic docs, ADRs and `docs/AI_*` notes are for whoever changes the code (Keeping notes, below).

For the site and the README:

- A change that alters what people read or do updates the Guide or Reference page for its area in the same change: `guide/` for what a person does in the management interface, `get-started/` and `self-hosting/` for setting up and running the server, `reference/` for the tablet plugin, `technical/` for what a developer or a Skin's author builds on, and `project/roadmap.md` when something planned is built or the plan changes. Task references, below, names each page.
- Document what the page's reader would notice or need: a control added, renamed or removed, a limit, margin or default that changed, who may do something, a step that changed, a new setting, requirement or supported version. What an upgrade asks of the person running the server goes in `UPGRADING.md`, and a new term in `GLOSSARY.md`.
- Leave out what that reader would not notice: a refactor, a rename inside the code, a test, a fix that makes Decent Sync do what its page already says, and how something is implemented, which belongs in the topic docs. Not every change needs a line. Where nothing a reader of the site would notice has changed, change no page.
- Write for the person doing the task, in the glossary's terms, and name a control as the management interface writes it. Change or delete the sentence a change makes untrue rather than adding one beside it, so a page says a thing once.
- A page found wrong while working in its area is corrected in the same change where that is small, and otherwise reported in an issue. Documentation that nobody corrects goes stale without any one change being at fault.
- Touch `README.md` only when the pitch changes: what Decent Sync is, who it is for, one of its benefits, how it works in outline, or the quick start. It describes no feature in detail, and links to the site's page instead. `npm run check:docs` fails it over 1,500 words.
- A change that redraws the page of an image in `docs/images/`, which are the README's, regenerates that image in the same change with `npm run readme-images` (`scripts/images/README.md`). It is done when every README image has been compared with the page as it now renders. The site's other images are built when it is deployed.
- Before reporting a change done, read the page for its area against what the change now does. The pull request's description names the pages it updated, or says that it changes nothing their readers would notice (`docs/agents/pull-requests.md`).

## Keeping notes

- Update `docs/AI_REPO_MAP.md` only when a change adds, moves or removes a file or folder, or changes what one is for: one short line per entry, saying what lives there. Its Task routing changes when an ADR or topic doc is added. An added ADR also gets its line on the site's Architecture page, and an added topic doc, note or agent convention its row on the Internals page (`site/src/content/docs/technical/`); the site's tests fail until they do.
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
- What people read to run and use Decent Sync, kept current with what a change does for them (Documentation, above): the documentation site's pages in `site/src/content/docs/`: `get-started/` (the quick start, Locations and Machines, installing the plugin, inviting people), `guide/` (a page for each area of the management interface, `assistants.md` for what an assistant may do and `accounts-and-roles.md` for what each role may), `self-hosting/` (deploying, upgrading, and every setting in `configuration.md`), `reference/tablet-plugin.md` (the tablet plugin), `technical/` (`architecture.md` for what is shared with which Machines, the three connections, the protocol in outline and each ADR in a line, `internals.md` for the index of the topic docs and notes, `skin-authors.md` for what the plugin answers a Skin, `development.md` for the way into `docs/DEVELOPMENT.md`) and `project/` (`roadmap.md` for what is planned, `releases.md` for what each release added); and `docs/DEVELOPMENT.md` (commands, tests, releasing, and The documentation site). The site's Assistant tools reference is written from the MCP tools' own definitions as the site is built, so a tool's description is its entry there: list no tools by hand. `docs/SELF-HOSTING.md` and `docs/PLUGIN.md` are stubs that link to those pages: write nothing else in them.
