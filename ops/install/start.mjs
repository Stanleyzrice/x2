import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const app = fileURLToPath(new URL("../../", import.meta.url));
const root = resolve(process.argv[2] ?? join(app, ".."));
const win = process.platform === "win32";
const exe = (name) => (win ? `${name}.exe` : name);
const update = { cwd: app, stdio: "inherit" };
const checkOnly = process.argv.includes("--check");

function run(command, args, options = {}) {
	const result = spawnSync(command, args, { ...update, ...options });
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`${command} exited with ${result.status}`);
}

async function port(number = 0) {
	const server = createServer();
	await new Promise((ok, fail) => server.once("error", fail).listen(number, "127.0.0.1", ok));
	const actual = server.address().port;
	await new Promise((ok, fail) => server.close((error) => (error ? fail(error) : ok())));
	return actual;
}

async function database() {
	const settingsFile = join(app, ".x2-setup.json");
	const settings = existsSync(settingsFile) ? JSON.parse(await readFile(settingsFile, "utf8")) : {};
	const env = { ...process.env, X2_HOME: join(root, "state") };
	// A store that already points to another database keeps using it.
	const config = join(root, "database.json");
	const localEnv = join(app, ".env");
	const external = process.env.X2_DATABASE_URL || (existsSync(localEnv) && parseEnv(await readFile(localEnv, "utf8")).X2_DATABASE_URL);
	if (external || (!existsSync(config) && settings.X2_DATABASE_URL)) return env;

	if (!existsSync(config)) {
		await writeFile(config, JSON.stringify({ dbPort: await port(), password: randomBytes(24).toString("hex") }), { flag: "wx", mode: 0o600 });
	}
	const { dbPort, password } = JSON.parse(await readFile(config, "utf8"));
	if (!Number.isInteger(dbPort) || dbPort < 1024 || dbPort > 65535 || !/^[a-f0-9]{48}$/.test(password)) throw new Error("Invalid X2 database configuration.");
	const data = join(root, "postgres");
	const pgctl = exe("pg_ctl");
	if (!existsSync(join(data, "PG_VERSION"))) {
		const passwordFile = join(root, "database-password.tmp");
		await writeFile(passwordFile, `${password}\n`, { mode: 0o600 });
		try {
			run(exe("initdb"), ["-D", data, "-U", "x2", "--encoding=UTF8", "--locale=C", "--auth=scram-sha-256", `--pwfile=${passwordFile}`]);
		} finally {
			await rm(passwordFile, { force: true });
		}
	}
	if (spawnSync(pgctl, ["-D", data, "status"], { stdio: "ignore" }).status !== 0) {
		run(pgctl, ["-D", data, "-l", join(root, "postgres.log"), "-o", `-h 127.0.0.1 -p ${dbPort}`, "-w", "start"]);
	}
	const connection = ["-h", "127.0.0.1", "-p", String(dbPort), "-U", "x2"];
	const dbEnv = { ...env, PGPASSWORD: password };
	const lookup = spawnSync(exe("psql"), [...connection, "-d", "postgres", "-XAtc", "select 1 from pg_database where datname = 'x2'"], {
		encoding: "utf8",
		env: dbEnv,
	});
	if (lookup.error || lookup.status !== 0) throw new Error("Could not connect to the X2 database.");
	if (lookup.stdout.trim() !== "1") run(exe("createdb"), [...connection, "x2"], { env: dbEnv });
	if (!settings.X2_DATABASE_URL) {
		settings.X2_DATABASE_URL = `postgresql://x2:${password}@127.0.0.1:${dbPort}/x2`;
		const temporary = `${settingsFile}.install`;
		await writeFile(temporary, `${JSON.stringify(settings)}\n`, { mode: 0o600 });
		await rename(temporary, settingsFile);
	}
	return env;
}

async function installHermes() {
	const path = join(app, "artifacts", "runtime", "hermes-agent");
	const python = join(path, ".venv", win ? "Scripts" : "bin", exe("python"));
	if (!existsSync(join(path, ".git"))) {
		await mkdir(dirname(path), { recursive: true });
		run(exe("git"), ["clone", "--depth", "1", "--branch", "v0.23.3", "https://github.com/NousResearch/hermes-agent.git", path]);
	}
	if (!existsSync(python)) run(exe("uv"), ["sync", "--project", path, "--locked", "--python", "3.14", "--extra", "mcp"]);
	run(python, ["-c", "from run_agent import AIAgent; import mcp"]);
}

async function chrome() {
	const platform = win ? "win64" : process.arch === "arm64" ? "mac-arm64" : "mac-x64";
	const directory = join(root, "browser");
	const binary = (folder) =>
		join(
			directory,
			folder,
			`chrome-${platform}`,
			...(win ? ["chrome.exe"] : ["Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"]),
		);
	await mkdir(directory, { recursive: true });
	const installed = (await readdir(directory)).find((folder) => existsSync(binary(folder)));
	if (installed) return binary(installed);
	const meta = await fetch("https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json", {
		signal: AbortSignal.timeout(30_000),
	});
	if (!meta.ok) throw new Error("Could not obtain Chrome for Testing release data.");
	const { version, downloads } = (await meta.json()).channels.Stable;
	const url = new URL(downloads.chrome.find((entry) => entry.platform === platform).url);
	if (url.origin !== "https://storage.googleapis.com" || !url.pathname.startsWith("/chrome-for-testing-public/") || !/^\d+(\.\d+){3}$/.test(version))
		throw new Error("Unexpected browser download URL.");
	const archive = join(directory, `${version}.zip`);
	const release = join(directory, version);
	await mkdir(release, { recursive: true });
	try {
		const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(300_000) });
		if (!response.ok || !response.body) throw new Error("Could not download Chrome for Testing.");
		await pipeline(response.body, createWriteStream(archive));
		run(win ? "tar.exe" : "/usr/bin/ditto", win ? ["-xf", archive, "-C", release] : ["-x", "-k", archive, release]);
	} finally {
		await rm(archive, { force: true });
	}
	if (!existsSync(binary(version))) throw new Error("Chrome for Testing is missing after extraction.");
	return binary(version);
}

const env = await database();
try {
	await installHermes();
	const booey = dirname(fileURLToPath(import.meta.resolve("@wuwe1/booey/package.json")));
	const browser = await chrome();
	if (!checkOnly) {
		const cli = join(booey, "dist", "cli", "booey.js");
		const status = spawnSync(process.execPath, [cli, "daemon", "status"], { ...update, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
		if (status.error || status.status !== 0) throw new Error("Could not read Booey status.");
		if (!JSON.parse(status.stdout).running) run(process.execPath, [cli, "daemon", "start"]);
	}
	const webPort = await port(5170).catch(() => port());
	const url = `http://127.0.0.1:${webPort}`;
	const web = spawn(process.execPath, ["x2.ts", "web", "--port", String(webPort)], { ...update, env });
	const done = once(web, "exit");
	try {
		let setup;
		for (let attempt = 0; attempt < 100 && web.exitCode === null; attempt++) {
			const response = await fetch(`${url}/api/setup`, { signal: AbortSignal.timeout(2000) }).catch(() => null);
			if (response?.ok) {
				setup = await response.json();
				break;
			}
			await setTimeout(500);
		}
		if (!setup?.database) throw new Error("X2 did not start with the database connected. See the messages above.");
		if (!checkOnly) {
			const chromeProcess = spawn(
				browser,
				[`--user-data-dir=${join(root, "chrome-profile")}`, `--load-extension=${join(booey, "extension")}`, "--no-first-run", url],
				{
					detached: true,
					stdio: "ignore",
				},
			);
			await once(chromeProcess, "spawn");
			chromeProcess.unref();
			process.stdout.write(`X2: ${url}\n`);
			const [code] = await done;
			process.exitCode = code ?? 0;
		} else process.stdout.write(`X2 setup and database ready: ${url}\n`);
	} finally {
		if (web.exitCode === null) {
			web.kill();
			await done;
		}
	}
} finally {
	if (checkOnly && existsSync(join(root, "postgres", "PG_VERSION"))) run(exe("pg_ctl"), ["-D", join(root, "postgres"), "-w", "stop"]);
}
