"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { LANG_COOKIE, parseLang } from "@/lib/i18n";

/** Simpan pilihan bahasa selama setahun, lalu render ulang semua halaman. */
export async function setLang(value: string): Promise<void> {
  const store = await cookies();
  store.set(LANG_COOKIE, parseLang(value), {
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
  });
  revalidatePath("/", "layout");
}
