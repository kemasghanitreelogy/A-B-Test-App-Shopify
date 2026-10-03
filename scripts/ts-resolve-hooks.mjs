import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export async function resolve(specifier, context, next) {
  // "./x.server" has no real extension either — decide by what exists on disk
  if ((specifier.startsWith("./") || specifier.startsWith("../")) && context.parentURL && !/\.(?:[cm]?[jt]sx?|json)$/i.test(specifier)) {
    const candidate = new URL(`${specifier}.ts`, context.parentURL);
    if (existsSync(fileURLToPath(candidate))) return next(candidate.href, context);
  }
  return next(specifier, context);
}
