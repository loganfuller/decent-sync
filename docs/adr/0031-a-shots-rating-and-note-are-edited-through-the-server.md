---
status: accepted
---

# A Shot's rating and note are edited through the server, and written to the tablet that holds the Shot

Everything about a Shot has come from the tablet that pulled it, and the server has written nothing about a Shot to any tablet. So a Shot could be rated only at one tablet: not at the Machine beside it, where it may have been tasted, and not from the office. From milestone 8 a Shot's rating and note may be edited through the server: from another tablet at the Shot's Location (ADR-0030), in the management interface and through the MCP endpoint (ADR-0026). The server applies the edit to the Shot it holds at once, keeps who made it, and writes it into the Shot on the tablet that holds it, at once if that tablet is connected and otherwise when it next connects.

Only the rating and the note are edited this way. Where two edits of one of them were made without seeing each other, the later wins and nothing is kept of the other.

The server is the source of truth (ADR-0003), and the tablet's copy is what its Skin and DYE2 show, so the edit is written back and the two don't stay different.

## Considered Options

- **Keeping the edit on the server alone.** The pulling tablet's Skin and DYE2 would go on showing the old rating, and that tablet's next edit of anything on the Shot would arrive whole and undo it. Rejected.
- **Keeping the losing edit as a Conflict,** as the Library does (ADR-0020). A rating or a remark is not worth someone's attention to settle, and a Shot would wait on them. Rejected: the later edit wins.
- **Refusing an edit while the pulling tablet is off,** as a Settings Edit is refused (ADR-0023). A Machine's settings have to be read live before they are changed; a rating doesn't. Rejected.
- **Every field of a Shot editable,** such as its dose, yield and TDS. Those are measured at the Machine, and nothing asks for them yet. Left out.

## Consequences

- **The server writes to a tablet's Shots for the first time,** and only these two fields, through Decaid's own Shot update. Decaid then reports the Shot as updated, which the server takes as it takes any tablet's edit.
- **An edit made through the server has an author:** an account and any Connected App, or a Machine and tablet. It is the first history a Shot has. An edit made on the tablet that holds the Shot still arrives with no person, as before.
- **"Later" is judged across two clocks:** the server's for an edit made through it, the tablet's for its own. A tablet whose clock is wrong can win or lose an edit it shouldn't.
- **An edit awaiting its tablet never undoes a later change made there.** It is dropped for a field the tablet changed since, and still written for one it didn't.
- **An edit can wait for good.** A tablet that was reset or replaced no longer holds the Shot. The edit stays on the server, marked as having no tablet to reach.
- **Accounts edit Shots for the first time.** Staff edit those at the Locations they work at, an Admin any, and a Viewer none.
