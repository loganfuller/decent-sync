# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`GLOSSARY.md`** at the repo root.
- **`docs/adr/`**: read ADRs that touch the area you're about to work in.

`GLOSSARY.md` defines vocabulary; ADRs record decisions. ADR-0010 is superseded by ADR-0012, ADR-0005 is interim, and ADR-0015 extends ADR-0004. Read the milestone spec and ticket for implementation scope: an accepted later-milestone decision does not make its implementation part of the current milestone.

The glossary is at the repo root; all ADRs are under `docs/adr/`. List that directory for the current set rather than relying on an example tree.

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `GLOSSARY.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal: either you're inventing language the project doesn't use (reconsider) or there's a real gap (flag the gap and use the `domain-modeling` skill when resolving it).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (PostgreSQL for storage), but worth reopening because…_
