"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import { intlLocale } from "@/lib/i18n";
import { useLang, useT } from "@/components/lang-provider";

const DEFAULT_INTERVAL_MS = 30_000;

/* Zona waktu dikunci, tidak diserahkan ke perangkat pembaca.
 *
 * Jam ini pertama kali dirender di server lalu ditampilkan ulang di browser. Kalau
 * zona waktunya mengikuti masing-masing, keduanya menghasilkan teks berbeda dan
 * React membuang seluruh hasil render server untuk cabang ini. Toko berjualan
 * dalam rupiah dan jam operasionalnya WIB, jadi itu pula acuan yang benar. */
const clocks = new Map<string, Intl.DateTimeFormat>();
function clockFor(locale: string): Intl.DateTimeFormat {
  let c = clocks.get(locale);
  if (!c) {
    c = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Jakarta" });
    clocks.set(locale, c);
  }
  return c;
}

/**
 * Penanda bahwa angka di halaman ini bergerak, plus muat ulang berkala.
 *
 * Halaman hasil dirender di server, jadi tanpa ini angkanya membeku di tab yang
 * dibiarkan terbuka seharian — dan tidak ada apa pun di layar yang memberi tahu
 * bahwa yang dilihat sudah basi. Yang disegarkan hanya data route lewat
 * router.refresh(), sehingga state komponen dan posisi scroll tidak hilang.
 *
 * Berhenti saat tab tidak terlihat (tiap refresh memanggil database dan bridge
 * ke app Shopify), lalu langsung memuat ulang begitu tab dibuka lagi — supaya
 * yang pertama terlihat bukan angka dari berjam-jam lalu.
 */
export function LiveIndicator({
  renderedAt,
  intervalMs = DEFAULT_INTERVAL_MS,
  className,
}: {
  /** ISO string dari saat server merender halaman */
  renderedAt: string;
  intervalMs?: number;
  className?: string;
}) {
  const router = useRouter();
  const lang = useLang();
  const t = useT();
  const [updatedAt, setUpdatedAt] = useState(renderedAt);

  useEffect(() => {
    let id: ReturnType<typeof setInterval> | undefined;
    const tick = () => {
      router.refresh();
      setUpdatedAt(new Date().toISOString());
    };
    const start = () => {
      clearInterval(id);
      id = setInterval(tick, intervalMs);
    };
    const onVisibility = () => {
      if (document.hidden) {
        clearInterval(id);
      } else {
        tick();
        start();
      }
    };
    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [router, intervalMs]);

  return (
    <span
      className={cn(
        "inline-flex items-center gap-2 rounded-full border border-[var(--positive)]/25 bg-[var(--positive)]/8 px-2.5 py-1 text-[11px] font-medium text-[var(--positive)]",
        className,
      )}
      title={t(
        `Data dimuat ulang otomatis tiap ${Math.round(intervalMs / 1000)} detik`,
        `Data refreshes automatically every ${Math.round(intervalMs / 1000)} seconds`,
      )}
    >
      <span className="relative flex size-1.5" aria-hidden>
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-[var(--positive)] opacity-60" />
        <span className="relative inline-flex size-1.5 rounded-full bg-[var(--positive)]" />
      </span>
      Live
      <span className="font-mono text-muted-foreground">{clockFor(intlLocale(lang)).format(new Date(updatedAt))}</span>
    </span>
  );
}
