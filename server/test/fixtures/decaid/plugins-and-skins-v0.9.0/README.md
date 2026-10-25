# Plugins and Skins on Decaid v0.9.0

What Decaid v0.9.0's API answered `GET /api/v1/plugins`, `GET
/api/v1/webui/skins`, `GET /api/v1/webui/skins/default` and `GET
/api/v1/webui/server/status` with, after each of the changes below, for
decent-sync #236: the plugin list and the Skins the plugin reports as its
`plugins` and `skins` collections (`docs/COLLECTIONS.md`).

`plugins-and-skins.json` holds one step per change, in order, each
`{exchanges, reads}`: the requests the script sent, with the status and body
Decaid answered (`exchanges`), then the four reads, by route (`reads`), each
its status and body, JSON parsed. A read whose answer is the same as the
step before's read of that route keeps its status and `"unchanged": true` in
place of its body. Nothing else was edited.

| Step | What it did before the reads |
|---|---|
| `started` | Nothing: Decaid as it started, once it listed its plugins and served a Skin |
| `dye2Release` | `POST /plugins/install/github-release {"repo":"decentespresso/dye2"}`, DYE2 v0.1.26 over the bundled v0.1.4 |
| `dye2Disabled` | `POST /plugins/dye2.reaplugin/disable` |
| `dye2Enabled` | `POST /plugins/dye2.reaplugin/enable` |
| `dye2Branch` | `POST /plugins/install/github-branch {"repo":"decentespresso/dye2","branch":"dist"}`, DYE2's `dist` branch at `4362dd1`, which builds `main` at `77db0fd` |
| `streamlineRelease` | `POST /webui/skins/install/github-release {"repo":"decentespresso/streamline-js"}`, v0.2.18 |
| `streamlineMain` | `POST /webui/skins/install/github-branch {"repo":"decentespresso/streamline-js","branch":"dist"}`, its `dist` branch at `55bd37d`, which builds `main` at `cec5664` |
| `defaultSwitched` | `PUT /webui/skins/default {"skinId":"streamline.js-dist"}` |
| `servedMain` | `POST /settings {"webUiPath":"<the streamline.js-dist Skin's path>"}`, which serves that folder (`settings_handler.dart`), as Quick Settings serves a Skin |
| `servedOther` | The same, for the `passione` Skin's path |
| `serverStopped` | `POST /webui/server/stop` |

## How they were recorded

They were recorded on 2026-10-25 (UTC) by Decaid's v0.9.0 Linux arm64
release (`decaid-linux-arm64-0.9.0.tar.gz`, SHA-256
`b76e64c89792cc3d7101ba211ecb81040fe353a46d353c7b0e73374f193970df`, as
`decaid-0.9.0-SHA256SUMS.txt` names it; `GET /info` answers `0.9.0+2977`,
commit `b9f9d055`), run headless in a throwaway Ubuntu 24.04 container as
`../dye2-v0.1.26/` describes: Xvfb as its display, a D-Bus system bus and
Avahi running, started as `xvfb-run -a dbus-run-session -- decaid --serial
--bypass-onboarding --no-account`, its clock in UTC and its data new, as on
a fresh install, without simulated devices. The script, `record.mjs`, ran on
the host against the container's published port 8080, one request after
another, waiting 2 s after each step's requests before its reads:
`node server/test/fixtures/decaid/plugins-and-skins-v0.9.0/record.mjs <output file>`.
It waited before `started` until Decaid listed a plugin and served a Skin.

The paths are the container's (`/root/.local/share/decaid/web-ui/…`), and the
WebUI server's `ip` was `localhost`, so nothing is scrubbed. The plugin list
holds Decaid's bundled plugins; the plugin itself was not installed.

## What they show

- **The served Skin is found by its path.** Headless, Decaid served its
  default Skin as it started: the WebUI server's `path` was the `path` of
  the default Skin's entry in the Skins list, `streamline.js`, character for
  character (`started`). Serving another folder through `webUiPath` changed
  the status's `path` (and its `port`) and nothing in the Skins list or the
  default (`servedMain`, `servedOther`). Switching the default changed only
  the default: the WebUI server kept serving the release (`defaultSwitched`).
  Stopped, it answers `{"serving":false,"path":null,"port":null,"ip":null}`
  (`serverStopped`), so the default is the active Skin then.
- **Streamline's two ids.** The release installed as `streamline.js`, its
  `reaMetadata.sourceUrl` `github_release:decentespresso/streamline-js@v0.2.18`;
  the `dist` branch as `streamline.js-dist`, the id its `skin-manifest.json`
  declares, beside it, with `reaMetadata.commitHash` `branch:dist` and no
  commit. Both report version `0.2.18`.
- **Skins change by themselves.** Decaid bundles a Streamline (`streamline.js`
  0.2.14, from `allofmeng/streamline_project`, `reaMetadata` null at
  `started`) and other Skins, and replaces them with their latest releases in
  the background after it starts, so later steps list `streamline.js` 0.2.18
  and other Skins' `reaMetadata` filled in, with no request of the script's.
- **DYE2's entry.** Loaded, `{"loaded":true,"autoLoad":true}`; disabled, both
  `false`, its version and `source` kept (`dye2Disabled`). A release install's
  `source` is `{"kind":"github_release","releaseTag":"v0.1.26",…}`; a branch
  install's `{"kind":"github_branch","branch":"dist","commit":"4362dd1…",…}`
  (`dye2Branch`). DYE2's `main` branch holds no plugin at its root, so Decaid
  refused its branch install, 400 `Plugin package has no manifest.json`, in
  an earlier run; its `dist` branch is what a branch install takes.
- **While Decaid starts.** In an earlier run that read at once, Decaid
  answered the plugin list and the Skins list `[]`, the default Skin 404
  (`{"error":"No default skin available"}`, as `_handleGetDefaultSkin` in
  `decaid:lib/src/services/webserver/webui_handler.dart` answers with no
  Skin installed) and the status `{"serving":false,…}`, before it had loaded
  its plugins and Skins.
