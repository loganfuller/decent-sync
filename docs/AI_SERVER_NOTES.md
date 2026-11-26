# AI Server Notes

Rules a server change follows across modules. The code each line names shows the mechanism.

## Access

- A REST route needs a signed-in account unless marked `@Public()`, and an Admin unless marked `@AllowStaff()`, so a new route stays Admin-only until Staff are meant to use it (`server/src/accounts/guards.ts`).
- A Viewer reaches only the `@AllowStaff()` routes that read (`GET`) and those marked `@AllowViewer()`, so a reading route opened to Staff opens to Viewers.
- Drafts are the one thing Staff read that a Viewer doesn't: `DraftsService` refuses a Viewer's Scope (`nothing`) itself, and `access.test.ts` lists their reading routes apart (`DRAFT_READS`), those of how one is tried among them (`DraftFollowingService`).
- `server/test/access.test.ts` names every route marked either way, and fails until a new one is named.
- Staff read everything an Admin reads but other accounts' personal information; their Locations limit only what they change.
- A Staff route that changes something takes the account's `Scope` (`@CurrentScope()`, `server/src/accounts/scope.ts`), read with the session on every request and never kept, so a change applies to the next request on any instance.
- Staff may move a Machine from now between their Locations and change the Library as `LIBRARY.md` says; every other change is Admin-only.
- A Batch Move is the one change of a Location's state Staff make with one of two Locations in their Scope, the one left or the one joined (`moveBatch` in `server/src/library/library-edits.service.ts`); adding, finishing and entering a weight need that Location.
- A controller whose reads Staff take and whose changes are an Admin's marks only its reads `@AllowStaff()`, leaving the rest Admin-only, an Admin's read included, as `SoftwareActionsController` does with `plugin-sources`; its service refuses anyone but an Admin again (`ADMINS_ONLY`), for the MCP endpoint and any other caller.
- The values of plugins' settings go to Admins alone, wherever they are read: anyone else gets `{ hidden: true }` in place of each, but null and a secret's `{ isSet }` (`shownPluginSettings` and `shownSetting` in `server/src/collections/plugin-settings.ts`).
- A Software Action's settings values, a secret's among them, are the one place a secret a person enters for a tablet is at rest in PostgreSQL, and only briefly: in `software_actions.held`, apart from what is shown, removed by the statement that claims the action, and from one never claimed once it is no longer awaited, by a timer of the instance that made it and by every instance as it starts and before it makes or lists one of that Machine (`SoftwareActionsService`). No response, log line or notification holds one.
- Global guards run again around each MCP tool call, outside HTTP, and a guard that reads no HTTP request fails closed, so a new kind of handler stays closed until a guard admits it (`SessionGuard` in `guards.ts`).
- A one-use secret, such as an invite or a password reset link, is claimed with a conditional update, so of concurrent uses on any instances only the first succeeds.
- A new way of revoking a Machine's access notifies `machine_access` inside its transaction (`notifyAccessChanged` in `server/src/machines/access-changes.ts`), so every instance checks its connections to that Machine.

## Clocks

- Every time the server stores or judges comes from PostgreSQL's clock (`now()` or `clock_timestamp()`), never from a `Date` made in the instance.
- Creation and receipt times default to `@default(dbgenerated("transaction_timestamp()"))`, as Prisma fills `@default(now())` from the instance's clock; only `@updatedAt` is the instance's (`server/prisma/schema.prisma`).

## Locks

- Whatever writes a row referencing a Machine first takes that Machine's row lock (`lockMachine`, `FOR NO KEY UPDATE`), or the hardware's advisory lock (`lockHardware`) and then its owner's row (`server/src/machines/credit.ts`).
- Take Machine rows before a Pending Machine's, several in id order, as a hello does; the reverse order deadlocks with a reconnecting tablet.
- A delivery takes its credit's locks before recording its delivery id (`creditFirstDelivery`); recording it first deadlocked with a binding hello (`server/test/binding-deadlocks.test.ts`).
- Taking in a tablet's Library reports follows the lock order in `LIBRARY.md`, Taking in a tablet's beans.
- Publishing a Draft takes its Draft's row, then `PROFILE_JOINING_LOCK`, then each Location's lock in id order, then `PROFILE_TITLE_LOCK`, then its source Profile's row `FOR KEY SHARE`, then the Recipes' rows, the order a tablet's report of new profiles takes them (`server/src/library/publishing.service.ts`). Returning to an earlier version takes each Location's lock in id order, then the version returned to `FOR SHARE`, then the Recipes' rows.
- What touches a Draft's following takes the Draft's row first (`FOR UPDATE` to start or stop it, `FOR KEY SHARE` to record a write's answer), then the Machine's row, then the following's, then the Draft's `draft_trials` rows, which ending a following marks no longer followed in a second statement (`endFollowings` in `server/src/library/draft-following.ts`): a save takes the Draft's row first too, and discarding and publishing take it, then (publishing after its Recipes' rows) the following's and the trials' rows before the delete cascades to them (`lockFollowingForDelete`), since the cascade would take the trials first. Storing a Workflow ends a following under the tablet's and the Location's locks, and a Location's setting turned off or a Machine moving ends its followings, each taking no Draft's row: the following's row, then its trials'.
- A Batch Move takes both its Locations' locks in id order, then the batch's row `FOR KEY SHARE`, as a batch created at several Locations does (`moveBatch` in `server/src/library/library-edits.service.ts`): a Location's lock comes before an item's, and several Locations' in id order, wherever more than one is taken.
- A clean-up of expired rows runs in statements of its own, in bounded batches that skip locked rows, never inside a transaction holding other locks, as the server starts and hourly (`DeliveryIdCleanup` in `server/src/machines/delivery-id-cleanup.ts`).

## Several instances

- Test state shared across connections or requests with two instances on one database (`startTestServer({ sharing })`), as `server/test/server-instances.test.ts` does.
- What one instance makes for a tablet's connection that another may hold, a Settings Edit or a Software Action, is a row inserted under the Machine's row lock naming the connection holding it then, announced in the same transaction on its own channel (`settings_edits`, `software_actions`, `server/src/notifications.ts`), and claimed under that lock again only by the instance holding that connection, by setting when it was sent; a later connection sends nothing made for an earlier one.
