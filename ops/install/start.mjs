import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { createDaemon } from "@wuwe1/booey/daemon";

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
	return python;
}

async function chrome(python) {
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
	const staging = await mkdtemp(join(directory, "download-"));
	const archive = join(staging, `${version}.zip`);
	const extracted = join(staging, "extracted");
	const release = join(directory, version);
	await mkdir(extracted);
	process.stdout.write(`Downloading Chrome for Testing ${version}...\n`);
	const download = new AbortController();
	let file;
	let written = 0;
	const monitor = setInterval(() => {
		const bytes = file?.bytesWritten ?? 0;
		if (bytes === written) download.abort(new Error("Chrome download made no progress for 60 seconds."));
		else process.stdout.write(`Chrome download: ${(bytes / 1024 ** 2).toFixed(1)} MiB\n`);
		written = bytes;
	}, 60_000);
	try {
		const response = await fetch(url, { redirect: "error", signal: download.signal });
		if (!response.ok || !response.body) throw new Error("Could not download Chrome for Testing.");
		file = createWriteStream(archive);
		await pipeline(response.body, file, { signal: download.signal });
		clearInterval(monitor);
		process.stdout.write(`Extracting Chrome for Testing ${version}...\n`);
		if (win) run(python, ["-m", "zipfile", "-e", archive, extracted]);
		else run("/usr/bin/ditto", ["-x", "-k", archive, extracted]);
		await rename(extracted, release);
	} catch (error) {
		download.signal.throwIfAborted();
		throw error;
	} finally {
		clearInterval(monitor);
		await rm(staging, { recursive: true, force: true });
	}
	if (!existsSync(binary(version))) throw new Error("Chrome for Testing is missing after extraction.");
	return binary(version);
}

async function relayReady(port) {
	const response = await fetch(`http://127.0.0.1:${port}/status`, { signal: AbortSignal.timeout(1500) }).catch(() => null);
	if (!response?.ok) return false;
	const status = await response.json().catch(() => null);
	return Number.isInteger(status?.version) && Array.isArray(status?.browsers);
}

const env = await database();
let relay;
try {
	const python = await installHermes();
	const booey = dirname(fileURLToPath(import.meta.resolve("@wuwe1/booey/package.json")));
	const browser = await chrome(python);
	const relayPort = Number(process.env.BOOEY_PORT || 9224);
	if (checkOnly || !(await relayReady(relayPort))) {
		relay = await createDaemon({ port: checkOnly ? 0 : relayPort });
		if (!(await relayReady(relay.port))) throw new Error("Booey did not start.");
	}
	const webPort = await port(5170).catch(() => port());
	const url = `http://127.0.0.1:${webPort}`;
	process.stdout.write(`Starting X2 web at ${url}...\n`);
	const web = spawn(process.execPath, ["x2.ts", "web", "--port", String(webPort)], { ...update, env });
	const done = once(web, "exit");
	try {
		let setup;
		let lastFailure;
		const deadline = Date.now() + 120_000;
		while (Date.now() < deadline && web.exitCode === null && web.signalCode === null) {
			try {
				const response = await fetch(`${url}/api/setup`, { signal: AbortSignal.timeout(2000) });
				if (response.ok) {
					setup = await response.json();
					break;
				}
				lastFailure = `HTTP ${response.status}`;
			} catch (error) {
				lastFailure = error.cause?.code ?? error.name;
			}
			await setTimeout(500);
		}
		if (web.exitCode !== null || web.signalCode !== null) throw new Error(`X2 web exited during startup (${web.exitCode ?? web.signalCode}).`);
		if (!setup) {
			const page = await fetch(url, { signal: AbortSignal.timeout(2000) }).catch(() => null);
			const stage = page?.ok ? "X2 web is listening but /api/setup did not become ready" : "X2 web did not start listening";
			throw new Error(`${stage} at ${url} (${lastFailure ?? "no setup response"}). See the messages above.`);
		}
		if (!setup.database) throw new Error("X2 web started, but its database initialization failed.");
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
		} else {
			const page = await fetch(url, { signal: AbortSignal.timeout(2000) });
			const script = (await page.text()).match(/<script\b[^>]*\bsrc="([^"]+)"/)?.[1];
			const asset = script && (await fetch(new URL(script, url), { signal: AbortSignal.timeout(2000) }));
			if (!asset?.ok || !asset.headers.get("content-type")?.startsWith("text/javascript")) throw new Error("X2 web frontend did not load.");
			process.stdout.write(`X2 setup and database ready: ${url}\n`);
		}
	} finally {
		if (web.exitCode === null && web.signalCode === null) {
			web.kill();
			await done;
		}
	}
} finally {
	await relay?.close();
	if (checkOnly && existsSync(join(root, "postgres", "PG_VERSION"))) run(exe("pg_ctl"), ["-D", join(root, "postgres"), "-w", "stop"]);
}
