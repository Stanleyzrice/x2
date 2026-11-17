// 原生上传块先加载伴随依赖，之后才可初始化服务；这里只准备服务，绝不上传图片。
import assert from "node:assert/strict";
import { test } from "node:test";
import { prepareUploadService, prepareUploadWithRecovery, uploadPageReloadBlock } from "./products.ts";

type UploadContext = NonNullable<Parameters<typeof prepareUploadService>[0]>;

type FixtureModule = { exports: Record<string, unknown> };
type FixtureFactory = (module: FixtureModule, exports: Record<string, unknown>, require: FixtureRequire) => void;
type FixtureRequire = ((id: string | number) => Record<string, unknown>) & {
	m: Record<string, FixtureFactory>;
	u: (id: number) => string | undefined;
	e: (id: number) => Promise<void>;
};

function mountedContext(extra: Record<string, unknown>, state = { pageReady: true }): UploadContext {
	return {
		name: "x2",
		location: { origin: "https://seller.shopee.tw", pathname: "/portal/product/new" },
		document: {
			get readyState() {
				return state.pageReady ? "complete" : "loading";
			},
			querySelector: () => ({ getClientRects: () => ({ length: state.pageReady ? 1 : 0 }) }),
		},
		...extra,
	};
}

function fixture(failDependency = false, unrelatedModule = false, throwInitializer = false, highChunks = false) {
	const loaded = new Set<number>();
	const required: (string | number)[] = [];
	const nativeCalls: { id: string | number; receiver: unknown }[] = [];
	const cache = new Map<string, FixtureModule>();
	const state = { pageReady: true, appReady: true };
	let factoryCalls = 0;
	let uploads = 0;
	let service: UploadService | undefined;
	class UploadService {
		constructor() {
			service = this;
		}
		async uploadImage() {
			uploads++;
			return { data: { resourceId: "fixture" } };
		}
	}
	const factories: Record<string, FixtureFactory> = {
		51: highChunks
			? function loader(_module, exports, i) {
					exports.load = () => Promise.all([i.e(763), i.e(936)]).then(i.bind(i, 325));
				}
			: function loader(_module, exports, i) {
					exports.load = () => Promise.all([i.e(63), i.e(36)]).then(i.bind(i, 325));
				},
		325: function initializeUploadService(_module, exports) {
			assert.ok(loaded.has(highChunks ? 763 : 63) && loaded.has(highChunks ? 936 : 36), "原生伴随依赖必须先加载");
			if (!state.appReady || throwInitializer) throw new Error("模拟首次模块工厂依赖未就绪");
			exports.default = new UploadService();
		},
	};
	if (unrelatedModule)
		factories[10] = function ui() {
			throw new Error("不能初始化仅引用uploadImage的UI模块");
		};
	const req: FixtureRequire = Object.assign(
		function (this: unknown, id: string | number): Record<string, unknown> {
			required.push(id);
			nativeCalls.push({ id, receiver: this });
			const key = String(id);
			const cached = cache.get(key);
			if (cached) return cached.exports;
			const module: FixtureModule = { exports: {} };
			// 忠实模拟真实runtime：先放缓存，再运行工厂；工厂抛错不会清掉这个空exports。
			cache.set(key, module);
			if (key === "325") factoryCalls++;
			const factory = req.m[key];
			assert.ok(factory, `模块${key}必须已注册`);
			factory.call(module.exports, module, module.exports, req);
			return module.exports;
		},
		{
			m: factories,
			u: (id: number) => (id === (highChunks ? 936 : 36) ? "product/js/upload.fixture.js" : undefined),
			e: async (id: number) => {
				if (failDependency && id === 63) throw new Error("依赖下载失败");
				loaded.add(id);
			},
		},
	);
	const context = mountedContext({ webpackChunkProduct: { push: (chunk: [string[], unknown, (req: unknown) => void]) => chunk[2](req) } }, state);
	return {
		context,
		req,
		state,
		loaded,
		cache,
		required,
		nativeCalls,
		get service() {
			return service;
		},
		factoryCalls: () => factoryCalls,
		uploads: () => uploads,
	};
}

test("Shopee 原生 upload loader 的伴随块必须先准备，支持 default 实例且不上传", async () => {
	const f = fixture();
	assert.equal(await prepareUploadService(f.context), true);
	assert.deepEqual(
		[...f.loaded].sort((a, b) => a - b),
		[36, 63],
	);
	assert.deepEqual(f.required, [325]);
	assert.equal(f.context.__x2Upload, f.service);
	assert.equal(f.uploads(), 0);
	assert.equal(await prepareUploadService(f.context), true);
	assert.deepEqual(f.required, [325]);
});

test("initializer忠实采用原生loader调用，不把参数形式当作真实缓存故障原因", async () => {
	const f = fixture();
	assert.equal(await prepareUploadService(f.context), true);
	assert.equal(f.context.__x2Upload, f.service);
	assert.equal(f.nativeCalls[0]?.id, 325);
	assert.equal(f.nativeCalls[0]?.receiver, f.req);
	assert.equal(f.req("325"), f.req.call(undefined, 325), "真实对象索引不区分数字和字符串，缓存不依赖require的this");
	assert.equal(f.uploads(), 0);
});

test("当前商品页的 rspackChunkProduct 仍按原生 loader 准备依赖和服务，不上传", async () => {
	const f = fixture(false, true);
	const context = mountedContext({ rspackChunkProduct: f.context.webpackChunkProduct });
	assert.equal(await prepareUploadService(context), true);
	assert.deepEqual(
		[...f.loaded].sort((a, b) => a - b),
		[36, 63],
	);
	assert.deepEqual(f.required, [325]);
	assert.equal(context.__x2Upload, f.service);
	assert.equal(f.uploads(), 0);
});

test("upload块可识别但原生loader尚未出现时不提前require，等页面加载完整后再准备", async () => {
	const f = fixture(false, true);
	const loader = f.req.m[51]!;
	Reflect.deleteProperty(f.req.m, "51");
	assert.equal(await prepareUploadService(f.context), false);
	assert.deepEqual(f.required, [], "不能因loader尚未加载而退回UI/服务模块猜测");
	assert.equal(f.loaded.size, 0, "尚不知道全部伴随依赖时不能只加载upload块");
	f.req.m[51] = loader;
	assert.equal(await prepareUploadService(f.context), true);
	assert.deepEqual(f.required, [325]);
	assert.equal(f.context.__x2Upload, f.service);
	assert.equal(f.uploads(), 0);
});

test("外层runtime仅提到uploadImage的UI模块不作为旧版上传服务初始化", async () => {
	const required: string[] = [];
	const req = Object.assign(
		(id: string) => {
			required.push(id);
			throw new Error("不能初始化UI模块");
		},
		{ m: { 10: { toString: () => "component.setup(){ uploadImage() }" } }, e: async () => {} },
	);
	const context = mountedContext({ webpackChunkShell: { push: (chunk: [string[], unknown, (req: unknown) => void]) => chunk[2](req) } });
	assert.equal(await prepareUploadService(context), false);
	assert.deepEqual(required, []);
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
	assert.deepEqual(f.required, [325]);
	assert.equal(f.uploads(), 0);
});

test("工厂真实抛错后留下空exports，保留首错并禁止再次初始化坏模块", async () => {
	const f = fixture(false, true, true);
	assert.equal(await prepareUploadService(f.context), false);
	assert.deepEqual(f.required, [325]);
	const first = f.context.__x2UploadPreparation?.firstFailure;
	assert.equal(first?.result, "threw");
	assert.equal(first?.error?.message, "模拟首次模块工厂依赖未就绪");
	assert.deepEqual(f.req(325), {}, "模拟原生runtime下一次只返回已缓存的空exports");
	const calls = f.required.length;
	assert.equal(await prepareUploadService(f.context), false);
	assert.equal(f.context.__x2UploadPreparation?.firstFailure, first);
	assert.equal(f.required.length, calls, "后续prepare不再require坏缓存");
	assert.equal(f.factoryCalls(), 1);
	assert.equal(f.context.__x2Upload, undefined);
	assert.equal(f.uploads(), 0);
});

test("页面未挂载不执行工厂，应用与表单就绪后才初始化；支持高位chunk编号", async () => {
	const f = fixture(false, true, false, true);
	f.state.pageReady = f.state.appReady = false;
	assert.equal(await prepareUploadService(f.context), false);
	assert.equal(f.context.__x2UploadPreparation?.status, "waiting");
	assert.equal(f.factoryCalls(), 0);
	assert.equal(f.loaded.size, 0);
	f.state.pageReady = f.state.appReady = true;
	assert.equal(await prepareUploadService(f.context), true);
	assert.deepEqual(
		[...f.loaded].sort((a, b) => a - b),
		[763, 936],
	);
	assert.equal(f.factoryCalls(), 1);
	assert.equal(f.context.__x2Upload, f.service);
	assert.equal(f.uploads(), 0);
});

test("共享upload块的UI loader优先出现也不能require；仅有UI时保持waiting", async () => {
	for (const hasService of [true, false]) {
		const f = fixture(false, true, false, true);
		// 数字模块1先于服务loader51被扫描，两者复用同一upload块936。
		f.req.m[1] = (_module, exports, i) => {
			exports.load = () => Promise.all([i.e(763), i.e(936)]).then(i.bind(i, 326));
		};
		f.req.m[326] = (_module, exports) => {
			exports.default = { uploadImage: () => "UI UploadDialog，并非上传服务" };
		};
		if (!hasService) Reflect.deleteProperty(f.req.m, "51");
		assert.equal(await prepareUploadService(f.context), hasService);
		assert.deepEqual(f.required, hasService ? [325] : []);
		assert.equal(f.cache.has("326"), false, "不得初始化UI或污染其缓存");
		assert.equal(f.context.__x2UploadPreparation?.status, hasService ? "ready" : "waiting");
		assert.equal(f.context.__x2UploadPreparation?.firstFailure, undefined);
	}
});

test("初始化返回空exports或非上传实例也属于终止失败，后续不重新require", async () => {
	for (const empty of [true, false]) {
		const f = fixture();
		f.req.m[325] = (_module, exports) => {
			if (empty) return;
			class UploadService {}
			exports.default = new UploadService();
		};
		assert.equal(await prepareUploadService(f.context), false);
		assert.equal(f.context.__x2UploadPreparation?.firstFailure?.result, empty ? "empty-exports" : "no-uploader");
		assert.equal(await prepareUploadService(f.context), false);
		assert.deepEqual(f.required, [325]);
		assert.equal(f.factoryCalls(), 1);
	}
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
	const req = Object.assign(() => ({ UploadService }), {
		m: { 44: { toString: () => "class UploadService { static $instance; uploadImage() {} }" } },
		e: async () => {},
	});
	const context = mountedContext({ webpackChunkProduct: { push: (chunk: [string[], unknown, (req: unknown) => void]) => chunk[2](req) } });
	assert.equal(await prepareUploadService(context), true);
	assert.equal(context.__x2Upload, UploadService.$instance);
	assert.equal(constructed, 0);
});

test("原生实例getter抛错时保留脱敏首错，后续prepare不再次require或触发getter", async () => {
	let requires = 0;
	let probes = 0;
	class UploadService {
		static get $instance() {
			probes++;
			throw new Error("实例尚不可用 https://example.com/upload?token=not-a-real-secret");
		}
		uploadImage() {
			throw new Error("旧版服务只能采用原生$instance，不能改用构造器原型");
		}
	}
	const req = Object.assign(
		() => {
			requires++;
			return { UploadService };
		},
		{ m: { 44: { toString: () => "class UploadService { static get $instance() {} }" } }, e: async () => {} },
	);
	const context = mountedContext({ webpackChunkProduct: { push: (chunk: [string[], unknown, (req: unknown) => void]) => chunk[2](req) } });
	assert.equal(await prepareUploadService(context), false);
	const first = context.__x2UploadPreparation?.firstFailure;
	assert.equal(first?.stage, "uploader");
	assert.equal(first?.result, "threw");
	assert.equal(first?.error?.message, "实例尚不可用 https://example.com/upload");
	assert.equal(await prepareUploadService(context), false);
	assert.equal(context.__x2UploadPreparation?.firstFailure, first);
	assert.equal(requires, 1);
	assert.equal(probes, 1);
});

const emptyUploadPage = () => ({
	owned: true,
	origin: "https://seller.shopee.tw",
	pathname: "/portal/product/new",
	plainRoute: true,
	ready: true,
	titleFields: 1,
	descriptionFields: 1,
	nonEmptyFields: 0,
	selectedFiles: 0,
	selectedImages: 0,
	changedControls: 0,
});

test("仅完整空白的X2自有新增商品页允许恢复重载", () => {
	assert.equal(uploadPageReloadBlock(emptyUploadPage()), null);
	for (const change of [
		{ owned: false },
		{ origin: "https://example.com" },
		{ pathname: "/portal/product/123" },
		{ plainRoute: false },
		{ ready: false },
		{ titleFields: 0 },
		{ descriptionFields: 0 },
		{ nonEmptyFields: 1 },
		{ selectedFiles: 1 },
		{ selectedImages: 1 },
		{ changedControls: 1 },
	])
		assert.notEqual(uploadPageReloadBlock({ ...emptyUploadPage(), ...change }), null, JSON.stringify(change));
});

test("真实初始页未选类别时允许原生描述占位，仍拒绝未加载及任何真实内容", () => {
	const initial = { ...emptyUploadPage(), descriptionFields: 0, categoryPending: true };
	assert.equal(uploadPageReloadBlock(initial), null);
	for (const change of [
		{ categoryPending: false },
		{ titleFields: 0 },
		{ ready: false },
		{ nonEmptyFields: 1 },
		{ selectedImages: 1 },
		{ selectedFiles: 1 },
		{ changedControls: 1 },
	])
		assert.notEqual(uploadPageReloadBlock({ ...initial, ...change }), null);
});

test("终止性失败最多重载一次，每个文档的坏模块只尝试一次", async () => {
	let prepares = 0;
	let reloads = 0;
	assert.equal(
		await prepareUploadWithRecovery({
			prepare: async () => {
				prepares++;
				return "failed";
			},
			reload: async () => {
				reloads++;
				return true;
			},
			pause: async () => {},
		}),
		false,
	);
	assert.equal(prepares, 2);
	assert.equal(reloads, 1);
});

test("仅等待页面或loader时有限轮询，超时不刷新", async () => {
	let prepares = 0;
	let reloads = 0;
	const ready = await prepareUploadWithRecovery({
		prepare: async () => {
			prepares++;
			return "waiting";
		},
		reload: async () => {
			reloads++;
			return true;
		},
		pause: async () => {},
	});
	assert.equal(ready, false);
	assert.equal(prepares, 20);
	assert.equal(reloads, 0);
});

test("非空页阻止失败恢复；安全重载后仍等待挂载，成功即停止", async () => {
	let actualReloads = 0;
	assert.equal(
		await prepareUploadWithRecovery({
			prepare: async () => "failed",
			reload: async () => {
				if (uploadPageReloadBlock({ ...emptyUploadPage(), nonEmptyFields: 1 })) return false;
				actualReloads++;
				return true;
			},
			pause: async () => {},
		}),
		false,
	);
	assert.equal(actualReloads, 0);
	const states = ["failed", "waiting", "ready"] as const;
	let prepares = 0;
	let pauses = 0;
	assert.equal(
		await prepareUploadWithRecovery({
			prepare: async () => states[prepares++]!,
			reload: async () => {
				actualReloads++;
				return true;
			},
			pause: async () => {
				pauses++;
			},
		}),
		true,
	);
	assert.equal(actualReloads, 1);
	assert.equal(prepares, 3);
	assert.equal(pauses, 1);
});
