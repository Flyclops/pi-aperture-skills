/**
 * Lifecycle of the skill cache: one throwaway directory per pi runtime,
 * named `<pid>-<random>` under a per-user root so a later start can tell which
 * ones belong to processes that died without cleaning up.
 *
 * The root lives in the OS temp dir, which on Linux is usually the shared
 * `/tmp`. Another user could pre-create it, or symlink it elsewhere, to plant
 * skills or make the sweep delete our files, so we refuse any root that isn't
 * a real directory owned by us and closed to everyone else.
 */
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";

/** Shared parent of this user's per-process cache directories. */
export const DEFAULT_ROOT = join(tmpdir(), `pi-aperture-skills-${process.getuid?.() ?? userInfo().username}`);

/** Matches the names `createCacheDir` produces (`mkdtemp` adds 6 chars). */
const CACHE_NAME = /^(\d+)-[A-Za-z0-9]{6}$/;

/** Creates a fresh, empty cache directory for this runtime. */
export function createCacheDir(root = DEFAULT_ROOT, pid = process.pid): string {
	mkdirSync(root, { recursive: true, mode: 0o700 });
	assertPrivateDir(root);
	return mkdtempSync(join(root, `${pid}-`));
}

/** Deletes a cache directory. Safe to call twice. */
export function removeCacheDir(dir: string): void {
	rmSync(dir, { recursive: true, force: true });
}

/**
 * Deletes cache directories whose process is gone. Entries that don't look
 * like `<pid>-<random>` are left alone, and an entry that can't be removed is
 * skipped: sweeping is housekeeping, not something to fail startup over.
 */
export function sweepStaleCacheDirs(root = DEFAULT_ROOT, isAlive = processIsAlive): void {
	let entries: string[];
	try {
		assertPrivateDir(root);
		entries = readdirSync(root);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
		throw err;
	}
	for (const name of entries) {
		const match = CACHE_NAME.exec(name);
		if (!match || isAlive(Number(match[1]))) continue;
		try {
			removeCacheDir(join(root, name));
		} catch {
			// Deliberately ignored, see above; the next start retries.
		}
	}
}

/** Throws unless `dir` is a real directory owned by us with no group/other access. */
export function assertPrivateDir(dir: string): void {
	const stat = lstatSync(dir);
	if (!stat.isDirectory()) {
		throw new Error(`${dir} is not a directory (is it a symlink?); refusing to use it`);
	}
	const uid = process.getuid?.();
	if (uid === undefined) return; // Windows: %TEMP% is already per-user.
	if (stat.uid !== uid || (stat.mode & 0o077) !== 0) {
		throw new Error(`${dir} must be owned by you with mode 0700; refusing to use it`);
	}
}

/** Signal 0 checks existence without touching the process. */
function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		// EPERM: it exists but belongs to someone else.
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}
