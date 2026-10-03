"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { setLang } from "@/app/lang-actions";
import { useLang } from "@/components/lang-provider";
import { LANGS, type Lang } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/** Sakelar ID | EN di header. Pilihan disimpan di cookie, halaman dirender ulang di server. */
export function LangToggle() {
  const lang = useLang();
  const router = useRouter();
  const [pending, start] = useTransition();

  function choose(next: Lang) {
    if (next === lang) return;
    start(async () => {
      await setLang(next);
      router.refresh();
    });
  }

  return (
    <div
      role="group"
      aria-label={lang === "en" ? "Language" : "Bahasa"}
      className={cn("flex rounded-lg border bg-muted/40 p-0.5 transition-opacity", pending && "opacity-60")}
    >
      {LANGS.map((l) => (
        <button
          key={l}
          type="button"
          aria-pressed={lang === l}
          onClick={() => choose(l)}
          disabled={pending}
          className={cn(
            "h-7 cursor-pointer rounded-md px-2 text-[11px] font-semibold uppercase tracking-[0.08em] transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            lang === l ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {l}
        </button>
      ))}
    </div>
  );
}
