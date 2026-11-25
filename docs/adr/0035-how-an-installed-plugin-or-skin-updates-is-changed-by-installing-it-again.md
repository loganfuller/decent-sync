---
status: accepted
---

# How an installed plugin or Skin updates is changed by installing it again

ADR-0034 showed how each plugin and Skin on a tablet updates and left it at that: "shown, not switched". The only way to change it was the Install dialog, which doesn't know the item is already there, doesn't check that the same item comes back, and can't pin a build the tablet already runs. It cost a real update: a Skin installed from one release's download showed as following its URL, which never changes, so every update check called it current while a newer release was out (#676).

So an Admin changes how an installed plugin or Skin updates from its row on the Software tab, as a **Software Action** like the others (ADR-0034): made once, on one Machine, while its tablet is connected and its Machine idle, and kept with who asked and what came of it. The choices are following a GitHub repository's releases, following a branch, pinning it to a commit, pinning it where it is now, and, for a Skin, a URL. This replaces ADR-0034's fourth limit.

- **The change is a reinstall.** Decaid records where an item came from as it installs it, and has no route that changes that otherwise. Installing over the same id replaces the item in place, so the plugin installs it again from the new source, through Decaid's install routes. It installs whatever that source serves then, which may be another version, and the result gives the version before and after. A plugin keeps its settings, whether it is enabled and what it stored; a Skin stays the default where it was.
- **Same item, or nothing.** The action names the id it is to change. Decaid checks ids only in update checks, so a source whose package declares another id is installed beside the item, as a second one. The plugin then removes that one again, unless the tablet held it before the action, and refuses the action as `differentItem`, the item it named being as it was.
- **Over what the Admin saw.** The action carries the item's source and build as its tablet reported them when it was made, and is refused as `changedSince` where the tablet reports another by the time it runs.
- **An older plugin build is refused.** Decaid installs no plugin build older than the one installed, and asks for the plugin to be removed first, which would delete its settings. The action is refused with Decaid's reason, and nothing is removed for it.
- **Added permissions are flagged, not blocked.** Decaid's install routes take whatever permissions the new build declares, without the approval an update waits for. Only an Admin makes this change, who is trusted with the tablet already (ADR-0034), so the result lists the permissions the new build adds and asks for nothing.
- **Decent Sync's own plugin** follows only the releases of `loganfuller/decent-sync` or is pinned to one of its commits. A branch's moving head, or a build from anywhere else, could cut the tablet off with no way back from the server, so the server and the plugin both refuse it (`notAllowed`).
- **A Skin that comes with Decaid is not changed.** Decaid installs its own repository's latest release again each time it starts and at each update check, which would undo any change, so none is offered.
- **Pinning it where it is now is found through GitHub**, by the server, as Decaid installs by latest release, branch, commit or URL and by no release tag (decentespresso/decaid#1030). A plugin following releases is installed from the commit its installed tag points at. A Skin following releases is installed from its installed tag's download, the one Decaid's own install picks, as a release may be a built bundle that its commit's archive is not. A plugin following a branch is installed from the commit Decaid recorded. Decaid records no commit for a Skin from a branch, only the ETag its archive was served with, so the server looks among the branch's latest commits for the one whose archive GitHub serves with that ETag. Where nothing matches, pinning it there is not offered.
- **Admins only, and no assistant** (ADR-0026): it puts code on a tablet, as an install does.

## Considered options

- **Leaving it to the Install dialog.** It installs a second item where the source holds another id, and says nothing of what it replaced.
- **Removing the item and installing it afresh.** It would take a plugin build older than the one installed, but it deletes the plugin's settings and, for a Skin, the default.
- **The plugin asking GitHub.** A tablet may have no way out but to its server, and the form must know whether a pin can be offered before anything is asked of the tablet.
- **One kind for both.** A plugin and a Skin are named, read and installed through different routes, as every other kind that acts on one is.

## Consequences

- The server now asks GitHub's API and its archives, read-only and without credentials, when an Admin opens the form: only public repositories can be pinned where they are, and GitHub answers 60 such requests an hour from one address. Where it does not answer, the form says so and offers the other choices.
- Matching a Skin's branch build by its archive's ETag rests on what GitHub was seen to serve, which it documents nowhere. Should it change, the match fails and pinning such a Skin where it is stops being offered; nothing wrong is installed.
- The two kinds, the `differentItem` refusal and the result's version before raise the wire revision to 6: a plugin of the previous release is told to update before it is sent one, and takes every other Software Action meanwhile.
- Two asks of Decaid would simplify this, and are drafted in #676: approving the permissions a reinstall adds, and letting a Skin Decaid comes with follow another source.
