// 把 page 画成一个网页并打开：show 写成 ~/x2/pages/<名字>.html 再打开（只看，不用常驻服务）；
// ask 在本机起一个一次性的服务，页面提交答案后就关掉，答案交回调用的命令（agent 在那里等）
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { home } from "../store.ts";
import type { Answer, Page } from "./spec.ts";

const web = (name: string) => readFileSync(new URL(`./web/${name}`, import.meta.url), "utf8");
// 放进 <script> 的 JSON：</script> 和 <!-- 会提前结束脚本，转义掉
const safe = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c");

function html(page: Page, answerUrl?: string): string {
	return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${page.title.replace(/</g, "&lt;")}</title><style>${web("style.css")}</style></head>
<body><div id="root"></div><script>window.X2_PAGE=${safe(page)};window.X2_ANSWER=${safe(answerUrl ?? null)};</script><script>${web("render.js")}</script></body></html>`;
}

// X2_NO_OPEN：不自动打开（测试时由别的方式打开页面）
const open = (target: string) => { if (!process.env.X2_NO_OPEN) execFile("open", [target], () => {}); };

export async function show(page: Page, name: string): Promise<string> {
	const dir = join(home, "pages");
	await mkdir(dir, { recursive: true });
	const file = join(dir, `${name}.html`);
	await writeFile(file, html(page));
	open(file);
	return file;
}

export function ask(page: Page): Promise<Answer> {
	return new Promise((resolve) => {
		const server = createServer((req, res) => {
			if (req.method === "POST" && req.url === "/answer") {
				let body = "";
				req.on("data", (c) => { body += c; });
				req.on("end", () => {
					res.writeHead(204).end();
					server.close();
					resolve(JSON.parse(body) as Answer);
				});
				return;
			}
			res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html(page, "/answer"));
		});
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address() as { port: number };
			const url = `http://127.0.0.1:${port}/`;
			console.error(`等你在页面上操作：${url}`);
			open(url);
		});
	});
}
