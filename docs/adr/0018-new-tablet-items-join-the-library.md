---
status: accepted (amended in place on 2026-10-08, while building milestone 2: Archived Beans are not matched)
---

# New items from a tablet join the Library, and Beans are matched by roaster and name

An item a tablet reports without a global id (ADR-0006) joins the Library as a new item, whether a barista just created it or it was on the tablet when its Machine joined a Location. Two kinds are matched instead of added. A Profile keeps Decaid's id, a hash of what the machine executes, which is the same on every tablet, so an identical Profile is already the same Profile. A Bean whose roaster and name match a Bean in the Library that is not Archived, ignoring case and white space at either end, is linked to that Bean, because the glossary identifies a Bean by roaster and name: when Uptown and Belmont both enter a new coffee on its launch day, it is one Bean. Bean Batches and Grinders are never matched. Two batches of one Bean can be roasted on the same day, and two grinders of one model at a Location are two Grinders.

Nothing a tablet brings replaces what the Library holds. A Machine that joins with items of its own adds them, and its page lists what it brought, so an Admin can Archive duplicates. This replaces the warning the plan gave a Machine that doesn't join empty; the onboarding merge tool stays deferred.

We rejected keeping a joining Machine's own items on its tablet, which would leave its Shots naming items the Library lacks, and holding its sharing until an Admin reviewed them, which would make adopting a used tablet wait on someone.

## Consequences

- **Links are made once.** A Bean is matched by roaster and name only when the server first sees it. An edit that later gives two Beans the same roaster and name, such as a rename, flags them as likely duplicates and doesn't merge them: merging two Beans that each have batches and Shots can't be undone cleanly.
- **A linked record takes the Library's content.** A tablet's Bean linked to an existing Bean is overwritten with that Bean's content. Each field where the two differed becomes a Conflict (ADR-0020), so nothing is dropped silently.
