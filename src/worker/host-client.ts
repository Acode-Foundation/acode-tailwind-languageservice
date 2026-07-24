type HostResponse = {
	kind: "host-response";
	id: number;
	result?: unknown;
	error?: string;
};

type PendingRequest = {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
};

export type ProjectFiles = {
	css: string[];
	configs: string[];
	truncated: boolean;
};

export type DirectoryEntry = {
	name: string;
	url: string;
	isDirectory: boolean;
	isFile: boolean;
};

export class WorkerHostClient {
	#nextId = 0;
	#pending = new Map<number, PendingRequest>();

	request(method: string, params: Record<string, unknown>): Promise<any> {
		const id = ++this.#nextId;
		return new Promise((resolve, reject) => {
			this.#pending.set(id, { resolve, reject });
			globalThis.postMessage({
				kind: "host-request",
				id,
				method,
				params,
			});
		});
	}

	handle(message: HostResponse): boolean {
		if (message?.kind !== "host-response") return false;
		const pending = this.#pending.get(message.id);
		if (!pending) return true;
		this.#pending.delete(message.id);

		if (message.error) pending.reject(new Error(message.error));
		else pending.resolve(message.result);
		return true;
	}

	readFile(uri: string): Promise<string> {
		return this.request("readFile", { uri });
	}

	readDirectory(uri: string): Promise<DirectoryEntry[]> {
		return this.request("readDirectory", { uri });
	}

	findProjectFiles(rootUri: string): Promise<ProjectFiles> {
		return this.request("findProjectFiles", { rootUri });
	}

	resolveFile(
		base: string,
		id: string,
		extensions: string[],
	): Promise<string | null> {
		return this.request("resolveFile", { base, id, extensions });
	}

	dispose(): void {
		for (const pending of this.#pending.values()) {
			pending.reject(new Error("Tailwind worker host was disposed"));
		}
		this.#pending.clear();
	}
}

export function isHostResponse(value: unknown): value is HostResponse {
	return (
		Boolean(value) &&
		typeof value === "object" &&
		(value as { kind?: unknown }).kind === "host-response"
	);
}

