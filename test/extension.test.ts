import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { tempDir } from "./temp.ts";
import { clean, registerApertureSkills } from "../src/extension.ts";
import { skill, startFakeAperture } from "./fake-aperture.ts";

type Handler = (event: any, ctx: any) => unknown;

/** A stand-in for pi: records handlers and notifications. */
function fakePi() {
	const handlers = new Map<string, Handler>();
	const notices: { message: string; level: string }[] = [];
	const ctx = {
		hasUI: true,
		ui: { notify: (message: string, level: string) => notices.push({ message, level }) },
	};
	return {
		api: { on: (event: string, h: Handler) => handlers.set(event, h) } as any,
		notices,
		emit: (event: string, payload: object = {}) => handlers.get(event)!({ type: event, ...payload }, ctx),
	};
}

function setup(mcpJson: object | undefined) {
	const dir = tempDir("aperture-ext");
	const mcpJsonPath = join(dir, "mcp.json");
	if (mcpJson) writeFileSync(mcpJsonPath, JSON.stringify(mcpJson));
	const cacheRoot = join(dir, "cache");
	return { mcpJsonPath, cacheRoot };
}

test("loads skills, reports the count, and cleans up on shutdown", async (t) => {
	const fake = await startFakeAperture({ skills: [skill("personal", "a"), skill("personal", "b")] });
	t.after(() => fake.close());
	const paths = setup({ mcpServers: { aperture: { url: fake.url } } });
	const pi = fakePi();
	registerApertureSkills(pi.api, paths);

	const result = (await pi.emit("resources_discover", { reason: "startup" })) as { skillPaths: string[] };

	assert.equal(result.skillPaths.length, 1);
	assert.ok(existsSync(join(result.skillPaths[0]!, "a", "SKILL.md")));
	assert.deepEqual(pi.notices, [{ message: "Aperture: loaded 2 skills", level: "info" }]);

	await pi.emit("session_shutdown", { reason: "quit" });
	assert.deepEqual(readdirSync(paths.cacheRoot), []);
});

test("rebuilds the cache from scratch on each discovery", async (t) => {
	const fake = await startFakeAperture({ skills: [skill("personal", "a")] });
	t.after(() => fake.close());
	const paths = setup({ mcpServers: { aperture: { url: fake.url } } });
	const pi = fakePi();
	registerApertureSkills(pi.api, paths);

	await pi.emit("resources_discover", { reason: "startup" });
	await pi.emit("resources_discover", { reason: "reload" });

	assert.equal(readdirSync(paths.cacheRoot).length, 1, "the previous cache dir is gone");
});

test("explains a missing aperture entry and loads nothing", async () => {
	const paths = setup({ mcpServers: {} });
	const pi = fakePi();
	registerApertureSkills(pi.api, paths);

	const result = await pi.emit("resources_discover", { reason: "startup" });

	assert.equal(result, undefined);
	assert.equal(pi.notices.length, 1);
	assert.equal(pi.notices[0]!.level, "warning");
	assert.match(pi.notices[0]!.message, /^Aperture skills not loaded: no "aperture" server in /);
	assert.ok(!existsSync(paths.cacheRoot), "no cache dir without a URL");
});

test("warns and carries on when Aperture is too slow", async (t) => {
	const fake = await startFakeAperture({ skills: [skill("personal", "a")], delayMs: 500 });
	t.after(() => fake.close());
	const paths = setup({ mcpServers: { aperture: { url: fake.url } } });
	const pi = fakePi();
	registerApertureSkills(pi.api, { ...paths, timeoutMs: 50 });

	const result = await pi.emit("resources_discover", { reason: "startup" });

	assert.equal(result, undefined);
	assert.match(pi.notices[0]!.message, /didn't answer within 0\.05s/);
	assert.deepEqual(readdirSync(paths.cacheRoot), [], "the empty cache dir is removed");
});

test("lists skipped skills in the single notice", async (t) => {
	const fake = await startFakeAperture({
		skills: [skill("personal", "ok"), skill("personal", "bad")],
		failReads: ["skill://personal/bad/SKILL.md"],
	});
	t.after(() => fake.close());
	const paths = setup({ mcpServers: { aperture: { url: fake.url } } });
	const pi = fakePi();
	registerApertureSkills(pi.api, paths);

	await pi.emit("resources_discover", { reason: "startup" });

	assert.equal(pi.notices.length, 1);
	assert.equal(pi.notices[0]!.level, "warning");
	assert.match(pi.notices[0]!.message, /^Aperture: loaded 1 skill; skipped bad \(resources\/read: Resource not found/);
});

test("strips terminal control characters from server text", () => {
	assert.equal(clean("evil\u001b]52;c;payload\u0007name"), "evil]52;c;payloadname");
	assert.equal(clean("x".repeat(300)).length, 200);
});

test("reports an unusable cache root instead of throwing", async (t) => {
	const fake = await startFakeAperture({ skills: [skill("personal", "a")] });
	t.after(() => fake.close());
	const paths = setup({ mcpServers: { aperture: { url: fake.url } } });
	mkdirSync(paths.cacheRoot, { mode: 0o777 });
	chmodSync(paths.cacheRoot, 0o777);
	const pi = fakePi();
	registerApertureSkills(pi.api, paths);

	const result = await pi.emit("resources_discover", { reason: "startup" });

	assert.equal(result, undefined);
	assert.match(pi.notices[0]!.message, /mode 0700.*Continuing without them/);
});
