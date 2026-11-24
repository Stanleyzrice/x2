import type { IncomingMessage } from "node:http";
import { basename, isAbsolute } from "node:path";
import { z } from "zod";
import { close, type Sql, setDatabase } from "../db/index.ts";
import { saveSetupSettings } from "../env.ts";
import { NeedsHuman, Usage } from "../errors.ts";
import { invoke } from "../tool.ts";
import { flashModel, hermesModel } from "../ui/hermes-schema.ts";
import { listBrowserAuthorizations } from "./browser-authorizations.ts";
import { requestOriginUrl } from "./browser-connection.ts";
import { ensureWorkspaces } from "./pages.ts";

export type SetupState = { ready: boolean; database: boolean; local: boolean; hermes: boolean; xiangji: boolean; model: string; shop: string | null };
export type Route = (body: Record<string, unknown>, url: URL, req: IncomingMessage) => Promise<unknown>;

const loopback = new Set(["127.0.0.1", "[::1]", "localhost"]);

export function localRequest(req: IncomingMessage, port: number): boolean {
	const address = req.socket.remoteAddress ?? "";
	const host = URL.parse(`http://${req.headers.host ?? ""}`);
	return ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(address) && !!host && loopback.has(host.hostname) && Number(host.port || "80") === port;
}

export function requireLocal(req: IncomingMessage, port: number): void {
	if (!localRequest(req, port)) throw new Usage("请在运行 X2 的电脑上打开本机地址后操作");
	if (req.method !== "GET" && (!req.headers.origin || requestOriginUrl(req.headers.origin).host !== req.headers.host))
		throw new Usage("请在当前 X2 页面完成操作");
}

const databaseInput = z.object({ url: z.string().trim().min(1).max(4096) });
const apiKey = z
	.string()
	.trim()
	.min(1)
	.max(300)
	.regex(/^[\x21-\x7e]+$/);
const xiangjiInput = z.strictObject({ userKey: apiKey, imgTransKey: apiKey });
export type XiangjiInput = z.input<typeof xiangjiInput>;
const modelInput = z.object({
	apiKey: apiKey.optional(),
	model: hermesModel,
	python: z
		.string()
		.trim()
		.max(1000)
		.refine((path) => isAbsolute(path) && /^python(?:3(?:\.\d+)?)?(?:\.exe)?$/i.test(basename(path)))
		.optional(),
});
const bindInput = z.object({ accountId: z.string().regex(/^\d+$/) });

export function setupRoutes(workspace: () => Promise<Sql>, port: () => number, persist: boolean): Record<string, Route> {
	let configuringDatabase = false;
	const state = async (req: IncomingMessage): Promise<SetupState> => {
		const local = localRequest(req, port());
		const database = await workspace().then(
			() => true,
			() => false,
		);
		const hermes = Boolean(process.env.DEEPSEEK_API_KEY?.trim());
		return {
			ready: database && (process.env.X2_SETUP_COMPLETE === "1" || !local),
			database,
			local,
			hermes,
			xiangji: Boolean(process.env.XIANGJI_USER_KEY?.trim() && process.env.XIANGJI_IMG_TRANS_KEY?.trim()),
			model: process.env.X2_HERMES_MODEL?.trim() || flashModel,
			shop: process.env.X2_DEFAULT_SHOP?.trim() || null,
		};
	};
	return {
		"GET /api/setup": async (_b, _url, req) => state(req),
		"POST /api/setup/database": async (raw, _url, req) => {
			requireLocal(req, port());
			if (!persist || configuringDatabase) throw new Usage("当前工作台正在使用数据库");
			const checked = databaseInput.safeParse(raw);
			const url = checked.success && URL.parse(checked.data.url);
			if (!url || !["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname || url.pathname.length < 2)
				throw new Usage("请填写包含主机和数据库名的 PostgreSQL 连接地址");
			configuringDatabase = true;
			try {
				if (
					await workspace().then(
						() => true,
						() => false,
					)
				)
					throw new Usage("数据库已连接。若要更换，请重新启动 X2 并指定新地址");
				setDatabase(url.href);
				try {
					await workspace();
				} catch {
					await close();
					setDatabase(null);
					throw new NeedsHuman("无法初始化数据库，请确认数据库已启动、连接信息正确且账号可建表");
				}
				await saveSetupSettings({ X2_DATABASE_URL: url.href }, persist);
				return state(req);
			} finally {
				configuringDatabase = false;
			}
		},
		"POST /api/setup/hermes": async (raw, _url, req) => {
			requireLocal(req, port());
			const p = modelInput.safeParse(raw);
			if (!p.success) throw new Usage("请检查 DeepSeek 接口密钥和模型");
			await invoke("hermes.check-connection", p.data);
			await saveSetupSettings(
				{
					...(p.data.apiKey ? { DEEPSEEK_API_KEY: p.data.apiKey } : {}),
					...(p.data.python ? { X2_HERMES_PYTHON: p.data.python } : {}),
					X2_HERMES_MODEL: p.data.model,
				},
				persist,
			);
			return state(req);
		},
		"POST /api/setup/xiangji": async (raw, _url, req) => {
			requireLocal(req, port());
			const p = xiangjiInput.safeParse(raw);
			if (!p.success) throw new Usage("请同时填写象寄的 UserKey 和 ImgTransKey，两项均为无空格的密钥");
			await saveSetupSettings({ XIANGJI_USER_KEY: p.data.userKey, XIANGJI_IMG_TRANS_KEY: p.data.imgTransKey }, persist);
			return state(req);
		},
		"GET /api/setup/shops": async (_raw, _url, req) => {
			requireLocal(req, port());
			return listBrowserAuthorizations(await workspace(), "shopee");
		},
		"POST /api/setup/shop": async (raw, _url, req) => {
			requireLocal(req, port());
			const p = bindInput.safeParse(raw);
			if (!p.success) throw new Usage("请选择已验证店铺");
			const sql = await workspace();
			const account = (await listBrowserAuthorizations(sql, "shopee")).find((entry) => entry.accountId === p.data.accountId);
			if (!account) throw new Usage("请先通过当前浏览器核实这家店铺");
			const { shop } = z.object({ shop: z.string() }).parse(await invoke("listing.configure-shop", { name: account.accountName, shopId: account.accountId }));
			await saveSetupSettings({ X2_DEFAULT_SHOP: shop }, persist);
			await ensureWorkspaces(sql);
			return state(req);
		},
		"POST /api/setup/finish": async (_raw, _url, req) => {
			requireLocal(req, port());
			await workspace();
			await saveSetupSettings({ X2_SETUP_COMPLETE: "1" }, persist);
			return state(req);
		},
	};
}
