type Position = { line: number; character: number };
type Range = { start: Position; end: Position };
type TextDocumentLike = {
	getText(range?: Range): string;
};

type Abbreviation = {
	abbreviation: string;
	abbreviationRange: Range;
};

// Tailwind only uses Emmet to turn a simple `div.class-name` abbreviation
// into a class completion query. Implement that small path instead of bundling
// the complete HTML/CSS Emmet engine into the mobile worker.
export function extractAbbreviation(
	document: TextDocumentLike,
	position: Position,
): Abbreviation | null {
	const lineStart = { line: position.line, character: 0 };
	const beforeCursor = document.getText({ start: lineStart, end: position });
	const abbreviation = beforeCursor.match(
		/(?:[A-Za-z][\w-]*)?(?:[.#][\w-]+)+$/,
	)?.[0];
	if (!abbreviation) return null;

	return {
		abbreviation,
		abbreviationRange: {
			start: {
				line: position.line,
				character: position.character - abbreviation.length,
			},
			end: position,
		},
	};
}

export function isAbbreviationValid(
	_syntax: string,
	abbreviation: string,
): boolean {
	return abbreviation.includes(".");
}

export function doComplete(
	document: TextDocumentLike,
	position: Position,
): { isIncomplete: false; items: Array<{ label: string }> } | null {
	const abbreviation = extractAbbreviation(document, position);
	if (!abbreviation) return null;
	return {
		isIncomplete: false,
		items: [{ label: abbreviation.abbreviation }],
	};
}
