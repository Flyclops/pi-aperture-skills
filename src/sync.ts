/**
 * Copies every skill Aperture publishes into a local directory pi can load.
 *
 * One call does the whole job: open an MCP session, page through
 * `skills/list`, read every file with `resources/read`, and mirror each file's
 * `skill://` URI under `cacheDir`. Each skill is confined to its own
 * directory and written only once all its files are read.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { MAX_BODY_BYTES, openSession, ResponseTooLargeError } from "./mcp-client.ts";

export interface SyncOptions {
	/** Aperture's MCP endpoint. */
	url: string;
	/** Existing, empty directory to write skills into. */
	cacheDir: string;
	signal?: AbortSignal;
	/** Maximum parallel `resources/read` calls. */
	concurrency?: number;
	/** Most file data to download in total (default `MAX_TOTAL_BYTES`). */
	maxTotalBytes?: number;
}

export interface SyncResult {
	/** Directories to hand to pi, highest priority first. */
	skillPaths: string[];
	/** Names of the skills written to disk. */
	loaded: string[];
	/** Skills left out, with a user-facing reason. */
	skipped: { name: string; reason: string }[];
}

/** One entry of a SEP-2640 `skills/list` result. */
interface ListedSkill {
	uri: string;
	frontmatter?: { name?: unknown };
	resources?: { uri: string }[];
}

interface ReadResult {
	contents: { uri: string; text?: string; blob?: string }[];
}

/** Groups pi should search first; any others follow alphabetically. */
const PRIORITY = ["personal", "org"];

/** Most file data one sync may download, across all skills. */
export const MAX_TOTAL_BYTES = 100 * 1024 * 1024;

export async function syncSkills(opts: SyncOptions): Promise<SyncResult> {
	const session = await openSession(opts.url, opts.signal);
	try {
		const plans = claimDirs((await listAllSkills(session.request)).map((s) => planSkill(s, opts.cacheDir)));
		const readFile = budgetedReader(session.request, opts.concurrency ?? 8, opts.maxTotalBytes ?? MAX_TOTAL_BYTES);
		const outcomes = await Promise.all(
			plans.map((plan) => ("reason" in plan ? plan : fetchSkill(plan, readFile, opts.signal))),
		);
		// A timeout must fail the sync, not show up as a few skipped skills.
		opts.signal?.throwIfAborted();

		const result: SyncResult = { skillPaths: [], loaded: [], skipped: [] };
		const groups = new Set<string>();
		for (const outcome of outcomes) {
			if ("reason" in outcome) {
				result.skipped.push(outcome);
				continue;
			}
			result.loaded.push(outcome.name);
			groups.add(outcome.group);
		}
		result.skillPaths = [...groups].sort(byPriority).map((g) => join(opts.cacheDir, g));
		return result;
	} finally {
		await session.close();
	}
}

/** The file's bytes from a `resources/read` result. */
function decodeContents(res: ReadResult, uri: string): Buffer {
	const c = Array.isArray(res?.contents) ? res.contents[0] : undefined;
	if (typeof c?.blob === "string") return Buffer.from(c.blob, "base64");
	if (typeof c?.text === "string") return Buffer.from(c.text, "utf8");
	throw new Error(`resources/read returned no content for ${uri}`);
}

/**
 * Returns a `resources/read` function that runs at most `concurrency` reads
 * at once (one limit across every file of every skill) and downloads at most
 * `total` bytes of file data overall.
 *
 * Each read reserves budget before it starts and its response is capped at
 * that reservation, so parallel reads can never overshoot; what the file
 * doesn't use goes back once it arrives. A read only takes less than a full
 * `MAX_BODY_BYTES` reservation when no other read is in flight, so a cap
 * reflects the real remaining budget rather than other reads' unused
 * reservations. Once a file fails for lack of budget, every later read fails
 * without a request.
 */
export function budgetedReader(
	request: Request,
	concurrency: number,
	total: number,
): (uri: string) => Promise<Buffer> {
	const limited = limiter(concurrency);
	let left = total;
	let spent = false;
	let inFlight = 0;
	let waiting: (() => void)[] = [];
	return (uri) =>
		limited(async () => {
			// Wait for in-flight reads to return their unused reservations.
			while (!spent && left < MAX_BODY_BYTES && inFlight > 0) {
				await new Promise<void>((r) => waiting.push(r));
			}
			const reserved = Math.min(MAX_BODY_BYTES, left);
			if (spent || reserved <= 0) throw overBudget(total);
			left -= reserved;
			inFlight++;
			let used = 0;
			try {
				const data = decodeContents(await request<ReadResult>("resources/read", { uri }, reserved), uri);
				// Decoding can grow the data (each invalid UTF-8 byte becomes a
				// 3-byte U+FFFD), so the cap on the response isn't enough.
				if (data.byteLength > reserved) throw new ResponseTooLargeError(reserved);
				used = data.byteLength;
				return data;
			} catch (err) {
				// Hitting a cap smaller than the per-response limit means the
				// budget, not the file, ran out.
				if (err instanceof ResponseTooLargeError && reserved < MAX_BODY_BYTES) {
					spent = true;
					throw overBudget(total);
				}
				throw err;
			} finally {
				left += reserved - used;
				inFlight--;
				const wake = waiting;
				waiting = [];
				for (const w of wake) w();
			}
		});
}

const overBudget = (total: number) => new Error(`skills exceed the ${total}-byte download budget`);

type Request = <T>(method: string, params?: object, maxBytes?: number) => Promise<T>;

async function listAllSkills(request: Request): Promise<unknown[]> {
	const all: unknown[] = [];
	let cursor: string | undefined;
	do {
		const page = await request<{ skills?: unknown; nextCursor?: unknown }>(
			"skills/list",
			cursor ? { cursor } : {},
		);
		if (!Array.isArray(page?.skills)) throw new Error("skills/list returned no skills array");
		for (const s of page.skills) all.push(s);
		cursor = typeof page.nextCursor === "string" && page.nextCursor ? page.nextCursor : undefined;
	} while (cursor);
	return all;
}

type Skipped = { name: string; reason: string };
type Plan = { name: string; group: string; dir: string; files: { uri: string; path: string }[] };

/**
 * Validates one listing entry and works out where its files go. Never
 * throws: anything wrong with the entry becomes a `reason`.
 */
function planSkill(raw: unknown, cacheDir: string): Plan | Skipped {
	const skill = raw as ListedSkill;
	const name =
		typeof skill?.frontmatter?.name === "string"
			? skill.frontmatter.name
			: typeof skill?.uri === "string"
				? skill.uri
				: "(unnamed)";
	const skip = (reason: string) => ({ name, reason });
	if (typeof skill?.uri !== "string") return skip("listing entry has no uri");
	const resources = skill.resources ?? [];
	if (!Array.isArray(resources)) return skip("listing entry has malformed resources");

	// The skill's directory is the parent of its SKILL.md, and must sit
	// below a group (`<group>/<name>/SKILL.md`), never be the group itself.
	const main = cachePathFor(skill.uri, cacheDir);
	if (!main || basename(main) !== "SKILL.md" || relative(cacheDir, main).split(sep).length < 3) {
		return skip(`unsafe skill URI ${JSON.stringify(skill.uri)}`);
	}
	const dir = dirname(main);

	// SKILL.md always comes first, whether or not `resources` lists it.
	const uris = [...new Set([skill.uri, ...resources.map((r) => r?.uri)])];
	const files: Plan["files"] = [];
	// Distinct URIs (`SKILL.md` vs `%53KILL.md`, or names differing in case)
	// can land on one file; refuse rather than let one silently replace another.
	const seen = new Set<string>();
	for (const uri of uris) {
		const path = typeof uri === "string" ? cachePathFor(uri, cacheDir) : undefined;
		if (!path || !path.startsWith(dir + sep)) return skip(`unsafe file URI ${JSON.stringify(uri)}`);
		const key = claimKey(path);
		if (seen.has(key)) return skip(`two files map to ${JSON.stringify(relative(dir, path))}`);
		seen.add(key);
		files.push({ uri: uri as string, path });
	}
	const group = relative(cacheDir, dir).split(sep)[0]!;
	return { name, group, dir, files };
}

/**
 * Skips every skill whose directory equals, contains or sits inside
 * another's, so no skill can overwrite another's files.
 *
 * Directories are compared by `claimKey`, which folds case (upper then lower,
 * so pairs like `ſ`/`s` and `µ`/`μ` match), Unicode form and
 * trailing dots/spaces the way macOS and Windows filesystems do, and ends in a
 * separator so `a/` is never mistaken for a prefix of `a-b/`. After sorting,
 * every directory nested in another comes after it, so one pass with a stack
 * of enclosing directories finds every overlap: O(n log n).
 */
function claimDirs(plans: (Plan | Skipped)[]): (Plan | Skipped)[] {
	const keyed = plans
		.filter((p): p is Plan => "dir" in p)
		.map((plan) => ({ plan, key: claimKey(plan.dir) }))
		.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
	const clash = new Set<Plan>();
	const enclosing: (typeof keyed)[number][] = [];
	for (const cur of keyed) {
		while (enclosing.length && !cur.key.startsWith(enclosing.at(-1)!.key)) enclosing.pop();
		const outer = enclosing.at(-1);
		if (outer) clash.add(outer.plan).add(cur.plan);
		enclosing.push(cur);
	}
	return plans.map((p) => ("dir" in p && clash.has(p) ? { name: p.name, reason: "overlaps another skill's directory" } : p));
}

/** A path's identity on a case- and normalization-insensitive filesystem. */
function claimKey(dir: string): string {
	const folded = dir
		.split(sep)
		.map((s) => s.normalize("NFC").toUpperCase().toLowerCase().replace(/[. ]+$/, ""))
		.join(sep);
	return folded + sep;
}

/**
 * Downloads one skill and writes it to disk. A skill is written only once all
 * its files are read, and a failed write removes what was written, so pi
 * never sees half a skill. Never throws, except to propagate an abort.
 */
async function fetchSkill(
	plan: Plan,
	readFile: (uri: string) => Promise<Buffer>,
	signal?: AbortSignal,
): Promise<{ name: string; group: string } | Skipped> {
	// allSettled, not all: every read of this skill finishes before we
	// return, so none is still running when the session closes.
	const reads = await Promise.allSettled(plan.files.map(({ uri }) => readFile(uri)));
	signal?.throwIfAborted();
	const failed = reads.find((r) => r.status === "rejected");
	if (failed) return { name: plan.name, reason: (failed.reason as Error).message };

	try {
		plan.files.forEach(({ path }, i) => {
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, (reads[i] as PromiseFulfilledResult<Buffer>).value);
		});
	} catch (err) {
		rmSync(plan.dir, { recursive: true, force: true });
		return { name: plan.name, reason: `could not write: ${(err as Error).message}` };
	}
	return { name: plan.name, group: plan.group };
}

/**
 * Maps `skill://<group>/<...>/<file>` to `<cacheDir>/<group>/<...>/<file>`.
 * Returns undefined for anything that is not a plain relative path, including
 * percent-encoded `..`, so a hostile listing can't write outside `cacheDir`.
 */
export function cachePathFor(uri: string, cacheDir: string): string | undefined {
	const prefix = "skill://";
	if (!uri.startsWith(prefix)) return undefined;
	let segments: string[];
	try {
		segments = uri.slice(prefix.length).split("/").map(decodeURIComponent);
	} catch {
		return undefined;
	}
	const unsafe = (s: string) =>
		s === "" ||
		s === "." ||
		s === ".." ||
		/[/\\:]/.test(s) ||
		[...s].some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127);
	if (segments.length < 2 || segments.some(unsafe)) return undefined;

	const root = resolve(cacheDir);
	const path = resolve(root, ...segments);
	return path.startsWith(root + sep) ? path : undefined;
}

function byPriority(a: string, b: string): number {
	const rank = (g: string) => {
		const i = PRIORITY.indexOf(g);
		return i === -1 ? PRIORITY.length : i;
	};
	return rank(a) - rank(b) || a.localeCompare(b);
}

/** Returns a wrapper that runs at most `limit` wrapped calls at a time. */
function limiter(limit: number): <T>(fn: () => Promise<T>) => Promise<T> {
	let active = 0;
	const queue: (() => void)[] = [];
	return async (fn) => {
		// A finishing call hands its slot straight to the next waiter, so
		// `active` never drops below the limit while calls are queued.
		if (active >= limit) await new Promise<void>((r) => queue.push(r));
		else active++;
		try {
			return await fn();
		} finally {
			const next = queue.shift();
			if (next) next();
			else active--;
		}
	};
}
