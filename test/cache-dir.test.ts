import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { tempDir } from "./temp.ts";
import { createCacheDir, sweepStaleCacheDirs } from "../src/cache-dir.ts";

function privateRoot(): string {
	return tempDir("aperture-root");
}

test("creates an empty <pid>-<random> directory under a new private root", () => {
	const root = join(privateRoot(), "nested");
	const dir = createCacheDir(root, 4242);
	assert.equal(dirname(dir), root);
	assert.match(basename(dir), /^4242-[A-Za-z0-9]{6}$/);
	assert.deepEqual(readdirSync(dir), []);
	assert.notEqual(createCacheDir(root, 4242), dir, "each call gets its own directory");
});

test("refuses a root that is a symlink", () => {
	const base = privateRoot();
	const target = join(base, "elsewhere");
	mkdirSync(target, { mode: 0o700 });
	const root = join(base, "root");
	symlinkSync(target, root);

	assert.throws(() => createCacheDir(root), /symlink/);
	assert.throws(() => sweepStaleCacheDirs(root, () => false), /symlink/);
});

test("refuses a root other users can access", () => {
	const root = privateRoot();
	chmodSync(root, 0o777);
	assert.throws(() => createCacheDir(root), /mode 0700/);
});

test("sweeps directories of dead processes and keeps everything else", () => {
	const root = privateRoot();
	for (const name of ["100-aaaaaa", "200-bbbbbb", "300-cccccc", "2024-taxes", "not-a-cache"]) {
		mkdirSync(join(root, name, "personal"), { recursive: true });
	}
	const alive = new Set([200]);

	sweepStaleCacheDirs(root, (pid) => alive.has(pid));

	assert.deepEqual(readdirSync(root).sort(), ["200-bbbbbb", "2024-taxes", "not-a-cache"]);
});

test("sweeping a missing root is a no-op", () => {
	const root = join(tmpdir(), "aperture-missing-root-xyz");
	sweepStaleCacheDirs(root, () => false);
	assert.ok(!existsSync(root));
});
