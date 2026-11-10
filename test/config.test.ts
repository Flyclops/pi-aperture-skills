import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { tempDir } from "./temp.ts";
import { readApertureUrl } from "../src/config.ts";

/** Writes `content` to a fresh mcp.json and returns its path. */
function mcpJson(content: string): string {
	const path = join(tempDir("aperture-config"), "mcp.json");
	writeFileSync(path, content);
	return path;
}

test("returns the aperture server's url", () => {
	const path = mcpJson(
		JSON.stringify({ mcpServers: { aperture: { url: "https://a.example/v1/mcp" } } }),
	);
	assert.deepEqual(readApertureUrl(path), { url: "https://a.example/v1/mcp" });
});

test("explains a missing mcp.json and shows the entry to add", () => {
	const path = join(tmpdir(), "does-not-exist", "mcp.json");
	const result = readApertureUrl(path);
	assert.ok("problem" in result);
	assert.match(result.problem, /no MCP config at .*does-not-exist\/mcp\.json/);
	assert.match(result.problem, /"aperture": \{ "url": "https:\/\/<your-aperture-host>\/v1\/mcp" \}/);
});

test("explains unparseable JSON", () => {
	const result = readApertureUrl(mcpJson("{ nope"));
	assert.ok("problem" in result);
	assert.match(result.problem, /could not parse .*mcp\.json/);
});

test("explains a missing aperture server and lists the servers found", () => {
	const path = mcpJson(JSON.stringify({ mcpServers: { github: { url: "https://g" } } }));
	const result = readApertureUrl(path);
	assert.ok("problem" in result);
	assert.match(result.problem, /no "aperture" server/);
	assert.match(result.problem, /found: github/);
	assert.match(result.problem, /"aperture": \{ "url":/);
});

test("explains an aperture server without a url", () => {
	const path = mcpJson(JSON.stringify({ mcpServers: { aperture: { command: "aperture-mcp" } } }));
	const result = readApertureUrl(path);
	assert.ok("problem" in result);
	assert.match(result.problem, /"aperture" server .* has no "url"/);
});

test("reports a disabled aperture server", () => {
	const path = mcpJson(
		JSON.stringify({ mcpServers: { aperture: { url: "https://a", enabled: false } } }),
	);
	const result = readApertureUrl(path);
	assert.ok("problem" in result);
	assert.match(result.problem, /disabled/);
});
