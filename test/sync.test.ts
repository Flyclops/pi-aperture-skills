import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { tempDir } from "./temp.ts";
import { MAX_BODY_BYTES } from "../src/mcp-client.ts";
import { syncSkills } from "../src/sync.ts";
import { type FakeSkill, skill, startFakeAperture } from "./fake-aperture.ts";

function freshDir(): string {
	return tempDir("aperture-sync");
}

test("mirrors every published file under the cache dir", async (t) => {
	const fake = await startFakeAperture({
		skills: [skill("personal", "pr-ready", { "agents/openai.yaml": "interface: {}\n" })],
	});
	t.after(() => fake.close());
	const cacheDir = freshDir();

	const result = await syncSkills({ url: fake.url, cacheDir });

	assert.deepEqual(result.loaded, ["pr-ready"]);
	assert.deepEqual(result.skipped, []);
	assert.match(readFileSync(join(cacheDir, "personal/pr-ready/SKILL.md"), "utf8"), /name: pr-ready/);
	assert.equal(
		readFileSync(join(cacheDir, "personal/pr-ready/agents/openai.yaml"), "utf8"),
		"interface: {}\n",
	);
	assert.ok(fake.closed, "session should be closed with DELETE");
});

test("orders skill paths personal, org, then the rest alphabetically", async (t) => {
	const fake = await startFakeAperture({
		skills: [
			skill("zeta", "z"),
			skill("org/acme", "o"),
			skill("alpha", "a"),
			skill("personal", "p"),
		],
	});
	t.after(() => fake.close());
	const cacheDir = freshDir();

	const result = await syncSkills({ url: fake.url, cacheDir });

	assert.deepEqual(
		result.skillPaths,
		["personal", "org", "alpha", "zeta"].map((g) => join(cacheDir, g)),
	);
});

test("follows skills/list pagination", async (t) => {
	const fake = await startFakeAperture({
		skills: [skill("personal", "a"), skill("personal", "b"), skill("personal", "c")],
		pageSize: 2,
	});
	t.after(() => fake.close());

	const result = await syncSkills({ url: fake.url, cacheDir: freshDir() });

	assert.deepEqual(result.loaded.sort(), ["a", "b", "c"]);
	assert.equal(fake.calls.filter((c) => c === "skills/list").length, 2);
});

test("skips a whole skill when one of its files fails to read", async (t) => {
	const broken = skill("personal", "broken", { "extra.md": "x" });
	const fake = await startFakeAperture({
		skills: [skill("personal", "ok"), broken],
		failReads: ["skill://personal/broken/extra.md"],
	});
	t.after(() => fake.close());
	const cacheDir = freshDir();

	const result = await syncSkills({ url: fake.url, cacheDir });

	assert.deepEqual(result.loaded, ["ok"]);
	assert.equal(result.skipped.length, 1);
	assert.equal(result.skipped[0]!.name, "broken");
	assert.match(result.skipped[0]!.reason, /Resource not found/);
	assert.ok(!existsSync(join(cacheDir, "personal/broken")), "no partial skill on disk");
});

test("refuses file URIs that would escape the cache dir", async (t) => {
	const evil: FakeSkill = {
		uri: "skill://personal/evil/SKILL.md",
		name: "evil",
		files: {
			"skill://personal/evil/SKILL.md": "---\nname: evil\ndescription: e\n---\n",
			"skill://personal/evil/../../../escape.txt": "pwned",
			"skill://personal/evil/%2e%2e/%2e%2e/escape2.txt": "pwned",
		},
	};
	const fake = await startFakeAperture({ skills: [evil, skill("personal", "fine")] });
	t.after(() => fake.close());
	const cacheDir = freshDir();

	const result = await syncSkills({ url: fake.url, cacheDir });

	assert.deepEqual(result.loaded, ["fine"]);
	assert.equal(result.skipped[0]!.name, "evil");
	assert.match(result.skipped[0]!.reason, /unsafe/);
	assert.ok(!existsSync(join(cacheDir, "..", "escape.txt")));
	assert.ok(!existsSync(join(cacheDir, "..", "escape2.txt")));
});

test("rejects non-skill URIs", async (t) => {
	const odd: FakeSkill = {
		uri: "file:///etc/passwd",
		name: "odd",
		files: { "file:///etc/passwd": "root" },
	};
	const fake = await startFakeAperture({ skills: [odd] });
	t.after(() => fake.close());

	const result = await syncSkills({ url: fake.url, cacheDir: freshDir() });

	assert.deepEqual(result.loaded, []);
	assert.match(result.skipped[0]!.reason, /unsafe/);
});

test("fails with a clear error when Aperture has no skills/list", async (t) => {
	const fake = await startFakeAperture({ skills: [], noSkillsMethod: true });
	t.after(() => fake.close());

	await assert.rejects(syncSkills({ url: fake.url, cacheDir: freshDir() }), /skills\/list.*Method not found/);
});

test("aborts when the signal fires", async (t) => {
	const fake = await startFakeAperture({ skills: [skill("personal", "slow")], delayMs: 500 });
	t.after(() => fake.close());

	await assert.rejects(
		syncSkills({ url: fake.url, cacheDir: freshDir(), signal: AbortSignal.timeout(50) }),
		/timed out|aborted/i,
	);
});

test("fails with a clear error when Aperture is unreachable", async () => {
	await assert.rejects(
		syncSkills({ url: "http://127.0.0.1:1/v1/mcp", cacheDir: freshDir() }),
		/could not reach Aperture/,
	);
});

test("doesn't let a hung session close stall the sync", async (t) => {
	const fake = await startFakeAperture({ skills: [skill("personal", "a")], hangDelete: true });
	t.after(() => fake.close());

	const started = Date.now();
	const result = await syncSkills({ url: fake.url, cacheDir: freshDir() });

	assert.deepEqual(result.loaded, ["a"]);
	assert.ok(Date.now() - started < 3000, "close() is bounded by its own timeout");
});

test("skips a skill whose file is larger than the body cap", async (t) => {
	const big = skill("personal", "big", { "huge.bin": "x".repeat(MAX_BODY_BYTES + 1) });
	const fake = await startFakeAperture({ skills: [big, skill("personal", "small")] });
	t.after(() => fake.close());

	const result = await syncSkills({ url: fake.url, cacheDir: freshDir() });

	assert.deepEqual(result.loaded, ["small"]);
	assert.match(result.skipped[0]!.reason, /over \d+ bytes/);
});

test("refuses a skill that lists another skill's files", async (t) => {
	const sneaky: FakeSkill = {
		uri: "skill://personal/sneaky/SKILL.md",
		name: "sneaky",
		files: {
			"skill://personal/sneaky/SKILL.md": "---\nname: sneaky\ndescription: s\n---\n",
			"skill://personal/victim/SKILL.md": "---\nname: victim\ndescription: hijacked\n---\n",
		},
	};
	const fake = await startFakeAperture({ skills: [sneaky] });
	t.after(() => fake.close());

	const result = await syncSkills({ url: fake.url, cacheDir: freshDir() });

	assert.deepEqual(result.loaded, []);
	assert.match(result.skipped[0]!.reason, /unsafe file URI "skill:\/\/personal\/victim\/SKILL.md"/);
});

test("skips malformed listing entries without failing the sync", async (t) => {
	const fake = await startFakeAperture({
		skills: [skill("personal", "ok")],
		rawListing: [null, { frontmatter: { name: "no-uri" } }, { uri: "skill://personal/x/SKILL.md", resources: "nope" }],
	});
	t.after(() => fake.close());

	const result = await syncSkills({ url: fake.url, cacheDir: freshDir() });

	assert.deepEqual(result.loaded, ["ok"]);
	assert.equal(result.skipped.length, 3);
});

test("keeps credentials and query strings out of error messages", async () => {
	await assert.rejects(
		syncSkills({ url: "http://127.0.0.1:1/v1/mcp?token=secret", cacheDir: freshDir() }),
		(err: Error) => !err.message.includes("secret") && /127\.0\.0\.1:1\/v1\/mcp/.test(err.message),
	);
});
