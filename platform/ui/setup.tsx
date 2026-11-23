import { ArrowRightIcon, BotIcon, CheckIcon, DatabaseIcon, KeyRoundIcon, LoaderCircleIcon, Settings2Icon, StoreIcon } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { api, type BrowserAuthorization, type SetupState } from "./api.ts";
import { BrowserConnection } from "./browser-connection.tsx";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Label } from "./components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./components/ui/select";
import { errorOf } from "./lib/state.ts";

type Section = "database" | "hermes" | "shop" | "finish";
const steps = [
	{ id: "database", title: "数据库", icon: DatabaseIcon },
	{ id: "hermes", title: "DeepSeek", icon: BotIcon },
	{ id: "shop", title: "Shopee 店铺", icon: StoreIcon },
] as const;

export function SetupPage({ state, onChange, onEnter }: { state: SetupState; onChange: (state: SetupState) => void; onEnter: () => void }) {
	const [url, setUrl] = useState("");
	const [key, setKey] = useState("");
	const [model, setModel] = useState(state.model);
	const [python, setPython] = useState("");
	const [accounts, setAccounts] = useState<BrowserAuthorization[]>([]);
	const [shop, setShop] = useState("");
	const [busy, setBusy] = useState<Section | null>(null);
	const [problem, setProblem] = useState<{ section: Section; text: string } | null>(null);
	const [checked, setChecked] = useState<Section | null>(null);
	const ready = { database: state.database, hermes: state.hermes, shop: Boolean(state.shop) };
	useEffect(() => {
		if (!state.database || !state.local) return;
		let active = true;
		void api
			.setupShops()
			.then((items) => {
				if (active) setAccounts(items);
			})
			.catch(() => {});
		return () => {
			active = false;
		};
	}, [state.database, state.local]);

	async function save(section: Section, submit: () => Promise<SetupState>) {
		if (busy) return;
		setBusy(section);
		setProblem(null);
		setChecked(null);
		try {
			onChange(await submit());
			setChecked(section);
			if (section === "hermes") {
				setKey("");
				setPython("");
			}
			if (section === "database") setUrl("");
			if (section === "finish") onEnter();
		} catch (error) {
			setProblem({ section, text: errorOf(error) });
		} finally {
			setBusy(null);
		}
	}
	const saveHermes = () => api.setupHermes({ model, ...(key.trim() ? { apiKey: key.trim() } : {}), ...(python.trim() ? { python: python.trim() } : {}) });
	function enter() {
		const pendingModel = state.local && (key.trim() || (state.hermes && (model !== state.model || python.trim())));
		if (state.ready && !pendingModel) {
			onEnter();
			return;
		}
		void save("finish", async () => {
			let next = state;
			if (pendingModel) {
				next = await saveHermes();
				onChange(next);
				setKey("");
				setPython("");
			}
			return next.ready ? next : api.finishSetup();
		});
	}
	const submit = (event: FormEvent, section: Section, write: () => Promise<SetupState>) => {
		event.preventDefault();
		void save(section, write);
	};
	const error = (section: Section) =>
		problem?.section === section && (
			<p role="alert" className="text-sm text-destructive">
				{problem.text}
			</p>
		);
	const label = (section: Section, idle: string, waiting: string) =>
		busy === section ? (
			<>
				<LoaderCircleIcon className="animate-spin" />
				{waiting}
			</>
		) : (
			idle
		);
	return (
		<div className="min-h-svh bg-muted/35 px-4 py-6 text-foreground sm:px-8 sm:py-12">
			<div className="mx-auto grid max-w-5xl items-start gap-0 overflow-hidden rounded-2xl border bg-background shadow-xl shadow-slate-900/5 lg:grid-cols-[260px_minmax(0,1fr)]">
				<aside className="flex h-full flex-col border-b bg-muted/45 px-6 py-6 lg:border-r lg:border-b-0 lg:px-7 lg:py-9">
					<div className="flex items-center gap-3">
						<span className="grid size-10 place-items-center rounded-xl bg-foreground text-base font-bold tracking-tight text-background">X2</span>
						<span className="text-sm font-semibold tracking-wide">运营工作台</span>
					</div>
					<nav aria-label="配置进度" className="mt-6 grid grid-cols-1 gap-2 sm:grid-cols-3 lg:mt-12 lg:grid-cols-1">
						{steps.map(({ id, icon: Icon, title }) => (
							<a
								key={id}
								href={`#setup-${id}`}
								onClick={(event) => {
									event.preventDefault();
									document.getElementById(`setup-${id}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
								}}
								className="flex min-w-0 items-center gap-3 rounded-lg border bg-background px-3 py-2.5 text-sm hover:bg-accent"
							>
								<Icon className="size-4 shrink-0 text-muted-foreground" />
								<span className="truncate">{title}</span>
								{ready[id] && <CheckIcon className="ml-auto size-4 shrink-0" aria-label="已就绪" />}
							</a>
						))}
					</nav>
				</aside>
				<main className="min-w-0 space-y-7 px-5 py-7 sm:px-9 sm:py-9">
					<header>
						<h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{state.ready ? "工作台设置" : "设置 X2"}</h1>
						<p className="mt-2 text-sm text-muted-foreground">
							{state.ready ? "管理本机数据库、模型连接和默认店铺。" : "连接数据库后进入工作台。也可以在这里配置模型和绑定店铺。"}
						</p>
					</header>
					{!state.local && (
						<p role="alert" className="rounded-lg border p-4 text-sm">
							请在运行 X2 的电脑上通过本机地址修改配置。
						</p>
					)}
					<section id="setup-database" className="space-y-3 border-b pb-5">
						<SectionTitle name="PostgreSQL（数据库）" checked={state.database} />
						{state.database ? (
							<p className="text-sm text-muted-foreground">已连接工作台数据库。</p>
						) : (
							<form className="space-y-3" onSubmit={(e) => submit(e, "database", () => api.setupDatabase(url))}>
								<Label htmlFor="setup-url">连接地址</Label>
								<div className="flex flex-col gap-2 sm:flex-row">
									<Input
										id="setup-url"
										className="min-w-0"
										type="password"
										autoComplete="off"
										value={url}
										onChange={(e) => setUrl(e.target.value)}
										placeholder="postgresql://用户:密码@127.0.0.1:55432/x2"
										disabled={!state.local || Boolean(busy)}
										required
									/>
									<Button type="submit" disabled={!state.local || !url.trim() || Boolean(busy)}>
										{label("database", "连接并初始化", "连接中…")}
									</Button>
								</div>
								<p className="text-xs text-muted-foreground">填入已创建的数据库地址，X2 会自动初始化所需数据表。</p>
							</form>
						)}
						{error("database")}
					</section>
					<section id="setup-hermes" className="space-y-3 border-b pb-5">
						<SectionTitle name="DeepSeek" checked={state.hermes} />
						<form className="space-y-3" onSubmit={(e) => submit(e, "hermes", saveHermes)}>
							<div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_170px]">
								<div className="space-y-2">
									<Label htmlFor="setup-key">DeepSeek API Key（接口密钥）</Label>
									<div className="relative">
										<KeyRoundIcon className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-muted-foreground" />
										<Input
											id="setup-key"
											className="pl-9"
											type="password"
											autoComplete="new-password"
											value={key}
											onChange={(e) => setKey(e.target.value)}
											placeholder={state.hermes ? "密钥已保存，输入新密钥可替换" : "输入 DeepSeek API Key"}
											disabled={!state.local || Boolean(busy)}
										/>
									</div>
								</div>
								<div className="space-y-2">
									<Label htmlFor="setup-model">模型</Label>
									<Select
										value={model}
										onValueChange={(value) => {
											if (value) setModel(value);
										}}
										disabled={!state.local || Boolean(busy)}
									>
										<SelectTrigger id="setup-model" className="w-full">
											<SelectValue>{model}</SelectValue>
										</SelectTrigger>
										<SelectContent>
											<SelectItem value="deepseek-flash">deepseek-flash</SelectItem>
											<SelectItem value="deepseek-v4-pro">deepseek-v4-pro</SelectItem>
										</SelectContent>
									</Select>
								</div>
							</div>
							<details className="rounded-md text-sm text-muted-foreground">
								<summary className="w-fit cursor-pointer rounded-sm py-1 focus-visible:outline-2">Hermes 运行路径</summary>
								<Label htmlFor="setup-python" className="mt-2">
									Python 路径（选填）
								</Label>
								<Input
									className="mt-2"
									id="setup-python"
									value={python}
									onChange={(e) => setPython(e.target.value)}
									placeholder="使用 X2 本机安装时留空"
									disabled={!state.local || Boolean(busy)}
								/>
							</details>
							<div className="flex flex-wrap items-center gap-3">
								<Button type="submit" variant="outline" disabled={!state.local || !(key.trim() || state.hermes) || Boolean(busy)}>
									{label("hermes", "测试并保存", "测试中…")}
								</Button>
								{checked === "hermes" && (
									<span role="status" className="text-sm text-muted-foreground">
										模型和运行环境已通过测试。
									</span>
								)}
							</div>
						</form>
						{error("hermes")}
					</section>
					<section id="setup-shop" className="space-y-3 border-b pb-5">
						<SectionTitle name="Shopee（虾皮）店铺" checked={Boolean(state.shop)} />
						{state.shop ? (
							<p className="text-sm text-muted-foreground">
								当前默认店铺 <strong className="font-medium text-foreground">{state.shop}</strong>。进入工作台后可在「店铺设置」维护费率、物流和水印。
							</p>
						) : (
							<p className="text-sm text-muted-foreground">登录卖家中心后，连接浏览器并选择要运营的店铺。</p>
						)}
						{state.database && state.local && (
							<BrowserConnection
								site="shopee"
								disabled={Boolean(busy)}
								onConnected={async (account) => {
									setShop(account.id);
									setAccounts(await api.setupShops());
								}}
							/>
						)}
						{accounts.length > 0 && (
							<div className="flex flex-wrap items-center gap-2">
								<Select value={shop} onValueChange={(value) => setShop(value ?? "")}>
									<SelectTrigger aria-label="已验证店铺" className="w-56">
										<SelectValue placeholder="选择已验证店铺">{accounts.find((a) => a.accountId === shop)?.accountName}</SelectValue>
									</SelectTrigger>
									<SelectContent>
										{accounts.map((account) => (
											<SelectItem key={account.accountId} value={account.accountId}>
												{account.accountName || account.accountId}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
								<Button variant="outline" disabled={!shop || Boolean(busy)} onClick={() => void save("shop", () => api.setupShop(shop))}>
									{label("shop", "设为默认店铺", "保存中…")}
								</Button>
							</div>
						)}
						{error("shop")}
					</section>
					<footer className="flex flex-wrap items-center justify-end gap-3">
						{error("finish")}
						<Button disabled={!state.database || Boolean(busy)} onClick={enter}>
							{label("finish", state.ready ? "返回工作台" : "进入工作台", "正在进入…")}
							<ArrowRightIcon />
						</Button>
					</footer>
				</main>
			</div>
		</div>
	);
}

function SectionTitle({ name, checked }: { name: string; checked: boolean }) {
	return (
		<div className="flex flex-wrap items-center gap-3">
			<h2 className="font-semibold">{name}</h2>
			<span
				className={
					checked
						? "inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2.5 py-1 text-xs text-emerald-700 dark:text-emerald-300"
						: "inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground"
				}
			>
				{checked ? (
					<>
						<CheckIcon className="size-3" />
						已配置
					</>
				) : (
					<>
						<Settings2Icon className="size-3" />
						待配置
					</>
				)}
			</span>
		</div>
	);
}
