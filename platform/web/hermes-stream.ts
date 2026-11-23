import type { ServerResponse } from "node:http";
import type { ToolTraceStep } from "../mcp.ts";

export function sendHermesEvent(res: ServerResponse, name: string, value: unknown) {
	res.write(`event: ${name}\ndata: ${JSON.stringify(value)}\n\n`);
}

export class HermesLiveRun {
	readonly steps = new Map<string, ToolTraceStep>();
	private readonly listeners = new Set<ServerResponse>();
	private text = "";
	private buffer = "";
	private timer: ReturnType<typeof setTimeout> | undefined;

	private broadcast(name: string, value: unknown) {
		for (const res of this.listeners) {
			if (res.writableLength > 512 * 1024) res.destroy();
			else if (!res.destroyed && !res.writableEnded) sendHermesEvent(res, name, value);
		}
	}

	private flush() {
		clearTimeout(this.timer);
		this.timer = undefined;
		if (!this.buffer) return;
		this.broadcast("delta", this.buffer);
		this.buffer = "";
	}

	append(delta: string | null) {
		if (delta === null) {
			clearTimeout(this.timer);
			this.timer = undefined;
			this.buffer = "";
			this.text = "";
			this.broadcast("reset", null);
			return;
		}
		this.text += delta;
		this.buffer += delta;
		this.timer ??= setTimeout(() => this.flush(), 55);
	}

	record(step: ToolTraceStep) {
		if (this.steps.size >= 100 && !this.steps.has(step.id)) return;
		this.steps.set(step.id, step);
		this.broadcast("tool", step);
	}

	subscribe(res: ServerResponse) {
		this.flush();
		sendHermesEvent(res, "snapshot", { text: this.text, trace: [...this.steps.values()] });
		this.listeners.add(res);
		const heartbeat = setInterval(() => {
			if (!res.destroyed && !res.writableEnded) res.write(": heartbeat\n\n");
		}, 15_000);
		heartbeat.unref();
		res.once("close", () => {
			clearInterval(heartbeat);
			this.listeners.delete(res);
		});
	}

	finish() {
		this.flush();
		this.broadcast("done", null);
		this.closeStreams();
	}

	closeStreams() {
		for (const res of this.listeners) res.end();
		this.listeners.clear();
	}
}
