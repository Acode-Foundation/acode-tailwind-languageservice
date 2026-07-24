function unavailable(): never {
	throw new Error("Node filesystem access is unavailable in the Tailwind worker");
}

export const readFileSync = unavailable;
export const existsSync = () => false;
export const statSync = unavailable;
export const promises = {
	readFile: unavailable,
	stat: unavailable,
};

export default {
	readFileSync,
	existsSync,
	statSync,
	promises,
};

