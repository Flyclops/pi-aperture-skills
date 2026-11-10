/**
 * A fake Aperture MCP endpoint for tests. It speaks the slice of Streamable
 * HTTP the extension uses: `initialize` hands out a session id, and
 * `skills/list` / `resources/read` answer as SSE `data:` lines, like Aperture.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeSkill {
	/** e.g. `skill://personal/tdd/SKILL.md` */
	uri: string;
	name: string;
	/** File URI → text content. Must include `uri` itself. */
	files: Record<string, string>;
}

export interface FakeAperture {
	url: string;
	/** Methods received, in order; a session close is recorded as "DELETE". */
	calls: string[];
	/** Whether the session was closed with DELETE. */
	closed: boolean;
	close(): Promise<void>;
}

export interface FakeOptions {
	skills: FakeSkill[];
	/** URIs whose `resources/read` should fail. */
	failReads?: string[];
	/** Delay every response by this many ms. */
	delayMs?: number;
	/** Answer `skills/list` with JSON-RPC "method not found". */
	noSkillsMethod?: boolean;
	/** Page size for `skills/list` (default: everything on one page). */
	pageSize?: number;
	/** Never answer the session-closing DELETE. */
	hangDelete?: boolean;
	/** Raw entries appended to the `skills/list` result, e.g. malformed ones. */
	rawListing?: unknown[];
	/** Keep every SSE response open after sending the reply. */
	keepOpen?: boolean;
	/** Per-URI delay, in ms, before answering `resources/read`. */
	readDelayMs?: Record<string, number>;
	/** Send each SSE response in pieces of this many bytes. */
	chunkBytes?: number;
	/**
	 * URIs whose `resources/read` starts an endless body: `"error"` with HTTP
	 * 500, `"huge"` with a Content-Length over the client's limit. When the
	 * client hangs up, `cancelled <uri>` is recorded in `calls`.
	 */
	endlessReads?: Record<string, "error" | "huge">;
	/** Leave each skill's SKILL.md out of its listed `resources`. */
	omitMainResource?: boolean;
}

const SESSION = "test-session";

export async function startFakeAperture(opts: FakeOptions): Promise<FakeAperture> {
	const state = { calls: [] as string[], closed: false };
	const server: Server = createServer((req, res) => {
		// A client that aborts mid-request (the timeout test) makes the
		// request stream error; that's expected, so don't let it escape.
		handle(req, res).catch(() => res.destroy());
	});
	const handle = async (req: IncomingMessage, res: ServerResponse) => {
		if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
		if (req.method === "DELETE") {
			state.calls.push("DELETE");
			if (opts.hangDelete) return;
			state.closed = true;
			res.writeHead(204).end();
			return;
		}
		let body = "";
		for await (const chunk of req) body += chunk;
		const msg = JSON.parse(body) as { id?: number; method: string; params?: any };
		state.calls.push(msg.method);

		if (msg.method !== "initialize" && req.headers["mcp-session-id"] !== SESSION) {
			res.writeHead(400).end("missing session");
			return;
		}
		if (msg.id === undefined) {
			res.writeHead(202).end();
			return;
		}
		const reply = (payload: object, headers: Record<string, string> = {}) => {
			res.writeHead(200, { "content-type": "text/event-stream", ...headers });
			const event = `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, ...payload })}\n\n`;
			const step = opts.chunkBytes ?? event.length;
			for (let i = 0; i < event.length; i += step) res.write(event.slice(i, i + step));
			if (!opts.keepOpen) res.end();
		};

		switch (msg.method) {
			case "initialize":
				return reply({ result: { protocolVersion: "2025-06-18", capabilities: {} } }, {
					"mcp-session-id": SESSION,
				});
			case "skills/list": {
				if (opts.noSkillsMethod) {
					return reply({ error: { code: -32601, message: "Method not found" } });
				}
				const size = opts.pageSize ?? opts.skills.length;
				const start = Number(msg.params?.cursor ?? 0);
				const page = opts.skills.slice(start, start + size);
				const next = start + size < opts.skills.length ? String(start + size) : undefined;
				return reply({
					result: {
						skills: [...(start === 0 ? (opts.rawListing ?? []) : []), ...page.map((s) => ({
							uri: s.uri,
							frontmatter: { name: s.name, description: `${s.name} skill` },
							resources: Object.entries(s.files)
								.filter(([uri]) => !(opts.omitMainResource && uri === s.uri))
								.map(([uri, text]) => ({
								uri,
								size: text.length,
							})),
						}))],
						...(next ? { nextCursor: next } : {}),
					},
				});
			}
			case "resources/read": {
				const uri = msg.params.uri as string;
				const endless = opts.endlessReads?.[uri];
				if (endless) {
					res.on("close", () => state.calls.push(`cancelled ${uri}`));
					res.writeHead(endless === "error" ? 500 : 200, {
						"content-type": "text/event-stream",
						...(endless === "huge" ? { "content-length": String(1e9) } : {}),
					});
					res.write(": still going\n");
					return;
				}
				const wait = opts.readDelayMs?.[uri];
				if (wait) {
					await new Promise((r) => setTimeout(r, wait));
					state.calls.push(`read-done ${uri}`);
				}
				const text = opts.skills.map((s) => s.files[uri]).find((t) => t !== undefined);
				if (text === undefined || opts.failReads?.includes(uri)) {
					return reply({ error: { code: -32602, message: "Resource not found" } });
				}
				return reply({ result: { contents: [{ uri, text }] } });
			}
			default:
				return reply({ error: { code: -32601, message: "Method not found" } });
		}
	};
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const { port } = server.address() as AddressInfo;
	return {
		url: `http://127.0.0.1:${port}/v1/mcp`,
		get calls() {
			return state.calls;
		},
		get closed() {
			return state.closed;
		},
		close: () =>
			new Promise<void>((r) => {
				server.closeAllConnections();
				server.close(() => r());
			}),
	};
}

/** Builds a skill whose SKILL.md has valid pi frontmatter. */
export function skill(group: string, name: string, extra: Record<string, string> = {}): FakeSkill {
	const base = `skill://${group}/${name}`;
	const files: Record<string, string> = {
		[`${base}/SKILL.md`]: `---\nname: ${name}\ndescription: ${name} skill\n---\n# ${name}\n`,
	};
	for (const [rel, text] of Object.entries(extra)) files[`${base}/${rel}`] = text;
	return { uri: `${base}/SKILL.md`, name, files };
}
