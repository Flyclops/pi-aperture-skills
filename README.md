# pi-aperture-skills

A [pi](https://pi.dev) extension that makes the skills Aperture publishes over
MCP available as ordinary `/skill:<name>` commands.

On every startup and `/reload` it:

1. reads Aperture's URL from the `aperture` server in `~/.pi/agent/mcp.json`;
2. calls `skills/list` and downloads every file with `resources/read`;
3. writes them to a throwaway directory under
   `$TMPDIR/pi-aperture-skills-<uid>/`;
4. points pi at that directory, then deletes it when the session ends.

You get one notice per startup, e.g. `Aperture: loaded 5 skills`.

## Setup

`~/.pi/agent/mcp.json` needs an `aperture` server with a `url`:

```json
{
  "mcpServers": { "aperture": { "url": "https://<your-aperture-host>/v1/mcp" } }
}
```

Install the package:

```bash
pi install /path/to/pi-aperture-skills
```

## Behaviour

- **Priority:** local skills win over Aperture skills of the same name; among
  Aperture skills, personal beats org. Pi warns about every collision.
- **Failures:** if Aperture doesn't answer within 5 seconds, or the URL is
  missing, pi starts without Aperture skills and the notice says why. A skill
  with an unreadable or unsafe file is skipped and named in the notice.
- **Not included:** Aperture's built-in skills and search-only upstream skills.
  See [docs/adr/0002](docs/adr/0002-published-skills-only.md).

## Trust

Loaded skills are instructions your agent follows with your tools, and their
names and descriptions enter every session's system prompt. Anyone who can
publish a skill to your Aperture can therefore steer your agent. The extension
keeps a hostile server from writing outside its cache, but it can't make a
skill's content safe.

## Development

```bash
npm install
npm test          # node:test against a fake Aperture
npm run typecheck
```
