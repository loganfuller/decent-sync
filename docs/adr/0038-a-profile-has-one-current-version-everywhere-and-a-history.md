---
status: accepted
---

# A Profile has one current version everywhere, and a history of the versions it has had

Decaid's id names what the machine executes, so ADR-0032 made every change of a Profile's steps a new Profile, tied to the one before by Decaid's `parentId`, and showed the chain as that Profile's Profile Versions. That left each version a Profile of its own, with its own row in the Library, its own page, its own Recipes and its own state at each Location. Publishing a new version took the old one's place only at the Locations, and for the Recipes, the person chose, so two versions of one Profile could be in use at once. A chain could fork. A Duplicate was listed among the versions, as it carries the same `parentId`. Returning to an earlier version was the same swap between two Profiles, Location by Location. The chain was a record of what was saved from what, not the history of one Profile.

So a Profile is now the lasting thing, and a Profile Version is one set of steps it has had. A Profile has one current version, the same at every Location, and a history of the versions it has had. A new version takes the current one's place everywhere at once, and any earlier version can be made current again.

This amends ADR-0032, replacing four of its consequences: publishing no longer chooses where a new version is shown, Recipes follow a new version, a chain no longer forks, and returning to an earlier version acts everywhere. It amends ADR-0006, in that a Profile now has an id no tablet holds, and ADR-0008, ADR-0018 and ADR-0019 where they speak of a Profile's steps changing on a tablet.

## The decision

- **A Profile has an id of the server's own.** Decaid's id goes on naming each Profile Version, on the server and on every tablet, as ADR-0006 has it. Decaid has no id for a Profile across its versions, only the `parentId` link, so this is no second id for something Decaid identifies, which is what ADR-0032 rejected. No tablet is written the Profile's id.
- **One current version, everywhere.** Whether a Profile is shown at a Location stays per Location (ADR-0008), but it is the Profile's state, not a version's. A Location that wants other steps has a Profile of its own, by Duplicate.
- **A Recipe names the Profile.** Every Recipe on a Profile follows to its current version, with none left on an earlier one. On a tablet its record names Decaid's id of the current version and holds its steps, so a new version is written to each of them, and a Machine that has such a Recipe loaded takes the new steps in its Workflow at once, as it takes any edit of its Loaded Recipe.
- **The title, author and notes are the Profile's.** A Profile Version is what the machine executes, which is what Decaid's id covers. A new version keeps the Profile's title. A Draft that changes steps and title publishes one new version and one edit of the title. Returning to an earlier version brings back its steps alone; the title, author and notes keep the history of edits they have today.
- **The history is a log of which version was current.** Each entry says which version became current, when and by whom or on which Machine. Versions are named "Version n" in the order each first joined the Profile, and are never renumbered. Returning to an earlier version adds an entry and no version, and creates nothing, since the same steps are always the same record to Decaid. The later versions stay in the history and can be returned to in turn.
- **Decaid's bundled Profiles have no versions.** Decaid refuses to change one, and every tablet has them. A save over one on a tablet, which Streamline makes as a new record beside it, starts a separate Profile that says which Profile it was started from, as a Duplicate does.
- **A Duplicate is a separate Profile,** with a history of its own, whether made in the management interface or by Streamline's Save As New. It keeps a note of the Profile it was started from and is listed among no other Profile's versions.

## Reading a tablet

A tablet reports the records it holds and whether each is visible, and nothing of why. The server reads a change of them so:

| What the tablet reports | What it is taken as |
|---|---|
| A new record saved from the current version, with that version hidden at the same moment | A new version of the Profile, current everywhere, credited to that Machine. This is Streamline's Save |
| A new record saved from the current version, which stays visible | A separate Profile, shown at that tablet's Location (ADR-0018). This is Streamline's Save As New, or its Duplicate once edited |
| An earlier version made visible, with the current one hidden or deleted | A return to that version, everywhere. This is Streamline's Reset, or a revert in its editor |
| The current version hidden or deleted, and nothing else | The Profile hidden at that tablet's Location (ADR-0019), as now |

Where the signs are unclear, the record is a separate Profile. A person can then attach it by hand to the Profile it belongs to: its steps become that Profile's current version, the Recipes of both are on it, and its own row is gone. Wrongly reading a new version as a separate Profile adds a row to the Library. Wrongly reading a separate Profile as a new version would change the Shots of every Location, so the doubt falls the first way.

"At the same moment" is judged by the records' own times, not by which report carried them: the old record was hidden within a few seconds of the new one's creation. Streamline creates the new record a moment before it hides the old one, and the plugin reads the list on a timer, so the two can arrive in two reports. A record first taken as a separate Profile then becomes the new version it was, once the report that hides the old one arrives. A Profile hidden long after another was saved from it is only hidden.

## Considered Options

- **Keeping each version a Profile, and listing only the newest of each chain.** The Recipes, the page and the state at each Location would stay attached to one version, so every new version would still have to move them, which is where the present design goes wrong. Rejected.
- **A current version per Location.** It keeps the choice ADR-0032 gave, and with it two versions of one Profile in use at once and a history that differs by Location. A Duplicate already serves a Location that wants its own steps. Rejected.
- **The first version's Decaid id as the Profile's id.** One id would name both a Profile and one of its versions, and the first version is often not the current one. Rejected.
- **A tablet's save staying a new Profile at its own Location.** Every other edit made on a tablet applies everywhere (ADR-0003, ADR-0020), and a Profile whose steps differ by where they were last saved is the state this replaces. Rejected. The cost is accepted: one barista's save changes the Shots of every Location, until someone returns to the version before.
- **Refusing a Draft that fell behind until it is started again from the current version.** The warning ADR-0032 gave before a fork says the same thing, and the version it replaces is one return away. Rejected.
- **Setting the new version on a Workflow that holds the old one with no Loaded Recipe.** Streamline folds a Recipe's yield and brew temperature into the Workflow's copy of a profile, so the server can't tell an untouched copy from one a barista adjusted. Rejected: the server sets a Workflow's profile only for a Loaded Recipe or a followed Draft, as now.
- **Asking Streamline to mark a save over a Profile.** It would replace the reading above with a fact. The owner chose not to ask, so the reading is the design, not an interim one.

## Consequences

- **Publishing a new version, and returning to an earlier one, ask for no Locations and no Recipes.** They stop once for a confirmation that lists the Locations showing the Profile, the Recipes that follow, the Machines that have those loaded now and anything below that warns or refuses. A new Profile, and a separate one, still choose the Locations they are shown at, as ADR-0032 has it.
- **A Draft that fell behind publishes on top.** One started from a version that is no longer current becomes the next version all the same, taking the current one's place, after a warning that shows how it differs from the current one. The history stays one line and says which version it was made from. A Draft can be started from any version in the history.
- **Of two changes that cross, the later is current** (ADR-0020). A tablet's save made before a newer version was published, and reported after, is kept in the history as a version that was never current (ADR-0033), which can be returned to, and the tablet is written the current one.
- **A version some Machine can't run is refused where the server can refuse it.** Publishing a new version, or returning to one, is refused from the management interface and the MCP endpoint while a Location showing the Profile has a Machine whose model can't run its values, naming the Location and the Machine. A tablet's save can't be refused: it becomes current, and those Machines are written nothing of it, as ADR-0032 has it for any Profile they can't run.
- **Staff change a Profile's current version only where they work at every Location showing it.** Publishing a new version, returning to one and attaching a Profile reach every Location that shows the Profile, so Staff may do them when they work at each of those Locations, and otherwise an Admin does. A tablet's save is no account's and is held to none of this.
- **A Workflow with no Loaded Recipe keeps the steps it has.** The tablet's list shows the new version, which the next pick of the Profile takes. The Profile's page names the Machines whose Workflow still holds an earlier version.
- **Earlier versions stay on tablets, hidden,** as Streamline leaves them, so a return on a tablet that holds one is a change of visibility.
- **Shots are a Profile's across its versions.** A Shot is tied to a version by its steps, as now, and the Profile's page lists the Shots of all its versions, each with its version.
- **Steps that exist already make no new version.** A Draft with the steps of an earlier version of its own Profile is a return to that version. One with the steps of another Profile's version, current or earlier, is refused, naming that Profile, as ADR-0032 has it.
- **Archiving and hard-deleting act on the whole Profile.** One version can't be removed from a Profile's history.
- **A Recipe's own history gains no entry for a new version.** The Profile's history holds it, and each Shot says which version it ran.
- **The upgrade changes nothing a Machine runs.** A Profile saved from another becomes a version of it only where the one it was saved from is shown at no Location, so was replaced. Where that one is still shown somewhere, as after a Duplicate or a version published at some Locations only, it becomes a separate Profile. Where a fork left two versions of one Profile shown, the later saved stays current and the other becomes a separate Profile. Where none is shown, the latest saved is current and the Profile is hidden everywhere. What it gets wrong is an extra row, put right by attaching it by hand.
- **It runs beside the previous release** (ADR-0025). The versions stay the rows they are, under Decaid's id, and the Profile is added above them, so the previous release goes on reading and writing what it knows during an upgrade.
- **The glossary's Profile and Profile Version change with the first change that builds this,** to the meanings above.
