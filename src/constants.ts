export const PLUGIN_ID = "acode.tailwind.languageservice";
export const SERVER_ID = "tailwindcss-worker";
export const RUNTIME_ID = "tailwindcss-web-worker";
export const WORKER_FILE = "tailwind.worker.js";

export const SUPPORTED_LANGUAGES = [
	"html",
	"css",
	"scss",
	"less",
	"javascript",
	"javascriptreact",
	"jsx",
	"typescript",
	"typescriptreact",
	"tsx",
	"vue",
	"svelte",
	"astro",
	"php",
	"blade",
	"twig",
	"erb",
] as const;

export const DEFAULT_SETTINGS = {
	validate: true,
	suggestions: true,
	hovers: true,
	colorDecorators: true,
	showPixelEquivalents: true,
	rootFontSize: 16,
	classAttributes: ["class", "className", "ngClass", "class:list"],
	classFunctions: ["clsx", "cn", "cva", "tw", "twMerge"],
};
