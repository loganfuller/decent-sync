---
status: accepted (amends ADR-0014; amended in place on 2026-10-12, while scoping milestone 3: it covers the hot water settings the plugin writes for a Loaded Recipe too, ADR-0022; amended in place on 2026-10-14: Streamline now follows the rule for skins, so the plugin no longer sets the values it remembers)
---

# Skins take a Workflow change made elsewhere; the plugin no longer sets the values Streamline remembers

Streamline, a skin for Decaid, remembers what the barista last set for steam time, flow, temperature and milk stop, hot water volume and temperature, and flush time, in Decaid's store under its namespace `streamline-app`. Up to v0.2.13, whenever the Workflow held another value, whoever set it, Streamline pushed the remembered one back through `PUT /workflow` (`resyncIfDrifted` in `streamline-js:src/modules/api.js`). So when the plugin wrote a Location's settings to a Streamline tablet (ADR-0014), Streamline put its own value back, the plugin reported that as the tablet's edit, and it became the Location's value, written to its other Machines. Two Streamline tablets remembering different values would undo each other's in turn.

This ADR first had the plugin set the value Streamline remembers of each setting it was about to write, then write the Workflow, the order Streamline's own setters use (`plugin/src/streamline.ts`, from #130 until 2026-10-14). We rejected asking Streamline to take a Workflow change made elsewhere as the new value, as its resync then counted "a value set from another device" as drift to undo, and as with DYE2 (ADR-0005) we would not tie this project to someone else's release. We also rejected having the server ignore a change back to the value it overwrote, made just after its write: it can't tell such a revert from a barista's change, and the tablet would keep the other value anyway.

## The rule for skins

On a Machine that shares these settings, the Workflow holds the current value. A skin may remember what the barista last set, but when the Workflow changes through something other than the skin itself, it takes that as the new value rather than writing its own back. The plugin writes the Workflow alone, and sets nothing a skin keeps.

## Streamline follows the rule

Streamline made that change itself. Since decentespresso/streamline-js#109 (`b13cffd`, merged 2026-10-13), it adopts a Workflow value that differs from the one it remembers: it writes the Workflow's value into its store and pushes nothing back (`decideResync` in `streamline-js:src/modules/resync-policy.js`, called by `resyncIfDrifted`). It still pushes its own write that has not reached the Workflow yet, and the value it remembers for a setting the Workflow lacks. It ignores a differing value seen within 10 s of its own push, rather than adopting it. Since decentespresso/streamline-js#132 and decentespresso/streamline-js#137, it also shows a steam flow, milk stop or flush time changed elsewhere, as it reads the Workflow back after its own writes, on a machine state change and every 20 s. Both are on Streamline's `main` and its `dist` branch, which still reports 0.2.13. No release after v0.2.13 holds them yet (checked at `07be2b3` on 2026-10-14).

Decent Sync supports only Streamline builds with this change, not v0.2.13 or earlier (ADR-0017). So the plugin no longer sets the values Streamline remembers. `plugin/src/streamline.ts` was removed.

## Consequences

- **No adapter for any skin.** Streamline v0.2.13 or earlier, or another skin that pushes remembered values back, undoes its Location's changes on its Machine and shares its own. Such a Machine's settings sharing needs to be turned off (ADR-0014). #131 tracks warning about such Machines.
- **The plugin writes nothing in a skin's namespace.** It never reads or creates `streamline-app`, and a refused Workflow write leaves nothing of a skin's to set back.
- **A narrow window remains in Streamline.** A Workflow change the plugin makes within 10 s of a barista's change of the same setting in Streamline is ignored as a stale echo of that change: Streamline's store keeps the barista's value until its next comparison after the window, as on its next load, adopts the Workflow's. Nothing is pushed, so the Workflow keeps the plugin's value meanwhile.
- **A barista's own change is still pushed.** If Decaid refuses a change made in Streamline, as while the machine is off, Streamline keeps it pending on that device and pushes it again at its next comparison, as on its next load. That is the barista's edit, and becomes the Location's.
