# Load only skills Aperture publishes through `skills/list`

The extension's only source is Aperture's standard MCP skills listing
(`skills/list`, SEP-2640), with no special handling for any upstream MCP server.
Two routes were rejected:

- **Built-in skills** (e.g. `skill-creator`) are not served over MCP. Aperture's
  web UI can list and export them
  (`aperture.chat.v1.ChatService/ListBuiltinSkills`,
  `/chat-api/skills/<id>/export`), but those APIs are internal and undocumented,
  so we chose not to depend on them. This can be revisited.
- **Search-only upstream skills**, such as AWS's `search_documentation` /
  `retrieve_skill`, can't be enumerated (each search returns at most 20 results
  and there is no manifest), so mirroring them would mean per-server code and
  guesswork.

Anything an upstream server later publishes through Aperture's `skills/list`
appears in pi with no code changes.
