# One owner per self-hosted server

Each Decent Sync server holds the data of exactly one owner (a person or one business, such as Roux with its lab and cafes), and the owner runs it themselves. We chose this over a hosted multi-tenant service because tenancy would bring accounts, per-owner isolation and per-machine credentials into the domain model, auth and storage all at once. Packaging the server so any Decent owner can self-host it keeps the project useful as open source without that cost.

Milestone 1 still requires Admin and Staff accounts and per-Machine tokens. This decision avoids multi-owner tenancy and its isolation model; it does not remove authentication within one owner's server.
