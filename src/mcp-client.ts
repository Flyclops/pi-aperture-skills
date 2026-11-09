/**
 * The smallest MCP client that can talk to Aperture: Streamable HTTP over
 * `fetch`, one session, request/response only.
 *
 * Why not reuse pi's MCP connection: extensions can call tools only from inside
 * a tool's `execute()`, and pi connects MCP servers in the background around
 * the time `resources_discover` runs. See docs/adr/0001.
 */

/** A JSON-RPC error returned by the server. */
export class McpError extends Error {
	readonly method: string;
	readonly code: number;

	constructor(method: string, code: number, message: string) {
		super(`${method}: ${message} (${code})`);
		this.name = "McpError";
		this.method = method;
		this.code = code;
	}
}

/** A response body was bigger than the caller allowed. */
export class ResponseTooLargeError extends Error {
	readonly limit: number;

	constructor(limit: number) {
		super(`Aperture sent a response over ${limit} bytes`);
		this.name = "ResponseTooLargeError";
		this.limit = limit;
	}
}

export interface McpSession {
	/**
	 * Sends a request and resolves with its `result`. The response body may
	 * be at most `maxBytes` (default and ceiling: `MAX_BODY_BYTES`).
	 */
	request<T>(method: string, params?: object, maxBytes?: number): Promise<T>;
	/** Ends the session. Best effort: the server expires idle sessions anyway. */
	close(): Promise<void>;
}

const PROTOCOL_VERSION = "2025-06-18";

/** Largest response body accepted; a skill file bigger than this is refused. */
export const MAX_BODY_BYTES = 10 * 1024 * 1024;

/** The URL without query, fragment or credentials, safe to show the user. */
export function displayUrl(url: string): string {
	try {
		const u = new URL(url);
		return u.origin + u.pathname;
	} catch {
		return "the configured URL";
	}
}

/** Opens a session: `initialize`, then `notifications/initialized`. */
export async function openSession(url: string, signal?: AbortSignal): Promise<McpSession> {
	const shown = displayUrl(url);
	let sessionId: string | undefined;
	let nextId = 1;

	const post = async (message: object): Promise<Response> => {
		const headers: Record<string, string> = {
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
			"mcp-protocol-version": PROTOCOL_VERSION,
		};
		if (sessionId) headers["mcp-session-id"] = sessionId;
		let res: Response;
		try {
			res = await fetch(url, { method: "POST", headers, body: JSON.stringify(message), signal });
		} catch (err) {
			if (signal?.aborted) throw signal.reason;
			// fetch's own messages can quote the full URL, credentials and
			// all, so scrub it before the text reaches the user.
			const cause = (err as { cause?: { message?: string } }).cause?.message;
			const detail = (cause ?? (err as Error).message).split(url).join(shown);
			throw new Error(`could not reach Aperture at ${shown}: ${detail}`);
		}
		if (!res.ok && res.status !== 202) {
			// An unread body keeps its connection busy; release it.
			await discard(res);
			throw new Error(`Aperture at ${shown} answered HTTP ${res.status}`);
		}
		return res;
	};

	const request = async <T>(method: string, params: object = {}, maxBytes = MAX_BODY_BYTES): Promise<T> => {
		const id = nextId++;
		const res = await post({ jsonrpc: "2.0", id, method, params });
		const sid = res.headers.get("mcp-session-id");
		if (sid) sessionId = sid;
		const reply = await readReply(res, id, Math.min(maxBytes, MAX_BODY_BYTES));
		if (reply.error) throw new McpError(method, reply.error.code, reply.error.message);
		return reply.result as T;
	};

	await request("initialize", {
		protocolVersion: PROTOCOL_VERSION,
		capabilities: {},
		clientInfo: { name: "pi-aperture-skills", version: "0.1.0" },
	});
	await discard(await post({ jsonrpc: "2.0", method: "notifications/initialized" }));

	return {
		request,
		async close() {
			if (!sessionId) return;
			// Best effort by design: the skills are already on disk, and the
			// server expires abandoned sessions, so a failed DELETE changes
			// nothing for the user. The short timeout keeps a hung server from
			// stalling pi's startup after the sync itself has finished.
			await fetch(url, {
				method: "DELETE",
				headers: { "mcp-session-id": sessionId },
				signal: AbortSignal.timeout(1000),
			}).catch(() => undefined);
		},
	};
}

interface JsonRpcReply {
	id?: number;
	result?: unknown;
	error?: { code: number; message: string };
}

/**
 * Reads the reply to request `id` from a JSON or SSE response body, never
 * buffering more than `maxBytes`. SSE events are parsed as they arrive
 * and reading stops at the matching reply, so a server that keeps the stream
 * open after answering doesn't stall us.
 */
async function readReply(res: Response, id: number, maxBytes: number): Promise<JsonRpcReply> {
	if (Number(res.headers.get("content-length") ?? 0) > maxBytes) {
		await discard(res);
		throw new ResponseTooLargeError(maxBytes);
	}
	const sse = (res.headers.get("content-type") ?? "").includes("text/event-stream");
	const decoder = new TextDecoder();
	let size = 0;
	// Pending text is kept as pieces and joined only once an event is
	// complete. Each new piece is searched together with the last 3 chars
	// before it (a `\r\n\r\n` can straddle chunks), so a large event costs
	// O(size) overall rather than O(size × chunks).
	let pending: string[] = [];
	let tail = "";
	const boundary = /\r?\n\r?\n/;
	// Throwing or returning out of `for await` cancels the stream.
	for await (const chunk of res.body ?? []) {
		size += chunk.byteLength;
		if (size > maxBytes) throw new ResponseTooLargeError(maxBytes);
		const text = decoder.decode(chunk, { stream: true });
		pending.push(text);
		const window = tail + text;
		tail = window.slice(-3);
		if (!sse || !boundary.test(window)) continue;
		const events = pending.join("").split(/\r?\n\r?\n/);
		const rest = events.pop()!; // the last piece may be incomplete
		const reply = events.map(parseEvent).find((m) => m?.id === id);
		if (reply) return reply;
		pending = [rest];
		tail = rest.slice(-3);
	}
	let buffer = pending.join("");
	buffer += decoder.decode();
	const reply = sse ? parseEvent(buffer) : (JSON.parse(buffer) as JsonRpcReply);
	if (reply?.id !== id) throw new Error(`Aperture sent no reply to request ${id}`);
	return reply;
}

/** Parses one SSE event's joined `data:` lines; undefined if it has none. */
function parseEvent(event: string): JsonRpcReply | undefined {
	const data = event
		.split(/\r?\n/)
		.filter((line) => line.startsWith("data:"))
		.map((line) => line.slice(5).trimStart())
		.join("\n");
	return data ? (JSON.parse(data) as JsonRpcReply) : undefined;
}

/** Cancels a body we won't read, freeing its connection. Never throws. */
async function discard(res: Response): Promise<void> {
	await res.body?.cancel().catch(() => undefined);
}
