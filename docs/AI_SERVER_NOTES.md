# AI Server Notes

Rules a server change follows across modules. The code each line names shows the mechanism.

## Access

- A REST route needs a signed-in account unless marked `@Public()`, and an Admin unless marked `@AllowStaff()`, so a new route stays Admin-only until Staff are meant to use it (`server/src/accounts/guards.ts`).
- A Viewer reaches only the `@AllowStaff()` routes that read (`GET`) and those marked `@AllowViewer()`, so a reading route opened to Staff opens to Viewers.
- `server/test/access.test.ts` names every route marked either way, and fails until a new one is named.
- Staff read everything an Admin reads but other accounts' personal information; their Locations limit only what they change.
- A Staff route that changes something takes the account's `Scope` (`@CurrentScope()`, `server/src/accounts/scope.ts`), read with the session on every request and never kept, so a change applies to the next request on any instance.
- Staff may move a Machine from now between their Locations and change the Library as `LIBRARY.md` says; every other change is Admin-only.
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
- A clean-up of expired rows runs in statements of its own, in bounded batches that skip locked rows, never inside a transaction holding other locks, as the server starts and hourly (`DeliveryIdCleanup` in `server/src/machines/delivery-id-cleanup.ts`).

## Several instances

- Test state shared across connections or requests with two instances on one database (`startTestServer({ sharing })`), as `server/test/server-instances.test.ts` does.
