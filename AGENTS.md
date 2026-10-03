# Agent Instructions

Decent Sync's target is one repository containing the plugin, server and management interface. The code currently present is the receive-only prototype; milestone 1 replaces it. The prototype is evidence of Decaid integration, not a specification or implementation foundation.

## Before implementation

- Read `GLOSSARY.md` and ADRs 0001–0014 in `docs/adr/`, then [milestone 1's spec](https://github.com/loganfuller/decent-sync/issues/1) and the assigned ticket. ADR-0010 is superseded by ADR-0012; ADR-0005 is interim and its writes belong to a later milestone.
- For orientation or a task spanning files, read `docs/AI_REPO_MAP.md`. Open known files directly.
- Use the glossary's terms. Surface conflicts between a ticket, spec and ADR rather than silently choosing one. Inspect code to establish current behavior; use the spec and accepted ADRs for target behavior.

## Implementation rules

- Use the TypeScript, NestJS, Prisma, PostgreSQL, React/Vite and shadcn/ui stack in ADR-0011 and the plain npm workspace layout in ADR-0012. The prototype's `.mjs` style and dependency list do not constrain new code.
- Define wire messages and runtime validators once in `protocol/`, shared by `plugin/` and `server/`. Update both ends together in this repo. `docs/PROTOCOL.md` describes only the unreleased prototype; milestone 1 starts a new protocol version 1 without prototype compatibility.
- Store Decaid payloads as sent. Keep envelope validation separate from opaque Decaid data, accept unknown fields, and tolerate missing fields when extracting or displaying data. Machines run different Decaid and plugin versions.
- Keep capture handlers idempotent and acknowledge a logical message only after storage completes. Follow the spec for chunking, reconnects and backfill.
- Resolve Machine identity using the token, reported hardware and aliases as specified in ADR-0004 and milestone 1. Attribute Shots and Steam Records using their capture-time identity, with the specified inferred fallback.
- Treat tokens as secrets: never log them or persist plaintext server-side. Store Machine token hashes; keep the plugin token in a secure setting.
- Verify behavior through the spec's testing seams. For plugin integration, run the built plugin in a simulated or real Decaid host. Report the commands, results and any verification limits. See `docs/AI_BUILD_NOTES.md` before using the test tablet.
- No emojis in comments or documentation.

## Working safely

- Preserve existing work and keep changes focused. Leave commits, pushes, tags, publication and PR creation to explicit user requests.
- Treat any `data/` or configured prototype `DATA_DIR` as user data. Use a scratch directory for experiments; deletion, rewriting or migration needs explicit approval.
- Install or update code on the test tablet only when explicitly asked. Use the simulated tablet for routine work.
- Keep notes current when a reusable constraint changes; remove stale instructions.

## External sources

References written `<name>:<path>` are relative to that checkout. Use an existing checkout or the corresponding environment variable; paths are not assumed. If a checkout is absent, read the linked GitHub repository instead. Read the version under investigation (`git show <tag>:<path>`), and cite files and symbols rather than line numbers.

| Name | Source | Use |
|---|---|---|
| `decaid` | [decentespresso/decaid](https://github.com/decentespresso/decaid), `$DECAID_DIR` | Verify host behavior in source at the supported version; milestone 1's minimum is v0.8.6 |
| `dye2` | [decentespresso/dye2](https://github.com/decentespresso/dye2), existing checkout | Verify recipe, equipment and basket storage shapes; milestone 1 reads them only |
| `decent-sync-plugin` | [loganfuller/decent-sync-plugin](https://github.com/loganfuller/decent-sync-plugin), `$DECENT_SYNC_PLUGIN_DIR` | Archived prototype, read-only prior art. Its `scripts/dev-harness.mjs` is input to ticket #5, not the finished simulated tablet |

## Task references

- Plugin host, transport limits, events and upstream evidence: `docs/AI_RUNTIME_NOTES.md`.
- Protocol ownership and compatibility: `docs/AI_PROTOCOL_NOTES.md`.
- Capture storage and prototype inspection: `docs/AI_STORAGE_NOTES.md`.
- Verification and real-tablet rules: `docs/AI_BUILD_NOTES.md`.
- GitHub Issues and dependency conventions: `docs/agents/issue-tracker.md`.
- Triage label meanings: `docs/agents/triage-labels.md`.
- Glossary use and ADR conflicts: `docs/agents/domain.md`.
