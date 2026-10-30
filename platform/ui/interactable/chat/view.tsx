// chat：左边一列这家店的会话（像侧栏，点一个换；未回覆的在前面、标出来），右边是选中会话的消息气泡（shadcn 的 message、bubble、message-scroller），底下输入框能改，
// 「生成回复」让 Gemini 写草稿进输入框。会话每 30 秒、消息每 15 秒重读（回到页面时也读）；浏览器没登录这家店，就显示 x2 回的原话
import { SparklesIcon } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Button } from "@/components/ui/button";
import { Message, MessageContent, MessageFooter } from "@/components/ui/message";
import {
	MessageScroller,
	MessageScrollerButton,
	MessageScrollerContent,
	MessageScrollerItem,
	MessageScrollerProvider,
	MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { api, fail, type Item as PageItem, usePoll } from "../../api.ts";
import type { Props } from "./schema.ts";

type Sender = "buyer" | "us" | "auto" | "platform" | "other_auto";
type Conversation = { id: string; buyer: string; lastText: string; lastAt: string | null; unread: number; unreplied: boolean };
type Msg = { id: string; sender: Sender; text: string; at: string };

const NOTE: Partial<Record<Sender, string>> = { auto: "自动回复", platform: "平台", other_auto: "对方的自动回复" };
const at = (iso: string) => new Date(iso).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });

export function View({ props, item }: { props: Props; item: PageItem }) {
	const [conversations, listError] = usePoll(() => api.act<Conversation[]>(item.id, "conversations"), 30_000, [item.id, props.shop]);
	const [picked, setPicked] = useState<string | null>(null);
	const current = picked ?? props.conversationId ?? conversations?.[0]?.id ?? null;

	if (listError) return <p className="p-4 text-sm text-destructive">{listError}</p>;
	if (!conversations) return <Skeleton className="m-4 h-40" />;
	return (
		<div className="flex h-full min-h-[32rem]">
			<nav className="w-56 shrink-0 overflow-y-auto border-r">
				{conversations.map((c) => (
					<button
						key={c.id}
						type="button"
						onClick={() => setPicked(c.id)}
						className={`flex w-full flex-col gap-0.5 border-b px-3 py-2 text-left text-sm hover:bg-muted ${c.id === current ? "bg-muted" : ""}`}
					>
						<span className="flex items-center gap-1">
							<span className="truncate font-medium">{c.buyer || c.id}</span>
							<span className="grow" />
							{c.unreplied && <Badge variant="destructive">未回覆</Badge>}
							{!c.unreplied && c.unread > 0 && <Badge variant="secondary">{c.unread}</Badge>}
						</span>
						<span className="truncate text-xs text-muted-foreground">{c.lastText}</span>
					</button>
				))}
				{!conversations.length && <p className="p-3 text-sm text-muted-foreground">没有会话</p>}
			</nav>
			{current ? <Thread key={current} item={item.id} conversationId={current} /> : <div className="grow" />}
		</div>
	);
}

function Thread({ item, conversationId }: { item: string; conversationId: string }) {
	const [messages, error] = usePoll(() => api.act<Msg[]>(item, "messages", { conversationId }), 15_000, [item, conversationId]);
	const [draft, setDraft] = useState("");
	const [writing, setWriting] = useState(false);
	const generate = () => {
		setWriting(true);
		api
			.act<{ text: string }>(item, "draft", { conversationId })
			.then((r) => setDraft(r.text), fail)
			.finally(() => setWriting(false));
	};
	return (
		<div className="flex min-w-0 grow flex-col">
			<div className="min-h-0 grow">
				{error ? (
					<p className="p-4 text-sm text-destructive">{error}</p>
				) : !messages ? (
					<Skeleton className="m-4 h-40" />
				) : (
					<MessageScrollerProvider defaultScrollPosition="end" autoScroll>
						<MessageScroller>
							<MessageScrollerViewport>
								<MessageScrollerContent className="gap-3 p-4">
									{messages.map((m) => {
										const ours = m.sender === "us" || m.sender === "auto";
										return (
											<MessageScrollerItem key={m.id} messageId={m.id}>
												<Message align={ours ? "end" : "start"}>
													<MessageContent>
														<Bubble align={ours ? "end" : "start"} variant={m.sender === "us" ? "default" : ours ? "tinted" : "muted"}>
															<BubbleContent className="whitespace-pre-wrap">{m.text}</BubbleContent>
														</Bubble>
														<MessageFooter>
															{NOTE[m.sender] ? `${NOTE[m.sender]} · ` : ""}
															{at(m.at)}
														</MessageFooter>
													</MessageContent>
												</Message>
											</MessageScrollerItem>
										);
									})}
								</MessageScrollerContent>
							</MessageScrollerViewport>
							<MessageScrollerButton />
						</MessageScroller>
					</MessageScrollerProvider>
				)}
			</div>
			<div className="flex flex-col gap-2 border-t p-3">
				<Textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={3} placeholder="回复（可以先让 Gemini 写一稿再改）" />
				<div className="flex items-center gap-2">
					<Button size="sm" variant="outline" onClick={generate} disabled={writing}>
						<SparklesIcon />
						{writing ? "在写…" : "生成回复"}
					</Button>
					<span className="text-xs text-muted-foreground">发送还没接上：改好了复制到卖家中心的聊聊里发</span>
				</div>
			</div>
		</div>
	);
}

export const tab = (p: Props) => p.title ?? `聊聊 ${p.shop}`;
