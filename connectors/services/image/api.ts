// 图片的字节：取图（1688 的 CDN 防盗链，要带浏览器的 UA 和 Referer）、认格式（看文件头，不信扩展名）、宽高、内容哈希。
// 一张图的身份是字节的 sha256，不是地址：1688 的地址带缓存参数（?__r__=…），同一张图换了参数会被当成两张、各付一次钱
import { createHash } from "node:crypto";

export const MAX_BYTES = 15 * 1024 * 1024;
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export type Bytes = { bytes: Uint8Array; mime: string; sha256: string; width: number; height: number };

export const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

export function mimeOf(b: Uint8Array): string | null {
	if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
	if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
	if (String.fromCharCode(...b.slice(0, 4)) === "RIFF" && String.fromCharCode(...b.slice(8, 12)) === "WEBP") return "image/webp";
	return null;
}

export function sizeOf(b: Uint8Array): { width: number; height: number } | null {
	const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
	const mime = mimeOf(b);
	if (mime === "image/png" && b.length >= 24) return { width: v.getUint32(16), height: v.getUint32(20) };
	if (mime === "image/jpeg") {
		for (let i = 2; i + 9 < b.length; ) {
			if (b[i] !== 0xff) {
				i++;
				continue;
			}
			const marker = b[i + 1]!;
			// SOF0–SOF15，除了 DHT(C4)、JPG(C8)、DAC(CC)
			if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { width: v.getUint16(i + 7), height: v.getUint16(i + 5) };
			if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
				i += 2;
				continue;
			}
			i += 2 + v.getUint16(i + 2);
		}
		return null;
	}
	if (mime === "image/webp" && b.length >= 30) {
		const chunk = String.fromCharCode(...b.slice(12, 16));
		if (chunk === "VP8 ") return { width: v.getUint16(26, true) & 0x3fff, height: v.getUint16(28, true) & 0x3fff };
		if (chunk === "VP8L") {
			const n = v.getUint32(21, true);
			return { width: (n & 0x3fff) + 1, height: ((n >> 14) & 0x3fff) + 1 };
		}
		if (chunk === "VP8X") return { width: 1 + (b[24]! | (b[25]! << 8) | (b[26]! << 16)), height: 1 + (b[27]! | (b[28]! << 8) | (b[29]! << 16)) };
	}
	return null;
}

export function inspect(bytes: Uint8Array, from = "图片"): Bytes {
	if (bytes.length > MAX_BYTES) throw new Error(`${from} 太大（${Math.round(bytes.length / 1048576)}MB，最多 15MB）`);
	const mime = mimeOf(bytes);
	if (!mime) throw new Error(`${from} 不是 JPEG、PNG、WebP`);
	const size = sizeOf(bytes);
	if (!size) throw new Error(`${from} 量不出宽高`);
	return { bytes, mime, sha256: sha256(bytes), ...size };
}

/** 取一张网上的图。1688（alicdn）要带 Referer，不然 403 */
export async function fetchImage(url: string, options?: Pick<RequestInit, "redirect">): Promise<Bytes> {
	const u = new URL(url.startsWith("//") ? `https:${url}` : url);
	const r = await fetch(u, { ...options, headers: { "user-agent": UA, referer: `https://${u.host}/` }, signal: AbortSignal.timeout(30_000) });
	if (!r.ok) throw new Error(`取图 HTTP ${r.status}：${u.href}`);
	return inspect(new Uint8Array(await r.arrayBuffer()), u.href);
}
