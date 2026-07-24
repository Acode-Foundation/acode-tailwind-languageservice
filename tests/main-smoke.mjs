import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const bundle = fs.readFileSync(
	new URL("../dist/main.js", import.meta.url),
	"utf8",
);

let initPlugin;
let unmountPlugin;
let registeredRuntime;
let registeredServer;
let registeredReplace;
let unregisteredRuntime;
let unregisteredServer;
let workerInstance;
const registeredIds = [];

class FakeWorker {
	constructor(url, options) {
		this.url = url;
		this.options = options;
		this.messages = [];
		workerInstance = this;
	}

	postMessage(message) {
		this.messages.push(message);
	}

	terminate() {
		this.terminated = true;
	}
}

const originalHtmlServer = {
	id: "html",
	label: "HTML (Web Worker)",
	languages: ["html", "vue", "svelte"],
	runtimes: ["web-worker"],
	transport: { kind: "external" },
	enabled: true,
};

function createFakeWorkerTransport(options) {
	const worker = new FakeWorker(options.url, { name: options.name });
	const listeners = new Set();
	let disposed = false;
	let readySettled = false;
	let resolveReady;
	let rejectReady;
	const ready = new Promise((resolve, reject) => {
		resolveReady = resolve;
		rejectReady = reject;
	});

	const startupTimer = setTimeout(() => {
		if (readySettled || disposed) return;
		readySettled = true;
		worker.terminate();
		rejectReady(new Error("Timed out starting worker"));
	}, options.startupTimeout ?? 20_000);

	const settleReady = (error) => {
		if (readySettled) return;
		readySettled = true;
		clearTimeout(startupTimer);
		if (error) rejectReady(error);
		else resolveReady();
	};

	worker.onmessage = (event) => {
		const data = event.data;
		if (typeof data === "string") {
			for (const listener of listeners) listener(data);
			return;
		}
		if (data?.kind === "ready") {
			settleReady();
			return;
		}
		if (data?.kind === "error") {
			settleReady(new Error(data.message || "Worker failed to start"));
			return;
		}
		if (data?.kind === "host-request") {
			const method = data.method;
			const params =
				data.params && typeof data.params === "object"
					? data.params
					: Object.fromEntries(
							Object.entries(data).filter(
								([key]) =>
									key !== "kind" && key !== "id" && key !== "method",
							),
						);
			const handler = options.hostHandlers?.[method];
			Promise.resolve(handler ? handler(params) : undefined)
				.then((result) => {
					if (!disposed) {
						worker.postMessage({
							kind: "host-response",
							id: data.id,
							result,
						});
					}
				})
				.catch((error) => {
					if (!disposed) {
						worker.postMessage({
							kind: "host-response",
							id: data.id,
							error: error instanceof Error ? error.message : String(error),
						});
					}
				});
		}
	};

	worker.onerror = (event) => {
		settleReady(new Error(event.message || "Worker failed"));
	};

	if (options.configure) {
		worker.postMessage(options.configure);
	}

	return {
		transport: {
			send(message) {
				if (disposed) throw new Error("Worker is closed");
				worker.postMessage(message);
			},
			subscribe(handler) {
				listeners.add(handler);
			},
			unsubscribe(handler) {
				listeners.delete(handler);
			},
		},
		ready,
		dispose() {
			if (disposed) return;
			disposed = true;
			clearTimeout(startupTimer);
			listeners.clear();
			worker.terminate();
		},
	};
}

const lsp = {
	defineServer(options) {
		return options;
	},
	register(server, options = {}) {
		registeredIds.push(server.id);
		registeredServer = server;
		registeredReplace = options.replace === true;
	},
	servers: {
		get(id) {
			if (id === "html") return originalHtmlServer;
			return null;
		},
		unregister(id) {
			unregisteredServer = id;
			return true;
		},
	},
	runtimes: {
		register(runtime) {
			registeredRuntime = runtime;
		},
		unregister(id) {
			unregisteredRuntime = id;
			return true;
		},
	},
	workers: {
		createTransport(options) {
			return createFakeWorkerTransport(options);
		},
	},
};

const acode = {
	require(id) {
		if (id === "lsp") return lsp;
		if (id === "fs") return () => null;
		if (id === "Url") {
			return {
				join: (...parts) => parts.join("/"),
				dirname: (uri) => uri.slice(0, uri.lastIndexOf("/") + 1),
				extname: (uri) => /\.[^/]+$/.exec(uri)?.[0] ?? "",
			};
		}
		throw new Error(`Unexpected Acode module: ${id}`);
	},
	setPluginInit(_id, callback) {
		initPlugin = callback;
	},
	setPluginUnmount(_id, callback) {
		unmountPlugin = callback;
	},
};

const context = vm.createContext({
	URL,
	Worker: FakeWorker,
	acode,
	clearTimeout,
	console,
	setTimeout,
	window: { acode },
});

vm.runInContext(bundle, context, { filename: "main.js" });
assert.equal(typeof initPlugin, "function");
assert.equal(typeof unmountPlugin, "function");

await initPlugin("https://localhost/plugins/tailwind/");
assert.equal(registeredRuntime.id, "tailwindcss-web-worker");
assert.equal(registeredServer.id, "tailwindcss-worker");
assert.equal(registeredReplace, true);
assert.deepEqual(registeredIds, ["tailwindcss-worker"]);
assert.ok(registeredServer.languages.includes("html"));
assert.ok(registeredServer.languages.includes("css"));
assert.ok(registeredServer.languages.includes("typescript"));
assert.ok(registeredServer.languages.includes("astro"));
assert.equal(
	Array.from(registeredServer.runtimes).join(","),
	"tailwindcss-web-worker",
);
assert.equal(
	registeredRuntime.canHandle({ id: "html" }),
	false,
	"runtime must not claim built-in HTML server",
);
assert.equal(
	registeredRuntime.canHandle({ id: "css" }),
	false,
	"runtime must not claim built-in CSS server",
);
assert.equal(
	registeredRuntime.canHandle({ id: "typescript" }),
	false,
	"runtime must not claim built-in TypeScript server",
);
assert.equal(registeredRuntime.canHandle({ id: "tailwindcss-worker" }), true);
assert.equal(
	lsp.servers.get("html").label,
	"HTML (Web Worker)",
	"built-in HTML server must remain unchanged",
);
assert.deepEqual(
	lsp.servers.get("html").runtimes,
	["web-worker"],
	"built-in HTML server runtime must remain web-worker",
);

const connection = await registeredRuntime.start(registeredServer, {
	originalRootUri: "file:///workspace/",
});
assert.equal(
	workerInstance.url,
	"https://localhost/plugins/tailwind/tailwind.worker.js",
);
assert.equal(connection.kind, "transport");
workerInstance.onmessage({ data: { kind: "ready" } });
await connection.transport.ready;

const messages = [];
connection.transport.transport.subscribe((message) => {
	messages.push(JSON.parse(message));
});
connection.transport.transport.send(
	JSON.stringify({
		jsonrpc: "2.0",
		id: 20,
		method: "textDocument/completion",
		params: {
			textDocument: { uri: "file:///workspace/index.html" },
			position: { line: 0, character: 12 },
		},
	}),
);
assert.equal(workerInstance.messages.length, 2);
assert.equal(workerInstance.messages[0].kind, "configure");
assert.equal(
	typeof workerInstance.messages[1],
	"string",
	"RPC messages are forwarded as strings",
);
workerInstance.onmessage({
	data: JSON.stringify({
		jsonrpc: "2.0",
		id: 20,
		result: { items: [{ label: "bg-red-500" }] },
	}),
});
assert.deepEqual(
	messages[0].result.items.map((item) => item.label),
	["bg-red-500"],
);
await connection.transport.dispose();
assert.equal(workerInstance.terminated, true);

unmountPlugin();
assert.equal(unregisteredServer, "tailwindcss-worker");
assert.equal(unregisteredRuntime, "tailwindcss-web-worker");
assert.equal(
	lsp.servers.get("html").label,
	"HTML (Web Worker)",
	"unmount must not rewrite built-in servers",
);

console.log("Main-thread smoke test passed");
