import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import vm from "node:vm";

const bundle = fs.readFileSync(
	new URL("../dist/tailwind.worker.js", import.meta.url),
	"utf8",
);

const projectCss = `
@import "tailwindcss";
@theme {
	--color-acode-brand: #8b5cf6;
}
`;

const controls = [];
const rpcMessages = [];
const rpcMessageSizes = new Map();
const hostCalls = new Map();
let context;

function hostResult(message) {
	hostCalls.set(message.method, (hostCalls.get(message.method) ?? 0) + 1);
	switch (message.method) {
		case "findProjectFiles":
			return {
				css: ["file:///workspace/src/app.css"],
				truncated: false,
			};
		case "readFile":
			if (message.params.uri === "file:///workspace/src/app.css") {
				return projectCss;
			}
			throw new Error(`Unexpected readFile: ${message.params.uri}`);
		case "readDirectory":
			return [];
		case "resolveFile":
			return null;
		default:
			throw new Error(`Unexpected host request: ${message.method}`);
	}
}

function postMessage(message) {
	if (typeof message === "string") {
		const parsed = JSON.parse(message);
		rpcMessages.push(parsed);
		if (parsed.id != null) rpcMessageSizes.set(parsed.id, message.length);
		return;
	}

	if (message?.kind === "host-request") {
		queueMicrotask(() => {
			try {
				context.onmessage({
					data: {
						kind: "host-response",
						id: message.id,
						result: hostResult(message),
					},
				});
			} catch (error) {
				context.onmessage({
					data: {
						kind: "host-response",
						id: message.id,
						error: error.message,
					},
				});
			}
		});
		return;
	}

	controls.push(message);
}

context = vm.createContext({
	AbortController,
	Blob,
	URL,
	URLSearchParams,
	TextDecoder,
	TextEncoder,
	clearInterval,
	clearTimeout,
	console,
	crypto: crypto.webcrypto,
	fetch,
	performance,
	postMessage,
	queueMicrotask,
	setInterval,
	setTimeout,
	structuredClone,
});

vm.runInContext(bundle, context, {
	filename: "tailwind.worker.js",
});

const waitFor = async (predicate, timeout = 10_000) => {
	const started = Date.now();
	while (!predicate()) {
		if (Date.now() - started > timeout) {
			throw new Error("Timed out waiting for worker response");
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
};

const send = (message) => {
	context.onmessage({
		data: typeof message === "string" ? message : JSON.stringify(message),
	});
};

context.onmessage({
	data: {
		kind: "configure",
		serverId: "tailwindcss-worker",
		rootUri: "file:///workspace/",
		initializationOptions: {
			tailwindCSS: { emmetCompletions: true },
		},
	},
});

await waitFor(() => controls.some((message) => message?.kind === "ready"));

send({
	jsonrpc: "2.0",
	id: 1,
	method: "initialize",
	params: {
		rootUri: "file:///workspace/",
		capabilities: {},
	},
});
await waitFor(() => rpcMessages.some((message) => message.id === 1));
assert.equal(
	rpcMessages.find((message) => message.id === 1).result.capabilities
		.hoverProvider,
	true,
);
assert.equal(
	rpcMessages.find((message) => message.id === 1).result.capabilities
		.colorProvider,
	true,
);
assert.equal(
	rpcMessages.find((message) => message.id === 1).result.capabilities
		.codeActionProvider,
	true,
);

const documentUri = "file:///workspace/src/index.html";
send({
	jsonrpc: "2.0",
	method: "textDocument/didOpen",
	params: {
		textDocument: {
			uri: documentUri,
			languageId: "html",
			version: 1,
			text: '<div class="bg-acode"></div>',
		},
	},
});

send({
	jsonrpc: "2.0",
	id: 2,
	method: "textDocument/completion",
	params: {
		textDocument: { uri: documentUri },
		position: { line: 0, character: 20 },
		context: { triggerKind: 1 },
	},
});
await waitFor(() => rpcMessages.some((message) => message.id === 2));
const completion = rpcMessages.find((message) => message.id === 2).result;
assert.ok(
	completion.items.length <= 750,
	"completion responses should be bounded before crossing the worker boundary",
);
assert.equal(
	completion.isIncomplete,
	true,
	"a truncated completion response should ask the client to request again",
);
assert.ok(
	(rpcMessageSizes.get(2) ?? Infinity) < 300_000,
	"completion JSON should stay small enough for a mobile worker bridge",
);
assert.ok(
	completion.items.some((item) => item.label === "bg-acode-brand"),
	"project-defined Tailwind class should be completed",
);
const completionItem = completion.items.find(
	(item) => item.label === "bg-acode-brand",
);
assert.equal(
	typeof completionItem.data?.__a,
	"number",
	"completion items should carry a compact document id",
);
assert.equal(
	completionItem.data?.__acodeTailwindUri,
	undefined,
	"completion items should not repeat the full document URI",
);
send({
	jsonrpc: "2.0",
	id: 4,
	method: "completionItem/resolve",
	params: completionItem,
});
await waitFor(() => rpcMessages.some((message) => message.id === 4));
const resolvedCompletion = rpcMessages.find((message) => message.id === 4).result;
assert.match(
	`${resolvedCompletion.detail ?? ""}${resolvedCompletion.documentation?.value ?? ""}`,
	/--color-acode-brand/,
);

const broadDocumentUri = "file:///workspace/src/broad.html";
send({
	jsonrpc: "2.0",
	method: "textDocument/didOpen",
	params: {
		textDocument: {
			uri: broadDocumentUri,
			languageId: "html",
			version: 1,
			text: '<div class="b"></div>',
		},
	},
});
send({
	jsonrpc: "2.0",
	id: 8,
	method: "textDocument/completion",
	params: {
		textDocument: { uri: broadDocumentUri },
		position: { line: 0, character: 13 },
		context: { triggerKind: 1 },
	},
});
await waitFor(() => rpcMessages.some((message) => message.id === 8));
const broadCompletion = rpcMessages.find((message) => message.id === 8).result;
assert.equal(
	broadCompletion.items.length,
	750,
	"broad completion queries should be capped",
);
assert.ok(
	(rpcMessageSizes.get(8) ?? Infinity) < 300_000,
	"even broad completion JSON should stay bounded",
);
send({
	jsonrpc: "2.0",
	method: "textDocument/didClose",
	params: { textDocument: { uri: broadDocumentUri } },
});

const emmetDocumentUri = "file:///workspace/src/emmet.html";
send({
	jsonrpc: "2.0",
	method: "textDocument/didOpen",
	params: {
		textDocument: {
			uri: emmetDocumentUri,
			languageId: "html",
			version: 1,
			text: "div.bg-acode",
		},
	},
});
send({
	jsonrpc: "2.0",
	id: 9,
	method: "textDocument/completion",
	params: {
		textDocument: { uri: emmetDocumentUri },
		position: { line: 0, character: 12 },
		context: { triggerKind: 1 },
	},
});
await waitFor(() => rpcMessages.some((message) => message.id === 9));
assert.ok(
	rpcMessages
		.find((message) => message.id === 9)
		.result.items.some((item) => item.label === "bg-acode-brand"),
	"the lightweight Emmet path should preserve Tailwind class completions",
);
send({
	jsonrpc: "2.0",
	method: "textDocument/didClose",
	params: { textDocument: { uri: emmetDocumentUri } },
});

const embeddedDocumentText =
	'<style>@theme { --color-inline-theme: #14b8a6; }</style><div class="bg-inline"></div>';
send({
	jsonrpc: "2.0",
	method: "textDocument/didChange",
	params: {
		textDocument: { uri: documentUri, version: 2 },
		contentChanges: [
			{ text: '<div class="bg-acode-brand"></div>' },
		],
	},
});
send({
	jsonrpc: "2.0",
	id: 3,
	method: "textDocument/hover",
	params: {
		textDocument: { uri: documentUri },
		position: { line: 0, character: 20 },
	},
});
await waitFor(() => rpcMessages.some((message) => message.id === 3));
const hover = rpcMessages.find((message) => message.id === 3).result;
assert.match(hover.contents.value, /background-color/);
assert.match(hover.contents.value, /--color-acode-brand/);
assert.match(hover.contents.value, /^```css\n/);

send({
	jsonrpc: "2.0",
	method: "textDocument/didChange",
	params: {
		textDocument: { uri: documentUri, version: 3 },
		contentChanges: [{ text: embeddedDocumentText }],
	},
});
send({
	jsonrpc: "2.0",
	id: 5,
	method: "textDocument/completion",
	params: {
		textDocument: { uri: documentUri },
		position: { line: 0, character: 77 },
		context: { triggerKind: 1 },
	},
});
await waitFor(() => rpcMessages.some((message) => message.id === 5));
const inlineCompletion = rpcMessages.find((message) => message.id === 5).result;
assert.ok(
	inlineCompletion.items.some((item) => item.label === "bg-inline-theme"),
	"an @theme block in the open HTML document should update completions",
);

send({
	jsonrpc: "2.0",
	method: "textDocument/didChange",
	params: {
		textDocument: { uri: documentUri, version: 4 },
		contentChanges: [{ text: `${embeddedDocumentText} ` }],
	},
});
send({
	jsonrpc: "2.0",
	id: 10,
	method: "textDocument/completion",
	params: {
		textDocument: { uri: documentUri },
		position: { line: 0, character: 77 },
		context: { triggerKind: 1 },
	},
});
await waitFor(() => rpcMessages.some((message) => message.id === 10));
assert.ok(
	rpcMessages
		.find((message) => message.id === 10)
		.result.items.some((item) => item.label === "bg-inline-theme"),
	"editing outside an unchanged @theme block should reuse its project state",
);

send({
	jsonrpc: "2.0",
	method: "textDocument/didChange",
	params: {
		textDocument: { uri: documentUri, version: 5 },
		contentChanges: [
			{ text: '<div class="bg-acode-brand"></div>' },
		],
	},
});
send({
	jsonrpc: "2.0",
	id: 6,
	method: "textDocument/documentColor",
	params: {
		textDocument: { uri: documentUri },
	},
});
await waitFor(() => rpcMessages.some((message) => message.id === 6));
const documentColors = rpcMessages.find((message) => message.id === 6).result;
assert.ok(documentColors.length > 0, "Tailwind class colors should be returned");
assert.ok(
	documentColors.some(
		(item) =>
			Math.abs(item.color.red - 0.545) < 0.02 &&
			Math.abs(item.color.blue - 0.965) < 0.02,
	),
	"custom theme color should be represented in document colors",
);

send({
	jsonrpc: "2.0",
	method: "textDocument/didChange",
	params: {
		textDocument: { uri: documentUri, version: 6 },
		contentChanges: [{ text: '<div class="block inline"></div>' }],
	},
});
await waitFor(() =>
	rpcMessages.some(
		(message) =>
			message.method === "textDocument/publishDiagnostics" &&
			message.params?.version === 6,
	),
);
const publishedDiagnostics = rpcMessages.find(
	(message) =>
		message.method === "textDocument/publishDiagnostics" &&
		message.params?.version === 6,
).params.diagnostics;
assert.ok(
	publishedDiagnostics.length > 0,
	"conflicting Tailwind classes should publish diagnostics",
);

send({
	jsonrpc: "2.0",
	id: 7,
	method: "textDocument/codeAction",
	params: {
		textDocument: { uri: documentUri },
		range: {
			start: { line: 0, character: 0 },
			end: { line: 0, character: 31 },
		},
		context: { diagnostics: publishedDiagnostics },
	},
});
await waitFor(() => rpcMessages.some((message) => message.id === 7));
const codeActions = rpcMessages.find((message) => message.id === 7).result;
assert.ok(
	codeActions.length > 0,
	"Tailwind diagnostics should provide quick-fix code actions",
);

const discoveriesBeforeWatch = hostCalls.get("findProjectFiles") ?? 0;
send({
	jsonrpc: "2.0",
	method: "workspace/didChangeWatchedFiles",
	params: {
		changes: [
			{ uri: documentUri, type: 2 },
			{ uri: "file:///workspace/src/unrelated.css", type: 2 },
		],
	},
});
await new Promise((resolve) => setTimeout(resolve, 400));
assert.equal(
	hostCalls.get("findProjectFiles") ?? 0,
	discoveriesBeforeWatch,
	"ordinary source-file changes should not rescan the Tailwind workspace",
);

send({
	jsonrpc: "2.0",
	method: "workspace/didChangeWatchedFiles",
	params: {
		changes: [{ uri: "file:///workspace/src/app.css", type: 2 }],
	},
});
await waitFor(
	() => (hostCalls.get("findProjectFiles") ?? 0) > discoveriesBeforeWatch,
);

console.log("Worker smoke test passed");
