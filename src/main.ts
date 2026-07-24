import plugin from "../plugin.json";
import {
	DEFAULT_SETTINGS,
	RUNTIME_ID,
	SERVER_ID,
	SUPPORTED_LANGUAGES,
} from "./constants";
import { createTailwindRuntime, reportStartupFailure } from "./transport";

class TailwindLanguageServicePlugin {
	#lsp: Acode.LspApi | null = null;
	#registered = false;
	baseUrl = "";

	async init(): Promise<void> {
		if (this.#registered) return;

		const lsp = acode.require("lsp");
		if (!lsp?.register || !lsp?.runtimes?.register) {
			throw new Error(
				"This Acode build does not expose the plugin LSP runtime API",
			);
		}

		lsp.runtimes.register(createTailwindRuntime(this.baseUrl));
		try {
			const serverOptions: Acode.LspManagedServerOptions = {
				id: SERVER_ID,
				label: "Tailwind CSS (Web Worker)",
				languages: [...SUPPORTED_LANGUAGES],
				runtimes: [RUNTIME_ID],
				transport: { kind: "external" },
				useWorkspaceFolders: true,
				enabled: true,
				startupTimeout: 20_000,
				initializationOptions: {
					tailwindCSS: DEFAULT_SETTINGS,
				},
				clientConfig: {
					builtinExtensions: {
						keymaps: false,
						formatting: false,
						signature: false,
						inlayHints: false,
					},
				},
			};
			lsp.register(lsp.defineServer(serverOptions), { replace: true });
		} catch (error) {
			lsp.runtimes.unregister(RUNTIME_ID);
			throw error;
		}

		this.#lsp = lsp;
		this.#registered = true;
		console.info("[Tailwind CSS] Worker language service registered");
	}

	destroy(): void {
		if (!this.#registered || !this.#lsp) return;
		this.#lsp.servers.unregister(SERVER_ID);
		this.#lsp.runtimes.unregister(RUNTIME_ID);
		this.#lsp = null;
		this.#registered = false;
		console.info("[Tailwind CSS] Worker language service unregistered");
	}
}

if (window.acode) {
	const tailwindPlugin = new TailwindLanguageServicePlugin();

	acode.setPluginInit(plugin.id, async (baseUrl) => {
		tailwindPlugin.baseUrl = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
		try {
			await tailwindPlugin.init();
		} catch (error) {
			reportStartupFailure(error);
			throw error;
		}
	});

	acode.setPluginUnmount(plugin.id, () => {
		tailwindPlugin.destroy();
	});
}
