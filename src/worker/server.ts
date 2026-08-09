import {
	doCodeActions,
	doComplete,
	doHover,
	doValidate,
	getDocumentColors,
	getDocumentLinks,
	resolveCompletionItem,
} from "@tailwindcss/language-service";
import plugin from "../../plugin.json";
import {
	TextDocument,
	type TextDocumentContentChangeEvent,
} from "vscode-languageserver-textdocument";
import type {
	CodeActionParams,
	ColorInformation,
	CompletionItem,
	CompletionList,
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
type ValidationJob = {
	timer?: ReturnType<typeof setTimeout>;
	generation: number;
	running: boolean;
	queued: boolean;
};
type CompletionTextEdit = {
	range?: { start: Position; end: Position };
	replace?: { start: Position; end: Position };
};

const VALIDATION_DELAY_MS = 250;
const RELOAD_DELAY_MS = 250;
const MAX_COMPLETION_ITEMS = 750;
const validationJobs = new Map<string, ValidationJob>();
const cancelledRequests = new Set<JsonRpcId>();
const activeRequests = new Set<JsonRpcId>();
const documentIds = new Map<string, number>();
const documentUris = new Map<number, string>();
const recentlyRebuiltFiles = new Map<string, number>();

let manager: TailwindProjectManager | null = null;
let managerReady: Promise<void> = Promise.resolve();
let shuttingDown = false;
let nextDocumentId = 0;
let reloadTimer: ReturnType<typeof setTimeout> | undefined;
let reloadRunning = false;
let reloadQueued = false;

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

function failStartup(error: unknown): void {
	const message = error instanceof Error ? error.message : String(error);
	log("error", message);
	// Signal the host immediately so ready rejects without waiting for
	// startupTimeout; uncaught rejections do not reliably fire Worker.onerror.
	globalThis.postMessage({ kind: "error", message });
	globalThis.close();
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
	documentId(item.uri);
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
	const job = validationJobs.get(uri);
	if (job?.timer) clearTimeout(job.timer);
	validationJobs.delete(uri);
	notify("textDocument/publishDiagnostics", { uri, diagnostics: [] });
}

function scheduleValidation(uri: string): void {
	let job = validationJobs.get(uri);
	if (!job) {
		job = { generation: 0, running: false, queued: false };
		validationJobs.set(uri, job);
	}
	job.generation += 1;
	if (job.timer) clearTimeout(job.timer);
	job.timer = setTimeout(() => {
		job!.timer = undefined;
		void runValidation(uri, job!);
	}, VALIDATION_DELAY_MS);
}

async function runValidation(uri: string, job: ValidationJob): Promise<void> {
	if (validationJobs.get(uri) !== job) return;
	if (job.running) {
		job.queued = true;
		return;
	}

	job.running = true;
	try {
		do {
			job.queued = false;
			await validateDocument(uri, job, job.generation);
		} while (job.queued && validationJobs.get(uri) === job);
	} finally {
		job.running = false;
	}
}

async function validateDocument(
	uri: string,
	job: ValidationJob,
	generation: number,
): Promise<void> {
	const document = documents.get(uri);
	if (!document || !manager || job.generation !== generation) return;
	const version = document.version;
	try {
		const state = await manager.stateForDocument(document);
		if (job.generation !== generation) return;
		const diagnostics = await doValidate(state, document);
		if (
			validationJobs.get(uri) === job &&
			job.generation === generation &&
			documents.get(uri)?.version === version
		) {
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

function documentId(uri: string): number {
	let id = documentIds.get(uri);
	if (id !== undefined) return id;
	id = ++nextDocumentId;
	documentIds.set(uri, id);
	documentUris.set(id, uri);
	return id;
}

function completionPrefix(
	document: TextDocument,
	position: Position,
	items: CompletionItem[],
): string {
	for (const item of items) {
		const edit = item.textEdit as CompletionTextEdit | undefined;
		const range = edit?.range ?? edit?.replace;
		if (range) {
			return document.getText({ start: range.start, end: position });
		}
	}

	const line = document.getText({
		start: { line: position.line, character: 0 },
		end: position,
	});
	return line.match(/[^\s"'`={}()[\],;<>]*$/)?.[0] ?? "";
}

function fuzzyMatch(label: string, query: string): boolean {
	let queryIndex = 0;
	for (
		let index = 0;
		index < label.length && queryIndex < query.length;
		index += 1
	) {
		if (label[index] === query[queryIndex]) queryIndex += 1;
	}
	return queryIndex === query.length;
}

function boundCompletionResult(
	result: CompletionList | null,
	document: TextDocument,
	position: Position,
): CompletionList | null {
	if (!result || result.items.length <= MAX_COMPLETION_ITEMS) return result;

	const query = completionPrefix(document, position, result.items).toLowerCase();
	const direct: CompletionItem[] = [];
	const fuzzy: CompletionItem[] = [];
	for (const item of result.items) {
		const label = String(item.label).toLowerCase();
		if (!query || label.startsWith(query)) direct.push(item);
		else if (fuzzyMatch(label, query)) fuzzy.push(item);
	}

	const ranked =
		direct.length || fuzzy.length ? [...direct, ...fuzzy] : result.items;
	return {
		...result,
		isIncomplete: true,
		items: ranked.slice(0, MAX_COMPLETION_ITEMS),
	};
}

function scheduleProjectReload(): void {
	if (reloadTimer) clearTimeout(reloadTimer);
	reloadTimer = setTimeout(() => {
		reloadTimer = undefined;
		void runProjectReload();
	}, RELOAD_DELAY_MS);
}

async function runProjectReload(): Promise<void> {
	if (!manager) return;
	if (reloadRunning) {
		reloadQueued = true;
		return;
	}

	reloadRunning = true;
	try {
		do {
			reloadQueued = false;
			await manager.reload();
		} while (reloadQueued);
		for (const uri of documents.keys()) scheduleValidation(uri);
	} catch (error) {
		log(
			"warn",
			`Tailwind project reload failed: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	} finally {
		reloadRunning = false;
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
					version: plugin.version,
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
			const result = boundCompletionResult(
				await doComplete(
					state,
					document,
					completion.position,
					completion.context,
				),
				document,
				completion.position,
			);
			const compactDocumentId = documentId(completion.textDocument.uri);
			for (const item of result?.items ?? []) {
				item.data = {
					...(item.data ?? {}),
					__a: compactDocumentId,
				};
			}
			return result;
		}

		case "completionItem/resolve": {
			if (!manager) return params;
			const uri =
				documentUris.get((params as CompletionItem).data?.__a) ??
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
				if (await manager.rebuildOpenEntrypoint(document)) {
					recentlyRebuiltFiles.set(document.uri, Date.now());
				}
				scheduleValidation(document.uri);
			}
			return;
		}
		case "workspace/didChangeConfiguration":
			manager?.updateSettings(params.settings ?? {});
			for (const uri of documents.keys()) scheduleValidation(uri);
			return;
		case "workspace/didChangeWatchedFiles": {
			if (!manager) return;
			const now = Date.now();
			const changes = (Array.isArray(params?.changes) ? params.changes : [])
				.map((change: { uri?: unknown; type?: unknown }) => ({
					uri: String(change.uri ?? ""),
					type: typeof change.type === "number" ? change.type : undefined,
				}))
				.filter(
					(change: { uri: string }) =>
						change.uri &&
						now - (recentlyRebuiltFiles.get(change.uri) ?? 0) > 1_000,
				);
			if (manager.shouldReloadForFiles(changes)) scheduleProjectReload();
			return;
		}
		case "workspace/didChangeWorkspaceFolders":
			scheduleProjectReload();
			return;
		case "$/cancelRequest":
			if (activeRequests.has(params.id)) cancelledRequests.add(params.id);
			return;
	}
}

async function handleRpc(message: JsonRpcMessage): Promise<void> {
	if (!message.method) return;

	if (Object.prototype.hasOwnProperty.call(message, "id")) {
		const id = message.id ?? null;
		activeRequests.add(id);
		try {
			const result = await handleRequest(message.method, message.params);
			if (!cancelledRequests.delete(id)) sendResponse(id, result);
		} catch (error) {
			if (!cancelledRequests.delete(id)) sendError(id, -32603, error);
		} finally {
			activeRequests.delete(id);
			cancelledRequests.delete(id);
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
		void configure(data).catch(failStartup);
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
