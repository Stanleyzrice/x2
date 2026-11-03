// 后台任务按注册的时区和小时执行；会话锁隔离活跃执行者，进程中断后可重领当天未完成任务。
import type { Sql } from "./db/index.ts";
import type { Job } from "./tool.ts";

export function dueDay(job: Pick<Job, "hour" | "timeZone">, now: Date): string | null {
	const parts = new Intl.DateTimeFormat("en-CA", {
		timeZone: job.timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		hourCycle: "h23",
	}).formatToParts(now);
	const part = (name: string) => parts.find((p) => p.type === name)!.value;
	return Number(part("hour")) >= job.hour ? `${part("year")}-${part("month")}-${part("day")}` : null;
}

export async function runDueJobs(sql: Sql, jobs: readonly Job[], now = new Date()): Promise<void> {
	for (const job of jobs) {
		const day = dueDay(job, now);
		if (!day) continue;
		const conn = await sql.reserve();
		const key = `background-job:${job.name}:${day}`;
		let locked = false;
		try {
			const [lease] = await conn<{ locked: boolean; pid: number }[]>`
				select pg_try_advisory_lock(hashtextextended(${key}, 0)) as locked, pg_backend_pid() as pid`;
			if (!lease!.locked) continue;
			locked = true;
			const pid = lease!.pid;
			const claimed = await conn`insert into job_runs (name, day, status, backend_pid) values (${job.name}, ${day}, 'running', ${pid})
				on conflict (name, day) do update set status = 'running', started_at = now(), finished_at = null, error = null, backend_pid = excluded.backend_pid
				where job_runs.status = 'running' returning name`;
			if (!claimed.length) continue;
			try {
				// 任务复用持锁连接，避免调度器和同步器层层占满连接池。
				await job.run(conn);
				await conn`update job_runs set status = 'completed', finished_at = now() where name = ${job.name} and day = ${day}
					and backend_pid = ${pid} and pg_backend_pid() = ${pid}
					and exists (select 1 from pg_locks l, (select hashtextextended(${key}, 0) as k) h
						where l.locktype = 'advisory' and l.granted and l.pid = pg_backend_pid() and l.objsubid = 1
						and l.classid = ((h.k >> 32) & 4294967295)::oid and l.objid = (h.k & 4294967295)::oid)`;
			} catch (e) {
				const message = (e as Error).message;
				await conn`update job_runs set status = 'failed', finished_at = now(), error = ${message} where name = ${job.name} and day = ${day}
					and backend_pid = ${pid} and pg_backend_pid() = ${pid}
					and exists (select 1 from pg_locks l, (select hashtextextended(${key}, 0) as k) h
						where l.locktype = 'advisory' and l.granted and l.pid = pg_backend_pid() and l.objsubid = 1
						and l.classid = ((h.k >> 32) & 4294967295)::oid and l.objid = (h.k & 4294967295)::oid)`;
				console.error(`后台任务 ${job.name}：${message}`);
			}
		} finally {
			if (locked) await conn`select pg_advisory_unlock(hashtextextended(${key}, 0))`.catch(() => {});
			conn.release();
		}
	}
}

export function startJobs(sql: Sql, jobs: readonly Job[]): () => Promise<void> {
	let running: Promise<void> | null = null;
	const tick = () => {
		if (running) return;
		running = runDueJobs(sql, jobs)
			.catch((e: Error) => console.error(`后台任务：${e.message}`))
			.finally(() => {
				running = null;
			});
	};
	tick();
	const timer = setInterval(tick, 30_000);
	return async () => {
		clearInterval(timer);
		await running;
	};
}
