---
title: Internals
description: An index of every implementer spec and architecture decision record, on GitHub.
---

The full behaviour of Decent Sync is written for the people and agents who
change its code, and it lives in the repository, not on this site. This page
links to each document on GitHub and says what it covers. Read
[Architecture](../../technical/architecture/) first for the outline.

## Behaviour specs

One document for each area: its wire messages, what the plugin and the server
do with them, its REST routes, and how the management interface shows it.

| Document | What it covers |
|---|---|
| [SHOTS.md](https://github.com/loganfuller/decent-sync/blob/main/docs/SHOTS.md) | Capturing Shots and their backfill, a Shot's links to the Library, a rating and note edited through the server, Shot Summaries and out of spec, the Shots a tablet's Skin is served, and the Shots pages. |
| [STEAM_RECORDS.md](https://github.com/loganfuller/decent-sync/blob/main/docs/STEAM_RECORDS.md) | Capturing Steam Records, and how each is given its time. |
| [WORKFLOW-AND-STATE.md](https://github.com/loganfuller/decent-sync/blob/main/docs/WORKFLOW-AND-STATE.md) | Workflow changes and Machine States, how a Machine's Loaded Recipe is worked out, and Machine Activity. |
| [COLLECTIONS.md](https://github.com/loganfuller/decent-sync/blob/main/docs/COLLECTIONS.md) | What a tablet reports of itself: its settings, paired devices, plugins and Skins. Settings Edits, Settings History and Software Actions. |
| [LIBRARY.md](https://github.com/loganfuller/decent-sync/blob/main/docs/LIBRARY.md) | The Library: who takes part, what a Location offers, how edits merge, taking in each kind of item from a tablet and writing it to the others, Recipes and Recipe Slots, simulating a Profile, Drafts, publishing and Trial Shots. |

The REST routes of each area are in its document's REST API section. The MCP
tools are on this site, in [Assistant tools](../../reference/assistant-tools/),
and what the plugin answers a Skin is in
[For a Skin's author](../../technical/skin-authors/).

## Decision records

The architecture decision records are in
[`docs/adr/`](https://github.com/loganfuller/decent-sync/tree/main/docs/adr):
one file for each decision, with why it was made and what it rules out.
[Architecture](../../technical/architecture/#the-design-decisions) gives each
in a line and links to it.

## The glossary and the upgrade notes

Both are kept at the repository's root and rendered on this site:

- [GLOSSARY.md](https://github.com/loganfuller/decent-sync/blob/main/GLOSSARY.md),
  as the [Glossary](../../reference/glossary/): every term the documents and
  the code use.
- [UPGRADING.md](https://github.com/loganfuller/decent-sync/blob/main/UPGRADING.md),
  as the [Upgrade notes](../../reference/upgrade-notes/): what each release
  needs of the person running the server.

## Building and releasing

[DEVELOPMENT.md](https://github.com/loganfuller/decent-sync/blob/main/docs/DEVELOPMENT.md)
is the development guide: the repository's layout, setup, commands, tests,
this site, and releasing. [Development](../../technical/development/) says how
to start.

## Notes for agents

Decent Sync is developed with AI agents, and the repository holds the
instructions and notes they work from. A person contributing follows the
same.

| Document | What it covers |
|---|---|
| [AGENTS.md](https://github.com/loganfuller/decent-sync/blob/main/AGENTS.md) | The rules every change follows, and where to read for each kind of task. |
| [AI_REPO_MAP.md](https://github.com/loganfuller/decent-sync/blob/main/docs/AI_REPO_MAP.md) | Where each thing lives, and which documents and decision records to read before changing an area. |
| [AI_BUILD_NOTES.md](https://github.com/loganfuller/decent-sync/blob/main/docs/AI_BUILD_NOTES.md) | Building, running part of the tests, what CI runs, the simulated tablet and the rules for a real one. |
| [AI_PROTOCOL_NOTES.md](https://github.com/loganfuller/decent-sync/blob/main/docs/AI_PROTOCOL_NOTES.md) | The wire: messages, validators, delivery, chunks, the wire revision, and what must keep working between releases. |
| [AI_RUNTIME_NOTES.md](https://github.com/loganfuller/decent-sync/blob/main/docs/AI_RUNTIME_NOTES.md) | What Decaid gives a plugin and where it limits one: its host, transport, events and local API. |
| [AI_SERVER_NOTES.md](https://github.com/loganfuller/decent-sync/blob/main/docs/AI_SERVER_NOTES.md) | Rules every server change follows: access, clocks, locks, and several instances on one database. |
| [AI_STORAGE_NOTES.md](https://github.com/loganfuller/decent-sync/blob/main/docs/AI_STORAGE_NOTES.md) | How captured records are stored, and writing a migration that runs beside the previous release. |
| [AI_WEB_NOTES.md](https://github.com/loganfuller/decent-sync/blob/main/docs/AI_WEB_NOTES.md) | The management interface's conventions. |
| [docs/agents/domain.md](https://github.com/loganfuller/decent-sync/blob/main/docs/agents/domain.md) | Using the glossary's terms, and what to do when a change conflicts with a decision record. |
| [docs/agents/issue-tracker.md](https://github.com/loganfuller/decent-sync/blob/main/docs/agents/issue-tracker.md) | How issues, specs and milestones are kept on GitHub. |
| [docs/agents/pull-requests.md](https://github.com/loganfuller/decent-sync/blob/main/docs/agents/pull-requests.md) | What a pull request's description holds, its screenshots, and what to do about a failing check. |
| [docs/agents/triage-labels.md](https://github.com/loganfuller/decent-sync/blob/main/docs/agents/triage-labels.md) | What each triage label means. |

Each milestone's spec is a GitHub issue, which the repo map's Task routing
names.
