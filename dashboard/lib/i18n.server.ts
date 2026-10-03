import { cookies } from "next/headers";
import { LANG_COOKIE, parseLang, type Lang } from "./i18n";

/**
 * Bahasa pembaca untuk render di server. Dibaca dari cookie supaya HTML pertama
 * sudah dalam bahasa yang benar — tanpa kedipan teks Indonesia sebelum hidrasi.
 */
export async function getLang(): Promise<Lang> {
  const store = await cookies();
  return parseLang(store.get(LANG_COOKIE)?.value);
}
