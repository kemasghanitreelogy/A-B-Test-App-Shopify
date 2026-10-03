"use client";

import { createContext, useContext, type ReactNode } from "react";
import { DEFAULT_LANG, tr, type Lang } from "@/lib/i18n";

const LangContext = createContext<Lang>(DEFAULT_LANG);

/** Bahasa dari cookie (dibaca server di root layout), diteruskan ke komponen klien. */
export function LangProvider({ lang, children }: { lang: Lang; children: ReactNode }) {
  return <LangContext.Provider value={lang}>{children}</LangContext.Provider>;
}

export function useLang(): Lang {
  return useContext(LangContext);
}

/** `const t = useT(); t("Indonesia", "English")` */
export function useT() {
  return tr(useContext(LangContext));
}
