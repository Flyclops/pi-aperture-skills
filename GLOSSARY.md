# Aperture Skills

A pi extension that makes skills hosted in or reachable through Aperture usable
in pi as ordinary `/skill:<name>` skills.

## Language

**Aperture**:
The gateway that hosts a skills library and fronts upstream MCP servers.
_Avoid_: llm-proxy, the server

**Skill source**:
The place within Aperture a skill comes from: personal, org library, built-in,
or an upstream MCP server.
_Avoid_: origin, provider

**Personal skill**:
A skill in the user's own Aperture library.

**Org library skill**:
A skill the user added from their organization's Aperture library.
_Avoid_: org skill, library skill (ambiguous with "skills library")

**Built-in skill**:
A read-only skill that ships with Aperture itself.
_Avoid_: Aperture skill (ambiguous: every skill here comes through Aperture)

**Upstream MCP server**:
An MCP server that Aperture fronts, such as AWS or New Relic.
_Avoid_: connector, integration

**Published skill**:
A skill Aperture advertises through the standard MCP skills listing, whatever
its skill source.
_Avoid_: MCP skill (ambiguous with skills an upstream server only lets you
search)

**Skill cache**:
The per-process, throwaway local copy of fetched skills that pi is pointed at.
_Avoid_: mirror, sync folder

**Collision**:
Two skills, from any sources including local ones, that share a name; the
local skill wins.
_Avoid_: duplicate, conflict
