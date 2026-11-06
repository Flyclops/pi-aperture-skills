/**
 * Copies every skill Aperture publishes into a local directory pi can load.
 *
 * One call does the whole job: open an MCP session, page through
 * `skills/list`, read every file with `resources/read`, and mirror each file's
 * `skill://` URI under `cacheDir`. A skill is written only once all its files
 * are read and every path is safe, so pi never sees half a skill.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { openSession } from "./mcp-client.ts";

export interface SyncOptions {
	/** Aperture's MCP endpoint. */
	url: string;
	/** Existing, empty directory to write skills into. */
	cacheDir: string;
	signal?: AbortSignal;
	/** Maximum parallel `resources/read` calls. */
	concurrency?: number;
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

export async function syncSkills(opts: SyncOptions): Promise<SyncResult> {
	const session = await openSession(opts.url, opts.signal);
	try {
		const skills = await listAllSkills(session.request);
		// One limit across every file of every skill, so a skill with
		// thousands of resources can't fire thousands of requests at once.
		const limited = limiter(opts.concurrency ?? 8);
		const read: Request = (method, params) => limited(() => session.request(method, params));
		const outcomes = await Promise.all(skills.map((s) => fetchSkill(s, opts.cacheDir, read)));

		const result: SyncResult = { skillPaths: [], loaded: [], skipped: [] };
		const groups = new Set<string>();
		for (const outcome of outcomes) {
			if ("reason" in outcome) {
				result.skipped.push(outcome);
				continue;
			}
			for (const file of outcome.files) {
				mkdirSync(dirname(file.path), { recursive: true });
				writeFileSync(file.path, file.data);
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

type Request = <T>(method: string, params?: object) => Promise<T>;

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

type Fetched =
	| { name: string; group: string; files: { path: string; data: Buffer }[] }
	| { name: string; reason: string };

/**
 * Reads one skill's files into memory. Never throws: anything wrong with the
 * skill, including a malformed listing entry, becomes a `reason`.
 */
async function fetchSkill(raw: unknown, cacheDir: string, request: Request): Promise<Fetched> {
	const skill = raw as ListedSkill;
	const name =
		typeof skill?.frontmatter?.name === "string"
			? skill.frontmatter.name
			: typeof skill?.uri === "string"
				? skill.uri
				: "(unnamed)";
	try {
		if (typeof skill?.uri !== "string") throw new Error("listing entry has no uri");
		const resources = skill.resources ?? [];
		if (!Array.isArray(resources)) throw new Error("listing entry has malformed resources");
		const uris = resources.length ? resources.map((r) => r?.uri) : [skill.uri];

		// Every file must sit in the skill's own directory, so one skill
		// can't overwrite another.
		const skillDir = cachePathFor(skill.uri, cacheDir);
		const paths: string[] = [];
		for (const uri of uris) {
			const path = typeof uri === "string" ? cachePathFor(uri, cacheDir) : undefined;
			if (!skillDir || !path || !path.startsWith(dirname(skillDir) + sep)) {
				return { name, reason: `unsafe file URI ${JSON.stringify(uri)}` };
			}
			paths.push(path);
		}

		const files = await Promise.all(
			(uris as string[]).map(async (uri, i) => {
				const res = await request<ReadResult>("resources/read", { uri });
				const c = Array.isArray(res?.contents) ? res.contents[0] : undefined;
				if (typeof c?.blob === "string") return { path: paths[i]!, data: Buffer.from(c.blob, "base64") };
				if (typeof c?.text === "string") return { path: paths[i]!, data: Buffer.from(c.text, "utf8") };
				throw new Error(`resources/read returned no content for ${uri}`);
			}),
		);
		const group = relative(cacheDir, paths[0]!).split(sep)[0]!;
		return { name, group, files };
	} catch (err) {
		return { name, reason: (err as Error).message };
	}
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
