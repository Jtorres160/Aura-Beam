// Minimal ESM resolve hook so `node --test` can run the TypeScript sources
// directly (Node 24 strips types natively) while honoring the project's
// "@/*" -> "./src/*" path alias from tsconfig.json. Test-only infrastructure;
// it changes nothing about how the app builds or runs.
import { pathToFileURL } from "node:url";
import { resolve as resolvePath } from "node:path";

const srcBase = pathToFileURL(resolvePath(process.cwd(), "src")).href + "/";

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@/")) {
    let url = srcBase + specifier.slice(2);
    if (!/\.[cm]?[jt]sx?$/.test(url)) url += ".ts";
    return nextResolve(url, context);
  }
  return nextResolve(specifier, context);
}
