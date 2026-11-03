// Shopee Chat 的ID边界和单次发送前置校验；不打开浏览器、不发消息。
import assert from "node:assert/strict";
import { test } from "node:test";
import { conversation, sendViaChatPage } from "./chat.ts";

test("超出JS安全整数的数值ID拒绝，字符串ID保持精确", () => {
	assert.equal(conversation.safeParse({ id: Number.MAX_SAFE_INTEGER + 1 }).success, false);
	assert.equal(conversation.parse({ id: "1000000000000000001" }).id, "1000000000000000001");
});
test("页面需要数字的目标不能安全转换时，不触碰DOM也不发送", async () => {
	const result = await sendViaChatPage({
		target: { shopId: "9007199254740993", userId: "1", buyerId: "2", buyerName: "fixture", conversationId: "3" },
		text: "fixture",
	});
	assert.equal(result.kind, "refused");
});

test("定位输入框期间新消息到达，Enter前拒绝旧上下文", async () => {
	const names = ["document", "window", "location", "HTMLTextAreaElement"] as const;
	const old = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
	let keydowns = 0;
	const state = {
		conversationReducer: { currentConversationId: "3" },
		entityReducer: { conversations: { "3": { to_id: "2", shop_id: "1", latest_message_id: "10" } } },
	};
	class Field {
		text = "";
		disabled = false;
		__reactProps$fixture = { value: "", onKeyDown: () => {} };
		get value() {
			return this.text;
		}
		set value(v: string) {
			this.text = v;
		}
		getClientRects() {
			return [{}];
		}
		dispatchEvent(event: Event) {
			if (event.type === "input") {
				this.__reactProps$fixture.value = this.value;
				state.entityReducer.conversations["3"].latest_message_id = "11";
			}
			if (event.type === "keydown") keydowns++;
			return true;
		}
	}
	const field = new Field(),
		fiber = { __reactFiber$fixture: { memoizedProps: { store: { getState: () => state } } } };
	try {
		Object.defineProperty(globalThis, "document", {
			configurable: true,
			value: { querySelectorAll: (selector: string) => (selector === "*" ? [fiber] : [field]) },
		});
		Object.defineProperty(globalThis, "window", { configurable: true, value: { postMessage: () => {} } });
		Object.defineProperty(globalThis, "location", { configurable: true, value: { origin: "https://seller.shopee.tw" } });
		Object.defineProperty(globalThis, "HTMLTextAreaElement", { configurable: true, value: Field });
		const result = await sendViaChatPage({
			target: { shopId: "1", userId: "4", conversationId: "3", buyerId: "2", buyerName: "fixture", expectedLatestMessageId: "10" },
			text: "舊上下文回覆",
		});
		assert.equal(result.kind, "refused");
		assert.equal(keydowns, 0);
	} finally {
		for (const name of names) {
			const descriptor = old.get(name);
			if (descriptor) Object.defineProperty(globalThis, name, descriptor);
			else Reflect.deleteProperty(globalThis, name);
		}
	}
});
