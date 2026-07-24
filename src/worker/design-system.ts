import {
	createState,
	getDefaultTailwindSettings,
	type Settings,
	type State,
} from "@tailwindcss/language-service";
import {
	__unstable__loadDesignSystem,
	type Config,
} from "tailwindcss";
import colors from "tailwindcss/colors";
import defaultTheme from "tailwindcss/defaultTheme";
import tailwindPlugin from "tailwindcss/plugin";
import tailwindPackage from "tailwindcss/package.json";
import tailwindIndexCss from "tailwindcss/index.css";
import tailwindPreflightCss from "tailwindcss/preflight.css";
import tailwindThemeCss from "tailwindcss/theme.css";
import tailwindUtilitiesCss from "tailwindcss/utilities.css";
import type { TextDocument } from "vscode-languageserver-textdocument";
import { DEFAULT_SETTINGS } from "../constants";
import type { DirectoryEntry, ProjectFiles } from "./host-client";
import { WorkerHostClient } from "./host-client";

type CoreDesignSystem = Awaited<
	ReturnType<typeof __unstable__loadDesignSystem>
>;

export type ProjectState = {
	state: State;
	entryUri: string | null;
	projectBase: string;
	degraded: boolean;
	sourceCss: string;
};

const MAX_PROJECTS = 12;
const MAX_CSS_CANDIDATES = 100;
const ENTRY_PATTERN =
	/@import\s+["']tailwindcss(?:\/[^"']*)?["']|@tailwind\s+(?:base|components|utilities)|@theme\b|@config\b|@plugin\b/;
const STYLE_PATTERN = /<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi;
const JS_EXTENSIONS = [".js", ".cjs", ".mjs", ".ts", ".cts", ".mts"];
const CSS_EXTENSIONS = [".css", ".pcss", ".postcss", ".scss", ".sass", ".less"];
const V4_FEATURES: State["features"] = [
	"css-at-theme",
	"css-at-config-as-project",
	"source-not",
	"source-inline",
	"relative-content-paths",
];

const BUILTIN_STYLESHEETS = new Map<string, string>([
	["tailwindcss", tailwindIndexCss],
	["tailwindcss/index", tailwindIndexCss],
	["tailwindcss/index.css", tailwindIndexCss],
	["tailwindcss/theme", tailwindThemeCss],
	["tailwindcss/theme.css", tailwindThemeCss],
	["tailwindcss/preflight", tailwindPreflightCss],
	["tailwindcss/preflight.css", tailwindPreflightCss],
	["tailwindcss/utilities", tailwindUtilitiesCss],
	["tailwindcss/utilities.css", tailwindUtilitiesCss],
	["./theme.css", tailwindThemeCss],
	["theme.css", tailwindThemeCss],
	["./preflight.css", tailwindPreflightCss],
	["preflight.css", tailwindPreflightCss],
	["./utilities.css", tailwindUtilitiesCss],
	["utilities.css", tailwindUtilitiesCss],
]);

const USER_LANGUAGE_MAP: Record<string, string> = {
	jsx: "javascriptreact",
	tsx: "typescriptreact",
	mdx: "javascriptreact",
	blade: "html",
	twig: "html",
	erb: "html",
};

function log(
	level: "error" | "warn" | "info",
	message: string,
): void {
	globalThis.postMessage({ kind: "log", level, message });
}

function dirname(uri: string): string {
	const clean = uri.replace(/[?#].*$/, "");
	const index = clean.lastIndexOf("/");
	return index >= 0 ? clean.slice(0, index + 1) : clean;
}

function sanitizeProjectCss(css: string): string {
	return css
		.replace(/@plugin\s+[^;]+;/g, "")
		.replace(/@config\s+[^;]+;/g, "");
}

function mergeSettings(overrides: Record<string, unknown> = {}): Settings {
	const defaults = getDefaultTailwindSettings();
	const tailwindOverrides =
		(overrides.tailwindCSS as Record<string, unknown> | undefined) ?? overrides;

	return {
		editor: {
			...defaults.editor,
		},
		tailwindCSS: {
			...defaults.tailwindCSS,
			...DEFAULT_SETTINGS,
			...tailwindOverrides,
			lint: {
				...defaults.tailwindCSS.lint,
				...((tailwindOverrides.lint as Record<string, never> | undefined) ??
					{}),
			},
			files: {
				...defaults.tailwindCSS.files,
				...((tailwindOverrides.files as Record<string, never> | undefined) ??
					{}),
			},
			experimental: {
				...defaults.tailwindCSS.experimental,
				...((tailwindOverrides.experimental as
					| Record<string, never>
					| undefined) ?? {}),
			},
		},
	};
}

export class TailwindProjectManager {
	readonly #host: WorkerHostClient;
	#rootUri: string | null;
	#settings: Settings;
	#fallback: ProjectState | null = null;
	#projects: ProjectState[] = [];
	#documentProjects = new Map<
		string,
		{ version: number; project: ProjectState }
	>();
	#initialization: Promise<void> | null = null;

	constructor(
		host: WorkerHostClient,
		rootUri: string | null,
		initializationOptions: Record<string, unknown> = {},
	) {
		this.#host = host;
		this.#rootUri = rootUri;
		this.#settings = mergeSettings(initializationOptions);
	}

	initialize(): Promise<void> {
		if (!this.#initialization) this.#initialization = this.#initialize();
		return this.#initialization;
	}

	updateSettings(settings: Record<string, unknown>): void {
		this.#settings = mergeSettings(settings);
	}

	async reload(): Promise<void> {
		this.#documentProjects.clear();
		this.#initialization = this.#initialize();
		await this.#initialization;
	}

	async stateFor(uri: string): Promise<State> {
		await this.initialize();
		return this.#projectFor(uri).state;
	}

	async stateForDocument(document: TextDocument): Promise<State> {
		await this.initialize();
		const embeddedCss = extractEmbeddedTailwindCss(document);
		if (!embeddedCss) return this.#projectFor(document.uri).state;

		const cached = this.#documentProjects.get(document.uri);
		if (cached?.version === document.version) return cached.project.state;

		const baseProject = this.#projectFor(document.uri);
		const project = await this.#createProjectState(
			`${baseProject.sourceCss}\n${embeddedCss}`,
			document.uri,
			baseProject.projectBase,
		);
		this.#documentProjects.set(document.uri, {
			version: document.version,
			project,
		});
		return project.state;
	}

	closeDocument(uri: string): void {
		this.#documentProjects.delete(uri);
	}

	#projectFor(uri: string): ProjectState {
		if (!this.#fallback) throw new Error("Tailwind fallback state is unavailable");
		if (!this.#projects.length) return this.#fallback;

		let best = this.#projects[0];
		let bestScore = -1;
		for (const project of this.#projects) {
			const score = commonPathScore(uri, project.projectBase);
			if (score > bestScore) {
				best = project;
				bestScore = score;
			}
		}
		return best ?? this.#fallback;
	}

	async rebuildOpenEntrypoint(document: TextDocument): Promise<boolean> {
		const project = this.#projects.find(
			(candidate) => candidate.entryUri === document.uri,
		);
		if (!project) return false;

		try {
			const replacement = await this.#createProjectState(
				document.getText(),
				document.uri,
			);
			const index = this.#projects.indexOf(project);
			this.#projects[index] = replacement;
			log("info", `Reloaded Tailwind project from ${document.uri}`);
			return true;
		} catch (error) {
			log(
				"warn",
				`Could not reload ${document.uri}: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
			return false;
		}
	}

	async readDirectory(
		document: TextDocument,
		directory: string,
	): Promise<Array<[string, { isDirectory: boolean }]>> {
		const base = /^[a-z][\w+.-]*:/i.test(directory)
			? directory
			: `${dirname(document.uri)}${directory}`;
		const entries = await this.#host.readDirectory(base);
		return entries.map((entry: DirectoryEntry) => [
			entry.name,
			{ isDirectory: entry.isDirectory },
		]);
	}

	async resolveDocumentLink(linkPath: string, documentUri: string): Promise<string> {
		const resolved = await this.#host.resolveFile(
			dirname(documentUri),
			linkPath,
			[...CSS_EXTENSIONS, ...JS_EXTENSIONS],
		);
		return resolved ?? linkPath;
	}

	async #initialize(): Promise<void> {
		this.#fallback = await this.#createProjectState(
			tailwindIndexCss,
			null,
			"tailwindcss://default/",
		);
		this.#projects = [];

		if (!this.#rootUri) {
			log("info", "No workspace root; using bundled Tailwind CSS defaults");
			return;
		}

		let files: ProjectFiles;
		try {
			files = await this.#host.findProjectFiles(this.#rootUri);
		} catch (error) {
			log(
				"warn",
				`Project discovery failed; using defaults: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
			return;
		}

		if (files.truncated) {
			log(
				"warn",
				"Workspace scan reached its safety limit; some Tailwind entrypoints may be omitted",
			);
		}

		const entrypoints: Array<{ uri: string; css: string }> = [];
		for (const uri of files.css.slice(0, MAX_CSS_CANDIDATES)) {
			try {
				const css = await this.#host.readFile(uri);
				if (ENTRY_PATTERN.test(css)) entrypoints.push({ uri, css });
				if (entrypoints.length >= MAX_PROJECTS) break;
			} catch {
				// A single unreadable file should not disable the workspace service.
			}
		}

		for (const entrypoint of entrypoints) {
			try {
				this.#projects.push(
					await this.#createProjectState(entrypoint.css, entrypoint.uri),
				);
			} catch (error) {
				log(
					"warn",
					`Skipped Tailwind entrypoint ${entrypoint.uri}: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
			}
		}

		if (this.#projects.length) {
			log(
				"info",
				`Loaded ${this.#projects.length} Tailwind CSS project${
					this.#projects.length === 1 ? "" : "s"
				}`,
			);
		} else {
			log("info", "No Tailwind CSS entrypoint found; using bundled defaults");
		}
	}

	async #createProjectState(
		css: string,
		entryUri: string | null,
		explicitBase?: string,
	): Promise<ProjectState> {
		const projectBase = explicitBase ?? (entryUri ? dirname(entryUri) : "/");
		const dependencies = new Set<string>();
		if (entryUri) dependencies.add(entryUri);
		let degraded = false;
		let designSystem: CoreDesignSystem;

		const options = {
			base: projectBase,
			from: entryUri ?? undefined,
			loadStylesheet: async (id: string, base: string) => {
				const builtin = BUILTIN_STYLESHEETS.get(id);
				if (builtin !== undefined) {
					return {
						path: `tailwindcss://${id.replace(/^\.\//, "")}`,
						base: "tailwindcss://default/",
						content: builtin,
					};
				}

				const resolved = await this.#host.resolveFile(base, id, CSS_EXTENSIONS);
				if (!resolved) {
					throw new Error(`Cannot resolve stylesheet '${id}' from ${base}`);
				}
				dependencies.add(resolved);
				return {
					path: resolved,
					base: dirname(resolved),
					content: await this.#host.readFile(resolved),
				};
			},
			loadModule: async (
				id: string,
				base: string,
				resourceHint: "plugin" | "config",
			) => {
				const resolved = await this.#host.resolveFile(base, id, JS_EXTENSIONS);
				if (!resolved) {
					throw new Error(`Cannot resolve ${resourceHint} module '${id}'`);
				}
				dependencies.add(resolved);
				const source = await this.#host.readFile(resolved);
				return {
					path: resolved,
					base: dirname(resolved),
					module: evaluateTailwindModule(source, resolved) as Config,
				};
			},
		};

		try {
			designSystem = await __unstable__loadDesignSystem(css, options);
		} catch (firstError) {
			const sanitized = sanitizeProjectCss(css);
			if (sanitized === css) throw firstError;
			degraded = true;
			log(
				"warn",
				`${entryUri ?? "Tailwind project"} contains a module that cannot run in a Web Worker; loading CSS theme without @plugin/@config`,
			);
			designSystem = await __unstable__loadDesignSystem(sanitized, options);
		}

		const serviceDesignSystem = adaptDesignSystem(designSystem, dependencies);
		const classList = designSystem
			.getClassList()
			.map(([className, metadata]) => [
				className,
				{ ...metadata, color: null },
			]) as State["classList"];

		const state = createState({
			enabled: true,
			v4: true,
			version: tailwindPackage.version,
			configPath: entryUri ?? "tailwindcss://default/index.css",
			configId: entryUri ?? "default",
			isCssConfig: true,
			separator: ":",
			config: {},
			plugins: [],
			screens: [],
			blocklist: [],
			features: V4_FEATURES,
			designSystem: serviceDesignSystem,
			classList,
			classListContainsMetadata: true,
			variants: designSystem.getVariants() as unknown as State["variants"],
			dependencies: [...dependencies],
			editor: {
				folder: projectBase,
				userLanguages: USER_LANGUAGE_MAP,
				getConfiguration: async () => this.#settings,
				getDocumentSymbols: async () => [],
				readDirectory: (document, directory) =>
					this.readDirectory(document, directory),
			},
		});

		return {
			state,
			entryUri,
			projectBase,
			degraded,
			sourceCss: css,
		};
	}
}

function extractEmbeddedTailwindCss(document: TextDocument): string | null {
	const language = document.languageId.toLowerCase();
	if (!["html", "vue", "svelte", "astro", "php", "blade", "twig", "erb"].includes(language)) {
		return null;
	}

	const styles: string[] = [];
	const text = document.getText();
	for (const match of text.matchAll(STYLE_PATTERN)) {
		if (ENTRY_PATTERN.test(match[1])) styles.push(match[1]);
	}
	return styles.length ? styles.join("\n") : null;
}

function adaptDesignSystem(
	designSystem: CoreDesignSystem,
	dependencies: Set<string>,
): State["designSystem"] {
	const extended = designSystem as CoreDesignSystem & {
		dependencies(): Set<string>;
		compile(classes: string[]): ReturnType<CoreDesignSystem["candidatesToAst"]>;
	};

	extended.dependencies = () => new Set(dependencies);
	extended.compile = (classes: string[]) =>
		designSystem.candidatesToAst(classes);

	return extended as unknown as State["designSystem"];
}

function evaluateTailwindModule(source: string, uri: string): unknown {
	const requireMap: Record<string, unknown> = {
		"tailwindcss/colors": colors,
		"tailwindcss/colors.js": colors,
		"tailwindcss/defaultTheme": defaultTheme,
		"tailwindcss/defaultTheme.js": defaultTheme,
		"tailwindcss/plugin": tailwindPlugin,
		"tailwindcss/plugin.js": tailwindPlugin,
	};

	const transformed = source
		.replace(
			/import\s+(\w+)\s+from\s+["']([^"']+)["'];?/g,
			"const $1 = require('$2');",
		)
		.replace(/\bexport\s+default\b/, "module.exports =")
		.replace(/\s+satisfies\s+[A-Za-z_$][\w$<>,.[\\] |]*/g, "");

	const module = { exports: {} as unknown };
	const localRequire = (id: string) => {
		if (id in requireMap) return requireMap[id];
		throw new Error(`Module '${id}' used by ${uri} is not bundled`);
	};

	const run = new Function(
		"module",
		"exports",
		"require",
		`"use strict";\n${transformed}\n//# sourceURL=${uri}`,
	);
	run(module, module.exports, localRequire);
	return (module.exports as { default?: unknown })?.default ?? module.exports;
}

function commonPathScore(uri: string, base: string): number {
	const left = uri.split(/[/:]+/);
	const right = base.split(/[/:]+/);
	let score = 0;
	const length = Math.min(left.length, right.length);
	for (let index = 0; index < length; index += 1) {
		if (left[index] !== right[index]) break;
		score += left[index].length + 1;
	}
	return score;
}
