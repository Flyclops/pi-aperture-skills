# Fetch skills with our own MCP client, not pi's MCP connection

The extension opens its own Streamable HTTP session to Aperture (plain `fetch`,
about 60 lines in `src/mcp-client.ts`) even though pi already connects to the
same server. Pi offers extensions no way to use its connection from
`resources_discover`: `ctx.executeTool()` exists only inside a tool's
`execute()`, `pi.getMcpServers()` returns configuration rather than a client,
and pi connects MCP servers in the background around the time
`resources_discover` runs. Reaching into pi internals would break on upgrades.
We do read the URL from the `aperture` entry in pi's `mcp.json`, so there is
still one place to configure it.

## Consequences

- Only `url` is honoured. `headers`, `oauth` and `env` from `mcp.json` are
  ignored; Aperture over the tailnet needs none of them.
- Pi's own Aperture tools and this extension use separate sessions.
