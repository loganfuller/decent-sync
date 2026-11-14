---
status: accepted
---

# The plugin serves a Skin what the server holds, and a tablet may choose a Reference Shot

A Skin runs on a tablet and knows only Decaid's API, so it can show nothing the server holds: not a Shot the Machine beside it pulled, and not a Recipe's Reference Shot (ADR-0029) unless its own tablet pulled it. Milestone 8 has the plugin serve it. A Skin calls HTTP endpoints of the plugin's on the tablet, the plugin asks the server over its WebSocket, and the answer comes back in the same call. Through them a Skin lists the Shots at its Machine's Location, reads any of them whole, and reads a Recipe's Reference Shot. Each tablet that takes part in the Library also keeps a copy of the Reference Shot of each of its Location's Recipes in a slot, which the server sends and keeps current, so a Skin still draws the reference while the server can't be reached.

A tablet may also choose a Recipe's Reference Shot, which ADR-0029 left to the management interface and the MCP endpoint: for a Recipe of its own Location, any Shot the tablet may read. The tablet is where a Shot is judged, and a dial-in change made there already edits the Recipe with no account. The server records the choice as it records that change, by its Machine and tablet and no person. A tablet cannot clear a Reference Shot.

## Considered Options

- **A Skin calling the server's REST API itself,** as ADR-0009 first had the tablet's location view. A Skin has no account, so each tablet would hold a credential for it, and each Skin the server's address. Rejected: the plugin already holds the Machine's Token and a connection that knows its Machine, its Location and whether it takes part.
- **The plugin calling the REST API with its Token,** in place of a request over the WebSocket. No new messages, but a second way for the plugin to reach the server, where ADR-0009 keeps one, with the Machine worked out again outside the connection that settled it (ADR-0004). Rejected.
- **Writing the Reference Shot into the tablet's Decaid storage** as a Shot of its own, so a Skin reads it as any other. Decaid has no route that creates a Shot, and one written there would be captured again as that tablet's. Rejected.
- **Tablets showing a Reference Shot and never choosing one.** The lead who pulls the Shot they want would have to find it in the management interface afterwards. Rejected.
- **A reference only among the tablet's own Shots,** which needs nothing from the server. Two Machines at one Location would be compared with different Shots, and a Shot dialled at another Location could never be a cafe's reference. A Skin running without Decent Sync may still do this; it is the Skin's affair.

## Consequences

- **Anything on a tablet's network can call the endpoints.** Decaid's web server checks no caller, for its own API or a plugin's. The same network can already change the Workflow and delete Shots, so this is accepted. The server holds a tablet to its own Location: its Shots, its Recipes and their Reference Shots.
- **A choice made on a tablet names no person.** The Recipe's history names the Machine and tablet. Anyone at the tablet may replace a lead's choice; the history is what shows it.
- **A choice is never queued.** One made while the server can't be reached is refused at once, so nothing changes later behind a barista's back.
- **Choosing a Reference Shot now reaches tablets.** ADR-0029 had nothing sent to them. A change is announced to the Recipe's Location and each tablet's copy is replaced. It is still not a content edit: it makes no Conflict (ADR-0020) and is no part of DYE2's recipe record.
- **The wire gains a request and an answer.** It is the first thing the plugin asks of the server. A request is never stored or retried: one unanswered when the connection closes is answered to the Skin as unreachable.
- **ADR-0009 is amended.** It had the tablet's location view use the REST API. A Skin reads through the plugin instead, and the plugin still speaks to the server only over its WebSocket.
- **Only a Machine that takes part is served.** A Capture-only Machine's Skin is told so, and shows its tablet's own Shots.
- **Streamline is unchanged.** The endpoint and push it reads stay as they are, and the new pushes go out on an endpoint of their own.
