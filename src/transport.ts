import { AcodeHost } from "./host";
import { RUNTIME_ID, SERVER_ID, WORKER_FILE } from "./constants";

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function createHostHandlers(
	host: AcodeHost,
): Record<string, Acode.LspWorkerHostHandler> {
	const methods = [
		"readFile",
		"readDirectory",
		"stat",
		"exists",
		"resolveFile",
		"findProjectFiles",
	] as const;

	const handlers: Record<string, Acode.LspWorkerHostHandler> = {};
	for (const method of methods) {
		handlers[method] = (params) => host.call(method, params);
	}
	return handlers;
}

export function createTailwindRuntime(
	workerBaseUrl: string,
): Acode.LspRuntimeProvider {
	const host = new AcodeHost();
	const workerUrl = new URL(WORKER_FILE, workerBaseUrl).href;
	const hostHandlers = createHostHandlers(host);

	return {
		id: RUNTIME_ID,
		label: "Tailwind CSS Web Worker",
		priority: 200,

		canHandle(server) {
			return server.id === SERVER_ID && typeof Worker !== "undefined";
		},

		resolveUris(_server, context) {
			return {
				documentUri: context.originalDocumentUri,
				rootUri: context.originalRootUri,
				scope: "workspace",
			};
		},

		async checkInstallation() {
			return {
				status: "present",
				version: "bundled",
				canInstall: false,
				canUpdate: false,
				message: "Bundled with the plugin and runs in a Web Worker.",
			};
		},

		getInstallCommand() {
			return null;
		},

		getUninstallCommand() {
			return null;
		},

		async start(server, context) {
			const lsp = acode.require("lsp");
			if (!lsp?.workers?.createTransport) {
				throw new Error(
					"This Acode build does not expose acode.lsp.workers.createTransport",
				);
			}

			const transport = lsp.workers.createTransport({
				url: workerUrl,
				name: "acode-tailwindcss-language-service",
				serverId: server.id,
				startupTimeout: server.startupTimeout ?? 20_000,
				configure: {
					kind: "configure",
					serverId: server.id,
					rootUri: context.originalRootUri ?? context.rootUri ?? null,
					initializationOptions: server.initializationOptions ?? {},
				},
				hostHandlers,
			});

			return {
				kind: "transport",
				providerId: RUNTIME_ID,
				transport,
			};
		},
	};
}

export function reportStartupFailure(error: unknown): void {
	console.error(
		`[Tailwind CSS] Failed to register language service: ${messageOf(error)}`,
		error,
	);
}
