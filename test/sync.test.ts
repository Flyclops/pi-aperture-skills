import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { tempDir } from "./temp.ts";
import { MAX_BODY_BYTES } from "../src/mcp-client.ts";
import { budgetedReader, syncSkills } from "../src/sync.ts";
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

test("keeps URL credentials out of fetch's own error messages", async () => {
	await assert.rejects(
		syncSkills({ url: "http://user:hunter2@127.0.0.1:1/v1/mcp?token=secret", cacheDir: freshDir() }),
		(err: Error) => !/hunter2|secret|user:/.test(err.message),
	);
});

test("answers from an SSE stream the server keeps open", async (t) => {
	const fake = await startFakeAperture({ skills: [skill("personal", "a")], keepOpen: true });
	t.after(() => fake.close());

	const result = await syncSkills({ url: fake.url, cacheDir: freshDir(), signal: AbortSignal.timeout(2000) });

	assert.deepEqual(result.loaded, ["a"]);
});

test("skips skills once the total download budget is spent", async (t) => {
	const fake = await startFakeAperture({
		skills: [skill("personal", "a", { "big.txt": "x".repeat(600) }), skill("personal", "b", { "big.txt": "x".repeat(600) })],
	});
	t.after(() => fake.close());

	const result = await syncSkills({ url: fake.url, cacheDir: freshDir(), maxTotalBytes: 1000, concurrency: 1 });

	assert.equal(result.loaded.length, 1);
	assert.match(result.skipped[0]!.reason, /1000-byte download budget/);
});

test("refuses a skill URI that would make a whole group its directory", async (t) => {
	const groupWide: FakeSkill = {
		uri: "skill://personal/SKILL.md",
		name: "wide",
		files: {
			"skill://personal/SKILL.md": "---\nname: wide\ndescription: w\n---\n",
			"skill://personal/victim/%53KILL.md": "hijacked",
		},
	};
	const fake = await startFakeAperture({ skills: [groupWide, skill("personal", "victim")] });
	t.after(() => fake.close());
	const dir = freshDir();

	const result = await syncSkills({ url: fake.url, cacheDir: dir });

	assert.deepEqual(result.loaded, ["victim"]);
	assert.match(result.skipped[0]!.reason, /unsafe skill URI/);
	assert.match(readFileSync(join(dir, "personal", "victim", "SKILL.md"), "utf8"), /name: victim/);
});

test("refuses skills whose directories overlap", async (t) => {
	const fake = await startFakeAperture({
		skills: [skill("personal", "outer"), skill("personal", "outer/inner"), skill("personal", "fine")],
	});
	t.after(() => fake.close());

	const result = await syncSkills({ url: fake.url, cacheDir: freshDir() });

	assert.deepEqual(result.loaded, ["fine"]);
	assert.deepEqual(result.skipped.map((s) => s.reason), ["overlaps another skill's directory", "overlaps another skill's directory"]);
});

test("fails the sync, rather than skipping skills, when it times out mid-read", async (t) => {
	const slow = skill("personal", "slow");
	const fake = await startFakeAperture({ skills: [skill("personal", "fast"), slow], readDelayMs: { [slow.uri]: 1000 } });
	t.after(() => fake.close());

	await assert.rejects(
		syncSkills({ url: fake.url, cacheDir: freshDir(), signal: AbortSignal.timeout(300) }),
		{ name: "TimeoutError" },
	);
});

test("skips a skill that can't be written and keeps the others", async (t) => {
	const clash = skill("personal", "clash", { "extra.md": "file", "extra.md/nested.txt": "under a file" });
	const fake = await startFakeAperture({ skills: [clash, skill("personal", "ok")] });
	t.after(() => fake.close());
	const dir = freshDir();

	const result = await syncSkills({ url: fake.url, cacheDir: dir });

	assert.deepEqual(result.loaded, ["ok"]);
	assert.match(result.skipped[0]!.reason, /^could not write/);
	assert.ok(!existsSync(join(dir, "personal", "clash")), "no half-written skill is left");
});

test("downloads SKILL.md even when resources leave it out", async (t) => {
	const fake = await startFakeAperture({ skills: [skill("personal", "a", { "notes.md": "n" })], omitMainResource: true });
	t.after(() => fake.close());
	const dir = freshDir();

	const result = await syncSkills({ url: fake.url, cacheDir: dir });

	assert.deepEqual(result.loaded, ["a"]);
	assert.ok(existsSync(join(dir, "personal", "a", "SKILL.md")));
	assert.ok(existsSync(join(dir, "personal", "a", "notes.md")));
});

test("lets a failed skill's other reads finish before closing the session", async (t) => {
	const s = skill("personal", "a", { "slow.md": "s" });
	const fake = await startFakeAperture({
		skills: [s],
		failReads: [s.uri],
		readDelayMs: { "skill://personal/a/slow.md": 200 },
	});
	t.after(() => fake.close());

	await syncSkills({ url: fake.url, cacheDir: freshDir() });

	// Snapshot as soon as the sync returns: by then every read must have
	// been answered and the session closed, in that order.
	const calls = [...fake.calls];
	assert.deepEqual(calls.slice(-2), ["read-done skill://personal/a/slow.md", "DELETE"]);
});

test("parses SSE replies that arrive in tiny chunks", async (t) => {
	const fake = await startFakeAperture({ skills: [skill("personal", "a", { "notes.md": "n\r\n\r\nm" })], chunkBytes: 1 });
	t.after(() => fake.close());
	const dir = freshDir();

	const result = await syncSkills({ url: fake.url, cacheDir: dir });

	assert.deepEqual(result.loaded, ["a"]);
	assert.equal(readFileSync(join(dir, "personal", "a", "notes.md"), "utf8"), "n\r\n\r\nm");
});

test("catches nesting hidden by a sibling that sorts between", async (t) => {
	const fake = await startFakeAperture({
		skills: [skill("personal", "a"), skill("personal", "a-b"), skill("personal", "a/x")],
	});
	t.after(() => fake.close());

	const result = await syncSkills({ url: fake.url, cacheDir: freshDir() });

	assert.deepEqual(result.loaded, ["a-b"]);
	assert.deepEqual(result.skipped.map((s) => s.name).sort(), ["a", "a/x"]);
});

test("treats directories differing only in case or Unicode form as the same", async (t) => {
	const fake = await startFakeAperture({
		skills: [
			skill("personal", "tdd"),
			skill("personal", "TDD"),
			skill("personal", "caf%C3%A9"),
			skill("personal", "cafe%CC%81"),
			skill("personal", "%C5%BFkill"),
			skill("personal", "skill"),
			skill("personal", "fine"),
		],
	});
	t.after(() => fake.close());

	const result = await syncSkills({ url: fake.url, cacheDir: freshDir() });

	assert.deepEqual(result.loaded, ["fine"]);
	assert.equal(result.skipped.length, 6);
});

test("stops downloading once the budget is spent", async (t) => {
	const files = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`f${i}.txt`, "x".repeat(600)]));
	const fake = await startFakeAperture({ skills: [skill("personal", "a", files)] });
	t.after(() => fake.close());

	await syncSkills({ url: fake.url, cacheDir: freshDir(), maxTotalBytes: 1000, concurrency: 1 });

	// SKILL.md, f0 and f1 use up 1000 bytes; nothing after that is fetched.
	assert.equal(fake.calls.filter((c) => c === "resources/read").length, 3);
});

test("parallel reads never keep more than the budget", async () => {
	let requests = 0;
	const request = async <T>(): Promise<T> => {
		requests++;
		await new Promise((r) => setTimeout(r, 5));
		return { contents: [{ text: "x".repeat(600) }] } as T;
	};
	const read = budgetedReader(request, 8, 1000);

	const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => read(`skill://g/s/f${i}`)));

	const kept = results.filter((r) => r.status === "fulfilled");
	assert.equal(kept.length, 1, "600 + 600 > 1000, so only one fits");
	assert.equal(requests, 2, "nothing is requested once the budget runs out");
});

test("budgets decoded bytes, so base64 overhead doesn't count", async () => {
	const MB = 1024 * 1024;
	// 4 MB of binary arrives as ~5.3 MB of base64; 5 MB of budget is enough.
	const request = async <T>(): Promise<T> => ({ contents: [{ blob: Buffer.alloc(4 * MB).toString("base64") }] }) as T;
	const read = budgetedReader(request, 8, 5 * MB);

	assert.equal((await read("skill://g/s/bin")).byteLength, 4 * MB);
});

test("skips a skill whose distinct URIs land on the same file", async (t) => {
	const twins = skill("personal", "twins", { "Notes.md": "a", "notes.md": "b" });
	const encoded = skill("personal", "encoded", { "%53KILL.md": "replaced" });
	const fake = await startFakeAperture({ skills: [twins, encoded, skill("personal", "ok")] });
	t.after(() => fake.close());

	const result = await syncSkills({ url: fake.url, cacheDir: freshDir() });

	assert.deepEqual(result.loaded, ["ok"]);
	assert.deepEqual(
		result.skipped.map((s) => s.reason),
		['two files map to "notes.md"', 'two files map to "SKILL.md"'],
	);
});

test("hangs up on error and oversized bodies instead of leaving them open", async (t) => {
	const a = skill("personal", "a");
	const b = skill("personal", "b");
	const fake = await startFakeAperture({
		skills: [a, b, skill("personal", "ok")],
		endlessReads: { [a.uri]: "error", [b.uri]: "huge" },
	});
	t.after(() => fake.close());

	const result = await syncSkills({ url: fake.url, cacheDir: freshDir() });
	await new Promise((r) => setTimeout(r, 100)); // let the close events land

	assert.deepEqual(result.loaded, ["ok"]);
	assert.ok(fake.calls.includes(`cancelled ${a.uri}`), "error body cancelled");
	assert.ok(fake.calls.includes(`cancelled ${b.uri}`), "oversized body cancelled");
});

test("small reads in flight don't make a mid-size read look over budget", async () => {
	const MB = 1024 * 1024;
	// Seven slow 1 KB reads each hold a full reservation while a 3 MB read
	// asks for budget; 31 MB of 100 MB is nowhere near the limit.
	const request = async <T>(_m: string, params?: object): Promise<T> => {
		const size = (params as { uri: string }).uri.endsWith("big") ? 3 * MB : 1024;
		await new Promise((r) => setTimeout(r, size === 1024 ? 30 : 5));
		return { contents: [{ blob: Buffer.alloc(size).toString("base64") }] } as T;
	};
	const read = budgetedReader(request, 8, 100 * MB);
	for (let i = 0; i < 10; i++) await read("skill://g/s/prefill-big"); // 30 MB used

	const results = await Promise.allSettled([
		...Array.from({ length: 7 }, (_, i) => read(`skill://g/s/small${i}`)),
		read("skill://g/s/big"),
	]);

	assert.deepEqual(results.map((r) => r.status), Array(8).fill("fulfilled"));
});

test("counts decoded bytes, not received bytes, against the budget", async () => {
	// 600 invalid UTF-8 bytes decode to 600 U+FFFD, 1800 bytes on disk.
	const request = async <T>(): Promise<T> => ({ contents: [{ text: "\uFFFD".repeat(600) }] }) as T;
	const read = budgetedReader(request, 1, 1000);

	await assert.rejects(read("skill://g/s/f"), /1000-byte download budget/);
});
