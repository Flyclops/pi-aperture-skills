/**
 * Finds Aperture's MCP URL the same way pi picks the `aperture` server it
 * connects to.
 *
 * Pi has two sources: the user-level `mcp.json`, and servers other extensions
 * register with `pi.registerMcpServer()` (e.g. an Aperture model provider).
 * A valid `mcp.json` entry wins over a registered server with the same name;
 * an `mcp.json` entry pi would reject (no `url`, `command` or `type`), or a
 * missing or broken file, leaves the registered server in charge.
 *
 * Every failure comes back as a `problem`: a complete, user-facing sentence
 * that says what is wrong and how to fix it.
 */
import { readFileSync } from "node:fs";
import type { RegisteredMcpServer } from "@earendil-works/pi-coding-agent";

/** The server name this extension looks for. */
export const SERVER_NAME = "aperture";

/** Either the URL, or a user-facing explanation of why there is none. */
export type UrlLookup = { url: string } | { problem: string };

/** `mcp.json` has no entry pi would use; `reason` says why. */
type Absent = { absent: string };

const EXAMPLE = `{ "mcpServers": { "aperture": { "url": "https://<your-aperture-host>/v1/mcp" } } }`;

/**
 * Returns the URL of the `aperture` server pi would connect to: the one in
 * `mcpJsonPath` if pi would use it, otherwise the one in `registered`
 * (normally `pi.getMcpServers()`).
 */
export function findApertureUrl(
	mcpJsonPath: string,
	registered: readonly RegisteredMcpServer[],
): UrlLookup {
	const fromFile = readApertureUrl(mcpJsonPath);
	if (!("absent" in fromFile)) return fromFile;

	const server = registered.find((s) => s.name === SERVER_NAME);
	if (server) return registeredUrl(server);

	return {
		problem:
			`${fromFile.absent}, and no extension registered an "${SERVER_NAME}" server. ` +
			`Add one to ${mcpJsonPath}: ${EXAMPLE}`,
	};
}

/** Reads `mcpJsonPath` and returns the `aperture` entry's `url`, if pi would use the entry. */
export function readApertureUrl(mcpJsonPath: string): UrlLookup | Absent {
	let text: string;
	try {
		text = readFileSync(mcpJsonPath, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			return { absent: `no MCP config at ${mcpJsonPath}` };
		}
		return { absent: `could not read ${mcpJsonPath}: ${(err as Error).message}` };
	}

	let config: unknown;
	try {
		// Pi strips a BOM before parsing; do the same so we agree on the entry.
		config = JSON.parse(text.replace(/^\uFEFF/, ""));
	} catch {
		// The parser's message quotes nearby text, which may be a secret header.
		return { absent: `${mcpJsonPath} is not valid JSON` };
	}

	const servers = (config as { mcpServers?: Record<string, unknown> })?.mcpServers ?? {};
	const server = servers[SERVER_NAME] as
		| { url?: unknown; command?: unknown; type?: unknown; enabled?: unknown }
		| undefined;
	if (!server || typeof server !== "object") {
		const found = Object.keys(servers);
		const foundText = found.length ? ` (found: ${found.join(", ")})` : "";
		return { absent: `no "${SERVER_NAME}" server in ${mcpJsonPath}${foundText}` };
	}
	// Pi skips user-level entries it can't validate (SSE, no transport, a
	// non-HTTP(S) url), so a registered server stays in charge.
	if (server.type === "sse") {
		return { absent: `the "${SERVER_NAME}" entry in ${mcpJsonPath} uses unsupported SSE` };
	}
	// A stdio server is one pi would run instead of any registered server.
	if (server.command !== undefined && server.url === undefined) {
		return {
			problem:
				`the "${SERVER_NAME}" server in ${mcpJsonPath} has no "url"; ` +
				`this extension needs Aperture's HTTP MCP endpoint, e.g. ${EXAMPLE}`,
		};
	}
	if (!isHttpUrl(server.url)) {
		return { absent: `the "${SERVER_NAME}" entry in ${mcpJsonPath} has no valid http(s) "url"` };
	}
	if (server.enabled === false) {
		return { problem: `the "${SERVER_NAME}" server is disabled in ${mcpJsonPath}` };
	}
	return { url: server.url };
}

/**
 * Returns a registered server's `url`. Our MCP client sends only the URL
 * (see docs/adr/0001), so a server that needs `headers` or `auth` is refused.
 */
function registeredUrl({ config, extensionPath }: RegisteredMcpServer): UrlLookup {
	const where = `the "${SERVER_NAME}" server registered by ${extensionPath}`;
	if (config.enabled === false) return { problem: `${where} is disabled` };
	if (!("url" in config) || typeof config.url !== "string" || config.url === "") {
		return { problem: `${where} has no "url"; this extension needs Aperture's HTTP MCP endpoint` };
	}
	if (config.headers || config.auth || config.oauth) {
		return {
			problem:
				`${where} uses headers, provider auth or OAuth, which this extension can't send. ` +
				`Override it in mcp.json: ${EXAMPLE}`,
		};
	}
	return { url: config.url };
}

/** Whether `value` is an absolute http: or https: URL, as pi requires. */
function isHttpUrl(value: unknown): value is string {
	if (typeof value !== "string" || !URL.canParse(value)) return false;
	const { protocol } = new URL(value);
	return protocol === "http:" || protocol === "https:";
}
