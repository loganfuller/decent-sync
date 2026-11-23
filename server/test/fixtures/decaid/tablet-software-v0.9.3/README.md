# Managing plugins on Decaid v0.9.3

What Decaid v0.9.3's API answered the requests that manage its plugins, what
`host.localApi` gave a plugin that made them, and Decaid's own update state
and socket, for decent-sync #660: the Software Actions the plugin carries out
(ADR-0034), and the simulated tablet's plugin management
(`server/test/support/decaid-plugins.ts`), which answers from these files.

| File | What it holds |
|---|---|
| `info.json` | `GET /api/v1/info`, which the simulated tablet answers `/info` from (`de1ProOnDecaid093` in `server/test/support/simulated-tablet.ts`) |
| `plugin-management.json` | A new Decaid: steps of installs, enabling and disabling, settings, update checks and a removal, the update socket, and a probe plugin's `host.localApi` calls (below) |
| `pending-update.json` | A Decaid started with an older Decent Sync release in its plugins folder: the update check that leaves its update waiting, and its approval |
| `protected.json` | A Decaid started with "Require authorization for extension management" on: the same requests without a token, and through `host.localApi` |
| `record.mjs` | The script that recorded the three, a phase a run |
| `probe/` | The probe plugin `record.mjs` installs: it makes the `host.localApi` calls it is asked to and answers with what each resolved to or was rejected with |

Each step is `{ exchanges, reads }`: the requests the script sent, with the
status and body Decaid answered, JSON parsed, then the reads named in the
script for that step, by route. A read whose answer is the same as that
route's read before it keeps its status and `"unchanged": true` in place of
its body. A `localApi` step holds `localApi` in place of `exchanges`: each
call the probe made, with `resolved`, what `host.localApi` resolved to (its
`body` parsed where it was JSON, marked `"bodyWasText": true`, as the plugin
is given text), or `rejected`, the error's `name` and `message`; where Decaid
unloaded the probe under its own call, it holds the calls with the status and
body Decaid answered the request to the probe's endpoint. The update socket's
steps hold the frames it sent as it opened (`opened`), the command sent
(`sent`) and the frames that followed (`frames`).

Two things are left out of every plugin list, in the reads and in the
`localApi` answers alike, as no step changes them and nothing reads them
here: each plugin's `api`, the endpoints it declares, and its `description`.
In `protected.json`, the plugin list a request was answered with is given as
how many plugins it held. Nothing else was edited.

## How they were recorded

They were recorded on 2026-11-23 (UTC) by Decaid's v0.9.3 Linux arm64 release
(`decaid-linux-arm64-0.9.3.tar.gz`, SHA-256
`6df61c82f46ae864a985b4d3deb71fa522b328c2a6abce7f61c08dcccbfcd1c6`, as
`decaid-0.9.3-SHA256SUMS.txt` names it; `GET /info` answers `0.9.3+3265`,
commit `1d74fbf7`), run headless in a throwaway Ubuntu 24.04 container as
`../simulated-devices-v0.9.2/` describes: Xvfb as its display, a D-Bus system
bus and Avahi running, its clock in UTC, with
`~/.local/share/decaid/shared_preferences.json` set to
`{"simulateDevices":["machine","scale"],"onboardingCompleted":true,"accountStepSeen":true}`
and no token: a new v0.9.3 asks none, as its "Require authorization for
extension management" setting starts off.

**A keyring.** v0.9.3 reads its GitHub credentials from the system keyring
before every request to GitHub, so with none unlocked every install and
update check fails: `{"error":"Couldn't install the plugin. Try again."}`,
500, and each update result `failed` with `Try again.`, its log naming
`GithubCredentialException` and `libsecret_error: KeyringLocked`. The
container had the `gnome-keyring` package, an unencrypted keyring made by
hand, and the daemon started inside the session Decaid runs in:

```sh
mkdir -p ~/.local/share/keyrings
printf 'login' > ~/.local/share/keyrings/default
printf '[keyring]\ndisplay-name=login\nctime=0\nmtime=0\nlock-on-idle=false\nlock-after=false\n' > ~/.local/share/keyrings/login.keyring
# start.sh, run as: xvfb-run -a dbus-run-session -- /tmp/start.sh
gnome-keyring-daemon --start --components=secrets </dev/null
exec /opt/decaid/bundle/decaid --serial --bypass-onboarding --no-account
```

Unlocking a new keyring with `gnome-keyring-daemon --unlock` instead opens a
prompt no one answers, and Decaid's request then never returns.

`record.mjs` ran on the host against the container's published port 8080,
one request after another, waiting 2 s after each step's requests before its
reads, a phase a run:
`DECAID=<address> node server/test/fixtures/decaid/tablet-software-v0.9.3/record.mjs <fresh|pending|protected> <output file>`.
Each phase waited first until Decaid listed a plugin and every Skin's source,
as a new Decaid installs the Skins it comes with in its first minute.

- **`fresh`** (`plugin-management.json`), on new data.
- **`pending`** (`pending-update.json`), after `fresh`, with Decaid stopped
  (`pkill -x decaid`) and started again the same way, its data kept, and in
  between, the plugin `fresh` had installed from `loganfuller/decent-sync`'s
  latest release, v1.12.2, replaced in
  `~/.local/share/decaid/plugins/decent-sync.reaplugin/` by the
  `manifest.json` and `plugin.js` of that repository's v0.3.0 release
  (`decent-sync.reaplugin-v0.3.0.zip`), and `releaseTag` set to `v0.3.0` in
  its `.rea_source.json`: a Tablet holding an older release, whose manifest
  lacks the `emit` permission the latest holds. Decaid installs by latest
  release only, so an older one can be put there no other way.
- **`protected`** (`protected.json`), after `pending`, with the probe enabled
  again through the API, Decaid stopped,
  `"requireExtensionManagementAuthorization": true` added to
  `shared_preferences.json`, which is where the setting on Decaid's Security
  page is kept, and Decaid started again.

The container reached GitHub, so the installs are of what those repositories
held that day: `loganfuller/decent-sync` v1.12.2, `decentespresso/dye2`'s
`dist` branch at `3a40837`, and `decentespresso/shot-upload` v0.2.5, which
the first update check installed over the bundled v0.2.4.

The simulated machine is `MockDe1`, the paths are the container's
(`/root/.local/share/decaid/…`), and `192.168.1.20` is an example in the
Decent Sync plugin's own manifest, so nothing names real hardware or a real
network and nothing is scrubbed. The passwords saved are made up. No token is
in any file: the requests that carried none are all there are.

## What they show

- **`host.localApi`.** Called with the whole path, from `/api/v1/`, it
  resolves `{ status, headers, body }`, the body as text, whatever the status
  (`reads`, `managed`: a 404 and a 400 resolve). It rejects, with an error
  whose message begins `Invalid argument(s): `, for a path not under
  `/api/v1/`, a method it does not take, a route off its list, such as `GET
  /api/v1/settings`, `GET /api/v1/update` or `GET /api/v1/machine/state`, and
  a `POST /api/v1/settings` holding any key but `defaultSkinId` and
  `automaticUpdateCheck` (`outOfReach`). A plugin without `manage.extensions`
  is rejected with a `PluginPermissionError` (`withoutPermission`).
- **With the Tablet's setting on,** a request without a token to a route that
  manages plugins answers 401 `{"error":"Missing or malformed bearer
  token"}`, and so does a `POST /settings` that turns `automaticUpdateCheck`
  on while it is off; turning it off, and the reads of the plugin list, a
  plugin's settings and Decaid's update state, need none. `host.localApi`
  is taken as before (`protected.json`).
- **A plugin unloaded under its own call.** The probe saving its own
  settings, or disabling itself, got no answer: Decaid answered the request
  to its endpoint 500 `{"error":"plugin unloaded"}`, and the settings were
  saved (`ownSettingsSaved`, `disabledItself`).
- **Settings.** `GET /plugins/{id}/settings` answers what was set, a secure
  setting only as `{"isSet": …}`, and no defaults: `{"Password":{"isSet":
  false}}` on a new Decaid (`started`). A `POST` merges into them and answers
  them (`settingsSaved`, `settingsSavedInPart`); `null` clears one
  (`settingCleared`); a name the manifest does not declare refuses the whole
  body, 400; a number sent as text is taken, 200, and put back to its
  default; a plugin Decaid does not know reads as `{}` and fails a `POST`
  with shelf's `Internal Server Error` (`settingsRefused`).
- **Sources.** A plugin Decaid bundles is listed with `"source": null` until
  its first update check, which gives each one it updates a `github_release`
  source naming its repository (`started`, `checked`). An install from a
  release records `releaseTag`; from a branch, `branch` and the `commit` at
  its head; from a commit given as the branch, that commit as both
  (`releaseInstalled`, `branchInstalled`, `commitInstalled`). A plugin newly
  installed is not loaded (`"loaded": false`), and one installed over keeps
  whether it was.
- **Update checks.** `POST /plugins/update` answers a result for each plugin
  with a source: `updated`, `alreadyCurrent`, or, for an update that adds a
  permission, `pendingApproval`, at every check while it waits, the list
  entry then holding `pendingUpdate` (`pending-update.json`: `checked`,
  `checkedAgain`). Approving it installs it and answers `Plugin updated`
  with its version; approving again, or a plugin with none waiting, 409
  (`approved`, `approvedAgain`, `unknownRefused`).
- **Removal.** `DELETE /plugins/{id}` removes a plugin (`removed`). One
  Decaid bundles is back once Decaid starts again: `dcamp.reaplugin`,
  removed in `fresh`, is listed in `pending-update.json`'s `staged`.
- **Decaid's own update.** `GET /update` answers its state, `idle` with no
  `latestVersion` on the newest release. Its socket, `/ws/v1/update`, sends
  the state as it opens, and for `{"command":"check"}` the state with
  `"phase": "checking"`, then the state again (`updateChecked`). On Linux it
  answers `{"command":"install"}` with `{"error":"In-app install is not
  supported on this platform", "url": …}` (`updateInstall`). No newer release
  existed, so no state with `"phase": "available"` was recorded: the
  simulated tablet derives one from the recorded state (`offerDecaid` in
  `decaid-plugins.ts`), and says so.
- **The Skins a new v0.9.3 comes with** are each flagged `"isBundled": true`,
  with a `reaMetadata.sourceUrl` of `github_release:<repository>@<tag>`
  (`started`). `../plugins-and-skins-v0.9.0/` holds Skins installed from a
  branch, which are not.
