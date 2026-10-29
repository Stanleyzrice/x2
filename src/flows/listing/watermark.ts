// 水印：在浏览器里用 canvas 画（不加原生依赖，用系统的中文和 emoji 字体）。照 lilto 的 page/shopee/image-render.ts（快照 1c8a7926）：
// 字号、边距按短边 / 800 缩放，位置五选一，文字太长横向压缩。和 lilto 不一样：字加一圈白色描边（lilto 的 #222 字在深色图上看不见，整个商品卡住过）；
// 先铺白底再画（透明的 PNG 转 JPEG 不变黑）；出 JPEG（比 PNG 小，传得快）。图用 data URL 传进页面，canvas 不会被跨域污染

import type { Mark } from "../../domain/listing/pics.ts";
import { type Bytes, inspect } from "../../services/image.ts";
import { page } from "../../sites/browser.ts";

/** 画法变了就加一：水印缓存按「原图 + 设置 + 版本」 */
export const WATERMARK_VERSION = 1;
export const markKey = (m: Mark) => `水印:${WATERMARK_VERSION}:${JSON.stringify([m.text, m.size, m.opacity, m.position])}`;

/** 给一张图加本店水印，回成品（JPEG）。在当前选中的浏览器里画（about:blank 不行：cdp-relay 只开有网址的标签页，用卖家中心） */
export async function watermark(img: { bytes: Uint8Array; mime: string }, mark: Mark): Promise<Bytes> {
	const p = await page("https://seller.shopee.tw");
	const r = await p.run(
		async (dataUrl: string, mark: { text: string; size: number; opacity: number; position: string }) => {
			const image = new Image();
			await new Promise<void>((ok, bad) => {
				image.onload = () => ok();
				image.onerror = () => bad(new Error("图解不开"));
				image.src = dataUrl;
			});
			const width = image.naturalWidth,
				height = image.naturalHeight;
			if (width * height > 40_000_000) return { error: `图太大（${width}×${height}）` };
			const canvas = document.createElement("canvas");
			canvas.width = width;
			canvas.height = height;
			const ctx = canvas.getContext("2d")!;
			ctx.fillStyle = "#fff";
			ctx.fillRect(0, 0, width, height);
			ctx.drawImage(image, 0, 0);
			const scale = Math.min(width, height) / 800;
			const px = mark.size * scale,
				pad = 32 * scale;
			ctx.font = `${px}px sans-serif`;
			const [v, h] = mark.position === "center" ? ["middle", "center"] : mark.position.split("-");
			ctx.textAlign = h === "left" ? "left" : h === "right" ? "right" : "center";
			ctx.textBaseline = v === "top" ? "top" : v === "bottom" ? "bottom" : "middle";
			const x = h === "left" ? pad : h === "right" ? width - pad : width / 2;
			const y = v === "top" ? pad : v === "bottom" ? height - pad : height / 2;
			ctx.globalAlpha = mark.opacity;
			ctx.lineJoin = "round";
			ctx.lineWidth = Math.max(2, px * 0.12);
			ctx.strokeStyle = "#fff";
			ctx.strokeText(mark.text, x, y, width - pad * 2);
			ctx.fillStyle = "#222";
			ctx.fillText(mark.text, x, y, width - pad * 2);
			const out = canvas.toDataURL("image/jpeg", 0.92);
			return { base64: out.slice(out.indexOf(",") + 1) };
		},
		`data:${img.mime};base64,${Buffer.from(img.bytes).toString("base64")}`,
		mark,
	);
	if ("error" in r) throw new Error(`加水印：${r.error}`);
	return inspect(new Uint8Array(Buffer.from(r.base64, "base64")), "水印成品");
}
