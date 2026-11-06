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

export interface McpSession {
	/** Sends a request and resolves with its `result`. */
	request<T>(method: string, params?: object): Promise<T>;
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
			const cause = (err as { cause?: { message?: string } }).cause?.message;
			throw new Error(`could not reach Aperture at ${shown}: ${cause ?? (err as Error).message}`);
		}
		if (!res.ok && res.status !== 202) {
			throw new Error(`Aperture at ${shown} answered HTTP ${res.status}`);
		}
		return res;
	};

	const request = async <T>(method: string, params: object = {}): Promise<T> => {
		const id = nextId++;
		const res = await post({ jsonrpc: "2.0", id, method, params });
		const sid = res.headers.get("mcp-session-id");
		if (sid) sessionId = sid;
		const reply = await readReply(res, id);
		if (reply.error) throw new McpError(method, reply.error.code, reply.error.message);
		return reply.result as T;
	};

	await request("initialize", {
		protocolVersion: PROTOCOL_VERSION,
		capabilities: {},
		clientInfo: { name: "pi-aperture-skills", version: "0.1.0" },
	});
	await post({ jsonrpc: "2.0", method: "notifications/initialized" });

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

/** Reads the reply to request `id` from a JSON or SSE response body. */
async function readReply(res: Response, id: number): Promise<JsonRpcReply> {
	const body = await readCapped(res);
	const type = res.headers.get("content-type") ?? "";
	const messages: JsonRpcReply[] = type.includes("text/event-stream")
		? body
				.split(/\r?\n\r?\n/)
				.map((event) =>
					event
						.split(/\r?\n/)
						.filter((line) => line.startsWith("data:"))
						.map((line) => line.slice(5).trimStart())
						.join("\n"),
				)
				.filter((data) => data !== "")
				.map((data) => JSON.parse(data) as JsonRpcReply)
		: [JSON.parse(body) as JsonRpcReply];
	const reply = messages.find((m) => m.id === id);
	if (!reply) throw new Error(`Aperture sent no reply to request ${id}`);
	return reply;
}

/** Reads the body as text, failing once it passes `MAX_BODY_BYTES`. */
async function readCapped(res: Response): Promise<string> {
	const tooBig = () => new Error(`Aperture sent a response over ${MAX_BODY_BYTES} bytes`);
	if (Number(res.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) throw tooBig();
	if (!res.body) return "";
	const chunks: Uint8Array[] = [];
	let size = 0;
	for await (const chunk of res.body) {
		size += chunk.byteLength;
		// Throwing out of `for await` cancels the stream.
		if (size > MAX_BODY_BYTES) throw tooBig();
		chunks.push(chunk);
	}
	return Buffer.concat(chunks).toString("utf8");
}
