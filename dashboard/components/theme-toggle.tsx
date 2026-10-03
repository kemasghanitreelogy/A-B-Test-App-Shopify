"use client";

import { Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useT } from "@/components/lang-provider";

/**
 * Ikon mana yang tampil ditentukan CSS lewat class `dark` di elemen <html>,
 * bukan lewat state React.
 *
 * Tema sudah dipasang oleh skrip sinkron di <head> sebelum React sempat jalan,
 * jadi menyimpannya lagi sebagai state hanya menciptakan sumber kebenaran kedua
 * yang bisa berbeda dari kenyataan pada render pertama.
 */
export function ThemeToggle() {
  const t = useT();
  function toggle() {
    const next = !document.documentElement.classList.contains("dark");
    document.documentElement.classList.toggle("dark", next);
    try {
      localStorage.setItem("tl-theme", next ? "dark" : "light");
    } catch {
      // Mode privat memblokir localStorage. Tema tetap berganti untuk sesi ini.
    }
  }

  return (
    <Button variant="ghost" size="icon" onClick={toggle} aria-label={t("Ganti mode terang atau gelap", "Toggle light or dark mode")}>
      <Sun className="hidden size-4 dark:block" />
      <Moon className="size-4 dark:hidden" />
    </Button>
  );
}
