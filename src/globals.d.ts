declare module "*.css" {
	const content: string;
	export default content;
}

declare module "process" {
	const process: {
		env: Record<string, string | undefined>;
		browser: boolean;
		nextTick(callback: (...args: unknown[]) => void, ...args: unknown[]): void;
	};
	export default process;
}
