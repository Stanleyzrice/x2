// 批量上架（mass upload）。一个一个建商品，必填的认证属性会被一个一个点名、补不完，所以 lilto 旧工作台走的是批量：
// 下模板 → 在本机把数据填进 xlsx → 传模板 → 等解析（异步）→ 草稿池里等图摄取完 → 发布成下架 → 人看过再上架。
// 模板按店发（列 = 这家店的物流渠道），不能存下来给别的店用；给了类目 id 才有 ps_product_global_attribute.<id> 这类属性列。
// xlsx 在页面和本机之间用 base64 传（cdp-relay 只传得了 JSON）
import { page } from "../../browser.ts";
import { ORIGIN, seller, type Write, write } from "./seller.ts";

/** 在页面里 GET 一个文件，回 base64 */
async function download(path: string): Promise<string> {
	const p = await page(ORIGIN);
	const r = await p.run(async (path: string) => {
		const cookie = (n: string) =>
			document.cookie
				.split("; ")
				.find((c) => c.startsWith(`${n}=`))
				?.slice(n.length + 1) ?? "";
		const url = new URL(path, location.origin);
		url.searchParams.set("SPC_CDS", cookie("SPC_CDS"));
		url.searchParams.set("SPC_CDS_VER", "2");
		const res = await fetch(url.href, { credentials: "include", headers: { "x-csrftoken": cookie("csrftoken") } });
		if (!res.ok) return { error: `HTTP ${res.status}` };
		const bytes = new Uint8Array(await res.arrayBuffer());
		if (bytes.length < 1000) return { error: `只有 ${bytes.length} 字节，不像 xlsx：${new TextDecoder().decode(bytes).slice(0, 200)}` };
		let bin = "";
		for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
		return { b64: btoa(bin) };
	}, path);
	if ("error" in r) throw new Error(`下载 ${path}：${r.error}`);
	return r.b64;
}

/** 批量上架的模板（xlsx 的 base64）。给了叶子类目 id 是类目模板（带这个类目的属性列），不给是 41 列的基础模板 */
export const template = (categoryId?: number) =>
	download(
		categoryId
			? `/api/tool/mass_product/download_template/?category_id=${categoryId}&timestamp=${Date.now()}`
			: `/api/tool/mass_product/download_basic_template/?timestamp=${Date.now()}`,
	);

/** 最近的批量上传记录（解析好没有、成功几行、失败几行、记录 id） */
export async function records(pageSize = 30): Promise<any[]> {
	const b = await seller("/api/tool/mass_product/get_mass_record_list/", {
		query: { operation_type: 2, page_number: 1, page_size: Math.max(10, Math.min(100, pageSize)) },
	});
	return b.data?.list ?? b.data?.records ?? [];
}

/** 一次上传的坏行报告（xlsx 的 base64，原因在 et_title_reason 列） */
export const recordFile = (recordId: number) => download(`/api/tool/mass_product/download_record_file/?record_id=${recordId}&timestamp=${Date.now()}`);

export type Draft = { id: string; parentSku: string; name: string; imagesPending: boolean };

/** 草稿池（传上去、还没发布的）。id 是 unpublished_product_id，不是商品 id（猜错了发布时平台照收一串空 id、什么都不做）。
 * 图还在摄取（imagesPending）时不能发布：发了会丢图，补不回来 */
export async function drafts(): Promise<Draft[]> {
	const b = await seller("/api/tool/mass_product/get_unpublished_product_list/", { query: { page_number: 1, page_size: 100 } });
	return ((b.data?.list ?? b.data?.products ?? []) as any[]).map((d) => ({
		id: String(d.unpublished_product_id ?? d.unpublished_id ?? d.id ?? ""),
		parentSku: String(d.sku_parent_short ?? d.parent_sku ?? ""),
		name: String(d.name ?? d.product_name ?? ""),
		// images 是图片 id 的数组；有 need_upload 就信它，没有时空数组算还没摄取完
		imagesPending: Boolean(d.need_upload) || (d.images ?? []).some((x: any) => x?.need_upload) || (d.images ?? []).length === 0,
	}));
}

// ── 写（没在 x2 里跑过） ──

/** 写：传填好的模板。站点当场受理，解析是异步的：之后看 records() */
export async function upload(base64: string, filename = "x2.xlsx"): Promise<Write> {
	const p = await page(ORIGIN);
	return p.run(
		async (b64: string, filename: string) => {
			const cookie = (n: string) =>
				document.cookie
					.split("; ")
					.find((c) => c.startsWith(`${n}=`))
					?.slice(n.length + 1) ?? "";
			const bin = atob(b64);
			const bytes = new Uint8Array(bin.length);
			for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
			const fd = new FormData();
			fd.append("file", new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), filename);
			try {
				const r = await fetch(`/api/mass/mpsku/upload_template?timestamp=${Date.now()}&SPC_CDS=${cookie("SPC_CDS")}&SPC_CDS_VER=2`, {
					method: "POST",
					credentials: "include",
					headers: { "x-csrftoken": cookie("csrftoken") },
					body: fd,
				});
				const j = await r.json();
				return j?.code === 0 ? { kind: "done" as const, data: j.data } : { kind: "refused" as const, code: j?.code, why: String(j?.message ?? "") };
			} catch (e) {
				return { kind: "unknown" as const, why: String((e as Error)?.message ?? e) };
			}
		},
		base64,
		filename,
	);
}

/** 写：把草稿发布出去。默认发成下架（unlisted），人在卖家中心看过再上架；直接开卖的路径 lilto 五次都回 10025。
 * 回 1000100007 时结果未知 */
export function publish(ids: string[], asListed = false): Promise<Write> {
	return write("/api/tool/mass_product/publish_product/", { body: { unpublished_ids: ids.map(Number), unlisted: !asListed } });
}

/** 写：删草稿池里的条目（只接 unpublished_product_id，不接商品 id） */
export function deleteDrafts(ids: string[]): Promise<Write> {
	return write("/api/tool/mass_product/delete_product/", { body: { unpublished_ids: ids.map(Number) } });
}
