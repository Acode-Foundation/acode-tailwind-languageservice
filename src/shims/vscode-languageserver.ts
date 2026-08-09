// The Tailwind language-service bundle only uses these protocol constants and
// a tiny LRU cache. Pulling the full language-server implementation into a Web
// Worker adds substantial startup and parse cost for APIs this plugin never uses.
export const CompletionItemKind = {
	Text: 1,
	Method: 2,
	Function: 3,
	Constructor: 4,
	Field: 5,
	Variable: 6,
	Class: 7,
	Interface: 8,
	Module: 9,
	Property: 10,
	Unit: 11,
	Value: 12,
	Enum: 13,
	Keyword: 14,
	Snippet: 15,
	Color: 16,
	File: 17,
	Reference: 18,
	Folder: 19,
	EnumMember: 20,
	Constant: 21,
	Struct: 22,
	Event: 23,
	Operator: 24,
	TypeParameter: 25,
} as const;

export const InsertTextFormat = {
	PlainText: 1,
	Snippet: 2,
} as const;

export const DiagnosticTag = {
	Unnecessary: 1,
	Deprecated: 2,
} as const;

export class LRUCache<K, V> {
	readonly #limit: number;
	readonly #values = new Map<K, V>();

	constructor(limit: number) {
		this.#limit = Math.max(1, limit);
	}

	get(key: K): V | undefined {
		const value = this.#values.get(key);
		if (value === undefined) return undefined;
		this.#values.delete(key);
		this.#values.set(key, value);
		return value;
	}

	set(key: K, value: V): void {
		this.#values.delete(key);
		this.#values.set(key, value);
		while (this.#values.size > this.#limit) {
			const oldest = this.#values.keys().next().value;
			if (oldest === undefined) break;
			this.#values.delete(oldest);
		}
	}
}
