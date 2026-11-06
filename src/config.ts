/**
 * Finds Aperture's MCP URL in pi's user-level `mcp.json`.
 *
 * The extension reuses the `aperture` entry the user already configured for
 * pi's built-in MCP support, so there is one place to set the URL. Every
 * failure comes back as a `problem`: a complete, user-facing sentence that
 * says what is wrong and how to fix it.
 */
import { readFileSync } from "node:fs";

/** The server name this extension looks for under `mcpServers`. */
export const SERVER_NAME = "aperture";

/** Either the URL, or a user-facing explanation of why there is none. */
export type UrlLookup = { url: string } | { problem: string };

const EXAMPLE = `{ "mcpServers": { "aperture": { "url": "https://<your-aperture-host>/v1/mcp" } } }`;

/** Reads `mcpJsonPath` and returns the `aperture` server's `url`. */
export function readApertureUrl(mcpJsonPath: string): UrlLookup {
	let text: string;
	try {
		text = readFileSync(mcpJsonPath, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			return { problem: `no MCP config at ${mcpJsonPath}. Create it with: ${EXAMPLE}` };
		}
		return { problem: `could not read ${mcpJsonPath}: ${(err as Error).message}` };
	}

	let config: unknown;
	try {
		config = JSON.parse(text);
	} catch (err) {
		return { problem: `could not parse ${mcpJsonPath}: ${(err as Error).message}` };
	}

	const servers = (config as { mcpServers?: Record<string, unknown> })?.mcpServers ?? {};
	const server = servers[SERVER_NAME] as { url?: unknown; enabled?: unknown } | undefined;
	if (!server || typeof server !== "object") {
		const found = Object.keys(servers);
		const foundText = found.length ? ` (found: ${found.join(", ")})` : "";
		return {
			problem: `no "${SERVER_NAME}" server in ${mcpJsonPath}${foundText}. Add one: ${EXAMPLE}`,
		};
	}
	if (server.enabled === false) {
		return { problem: `the "${SERVER_NAME}" server is disabled in ${mcpJsonPath}` };
	}
	if (typeof server.url !== "string" || server.url === "") {
		return {
			problem:
				`the "${SERVER_NAME}" server in ${mcpJsonPath} has no "url"; ` +
				`this extension needs Aperture's HTTP MCP endpoint, e.g. ${EXAMPLE}`,
		};
	}
	return { url: server.url };
}
