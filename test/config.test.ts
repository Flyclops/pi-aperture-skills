import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { RegisteredMcpServer } from "@earendil-works/pi-coding-agent";
import { tempDir } from "./temp.ts";
import { findApertureUrl } from "../src/config.ts";

/** Writes `content` to a fresh mcp.json and returns its path. */
function mcpJson(content: string): string {
	const path = join(tempDir("aperture-config"), "mcp.json");
	writeFileSync(path, content);
	return path;
}

/** An `aperture` server as another extension would register it. */
function registered(config: object, name = "aperture"): RegisteredMcpServer {
	return { name, config: config as RegisteredMcpServer["config"], extensionPath: "/ext/provider.ts" };
}

const missing = join(tmpdir(), "does-not-exist", "mcp.json");
const providerServer = registered({ url: "https://registered.example/v1/mcp" });

function problemOf(result: ReturnType<typeof findApertureUrl>): string {
	assert.ok("problem" in result, `expected a problem, got ${JSON.stringify(result)}`);
	return result.problem;
}

// --- mcp.json only ---

test("returns the aperture server's url", () => {
	const path = mcpJson(
		JSON.stringify({ mcpServers: { aperture: { url: "https://a.example/v1/mcp" } } }),
	);
	assert.deepEqual(findApertureUrl(path, []), { url: "https://a.example/v1/mcp" });
});

test("explains a missing mcp.json and shows the entry to add", () => {
	const problem = problemOf(findApertureUrl(missing, []));
	assert.match(problem, /no MCP config at .*does-not-exist\/mcp\.json/);
	assert.match(problem, /no extension registered an "aperture" server/);
	assert.match(problem, /"aperture": \{ "url": "https:\/\/<your-aperture-host>\/v1\/mcp" \}/);
});

test("explains unparseable JSON without quoting the file", () => {
	const problem = problemOf(findApertureUrl(mcpJson('{ "Bearer secret" nope'), []));
	assert.match(problem, /mcp\.json is not valid JSON/);
	assert.doesNotMatch(problem, /secret/);
});

test("reads mcp.json with a byte-order mark, as pi does", () => {
	const path = mcpJson(`\uFEFF${JSON.stringify({ mcpServers: { aperture: { url: "https://a/v1/mcp" } } })}`);
	assert.deepEqual(findApertureUrl(path, [providerServer]), { url: "https://a/v1/mcp" });
});

test("explains a missing aperture server and lists the servers found", () => {
	const path = mcpJson(JSON.stringify({ mcpServers: { github: { url: "https://g" } } }));
	const problem = problemOf(findApertureUrl(path, []));
	assert.match(problem, /no "aperture" server/);
	assert.match(problem, /found: github/);
	assert.match(problem, /"aperture": \{ "url":/);
});

test("explains an aperture stdio server", () => {
	for (const entry of [
		{ command: "aperture-mcp" },
		{ type: "stdio", command: "aperture-mcp", url: "https://ignored/v1/mcp" },
	]) {
		const path = mcpJson(JSON.stringify({ mcpServers: { aperture: entry } }));
		assert.match(problemOf(findApertureUrl(path, [providerServer])), /"aperture" server .* has no "url"/);
	}
});

test("reports a disabled aperture server", () => {
	const path = mcpJson(
		JSON.stringify({ mcpServers: { aperture: { url: "https://a", enabled: false } } }),
	);
	assert.match(problemOf(findApertureUrl(path, [])), /disabled/);
});

// --- registered by another extension ---

test("falls back to a registered server when mcp.json is missing", () => {
	assert.deepEqual(findApertureUrl(missing, [providerServer]), {
		url: "https://registered.example/v1/mcp",
	});
});

test("falls back to a registered server when mcp.json has no aperture entry", () => {
	const path = mcpJson(JSON.stringify({ mcpServers: { github: { url: "https://g" } } }));
	assert.deepEqual(findApertureUrl(path, [providerServer]), {
		url: "https://registered.example/v1/mcp",
	});
});

test("falls back to a registered server when mcp.json is unparseable", () => {
	assert.deepEqual(findApertureUrl(mcpJson("{ nope"), [providerServer]), {
		url: "https://registered.example/v1/mcp",
	});
});

test("falls back to a registered server past a url-less mcp.json entry", () => {
	const path = mcpJson(JSON.stringify({ mcpServers: { aperture: { enabled: false } } }));
	assert.deepEqual(findApertureUrl(path, [providerServer]), {
		url: "https://registered.example/v1/mcp",
	});
});

test("falls back to a registered server past mcp.json entries pi would reject", () => {
	for (const entry of [
		{ url: "file:///etc/passwd" },
		{ url: "data:text/plain,hi" },
		{ url: "not a url" },
		{ type: "http" },
		{ type: "sse", url: "https://a/sse" },
		{ type: "remote", url: "https://stale.example/mcp" },
		{ url: "https://stale.example/mcp", enabled: "no" },
		{ type: "stdio", url: "https://stale.example/mcp" },
	]) {
		const path = mcpJson(JSON.stringify({ mcpServers: { aperture: entry } }));
		assert.deepEqual(findApertureUrl(path, [providerServer]), {
			url: "https://registered.example/v1/mcp",
		}, JSON.stringify(entry));
	}
});

test("never returns a non-http(s) url from mcp.json", () => {
	const path = mcpJson(JSON.stringify({ mcpServers: { aperture: { url: "file:///etc/passwd" } } }));
	assert.match(problemOf(findApertureUrl(path, [])), /no valid http\(s\) "url"/);
});

test("accepts every transport type pi accepts in mcp.json", () => {
	for (const type of ["http", "streamable-http"]) {
		const path = mcpJson(JSON.stringify({ mcpServers: { aperture: { type, url: "https://f/v1/mcp" } } }));
		assert.deepEqual(findApertureUrl(path, [providerServer]), { url: "https://f/v1/mcp" }, type);
	}
});

test("accepts a registered server with empty headers", () => {
	assert.deepEqual(findApertureUrl(missing, [registered({ url: "https://a/v1/mcp", headers: {} })]), {
		url: "https://a/v1/mcp",
	});
});

test("ignores registered servers with other names", () => {
	const problem = problemOf(findApertureUrl(missing, [registered({ url: "https://x" }, "github")]));
	assert.match(problem, /no extension registered an "aperture" server/);
});

test("reports a disabled registered server", () => {
	const problem = problemOf(findApertureUrl(missing, [registered({ url: "https://a", enabled: false })]));
	assert.match(problem, /registered by \/ext\/provider\.ts is disabled/);
});

test("reports a registered stdio server", () => {
	const problem = problemOf(findApertureUrl(missing, [registered({ command: "aperture-mcp" })]));
	assert.match(problem, /registered by \/ext\/provider\.ts has no "url"/);
});

test("refuses a registered server that needs headers, provider auth or OAuth", () => {
	for (const extra of [
		{ headers: { Authorization: "x" } },
		{ auth: { provider: "aperture" } },
		{ oauth: { clientId: "c" } },
	]) {
		const problem = problemOf(findApertureUrl(missing, [registered({ url: "https://a", ...extra })]));
		assert.match(problem, /headers, provider auth or OAuth/);
	}
});

// --- both ---

test("mcp.json wins over a registered server", () => {
	const path = mcpJson(
		JSON.stringify({ mcpServers: { aperture: { url: "https://file.example/v1/mcp" } } }),
	);
	assert.deepEqual(findApertureUrl(path, [providerServer]), { url: "https://file.example/v1/mcp" });
});

test("a disabled mcp.json entry still wins over a registered server", () => {
	const path = mcpJson(
		JSON.stringify({ mcpServers: { aperture: { url: "https://a", enabled: false } } }),
	);
	assert.match(problemOf(findApertureUrl(path, [providerServer])), /disabled in .*mcp\.json/);
});
