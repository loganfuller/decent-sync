# Each release runs beside the previous one

An upgrade takes nothing offline. Release N works beside release N-1 wherever the two meet:
- as two server instances on one database, with N's migrations applied under N-1's code, and rows each writes that the other reads;
- as either release's plugin connected to either release's server;
- as the plugin's storage on a tablet and the records it writes onto the tablet, which one release leaves for the other after an update;
- as a page of the management interface loaded from N-1 talking to a server of N.

It never has to work beside N-2. Only tagged releases count. Anything added since the latest release, such as a column, message, field or route, may still be changed or removed before the next release, since no release runs it. A merged migration is still changed by a later one rather than edited, as staging and development databases have applied it. Several instances are upgraded by starting the new release beside the old and moving traffic over. No release asks for a step that stops service: no stopped server, no recreated database, nothing its upgrade notes ask to be redone. The steps left by hand happen while everything runs:
- updating tablets before a release raises the Decaid, DYE2 or Streamline minimum (ADR-0017);
- seeing that every tablet has the previous release's plugin before deploying a release that raises the wire revision.

Both directions matter for the plugin. Decaid checks for plugin releases every 12 hours while it runs, whatever its server runs, so a plugin meets the previous release's server as well as the next one's. It installs an update that asks for a new permission only once someone approves it on the tablet.

- **The database.**
  - **Two releases for a change N-1 would break on.** N adds the new form beside the old and writes both. While N-1 may still be running it reads the old form, or both, as N-1 writes only the old. A later release removes the old form once no release still running reads it.
  - **Large changes to data**, such as rewriting Shots' measurements, are made by the new release's server in batches in the background, as the delivery id cleanup works. The migration that removes the old form first checks that this work is done, and otherwise fails, naming the release to run until it is.
  - **No new constraint N-1 would trip.** No migration adds a constraint, a required column or a narrower type that N-1's writes would break. A delivery N-1 then failed to store would be set aside as unstorable and lost.
  - **Migrations are quick and atomic.** They change the schema only, because they run while N-1 serves, and a new instance answers its health check only once it has migrated.
    - Each wraps its statements in one transaction that sets `lock_timeout` locally, so it waits at most a few seconds for a lock N-1 holds and then gives up whole.
    - An index on a large table is built concurrently, in a migration of its own that first drops any index a failed attempt left behind.
    - After a migration fails, the server records it as rolled back before exiting, so neither release's instances are refused at their next start, and the next deploy tries it again.
- **The wire.**
  - **The revision.** `hello` and `welcome` carry a wire revision, a whole number. A peer that sends none is at revision 1, the wire of 1.2.0. Any change to the wire raises it, new fields included: the first change after a release raises it by one, and later changes before the next release share that number.
  - **Checks where something new is sent.** A message, field or value new in a revision goes only to a peer at that revision or later. The one exception is a field the receiver may ignore for good.
  - **The window.** The server refuses a plugin more than one revision behind its own with `plugin_too_old`, which the Machine's page shows. So once the wire has moved on to a later revision, every peer within the window has the earlier one, and its checks are deleted. A release that leaves the wire alone keeps them, as a plugin two releases behind is then still only one revision behind.
  - **Unknown messages.** The protocol version stays 1. The server closes the connection on a message of a type it doesn't know. The plugin logs and ignores one, as it always has, and the mixed-versions suite fails whenever the previous release's plugin logs that, so a missing check is found before a release.
- **Between instances.** `NOTIFY` payloads, and rows one release writes for the other to read or relay to a tablet, follow the same rule: N reads what N-1 writes and writes nothing N-1 misreads. N-1 never listens on a channel new in N, so whatever it announces may wait until no instance of N-1 is left.
- **The management interface.**
  - **The REST API serves N-1's pages.** A page of N reaching an instance of N-1 while a deploy moves traffic over may have a request fail once.
  - **Reloading.** Every response names the build of the management interface the server serves, so two unreleased builds of one version differ. A page reloads itself at its next navigation once that differs from its own build, or once loading one of its chunks fails, since a server of another build doesn't have them. It never reloads in the middle of a form, and a page or server without a build, as in development, never reloads.
- **Checks.** CI holds every pull request and every push to `main` to the latest release, built from its tag. Both checks are required, by branch protection that binds the owner too.
  - That release's server test suite runs against databases copied from a `template1` migrated by the change. Tests that need an empty database start from `template0` from now on. 1.2.0's three such tests are left out.
  - A mixed-versions suite runs that release's plugin against the change's server, the change's plugin against that release's server, and both servers as two instances on one database.
- **The escape hatch.** A release may break this rule only with the owner's approval, never on an agent's judgment.
  - It bumps the major version.
  - Its upgrade notes open by saying it can't be deployed without downtime, and how to deploy it: stop every instance, then start the new release.
  - It loses no data its notes don't name.
  - The pull requests that make the break carry the `breaking-release` label. From the merge of the first until the release is tagged, the two checks skip with a notice. Only the owner applies the label; GitHub can't enforce that, so it is a rule agents keep.
- **Deploying.**
  - **By hand, in order.** Deploys stay by hand. Each release is deployed before the next is tagged, as a plugin more than one release ahead of its server falls outside the window (the README's Releasing section). A self-hoster keeps their server within one release of the newest.
  - **Before raising the wire revision,** the owner sees on each Machine's page that it runs the previous release's plugin. A tablet that doesn't is approved, or updated through Decaid's API, first.
  - **A server that skipped a release** can't be upgraded side by side. It is stopped first, or taken up one release at a time, each run until its background work is done.
- **fly.io.**
  - **Two instances.** The deployment the README describes runs two instances in one region, on fly.io VMs that fly.io normally places on separate hosts, though it doesn't promise to.
  - **The switch.** A blue-green deploy starts a new VM beside each old one and waits for their health checks, failing the deploy and leaving the old ones serving if they don't pass. Then it sends new traffic to both releases for some 10 to 20 seconds, cordons the old VMs, stops them with their signal and destroys them. Their tablets reconnect within about a second.
  - **The routing check** reports only whether the instance is up and not stopping. Whether the database is reachable is in its body, so a database failover doesn't keep traffic away once the database is back.
  - **Staging and single instances.** Roux's staging keeps one VM, which a blue-green deploy pairs with a new one only for the switch. One instance, as in the Docker Compose example, still restarts to upgrade, for a few seconds.

## Considered Options

- **Stopping every instance to upgrade**, as ADR-0016 and ADR-0017 asked. It needs no compatibility work, but each deploy is an outage: tablets hold their deliveries until it ends and the management interface is down. Rejected: the owner wants no outages.
- **fly.io's rolling deploys**, replacing one VM at a time. They need the same compatibility, but both releases serve side by side for minutes, so a page or a tablet may reach either one on each request. A blue-green deploy overlaps them for seconds. Rolling deploys still work, for anyone who runs them.
- **A list of features in `hello` and `welcome`.** It suits peers that each implement a different subset. Here there are two, built from one repo, each release's wire a superset of the last, so one number says the same.
- **Checking the release version**, which `hello` already carries as `pluginVersion`. Staging runs unreleased `main` builds, which report the last release's version, so their new features would be withheld from each other.
- **Raising the protocol version.** A 1.2.0 server refuses a `hello` of a newer protocol version, so every plugin that updated would be cut off until its server was upgraded.
- **Having the plugin close the connection on a message it doesn't know**, as the server does. A missing check would then become a reconnect loop on the tablets rather than one message ignored, which the mixed-versions suite finds anyway.
- **Deploying releases automatically.** It could be done within Decaid's 12 hours, but deploys stay by hand for now.
- **A wider window**, such as N-2. Every change would carry its old forms longer, and tablets check for plugin releases every 12 hours.

## Consequences

- **ADR-0016 and ADR-0017 are amended.** During an upgrade, instances of two releases share a database. Decent Sync supports the previous release of its own plugin and server beside the current one, and migrates its database in place.
- **Every change to the database or the wire costs more.** A removal or rename takes two releases. Each new message or field needs a check where it is sent, deleted once the wire moves on to a later revision.
- **What is new in N works only between peers of N.** During an upgrade, and until every tablet has the new plugin, a new feature may be missing wherever a peer of N-1 is involved. What N-1 did keeps working.
- **In flight at a switch.** A Settings Edit whose connection closes comes back not confirmed (ADR-0023), a Live View stream reconnects by itself (ADR-0024), and a request in flight on an old instance, or from a new page to an old instance, may fail once. A stopping instance answers its routing check with 503 and hands its tablets to another instance at once. It answers requests for a short grace, until the proxy has noticed, and finishes those under way before it disconnects from the database.
- **The database stays one primary.** A failover to a replica takes the database away for some seconds, which no deploy hides: requests answer 503, and tablets keep their deliveries until it is back. The server rides through its database restarting or going silent, which CI tests.
- **The first release under this rule** works beside 1.2.0, which has no wire revision, so its first change to the wire is checked against revision 1 like any later one.
