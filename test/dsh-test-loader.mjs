// Test-only ESM loader: profile plugins declare @deepseek-ai/* as peer
// dependencies, which the DSH host resolves against its own module tree
// at runtime. Plain node cannot, so redirect failed @deepseek-ai/*
// resolutions to the globally installed dsh tree (same version).
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const hostRequire = createRequire("/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/package.json");

export async function resolve(specifier, context, next) {
	try {
		return await next(specifier, context);
	} catch (error) {
		if (specifier.startsWith("@deepseek-ai/")) {
			const resolved = hostRequire.resolve(specifier);
			return { url: pathToFileURL(resolved).href, shortCircuit: true };
		}
		throw error;
	}
}
