# Shared items have per-location state

A shared item's content (a profile's steps, a batch's roast date) is the same everywhere. Some of its state differs by location: whether a profile is shown, a batch's stock, and whether a batch is archived. The server keeps that state per location, and the plugin writes each tablet the state for the tablet's own location. On a tablet, a batch's `weightRemaining` is that location's stock, and its `archived` flag is true when that location has none left. Editing those fields on a tablet changes them only for that location: a corrected `weightRemaining` is recorded as a count there.

This is surprising because Decaid has a single `archived` flag and a single `weightRemaining` per record, which reads as global. Decaid has no notion of location, so the plugin maps the fields per tablet.

New profiles are shown only at the location where they were created and hidden elsewhere until someone shows them there. That keeps lab experiments out of the cafes' lists. Decaid's bundled profiles aren't synced, but whether they are shown is per location like any other profile.
