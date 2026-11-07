---
status: accepted
---

# Assistants reach the server through an MCP endpoint that every instance serves

People use AI assistants, such as Claude or ChatGPT on a phone, to read their server's data and change it, through a Model Context Protocol endpoint at `/api/mcp`. Each server instance serves it from its own Nest application with `@nestjs/mcp`, over Streamable HTTP and statelessly: no MCP session is kept between requests, so any instance answers any request, as ADR-0016 requires. Its tools call the server's services in process, not the REST API over the network. Every call acts as one account, with that account's role and Scope read again on each call, as a session's are, so the endpoint has no permission model of its own: an account reads and changes through an assistant what it could in the management interface, and no more. Writes are included, not only reads, except what grants access or destroys history, which stays in the management interface: accounts, invites and password resets, creating Machines and their Tokens, Pending Machines, hard deletes, Connected Apps and first-run setup. Text an assistant reads, such as a Bean's notes typed on a tablet, may try to steer it, so it never grants access or deletes anything for good. Assistants connect as Connected Apps (ADR-0027).

## Considered Options

- **A stdio server on the person's computer.** It would hold the database's credentials and bypass accounts, can't reach a database on a host's private network, and no phone app runs one. Rejected.
- **A separate MCP service calling the REST API.** A second process for every self-hoster to deploy, and a second hop for every call. Rejected.
- **`@rekog/mcp-nest`, or the MCP SDK on its own.** `@nestjs/mcp` is Nest's own module and runs Nest's guards, interceptors and filters around each call, so the drain interceptor and the database filter apply as they do to REST routes. It is new (0.0.x), so it is pinned to an exact version. Tools are thin methods over the services, so replacing it would touch only their decorators.
- **Confirming each write on the server,** with a preview that a second call applies. It would guard against an app set to approve every call, but doubles the calls, and the previews waiting for their second call would be kept in PostgreSQL. Rejected: the app asks the person before a tool that changes something, and each tool is marked as reading, changing, or destructive (archiving, Settings Edits) for it to judge.

## Consequences

- **ADR-0009 is amended.** Beside the plugin's WebSocket and the REST API, the server has a second public interface: the MCP endpoint.
- **Tool schemas use Zod**, as the module needs a schema that produces JSON Schema. REST bodies are still checked by hand.
- **Every change keeps the endpoint whole.** What a change adds or changes for people to read or do, in the management interface or the REST API, it makes available through the endpoint too, in the same change, unless it grants access or destroys history.
- **Tools follow ADR-0025 as REST routes do.** A tool or input is added freely, and changed or removed only in a later release. A call that reaches an instance of the previous release during a deploy may fail once.
