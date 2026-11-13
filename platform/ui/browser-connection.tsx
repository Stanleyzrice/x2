// 点击后才授权检测当前浏览器的站点身份；临时 URL 标记只用于定位当前标签，检测结束移除自己的标记。
import { ExternalLinkIcon, PlugZapIcon, RefreshCwIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, type BrowserConnectionResult } from "./api.ts";
import { Button } from "./components/ui/button";

type Props = {
	site?: "1688" | "shopee";
	expectedAccount?: string;
	verificationRequired?: boolean;
	disabled?: boolean;
	onCheckingChange?: (checking: boolean) => void;
	onConnected?: (account: NonNullable<BrowserConnectionResult["account"]>) => void | Promise<void>;
};
const sites = {
	"1688": { name: "1688", identity: "账号", button: "授权连接当前浏览器", login: "打开1688登录", loginUrl: "https://login.1688.com/member/signin.htm" },
	shopee: {
		name: "Shopee（虾皮）",
		identity: "店铺",
		button: "授权当前浏览器店铺",
		login: "打开 Shopee（虾皮）登录",
		loginUrl: "https://seller.shopee.tw/",
	},
};

let locatingBrowser = false;

/** 授权和采集共用一次性定位标记；串行领取，结束时只移除自己的值并保留期间的导航。 */
export async function withCurrentBrowserMarker<T>(run: (input: { pageUrl: string; marker: string }) => Promise<T>): Promise<T> {
	if (locatingBrowser) throw new Error("正在连接当前浏览器，请稍后再试");
	locatingBrowser = true;
	const marker = crypto.randomUUID();
	try {
		const url = new URL(location.href);
		url.searchParams.set("x2BrowserConnect", marker);
		history.replaceState(history.state, "", url);
		return await run({ pageUrl: url.href, marker });
	} finally {
		const current = new URL(location.href);
		if (current.searchParams.getAll("x2BrowserConnect").includes(marker)) {
			current.searchParams.delete("x2BrowserConnect", marker);
			history.replaceState(history.state, "", current);
		}
		locatingBrowser = false;
	}
}

export function BrowserConnection({ site = "1688", expectedAccount, verificationRequired = false, disabled = false, onCheckingChange, onConnected }: Props) {
	const [operation, setOperation] = useState<"check" | "open-verification" | null>(null);
	const [result, setResult] = useState<BrowserConnectionResult | null>(null);
	const [error, setError] = useState<string | null>(null);
	const pending = useRef(false);
	const mounted = useRef(true);
	const scopeKey = JSON.stringify([site, expectedAccount ?? null]);
	const expected = useRef(scopeKey);
	const copy = sites[site];
	const checking = operation !== null;
	const statuses: Record<BrowserConnectionResult["status"], string> = {
		connected: `已连接并核实${copy.identity}`,
		login_required: `${copy.name} 尚未登录`,
		wrong_account: `登录${copy.identity}不匹配`,
		not_connected: "当前浏览器尚未连接",
		challenge: `${copy.name} 需要安全验证`,
		ambiguous: "无法唯一识别当前浏览器",
		error: "浏览器检测失败",
	};
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);
	useEffect(() => {
		expected.current = scopeKey;
		setResult(null);
		setError(null);
	}, [scopeKey]);

	const connect = async (action: "check" | "open-verification" = "check") => {
		if (pending.current || disabled) return;
		pending.current = true;
		setOperation(action);
		if (action === "check") setResult(null);
		setError(null);
		onCheckingChange?.(true);
		let response: BrowserConnectionResult | undefined;
		try {
			response = await withCurrentBrowserMarker(({ pageUrl, marker }) =>
				api.connectBrowser({ url: pageUrl, marker, site, action, ...(expectedAccount ? { expectedAccount } : {}) }),
			);
		} catch (e) {
			if (mounted.current && expected.current === scopeKey) setError(e instanceof Error ? e.message : "浏览器检测失败，请重新检测");
		} finally {
			pending.current = false;
			if (mounted.current) setOperation(null);
			onCheckingChange?.(false);
		}
		if (!response || !mounted.current || expected.current !== scopeKey) return;
		if (response.status === "connected" && !response.account) {
			setResult({ ...response, status: "error", message: `检测结果缺少已核实的${copy.identity}身份，请重新检测。` });
			return;
		}
		if (response.status === "connected" && expectedAccount && response.account?.id !== expectedAccount && response.account?.name !== expectedAccount) {
			setResult({
				...response,
				status: "wrong_account",
				message: `当前登录${copy.identity}与待连接${copy.identity} ${expectedAccount} 不匹配，请切换后重新检测。`,
			});
			return;
		}
		setResult(response);
		if (action === "check" && response.status === "connected" && response.account) {
			try {
				await onConnected?.(response.account);
			} catch (e) {
				if (mounted.current) setError(e instanceof Error ? e.message : `已核实${copy.identity}，但后续操作失败，请重试`);
			}
		}
	};
	const needsLogin = result && ["login_required", "wrong_account"].includes(result.status);
	const needsVerification = verificationRequired || result?.status === "challenge";
	return (
		<div className="space-y-2">
			<Button variant="outline" size="sm" onClick={() => void connect()} disabled={disabled || checking}>
				<PlugZapIcon className={checking ? "animate-pulse" : ""} />
				{operation === "open-verification" ? "正在打开验证页面…" : checking ? "正在检测当前浏览器…" : copy.button}
			</Button>
			<p className="text-xs text-muted-foreground">
				点击即授权 X2 读取当前浏览器的 {copy.name} 登录{copy.identity}身份。
			</p>
			{result && (
				<div role="status" className="space-y-2 rounded-md border bg-muted/30 p-3 text-xs">
					<p className="font-medium">{statuses[result.status]}</p>
					<p className="break-words">{result.message}</p>
					{result.browser && <p>浏览器：{result.browser.label || "当前浏览器"}</p>}
					{result.account && (
						<p className="break-all">
							当前{copy.identity}：{result.account.name}（{result.account.id}）
						</p>
					)}
					{result.status === "not_connected" && <p>请确认当前浏览器的 CDP（浏览器调试协议）扩展已连接 X2，再重新检测。</p>}
					{result.status !== "connected" && (
						<div className="flex flex-wrap gap-2">
							{needsLogin && (
								<Button variant="outline" size="sm" render={<a href={result.loginUrl ?? copy.loginUrl} target="_blank" rel="noreferrer" />}>
									<ExternalLinkIcon />
									{copy.login}
								</Button>
							)}
							{!needsVerification && (
								<Button variant="outline" size="sm" onClick={() => void connect()} disabled={disabled || checking}>
									<RefreshCwIcon />
									重新检测
								</Button>
							)}
						</div>
					)}
				</div>
			)}
			{needsVerification && (
				<div className="space-y-2 rounded-md border bg-muted/30 p-3 text-xs">
					<p role="status">
						{verificationRequired || result?.canOpenVerification
							? "读取需要安全验证。请打开验证页面完成验证，再回到此页重新检测。"
							: `请在已打开的 ${copy.name} 验证页完成安全验证，再回到此页重新检测。`}
					</p>
					<div className="flex flex-wrap gap-2">
						{(verificationRequired || result?.canOpenVerification) && (
							<Button variant="outline" size="sm" onClick={() => void connect("open-verification")} disabled={disabled || checking}>
								<ExternalLinkIcon />
								打开验证页面
							</Button>
						)}
						<Button variant="outline" size="sm" onClick={() => void connect()} disabled={disabled || checking}>
							<RefreshCwIcon />
							验证完成，重新检测
						</Button>
					</div>
				</div>
			)}
			{error && (
				<p role="alert" className="break-words text-xs text-destructive">
					{error}
				</p>
			)}
		</div>
	);
}
