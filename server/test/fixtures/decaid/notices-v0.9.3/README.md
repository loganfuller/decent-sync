# A plugin's notices on Decaid v0.9.3

What Decaid v0.9.3 did with the notices a plugin put up and withdrew through
`host.notify` and `host.dismissNotification`, which the `notifications`
permission gives it, for decent-sync #540: the plugin's one notice on the
tablet saying why it stopped syncing (`plugin/src/tablet-notice.ts`), and
the simulated tablet's notification center
(`server/test/support/decaid-notices.ts`), which
`server/test/decaid-notices.test.ts` replays these files against.

| File | What it holds |
|---|---|
| `notices.json` | A new Decaid: the probe installed and enabled, then notices put up, put up again unchanged, changed, refused for their id or message, refused past the plugin's five, withdrawn one and all, kept across a reload, removed by a disable, and put up again |
| `restarted.json` | The same Decaid stopped and started again, its data kept: the notice the last step of `notices.json` put up, put up again unchanged, then withdrawn |
| `record.mjs` | The script that recorded the two, a phase a run |
| `probe/` | The probe plugin `record.mjs` installs: it makes the `host.notify` and `host.dismissNotification` calls it is asked to, waits 1.5 s, and answers with what each returned or threw and the events it was sent meanwhile |

A step of the probe's calls holds `calls`, what the probe was asked to do;
`answer`, the status and body of the probe's answer: `calls`, what each
returned (`returned`, or `returnedNothing` for `host.dismissNotification`,
which returns nothing), `events`, the events delivered to the probe in that
time, and `loads`, how many times that load of the probe's code had been
loaded; and `center`, what Decaid's notification center held 0.5 s after the
answer. A step of requests to Decaid's API holds `exchanges`, each request
with the status and body Decaid answered, and `center`, read 2 s after the
last. `center` is the entry Decaid keeps in its `shared_preferences.json`,
its `key` and its `value` parsed, or `{"key": null}` before Decaid saved one.
Nothing in the files was edited.

## How they were recorded

They were recorded on 2026-11-23 (UTC) by Decaid's v0.9.3 Linux arm64 release
(`decaid-linux-arm64-0.9.3.tar.gz`, SHA-256
`6df61c82f46ae864a985b4d3deb71fa522b328c2a6abce7f61c08dcccbfcd1c6`, as
`decaid-0.9.3-SHA256SUMS.txt` names it; `GET /info` answers `0.9.3+3265`,
commit `1d74fbf7`), run headless in a throwaway container as
`../tablet-software-v0.9.3/` describes, but with no keyring, as nothing was
installed from GitHub: Xvfb as its display, a D-Bus system bus and Avahi
running, its clock in UTC, with
`~/.local/share/decaid/shared_preferences.json` set to
`{"simulateDevices":["machine","scale"],"onboardingCompleted":true,"accountStepSeen":true}`
and no token, as a new v0.9.3's "Require authorization for extension
management" setting starts off.

`record.mjs` ran on the host against the container's published port 8080,
one request after another, with `CENTER` set to a `docker exec` of `cat
/root/.local/share/decaid/shared_preferences.json` in the container:
`DECAID=<address> CENTER="<command>" node server/test/fixtures/decaid/notices-v0.9.3/record.mjs <fresh|restarted> <output file>`.

- **`fresh`** (`notices.json`), on new data.
- **`restarted`** (`restarted.json`), after `fresh`, with Decaid stopped
  (`pkill -x decaid`) and started again the same way, its data kept.

The probe's name and messages are made up, and nothing names real hardware,
a real network or an account, so nothing is scrubbed.

## What they show

- **Results.** `host.notify` returns a request id at once (`notice_1`,
  counting on within one start of Decaid, from `notice_1` after a restart).
  A `notificationResult` event follows, `{ requestId, id, status:
  "accepted" }`, or `{ requestId, id, status: "rejected", reason }`, with
  `id` left out where the id was not valid (`lengths`).
- **What is refused.** A message of 601 characters, one holding a control
  character such as U+0007, a blank one, an id of 129 characters and a
  notice with no id are each refused as `validation`; a message of 600, and
  one holding a line feed and a tab, are taken (`lengths`). A plugin's sixth
  notice of a new id is refused as `capacity`, while replacing one of its
  five is taken (`capacity`).
- **Replacing.** A notice with the id of one the plugin holds replaces it in
  place. The same message keeps its revision and read state
  (`publishedAgain`); another gets the next revision, counted across the
  whole center (`changed`, `capacity`).
- **Withdrawing.** `host.dismissNotification(id)` removes that notice, an id
  the plugin does not hold changing nothing, and with no id every notice of
  the plugin (`dismissedOne`, `dismissedAll`). No event follows either.
- **Reloads, disables, restarts.** Saving the plugin's settings reloaded it
  and kept its notice, which the new load's same message kept as it was
  (`reloaded`, `publishedAfterReload`). Disabling the plugin removed its
  notices, and enabling it brought none back (`disabled`, `enabled`).
  Restarting Decaid kept the notice, and the new start's same message kept
  its revision (`restarted.json`).
- Nothing reads notices over REST: Decaid keeps the center in its
  preferences as `flutter.private.notificationCenter.v1`, `read` false here
  as nobody opened the bell.
