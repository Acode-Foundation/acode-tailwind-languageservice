import {
	doCodeActions,
	doComplete,
	doHover,
	doValidate,
	getDocumentColors,
	getDocumentLinks,
	resolveCompletionItem,
} from "@tailwindcss/language-service";
import {
	TextDocument,
	type TextDocumentContentChangeEvent,
} from "vscode-languageserver-textdocument";
import type {
	CodeActionParams,
	ColorInformation,
	CompletionItem,
	CompletionParams,
	DocumentLink,
	DocumentLinkParams,
	Hover,
	Position,
} from "vscode-languageserver";
import { TailwindProjectManager } from "./design-system";
import {
	isHostResponse,
	WorkerHostClient,
} from "./host-client";

type JsonRpcId = number | string | null;
type JsonRpcMessage = {
	jsonrpc?: string;
	id?: JsonRpcId;
	method?: string;
	params?: any;
};

type ConfigureMessage = {
	kind: "configure";
	serverId: string;
	rootUri?: string | null;
	initializationOptions?: Record<string, unknown>;
};

const host = new WorkerHostClient();
const documents = new Map<string, TextDocument>();
const validationTimers = new Map<string, ReturnType<typeof setTimeout>>();
const cancelledRequests = new Set<JsonRpcId>();

let manager: TailwindProjectManager | null = null;
let managerReady: Promise<void> = Promise.resolve();
let shuttingDown = false;

function sendJson(message: unknown): void {
	globalThis.postMessage(JSON.stringify(message));
}

function sendResponse(id: JsonRpcId, result: unknown): void {
	sendJson({ jsonrpc: "2.0", id, result: result ?? null });
}

function sendError(id: JsonRpcId, code: number, error: unknown): void {
	sendJson({
		jsonrpc: "2.0",
		id,
		error: {
			code,
			message: error instanceof Error ? error.message : String(error),
		},
	});
}

function notify(method: string, params: unknown): void {
	sendJson({ jsonrpc: "2.0", method, params });
}

function log(level: "error" | "warn" | "info", message: string): void {
	globalThis.postMessage({ kind: "log", level, message });
}

function isConfigureMessage(value: unknown): value is ConfigureMessage {
	return (
		Boolean(value) &&
		typeof value === "object" &&
		(value as { kind?: unknown }).kind === "configure"
	);
}

async function configure(message: ConfigureMessage): Promise<void> {
	manager = new TailwindProjectManager(
		host,
		message.rootUri ?? null,
		message.initializationOptions ?? {},
	);
	managerReady = manager.initialize();
	await managerReady;
	globalThis.postMessage({ kind: "ready" });
}

function openDocument(params: {
	textDocument: {
		uri: string;
		languageId: string;
		version: number;
		text: string;
	};
}): void {
	const item = params.textDocument;
	documents.set(
		item.uri,
		TextDocument.create(item.uri, item.languageId, item.version, item.text),
	);
	scheduleValidation(item.uri);
}

function changeDocument(params: {
	textDocument: { uri: string; version: number };
	contentChanges: TextDocumentContentChangeEvent[];
}): void {
	const current = documents.get(params.textDocument.uri);
	if (!current) return;
	documents.set(
		current.uri,
		TextDocument.update(
			current,
			params.contentChanges,
			params.textDocument.version,
		),
	);
	scheduleValidation(current.uri);
}

function closeDocument(params: { textDocument: { uri: string } }): void {
	const uri = params.textDocument.uri;
	documents.delete(uri);
	manager?.closeDocument(uri);
	const timer = validationTimers.get(uri);
	if (timer) clearTimeout(timer);
	validationTimers.delete(uri);
	notify("textDocument/publishDiagnostics", { uri, diagnostics: [] });
}

function scheduleValidation(uri: string): void {
	const existing = validationTimers.get(uri);
	if (existing) clearTimeout(existing);
	validationTimers.set(
		uri,
		setTimeout(() => {
			validationTimers.delete(uri);
			void validateDocument(uri);
		}, 250),
	);
}

async function validateDocument(uri: string): Promise<void> {
	const document = documents.get(uri);
	if (!document || !manager) return;
	const version = document.version;
	try {
		const state = await manager.stateForDocument(document);
		const settings = await state.editor?.getConfiguration(uri);
		const diagnostics = settings?.tailwindCSS.validate
			? await doValidate(state, document)
			: [];
		if (documents.get(uri)?.version === version) {
			notify("textDocument/publishDiagnostics", {
				uri,
				version,
				diagnostics,
			});
		}
	} catch (error) {
		log(
			"warn",
			`Validation failed for ${uri}: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
}

async function stateAndDocument(uri: string) {
	if (!manager) throw new Error("Tailwind project manager is not configured");
	await managerReady;
	const document = documents.get(uri);
	if (!document) throw new Error(`Document is not open: ${uri}`);
	return {
		state: await manager.stateForDocument(document),
		document,
	};
}

function markdownHover(hover: Hover | null): Hover | null {
	if (!hover) return null;
	const contents = hover.contents;
	const values = Array.isArray(contents) ? contents : [contents];
	const sections = values.map((value) => {
		if (typeof value === "string") return value;
		if ("language" in value) {
			const marked = value as { language: string; value: string };
			return `\`\`\`${marked.language || "text"}\n${marked.value}\n\`\`\``;
		}
		return value.kind === "markdown"
			? value.value
			: `\`\`\`text\n${value.value}\n\`\`\``;
	});
	return {
		...hover,
		contents: {
			kind: "markdown",
			value: sections.join("\n\n"),
		},
	};
}

async function handleRequest(
	method: string,
	params: any,
): Promise<unknown> {
	switch (method) {
		case "initialize":
			return {
				capabilities: {
					textDocumentSync: {
						openClose: true,
						change: 2,
						save: { includeText: true },
					},
					completionProvider: {
						resolveProvider: true,
						triggerCharacters: [":", "/", "-", "[", "!", "@"],
					},
					hoverProvider: true,
					colorProvider: true,
					codeActionProvider: true,
					documentLinkProvider: { resolveProvider: false },
					workspace: {
						workspaceFolders: {
							supported: true,
							changeNotifications: true,
						},
					},
				},
				serverInfo: {
					name: "Acode Tailwind CSS Language Service",
					version: "1.1.0",
				},
			};

		case "shutdown":
			shuttingDown = true;
			return null;

		case "textDocument/completion": {
			const completion = params as CompletionParams;
			const { state, document } = await stateAndDocument(
				completion.textDocument.uri,
			);
			const result = await doComplete(
				state,
				document,
				completion.position,
				completion.context,
			);
			for (const item of result?.items ?? []) {
				item.data = {
					...(item.data ?? {}),
					__acodeTailwindUri: completion.textDocument.uri,
				};
			}
			return result;
		}

		case "completionItem/resolve": {
			if (!manager) return params;
			const uri =
				(params as CompletionItem).data?.__acodeTailwindUri ??
				documents.keys().next().value;
			if (!uri) return params;
			const document = documents.get(uri);
			const state = document
				? await manager.stateForDocument(document)
				: await manager.stateFor(uri);
			return resolveCompletionItem(state, params as CompletionItem);
		}

		case "textDocument/hover": {
			const uri = params.textDocument.uri as string;
			const { state, document } = await stateAndDocument(uri);
			const hover = await doHover(
				state,
				document,
				params.position as Position,
			);
			return markdownHover(hover as Hover | null);
		}

		case "textDocument/documentColor": {
			const uri = params.textDocument.uri as string;
			const { state, document } = await stateAndDocument(uri);
			return getDocumentColors(state, document) as Promise<ColorInformation[]>;
		}

		case "textDocument/codeAction": {
			const actionParams = params as CodeActionParams;
			const { state, document } = await stateAndDocument(
				actionParams.textDocument.uri,
			);
			return doCodeActions(state, actionParams, document);
		}

		case "textDocument/documentLink": {
			const linkParams = params as DocumentLinkParams;
			const { state, document } = await stateAndDocument(
				linkParams.textDocument.uri,
			);
			return getDocumentLinks(state, document, (path) =>
				manager!.resolveDocumentLink(path, document.uri),
			) as Promise<DocumentLink[]>;
		}

		default:
			return null;
	}
}

async function handleNotification(method: string, params: any): Promise<void> {
	switch (method) {
		case "initialized":
			return;
		case "exit":
			host.dispose();
			globalThis.close();
			return;
		case "textDocument/didOpen":
			openDocument(params);
			return;
		case "textDocument/didChange":
			changeDocument(params);
			return;
		case "textDocument/didClose":
			closeDocument(params);
			return;
		case "textDocument/didSave": {
			const document = documents.get(params.textDocument.uri);
			if (document && manager) {
				await manager.rebuildOpenEntrypoint(document);
				scheduleValidation(document.uri);
			}
			return;
		}
		case "workspace/didChangeConfiguration":
			manager?.updateSettings(params.settings ?? {});
			for (const uri of documents.keys()) scheduleValidation(uri);
			return;
		case "workspace/didChangeWatchedFiles":
		case "workspace/didChangeWorkspaceFolders":
			if (manager) {
				await manager.reload();
				for (const uri of documents.keys()) scheduleValidation(uri);
			}
			return;
		case "$/cancelRequest":
			cancelledRequests.add(params.id);
			return;
	}
}

async function handleRpc(message: JsonRpcMessage): Promise<void> {
	if (!message.method) return;

	if (Object.prototype.hasOwnProperty.call(message, "id")) {
		const id = message.id ?? null;
		try {
			const result = await handleRequest(message.method, message.params);
			if (!cancelledRequests.delete(id)) sendResponse(id, result);
		} catch (error) {
			sendError(id, -32603, error);
		}
		return;
	}

	try {
		await handleNotification(message.method, message.params);
	} catch (error) {
		log(
			"warn",
			`${message.method} failed: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
}

globalThis.onmessage = (event: MessageEvent<unknown>) => {
	const data = event.data;

	if (isHostResponse(data)) {
		host.handle(data);
		return;
	}

	if (isConfigureMessage(data)) {
		void configure(data).catch((error) => {
			log(
				"error",
				error instanceof Error ? error.message : String(error),
			);
			throw error;
		});
		return;
	}

	if (typeof data !== "string" || shuttingDown) return;
	try {
		void handleRpc(JSON.parse(data) as JsonRpcMessage);
	} catch (error) {
		log(
			"warn",
			`Invalid JSON-RPC message: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
};
