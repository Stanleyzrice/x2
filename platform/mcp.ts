import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, type CallToolResult, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";

/** 只向持有本次密钥的本机进程开放工具。按次销毁，等已开始的调用完成后才关闭数据库。 */
export async function withLocalTools<T>(
	tools: Tool[],
	call: (name: string, args: Record<string, unknown>) => Promise<CallToolResult>,
	use: (connection: { url: string; token: string }) => Promise<T>,
): Promise<T> {
	const token = randomUUID(),
		authorization = Buffer.from(`Bearer ${token}`);
	const mcp = new Server({ name: "x2", version: "1" }, { capabilities: { tools: {} } });
	const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID, enableJsonResponse: true });
	let pending = Promise.resolve(),
		closing = false;
	mcp.setRequestHandler(ListToolsRequestSchema, () => ({ tools }));
	mcp.setRequestHandler(CallToolRequestSchema, ({ params }) => {
		const work = pending.then(async (): Promise<CallToolResult> => {
			try {
				if (closing) throw new Error("本次工具连接已结束");
				return await call(params.name, params.arguments ?? {});
			} catch (error) {
				return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : "工具调用失败" }] };
			}
		});
		pending = work.then(() => undefined);
		return work;
	});
	await mcp.connect(transport);
	const listener = createServer((req, res) => {
		const given = Buffer.from(req.headers.authorization ?? "");
		if (closing || req.url !== "/mcp" || given.length !== authorization.length || !timingSafeEqual(given, authorization)) {
			res.writeHead(403).end();
			return;
		}
		void transport.handleRequest(req, res).catch(() => {
			if (res.headersSent) res.destroy();
			else res.writeHead(500).end();
		});
	});
	try {
		await new Promise<void>((ok, fail) => listener.once("error", fail).listen(0, "127.0.0.1", ok));
		const { port } = listener.address() as { port: number };
		return await use({ url: `http://127.0.0.1:${port}/mcp`, token });
	} finally {
		closing = true;
		await pending;
		await mcp.close();
		await new Promise<void>((ok) => {
			listener.close(() => ok());
			listener.closeAllConnections();
		});
	}
}
