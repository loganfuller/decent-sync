---
status: accepted
---

# The server is its own OAuth authorization server for Connected Apps

Assistants on phones, such as Claude and ChatGPT, connect to an MCP endpoint (ADR-0026) only through OAuth: neither can send a key a person pastes in. So each server is its own OAuth 2.1 authorization server. A person connecting an app is sent to their server, signs in as they do to the management interface, and approves the app on a consent page there, choosing whether it may only read or may also change things. Each approval makes one Connected App, which acts as that account until the person or an Admin disconnects it, or the account is deactivated. Its codes and tokens are random secrets stored hashed in PostgreSQL, as sessions are, so any instance accepts what another issued (ADR-0016). OAuth is the only way in, for desktop clients such as Claude Code too: there is no key to paste into a config file.

Apps register only by Client ID Metadata Document: an app's id is a URL where it publishes its name and redirects, which the server fetches. Claude, ChatGPT and VS Code use them. Lifetimes follow sessions: an access token lasts an hour, a refresh token is replaced each time it is used, and a Connected App lapses after 30 days without use.

## Considered Options

- **An external identity provider,** such as Auth0 or Keycloak. Every self-hoster would run or pay for a second service, against ADR-0016's promise that the server needs only PostgreSQL. Rejected.
- **Keys an account creates and pastes into its app's settings.** Simple, and enough for Claude Code, Cursor and VS Code, but claude.ai and ChatGPT can't send one, and each would be a long-lived secret in a file. Rejected.
- **`@nestjs/authentication`.** It has no authorization server, and brings a global guard, sessions and sign-in of its own beside the server's. Rejected.
- **Dynamic Client Registration as well.** The MCP spec deprecates it from revision 2026-07-28, and it would let anyone have the server store a client. Left out until a client the owner uses needs it: Cursor documents nothing else.
- **An approval replacing the same app's earlier one for the account.** It would save a stale Connected App when a read-only one is approved again to change things, but Claude Code on two laptops is the same app for the same account, so connecting the second would disconnect the first. Rejected: each approval makes a Connected App, and an unused one lapses.

## Consequences

- **Phones need a public server.** claude.ai and ChatGPT reach the endpoint from their own clouds, so it must be reachable from the internet over HTTPS at the server's public URL. A server reachable only on a local network serves only clients on that network.
- **The consent page names the host an app's id is published at** above the name the app gives itself, which any page could make "Claude".
- **Changes name their Connected App.** A change made through one is recorded as its account's and names the app, in an item's history and on Settings Edits.
- **On by default.** A server setting turns the endpoint and its authorization server off as a whole. Admins see and disconnect every account's Connected Apps.
