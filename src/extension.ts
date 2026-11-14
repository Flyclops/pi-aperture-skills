/**
 * Wires the skill cache into pi's lifecycle.
 *
 * On every `resources_discover` (startup and `/reload`) it throws away the
 * previous cache, copies Aperture's published skills into a fresh one, and
 * hands pi the directories. On `session_shutdown` it deletes the cache. The
 * user gets exactly one notice per discovery.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createCacheDir, DEFAULT_ROOT, removeCacheDir, sweepStaleCacheDirs } from "./cache-dir.ts";
import { findApertureUrl } from "./config.ts";
import { displayUrl } from "./mcp-client.ts";
import { type SyncResult, syncSkills } from "./sync.ts";

export interface Options {
	/** Path of pi's user-level `mcp.json`. */
	mcpJsonPath: string;
	/** Parent of the per-process cache directories. */
	cacheRoot?: string;
	/** How long startup may wait for Aperture. */
	timeoutMs?: number;
}

export function registerApertureSkills(pi: ExtensionAPI, opts: Options): void {
	const cacheRoot = opts.cacheRoot ?? DEFAULT_ROOT;
	const timeoutMs = opts.timeoutMs ?? 5000;
	let cacheDir: string | undefined;

	const dropCache = () => {
		if (cacheDir) removeCacheDir(cacheDir);
		cacheDir = undefined;
	};

	pi.on("resources_discover", async (_event, ctx) => {
		const notify = (message: string, level: "info" | "warning") => {
			if (ctx.hasUI) ctx.ui.notify(message, level);
		};
		dropCache();

		// Servers other extensions registered are all in place by now: pi awaits
		// every extension factory before `resources_discover`. Don't handle
		// `mcp_servers_change` to catch later ones; that makes this extension
		// responsible for connecting registered servers. `/reload` picks them up.
		const lookup = findApertureUrl(opts.mcpJsonPath, pi.getMcpServers());
		if ("problem" in lookup) {
			notify(`Aperture skills not loaded: ${clean(lookup.problem, 400)}`, "warning");
			return;
		}

		let result: SyncResult;
		try {
			sweepStaleCacheDirs(cacheRoot);
			cacheDir = createCacheDir(cacheRoot);
			result = await syncSkills({
				url: lookup.url,
				cacheDir,
				signal: AbortSignal.timeout(timeoutMs),
			});
		} catch (err) {
			dropCache();
			const reason =
				(err as Error).name === "TimeoutError"
					? `Aperture at ${displayUrl(lookup.url)} didn't answer within ${timeoutMs / 1000}s`
					: (err as Error).message;
			notify(`Aperture skills not loaded: ${clean(reason)}. Continuing without them.`, "warning");
			return;
		}

		const { message, level } = summarize(result);
		notify(message, level);
		return result.skillPaths.length ? { skillPaths: result.skillPaths } : undefined;
	});

	pi.on("session_shutdown", () => dropCache());
}

/** Builds the one-line notice shown after a successful sync. */
function summarize(result: SyncResult): { message: string; level: "info" | "warning" } {
	const n = result.loaded.length;
	let message = `Aperture: loaded ${n} skill${n === 1 ? "" : "s"}`;
	if (result.skipped.length === 0) return { message, level: "info" };
	const skipped = result.skipped.map((s) => `${clean(s.name)} (${clean(s.reason)})`).join(", ");
	message += `; skipped ${skipped}`;
	return { message, level: "warning" };
}

/**
 * Makes server-supplied text safe to show: drops control characters (which
 * could carry terminal escape sequences) and caps the length.
 */
export function clean(text: string, max = 200): string {
	const plain = text.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
	return plain.length > max ? `${plain.slice(0, max - 1)}…` : plain;
}
