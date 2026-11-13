// 原生上传块先加载伴随依赖，之后才可初始化服务；这里只准备服务，绝不上传图片。
import assert from "node:assert/strict";
import { test } from "node:test";
import { prepareUploadService } from "./products.ts";

type UploadContext = NonNullable<Parameters<typeof prepareUploadService>[0]>;

function fixture(failDependency = false, unrelatedModule = false, poisonedInitializer = false) {
	const loaded = new Set<number>();
	const required: string[] = [];
	let uploads = 0;
	const service = {
		uploadImage: async () => {
			uploads++;
			return { data: { resourceId: "fixture" } };
		},
	};
	const req = Object.assign(
		(id: string): Record<string, unknown> => {
			required.push(id);
			if (!loaded.has(63) || !loaded.has(36)) throw new Error("原生依赖尚未加载，不能初始化模块");
			if (id === "10") throw new Error("不能初始化仅引用uploadImage的UI模块");
			if (poisonedInitializer) return {};
			return { default: service };
		},
		{
			m: {
				...(unrelatedModule ? { 10: { toString: () => "component.setup(){ uploadImage() }" } } : {}),
				51: { toString: () => "()=>Promise.all([i.e(63),i.e(36)]).then(i.bind(i,325)).then(e=>e.default)" },
				325: { toString: () => "t.default=new a.UploadService({qualityDetection:true})" },
			},
			u: (id: number) => (id === 36 ? "product/js/upload.fixture.js" : undefined),
			e: async (id: number) => {
				if (failDependency && id === 63) throw new Error("依赖下载失败");
				loaded.add(id);
			},
		},
	);
	const context: UploadContext = { webpackChunkProduct: { push: (chunk: [string[], unknown, (req: unknown) => void]) => chunk[2](req) } };
	return { context, loaded, required, service, uploads: () => uploads };
}

test("Shopee 原生 upload loader 的伴随块必须先准备，支持 default 实例且不上传", async () => {
	const f = fixture();
	assert.equal(await prepareUploadService(f.context), true);
	assert.deepEqual(
		[...f.loaded].sort((a, b) => a - b),
		[36, 63],
	);
	assert.deepEqual(f.required, ["325"]);
	assert.equal(f.context.__x2Upload, f.service);
	assert.equal(f.uploads(), 0);
	assert.equal(await prepareUploadService(f.context), true);
	assert.deepEqual(f.required, ["325"]);
});

test("伴随块失败不提前 require，避免半初始化缓存，留给下一次重新准备", async () => {
	const f = fixture(true);
	assert.equal(await prepareUploadService(f.context), false);
	assert.deepEqual(f.required, []);
	assert.equal(f.context.__x2Upload, undefined);
	assert.equal(f.uploads(), 0);
});

test("只初始化原生loader返回的服务模块，不require仅引用uploadImage的UI模块", async () => {
	const f = fixture(false, true);
	assert.equal(await prepareUploadService(f.context), true);
	assert.deepEqual(f.required, ["325"]);
	assert.equal(f.uploads(), 0);
});

test("早期初始化留下空exports时不伪装服务、不自行重构实例或上传", async () => {
	const f = fixture(false, true, true);
	assert.equal(await prepareUploadService(f.context), false);
	assert.deepEqual(f.required, ["325"]);
	assert.equal(f.context.__x2Upload, undefined);
	assert.equal(f.uploads(), 0);
});

test("仍支持旧版 UploadService 构造器的原生 $instance，不自行构造实例", async () => {
	let constructed = 0;
	class UploadService {
		static $instance = { uploadImage: async () => ({ data: { resourceId: "legacy" } }) };
		constructor() {
			constructed++;
		}
		async uploadImage() {
			throw new Error("不应调用构造器原型");
		}
	}
	const req = Object.assign(() => ({ UploadService }), { m: { 44: { toString: () => "class UploadService { uploadImage() {} }" } }, e: async () => {} });
	const context: UploadContext = { webpackChunkProduct: { push: (chunk: [string[], unknown, (req: unknown) => void]) => chunk[2](req) } };
	assert.equal(await prepareUploadService(context), true);
	assert.equal(context.__x2Upload, UploadService.$instance);
	assert.equal(constructed, 0);
});
