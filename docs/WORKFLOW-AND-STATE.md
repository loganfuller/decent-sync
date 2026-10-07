# Workflow changes and machine state transitions

Ticket [#13](https://github.com/loganfuller/decent-sync/issues/13) extends
protocol version 1 with two deliveries, defined and validated in `protocol/`:

| Direction | Message | Fields |
|---|---|---|
| Plugin to server | `workflow` | `id` (delivery id), `observedAt`, `workflow` (opaque, as Decaid's `workflowUpdated` event gave it) |
| Plugin to server | `machineState` | `id`, `observedAt`, `state` and `substate` (Decaid's names, such as `espresso` and `preinfusion`) |

Both are acknowledged with `ack` once stored, or set aside because storing
them fails in a way that would repeat, as Shots are (`AI_PROTOCOL_NOTES.md`,
Deliveries set aside). Older plugins never
send them, so the protocol version stays 1.

## Plugin

`plugin/src/machine-events.ts` turns Decaid's events into deliveries, through
the plugin's one outbox (`plugin/src/outbox.ts`), which Shots share:

- `workflowUpdated` carries the whole Workflow. Decaid sends it just after
  loading the plugin and on every change (`PluginManager` in
  `decaid:lib/src/plugins/plugin_manager.dart`), so the plugin never reads
  `GET /workflow`. Every one is sent.
- `stateUpdate` arrives several times a second while a machine is connected.
  Only a change of state or substate from the last one queued is sent.
- On every `welcome`, the latest Workflow is sent again in a new delivery,
  observed then, replacing one an earlier `welcome` queued if that is still
  queued, and the next state update is sent whatever it is. A reconnect may
  stand for other hardware, after a tablet moved to another machine. A
  delivery still queued from the last connection may already have been
  stored for the last hardware, and its resend then changes nothing, so the
  new hardware gets the Workflow only from this new delivery. The server
  records nothing for either if it is unchanged.

`observedAt` is when the plugin observed the event, from its own clock in UTC
(`new Date().toISOString()`), because the outbox may deliver it minutes later.
A state update's own `timestamp` is the tablet's local time without an offset,
like a Shot's sample times, so it is not used; the validator refuses a time
without its `Z`. Deliveries go in order, one awaiting acknowledgment at a
time, and what a connection left unacknowledged is sent again first on the
next, with the same delivery ids, ahead of the Workflow sent on `welcome`, so
a reconnect never replaces changes made while disconnected. The outbox is in
memory: events it holds when the plugin unloads are lost, and milestone 2's
durable outbox recovers them. A reload sends the current Workflow, and the
next state update, again.

## Server

`server/src/machine-events/machine-events.service.ts` appends each delivery to
`workflow_events` or `machine_state_events`, handling each delivery once.

First it locks whoever the event belongs to (below), then records the
delivery's id in `machine_event_deliveries`, keyed by the token's Machine,
whether or not the delivery turns out to change anything
(`creditFirstDelivery` in `server/src/machines/credit.ts`). A delivery whose
id is already recorded is acknowledged and changes nothing: the plugin keeps a
delivery's id when it sends it again, and always through the same token, so a
resend changes nothing, through any connection or instance, even after other
changes, and even when the first delivery changed nothing either. A resend
arriving while the first is still being stored waits for it, at that lock or
on the record's key.

The lock comes first because the record references the token's Machine, and
whatever writes a row referencing a Machine locks first (`lockMachine` in
`server/src/machines/machines.service.ts`). Recorded first, the record's
foreign-key check held the Machine's row against an update of its model and
serial while the delivery waited for the row lock, so a hello or an Admin
binding the Machine's hardware under that lock deadlocked with it.

Each id is kept for 90 days from when it was recorded, by PostgreSQL's clock
(`DELIVERY_ID_RETENTION_DAYS` in `server/src/machines/delivery-id-cleanup.ts`).
Every server instance deletes older ones as it starts and then hourly, at
most 1,000 in each statement, oldest first. Each statement runs on its own,
outside any delivery's transaction, and skips rows another transaction has
locked, so it waits for no delivery, and instances running it at once delete
different rows. A failed run is logged and the next tries again. The index on
`received_at` finds the rows to delete.

Deleting them is safe because a resend comes only from the plugin load that
sent the delivery, from its in-memory outbox on its next welcomed connection,
far sooner than 90 days. A resend that comes later anyway is handled as a new
delivery. Only one delivery awaits acknowledgment at a time, so only that one
can have been stored without the plugin knowing, and it is sent again ahead
of anything newer. It is stored only if it differs from the latest event, so
at worst it puts one stale event after a newer one another tablet's
mismatched session stored for the same Machine. Milestone 2's durable outbox
lets a delivery outlive its plugin load, so a resend may come later, but the
same bound holds.

An event belongs to the session's token's Machine, or for a mismatched
session, to its reported hardware: the Machine that has it, or else its
Pending Machine (ADR-0015), as an inferred Shot or a Steam Record is
(`creditReporter` in `server/src/machines/credit.ts`). Whoever is chosen is
locked: the Machine's row, or the hardware's advisory lock for a Pending
Machine. Under that lock, one statement inserts the event unless the latest
event stored for the same Machine or Pending Machine (the highest `id`) has
the same Workflow (jsonb equality) or state and substate. That makes the
history transitions only, judged by what is stored rather than what any
instance or connection remembers, so it holds across reconnects, instances and
restarts. A mismatched session's events are judged against the latest of
whoever has its hardware, so a tablet moved onto another Machine's hardware
adds only what changes that Machine's own. Creating a machine entry for a
Pending Machine's hardware, binding it at `hello` or entering it by hand hands
its events over with its Shots and Steam Records (`transferPendingRecords`).

The current Workflow and machine state are the latest events stored, which
for one tablet are also the latest observed. `observed_at` keeps the tablet's
time, which may be wrong or jump; `received_at` is PostgreSQL's.

Known limits: a state update that arrives on a connection whose `hello`
reported no machine belongs to the token's Machine, as everything on that
connection does, until the plugin reconnects with the hardware the machine
then reports (ADR-0015). Events lost by an unload stay lost until milestone 2.

## REST API

All endpoints require the account session, and answer 404 for an unknown
Machine. Pending Machines' events are not exposed; they appear on the Machine
that takes their hardware over. Staff read them as Admins do.

- `GET /api/machines` and `GET /api/machines/:id` include `machineState:
  { state, substate, observedAt } | null`, the latest stored.
- `GET /api/machines/:id/workflow` returns `{ workflow }`, the latest Workflow
  event `{ id, observedAt, receivedAt, workflow }` or null; `workflow` is
  Decaid's, as sent.
- `GET /api/machines/:id/workflow-events?limit=20&offset=0` and
  `GET /api/machines/:id/machine-state-events?limit=20&offset=0` return
  `{ events, total, limit, offset }`, latest first. A state event is
  `{ id, state, substate, observedAt, receivedAt }`. Limit is 1–100.

The Machines list shows each Machine's state and last Shot; the Machine page
also shows its current Workflow.

`server/test/machine-events.test.ts` covers this through Seam 1, with the
built plugin and raw frames on two instances sharing PostgreSQL, and
`e2e/workflow-and-state.spec.ts` the management interface.
`server/test/binding-deadlocks.test.ts` races deliveries, collections
included, against a hello or an Admin binding the Machine's hardware, in
both orders.
