// 数据：~/x2/<名字>.json（X2_HOME 可以改目录）。读来的整份覆盖（write），人给的往后加（append）。
// 写先写临时文件再改名：写到一半进程挂了，原来的文件还在
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const home = process.env.X2_HOME ?? join(homedir(), "x2");
const file = (name: string) => join(home, `${name}.json`);

export async function read<T>(name: string, empty: T): Promise<T> {
	const text = await readFile(file(name), "utf8").catch((e: NodeJS.ErrnoException) => { if (e.code === "ENOENT") return null; throw e; });
	return text === null ? empty : (JSON.parse(text) as T);
}

export async function write(name: string, value: unknown): Promise<void> {
	await mkdir(home, { recursive: true });
	const tmp = `${file(name)}.tmp`;
	await writeFile(tmp, `${JSON.stringify(value, null, "\t")}\n`);
	await rename(tmp, file(name));
}

/** 往一个数组文件后面加几项，每项带上记下的时间 */
export async function append<T extends object>(name: string, items: readonly T[]): Promise<void> {
	const all = await read<(T & { at: string })[]>(name, []);
	const at = new Date().toISOString();
	await write(name, [...all, ...items.map((x) => ({ ...x, at }))]);
}
