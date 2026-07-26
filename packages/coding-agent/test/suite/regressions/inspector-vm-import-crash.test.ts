import { type ChildProcessByStdio, spawn, spawnSync } from "node:child_process";
import { close as closeInspector, url as inspectorUrl, open as openInspector } from "node:inspector";
import { createServer } from "node:net";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, test, vi } from "vitest";
import { isRecoverableInspectorVmImportError } from "../../../src/inspector-policy.ts";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";

type UncaughtExceptionOrigin = "uncaughtException" | "unhandledRejection";

const originalRecoveryFlag = vi.hoisted(() => {
	const original = process.env.SENPI_RECOVER_INSPECTOR_VM_IMPORT;
	process.env.SENPI_RECOVER_INSPECTOR_VM_IMPORT = "1";
	return original;
});

type UncaughtCrashThis = {
	isShuttingDown: boolean;
	showWarning: (message: string) => void;
	ui: { stop: () => void };
	unregisterSignalHandlers: () => void;
};

type InteractiveModePrototypeWithUncaughtCrash = {
	uncaughtCrash(this: UncaughtCrashThis, error: Error, origin: UncaughtExceptionOrigin): void;
};

class ProcessExitError extends Error {
	readonly code: string | number | null | undefined;

	constructor(code: string | number | null | undefined) {
		super(`process.exit(${String(code)})`);
		this.code = code;
	}
}

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrototypeWithUncaughtCrash;

function callUncaughtCrash(context: UncaughtCrashThis, error: Error, origin: UncaughtExceptionOrigin): void {
	interactiveModePrototype.uncaughtCrash.call(context, error, origin);
}

function createVmImportError(source: "<anonymous>" | "evalmachine.<anonymous>"): Error {
	const error = Object.assign(new TypeError("A dynamic import callback was not specified."), {
		code: "ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING",
	});
	error.stack = [
		"TypeError [ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING]: A dynamic import callback was not specified.",
		"    at importModuleDynamicallyCallback (node:internal/modules/esm/utils:279:9)",
		`    at Timeout._onTimeout (${source}:1:16)`,
		"    at listOnTimeout (node:internal/timers:605:17)",
	].join("\n");
	return error;
}

function createCrashContext(): UncaughtCrashThis {
	return {
		isShuttingDown: false,
		showWarning: vi.fn(),
		ui: { stop: vi.fn() },
		unregisterSignalHandlers: vi.fn(),
	};
}

function findFreePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (address === null || typeof address === "string") {
				server.close(() => reject(new Error("Expected a TCP server address")));
				return;
			}
			server.close(() => resolve(address.port));
		});
	});
}

/**
 * Attach a full-fidelity debugger client to every Inspector endpoint the run prints —
 * enable the Debugger domain, resume the break-at-start pause, and stay connected until
 * the CLI prints its help output — mirroring a developer who remains attached across the
 * launcher-to-child handoff.
 */
function driveInspectorBrkRun(
	child: ChildProcessByStdio<null, Readable, Readable>,
	sockets: WebSocket[],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		let stdout = "";
		let stderr = "";
		const attached = new Set<string>();
		const timer = setTimeout(() => {
			reject(new Error(`--inspect-brk handoff timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`));
		}, 55_000);
		timer.unref();
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
			if (stdout.includes("Usage:")) {
				// The run is past both break-at-starts; detach so neither process is kept
				// alive by its still-attached debugger client.
				for (const socket of sockets) socket.close();
			}
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
			for (const match of stderr.matchAll(/Debugger listening on (ws:\/\/\S+)/g)) {
				const url = match[1];
				if (url === undefined || attached.has(url)) continue;
				attached.add(url);
				const socket = new WebSocket(url);
				sockets.push(socket);
				socket.addEventListener("open", () => {
					socket.send(JSON.stringify({ id: 1, method: "Debugger.enable" }));
					socket.send(JSON.stringify({ id: 2, method: "Runtime.runIfWaitingForDebugger" }));
				});
				socket.addEventListener("message", (event) => {
					const message = JSON.parse(String(event.data)) as { method?: string };
					if (message.method === "Debugger.paused") {
						socket.send(JSON.stringify({ id: 3, method: "Debugger.resume" }));
					}
				});
				socket.addEventListener("error", () => {
					// The endpoint disappears when its process exits first; that is fine.
				});
			}
		});
		child.on("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ code, stdout, stderr });
		});
	});
}

afterEach(() => {
	vi.restoreAllMocks();
});

afterAll(() => {
	if (originalRecoveryFlag === undefined) {
		delete process.env.SENPI_RECOVER_INSPECTOR_VM_IMPORT;
	} else {
		process.env.SENPI_RECOVER_INSPECTOR_VM_IMPORT = originalRecoveryFlag;
	}
});

describe("Inspector VM dynamic import crash handling", () => {
	test("hands the fixed Inspector endpoint from the launcher to cli-main", () => {
		const fixturePath = fileURLToPath(new URL("../../fixtures/inspector-fixed-port.ts", import.meta.url));
		const cliPath = fileURLToPath(new URL("../../../src/cli.ts", import.meta.url));
		const result = spawnSync(process.execPath, ["--import", "tsx", fixturePath, cliPath, "--help"], {
			encoding: "utf8",
			env: {
				...process.env,
				NODE_OPTIONS: "--inspect=127.0.0.1:0",
				PI_OFFLINE: "1",
			},
			timeout: 30_000,
		});
		const output = `${result.stdout}${result.stderr}`;
		const endpoints = [...output.matchAll(/Debugger listening on ws:\/\/127\.0\.0\.1:(\d+)\//g)].map(
			(match) => match[1],
		);

		expect(result.status).toBe(0);
		expect(output).not.toContain("address already in use");
		expect(endpoints).toHaveLength(2);
		expect(new Set(endpoints).size).toBe(1);
	});

	test("hands the fixed --inspect-brk endpoint to cli-main while a debugger stays attached", async () => {
		// Review question this pins: node:inspector documents close() as "blocks until
		// there are no active connections", which would hang the launcher handoff under
		// --inspect-brk because a client must stay attached to resume the launcher at
		// all. On the supported runtime (Node >= 24) close() force-disconnects instead,
		// so the handoff completes and the child rebinds the same fixed endpoint.
		const cliPath = fileURLToPath(new URL("../../../src/cli.ts", import.meta.url));
		const port = await findFreePort();
		const child = spawn(process.execPath, [`--inspect-brk=127.0.0.1:${port}`, "--import", "tsx", cliPath, "--help"], {
			env: { ...process.env, PI_OFFLINE: "1" },
			stdio: ["ignore", "pipe", "pipe"],
		});
		const sockets: WebSocket[] = [];

		try {
			const { code, stdout, stderr } = await driveInspectorBrkRun(child, sockets);
			const endpoints = [...stderr.matchAll(/Debugger listening on ws:\/\/127\.0\.0\.1:(\d+)\//g)].map(
				(match) => match[1],
			);

			expect(stdout).toContain("Usage:");
			expect(code).toBe(0);
			expect(stderr).not.toContain("address already in use");
			// Launcher and child each announced a break-at-start endpoint on the same
			// configured port: the launcher released it without blocking on the attached
			// client and the child rebound it.
			expect(endpoints).toHaveLength(2);
			expect(new Set(endpoints)).toEqual(new Set([String(port)]));
		} finally {
			for (const socket of sockets) {
				try {
					socket.close();
				} catch {
					// Already closed.
				}
			}
			if (child.exitCode === null) child.kill("SIGKILL");
		}
	}, 60_000);

	test("keeps the interactive child running for the exact Inspector eval rejection", () => {
		const context = createCrashContext();
		const openedInspector = inspectorUrl() === undefined;
		if (openedInspector) openInspector(0, "127.0.0.1", false);

		try {
			expect(() =>
				callUncaughtCrash(context, createVmImportError("<anonymous>"), "unhandledRejection"),
			).not.toThrow();
			expect(context.showWarning).toHaveBeenCalledWith(
				"Node Inspector dynamic import is unsupported; use require() or a target-side loader. Senpi kept running.",
			);
			// Recovery must leave the TUI fully alive: no terminal teardown, no signal
			// unregister, and no latch into the shutting-down state.
			expect(context.ui.stop).not.toHaveBeenCalled();
			expect(context.unregisterSignalHandlers).not.toHaveBeenCalled();
			expect(context.isShuttingDown).toBe(false);
		} finally {
			if (openedInspector) closeInspector();
		}
	});

	test("keeps application-owned VM failures on the existing fatal path", () => {
		const context = createCrashContext();
		const exit = vi.spyOn(process, "exit").mockImplementation((code) => {
			throw new ProcessExitError(code);
		});
		const openedInspector = inspectorUrl() === undefined;
		if (openedInspector) openInspector(0, "127.0.0.1", false);

		try {
			expect(() =>
				callUncaughtCrash(context, createVmImportError("evalmachine.<anonymous>"), "unhandledRejection"),
			).toThrow(ProcessExitError);
			expect(exit).toHaveBeenCalledWith(1);
			expect(context.showWarning).not.toHaveBeenCalled();
		} finally {
			if (openedInspector) closeInspector();
		}
	});

	test("does not enable recovery when the environment changes after policy import", () => {
		const fixturePath = fileURLToPath(new URL("../../fixtures/inspector-recovery-env.ts", import.meta.url));
		const env = { ...process.env };
		delete env.SENPI_RECOVER_INSPECTOR_VM_IMPORT;
		const result = spawnSync(process.execPath, ["--import", "tsx", fixturePath], {
			encoding: "utf8",
			env,
			timeout: 30_000,
		});

		expect(result.status).toBe(0);
		expect(result.stdout.trim()).toBe("false");
	});

	test("recovers the exact Inspector rejection during early bootstrap before the TUI exists", () => {
		const fixturePath = fileURLToPath(new URL("../../fixtures/inspector-early-recovery.ts", import.meta.url));
		const result = spawnSync(process.execPath, ["--import", "tsx", fixturePath, "recoverable"], {
			encoding: "utf8",
			env: { ...process.env, SENPI_RECOVER_INSPECTOR_VM_IMPORT: "1" },
			timeout: 30_000,
		});

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("recovered:1");
	});

	test("keeps non-matching bootstrap crashes fatal with the early seam installed", () => {
		const fixturePath = fileURLToPath(new URL("../../fixtures/inspector-early-recovery.ts", import.meta.url));
		const result = spawnSync(process.execPath, ["--import", "tsx", fixturePath, "fatal"], {
			encoding: "utf8",
			env: { ...process.env, SENPI_RECOVER_INSPECTOR_VM_IMPORT: "1" },
			timeout: 30_000,
		});

		expect(result.status).toBe(1);
		expect(result.stdout).not.toContain("recovered:");
		expect(result.stderr).toContain("ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING");
	});

	test("classifies hostile rejection values without throwing", () => {
		const openedInspector = inspectorUrl() === undefined;
		if (openedInspector) openInspector(0, "127.0.0.1", false);

		try {
			const hostileHasTrap = new Proxy(
				{},
				{
					has() {
						throw new Error("hostile has trap");
					},
				},
			);
			const hostileGetter = {
				get code(): never {
					throw new Error("hostile code getter");
				},
				stack: "irrelevant",
			};

			expect(isRecoverableInspectorVmImportError(hostileHasTrap, "unhandledRejection")).toBe(false);
			expect(isRecoverableInspectorVmImportError(hostileGetter, "unhandledRejection")).toBe(false);
		} finally {
			if (openedInspector) closeInspector();
		}
	});

	test("keeps direct uncaught exceptions fatal with recovery enabled", () => {
		const context = createCrashContext();
		const exit = vi.spyOn(process, "exit").mockImplementation((code) => {
			throw new ProcessExitError(code);
		});
		const openedInspector = inspectorUrl() === undefined;
		if (openedInspector) openInspector(0, "127.0.0.1", false);

		try {
			expect(() => callUncaughtCrash(context, createVmImportError("<anonymous>"), "uncaughtException")).toThrow(
				ProcessExitError,
			);
			expect(exit).toHaveBeenCalledWith(1);
			expect(context.showWarning).not.toHaveBeenCalled();
		} finally {
			if (openedInspector) closeInspector();
		}
	});
});
