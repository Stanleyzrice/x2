// 到库的 SSH 隧道：共享库在香港服务器上只听它自己的 5432，不开公网端口；各人用自己放在服务器上的 SSH 钥匙，经 ops/ssh_config 里 X2_DATABASE_SSH 写的那个 Host 转到本机端口（X2_DATABASE_URL 指这个本机端口）。
// 每开一条到库的连接先看本机端口通不通，不通就 ssh -fN 开一条留在后台：电脑睡了、断了网，ssh 自己退出，下次连库再开，开着的网页不用重启。几个进程同时开只有一个占到端口，别的看端口通了就行
import { spawn } from "node:child_process";
import { once } from "node:events";
import { connect, type Socket } from "node:net";
import { fileURLToPath } from "node:url";
import { NeedsHuman } from "../errors.ts";

const CONFIG = fileURLToPath(new URL("../../ops/ssh_config", import.meta.url));

async function reach(host: string, port: number): Promise<Socket | null> {
	const s = connect({ host, port });
	try {
		await once(s, "connect");
		return s;
	} catch {
		s.destroy();
		return null;
	}
}

/** 连上 url 的主机、端口（隧道在本机的那头）：不通就经 ssh 的 alias 开隧道 */
export async function open(url: string, alias: string): Promise<Socket> {
	const u = new URL(url);
	const host = u.hostname;
	const port = Number(u.port || 5432);
	const first = await reach(host, port);
	if (first) return first;
	const ssh = spawn("ssh", ["-F", CONFIG, "-fN", "-o", "BatchMode=yes", "-o", "ExitOnForwardFailure=yes", alias], { stdio: "ignore" });
	const [code] = await once(ssh, "exit").catch(() => [null]);
	const s = await reach(host, port);
	if (!s)
		throw new NeedsHuman(`开不了到库的 SSH 隧道（退出码 ${code}）：在仓库根目录跑 ssh -F ops/ssh_config -fN ${alias} 看哪里不对（钥匙有密码的先 ssh-add）`);
	return s;
}
