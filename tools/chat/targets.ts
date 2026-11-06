// 已完成前后账号核对的目标只用于短时只读展示；发送链路始终重新读取目标。
import type { Target } from "./context.ts";

export function recentTargets(ttl = 30_000, limit = 200, now = Date.now) {
	const entries = new Map<string, { target: Target; at: number }>();
	const key = (shop: string, account: { shopId: string; userId: string }, conversationId: string) =>
		JSON.stringify([shop, account.shopId, account.userId, conversationId]);
	return {
		remember(target: Target) {
			const id = key(target.shop, target, target.conversationId);
			entries.delete(id);
			entries.set(id, { target, at: now() });
			while (entries.size > limit) entries.delete(entries.keys().next().value!);
		},
		peek(shop: string, account: { shopId: string; userId: string }, conversationId: string): Target | undefined {
			const id = key(shop, account, conversationId),
				entry = entries.get(id);
			if (!entry) return undefined;
			if (now() - entry.at >= ttl) {
				entries.delete(id);
				return undefined;
			}
			return entry.target;
		},
	};
}
