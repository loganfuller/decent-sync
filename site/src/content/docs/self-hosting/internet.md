---
title: On the internet
description: "Putting the server on the internet: HTTPS, a reverse proxy, and limits on sign-ins and connections."
---

## Limit sign-ins and connections

Anyone who can reach the server can try to sign in or open a sync connection.
Each server instance protects itself:

- It checks at most 2 passwords at once, with 16 more waiting, and refuses
  further sign-ins with 429.
- It holds at most 64 sync connections that haven't yet had a `hello`
  accepted, and refuses more with 503.

That keeps the instance running, but a flood can still keep real people and
tablets out. In front of a server on the internet, also set these limits at
the reverse proxy:

- **Sign-in rate.** Limit `POST /api/session`, per client address if the proxy
  sees it. People sign in rarely, so a few a minute is plenty.
- **Sync connections.** Limit concurrent connections to `/sync` to well above
  your number of tablets.

fly.io's proxy can't limit one route's request rate, but it can cap the
connections it sends each VM: see `[http_service.concurrency]` in the
[fly.io example](../../self-hosting/fly-io/#3-write-flytoml).

## Behind a reverse proxy

Behind a reverse proxy, every connection comes from the proxy, so Machines
show the proxy's address instead of their tablet's. To fix this, set
`CLIENT_ADDRESS_HEADER` to the header the proxy puts the client's address in,
usually `X-Forwarded-For`. Caddy sets it, and nginx does with
`proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`.

The server uses the header's last comma-separated entry, the one the nearest
proxy added, if it is an IP address. Otherwise it uses the connection's own
address.

:::caution
Any client can send that header. Set `CLIENT_ADDRESS_HEADER` only when every
request reaches the server through a proxy that sets or overwrites it.
:::

## Assistants

People connect AI assistants through the MCP endpoint at `/api/mcp` (see
[Assistants](../../guide/assistants/)). The server approves them
itself, through its own authorization server, and each approval makes a
Connected App
([ADR-0026](https://github.com/loganfuller/decent-sync/blob/main/docs/adr/0026-assistants-reach-the-server-through-mcp.md),
[ADR-0027](https://github.com/loganfuller/decent-sync/blob/main/docs/adr/0027-the-server-authorizes-connected-apps-itself.md)).

### What the server needs

- **HTTPS.** Assistant apps connect only over HTTPS, so `PUBLIC_URL` must
  start with `https://`. The one exception is an app on the server's own
  computer, reaching it at `localhost`.
- **Reachable from where the app runs.** Claude and ChatGPT, on the web and on
  phones, connect from their own clouds. For them, the server must be
  reachable from the internet at `PUBLIC_URL`. A server reachable only on a
  local network serves only apps on that network.
- **The discovery paths.** A reverse proxy that passes only some paths to the
  server must pass `/.well-known/oauth-authorization-server` and
  `/.well-known/oauth-protected-resource/api/mcp` as well as `/api`.

Apps that can register only by Dynamic Client Registration, such as Cursor,
can't connect.

### Connected Apps

- A Connected App acts as the account that approved it, within what that
  account may do.
- An app unused for 30 days stops working until it connects again.
- Apps usually ask the person before making a change, unless they are set to
  allow it without asking.
- Each Library change and each Settings Edit made through an app is recorded
  as the person's, through the app. It shows as "*account*, through *app*" in
  the item's history, and in the Machine's Settings Edits.
- An app reads what each Machine's tablet runs, its Tablet Software, and the
  Software Actions made on it, but makes none: installing, removing,
  approving or configuring anything on a tablet is done by an Admin in the
  management interface, as it can put code on the tablet. Nor can an app turn
  a tablet's automatic update checks on or off
  ([ADR-0034](https://github.com/loganfuller/decent-sync/blob/main/docs/adr/0034-the-plugin-manages-its-tablets-software-one-action-at-a-time.md)).
  An app approved by an Admin reads the values of plugins' settings; one
  approved by Staff or a Viewer reads which are set, not their values.
- Each person sees their own apps on the **Connected Apps** page, in the
  account menu under their name. Disconnecting one there stops it at once.
- Admins see and disconnect everyone's apps on the **Accounts** page.
  Deactivating an account disconnects all of its Connected Apps, and they stay
  disconnected if the account is reactivated.

### Turning assistants off

Set `MCP_ENABLED=false`. The endpoint, the authorization server and their
metadata then answer 404, and no Connected App's token is accepted. The
Connected Apps pages still list existing apps and can disconnect them.
