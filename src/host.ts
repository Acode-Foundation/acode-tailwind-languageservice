type FileEntry = {
	name: string;
	url: string;
	isDirectory?: boolean;
	isFile?: boolean;
};

const EXCLUDED_DIRECTORIES = new Set([
	".git",
	".hg",
	".svn",
	".idea",
	".vscode",
	"node_modules",
	"vendor",
	"dist",
	"build",
	"coverage",
	".next",
	".nuxt",
	".svelte-kit",
	".astro",
	".turbo",
]);

const CSS_PATTERN = /\.(?:css|scss|sass|less|pcss|postcss)$/i;
const MAX_DIRECTORIES = 600;
const MAX_FILES = 2500;
const MAX_DEPTH = 14;
const DIRECTORY_READ_CONCURRENCY = 4;

export class AcodeHost {
	readonly #fs: Acode.FS;
	readonly #url: Acode.Url;

	constructor() {
		this.#fs = acode.require("fs");
		this.#url = acode.require("Url");
	}

	/** Invoke a host method by name (used by worker hostHandlers). */
	async call(
		method: string,
		params: Record<string, unknown> = {},
	): Promise<unknown> {
		return this.#dispatch(method, params);
	}

	async #dispatch(
		method: string,
		params: Record<string, unknown>,
	): Promise<unknown> {
		switch (method) {
			case "readFile":
				return this.#readFile(String(params.uri ?? ""));
			case "readDirectory":
				return this.#readDirectory(String(params.uri ?? ""));
			case "resolveFile":
				return this.#resolveFile(
					String(params.base ?? ""),
					String(params.id ?? ""),
					Array.isArray(params.extensions)
						? params.extensions.map(String)
						: [],
				);
			case "findProjectFiles":
				return this.#findProjectFiles(String(params.rootUri ?? ""));
			default:
				throw new Error(`Unsupported worker host method: ${method}`);
		}
	}

	async #readFile(uri: string): Promise<string> {
		const fs = this.#requireFs(uri);
		return String(await fs.readFile("utf-8"));
	}

	async #readDirectory(uri: string): Promise<FileEntry[]> {
		const fs = this.#requireFs(uri);
		const entries = await fs.lsDir();
		return (entries ?? []).map((entry: FileEntry) => ({
			name: entry.name,
			url: entry.url,
			isDirectory: Boolean(entry.isDirectory),
			isFile: Boolean(entry.isFile),
		}));
	}

	async #exists(uri: string): Promise<boolean> {
		const fs = this.#fs(uri);
		return Boolean(fs && (await fs.exists()));
	}

	async #resolveFile(
		base: string,
		id: string,
		extensions: string[],
	): Promise<string | null> {
		if (!id) return null;
		const absolute = /^[a-z][\w+.-]*:/i.test(id) || id.startsWith("/");
		const initial = absolute ? id : this.#url.join(base, id);
		const candidates = [initial];

		if (!this.#url.extname(initial)) {
			for (const extension of extensions) {
				candidates.push(`${initial}${extension}`);
			}
			for (const extension of extensions) {
				candidates.push(this.#url.join(initial, `index${extension}`));
			}
		}

		for (const candidate of candidates) {
			if (await this.#exists(candidate)) return candidate;
		}
		return null;
	}

	async #findProjectFiles(rootUri: string): Promise<{
		css: string[];
		truncated: boolean;
	}> {
		if (!rootUri) return { css: [], truncated: false };

		const css: string[] = [];
		const queue = [{ uri: rootUri, depth: 0 }];
		let directories = 0;
		let files = 0;
		let truncated = false;

		scan: while (queue.length) {
			if (directories >= MAX_DIRECTORIES || files >= MAX_FILES) {
				truncated = true;
				break;
			}

			const batch = queue.splice(
				0,
				Math.min(
					DIRECTORY_READ_CONCURRENCY,
					MAX_DIRECTORIES - directories,
				),
			);
			directories += batch.length;
			const results = await Promise.all(
				batch.map(async (current) => {
					try {
						return {
							current,
							entries: await this.#readDirectory(current.uri),
						};
					} catch {
						return { current, entries: [] as FileEntry[] };
					}
				}),
			);

			for (const { current, entries } of results) {
				for (const entry of entries) {
					if (entry.isDirectory) {
						if (
							current.depth < MAX_DEPTH &&
							!EXCLUDED_DIRECTORIES.has(entry.name)
						) {
							queue.push({ uri: entry.url, depth: current.depth + 1 });
						}
						continue;
					}

					files += 1;
					if (CSS_PATTERN.test(entry.name)) css.push(entry.url);
					if (files >= MAX_FILES) {
						truncated = true;
						break scan;
					}
				}
			}
		}

		return {
			css: rankCssFiles(css),
			truncated,
		};
	}

	#requireFs(uri: string): Acode.FileSystem {
		if (!uri) throw new Error("A filesystem URI is required");
		const fs = this.#fs(uri);
		if (!fs) throw new Error(`No Acode filesystem provider can handle ${uri}`);
		return fs;
	}
}

function rankCssFiles(files: string[]): string[] {
	const preferred =
		/(?:^|\/)(?:app|global|globals|index|input|main|style|styles|tailwind)\.(?:css|pcss|postcss)$/i;
	return files.sort((a, b) => {
		const aPreferred = preferred.test(a) ? 0 : 1;
		const bPreferred = preferred.test(b) ? 0 : 1;
		return aPreferred - bPreferred || a.length - b.length || a.localeCompare(b);
	});
}
