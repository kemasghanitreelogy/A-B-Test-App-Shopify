/**
 * Loader kecil untuk skrip verifikasi: membuat Node bisa menjalankan sumber
 * TypeScript yang saling meng-import tanpa ekstensi (gaya bundler), dengan
 * menambahkan ".ts" pada import relatif yang file-nya memang ada.
 *
 *   node --import ./scripts/ts-resolve.mjs scripts/verify-posthog.mjs
 */
import { register } from "node:module";

register("./ts-resolve-hooks.mjs", import.meta.url);
