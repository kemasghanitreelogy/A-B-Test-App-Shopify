"use client";

import { useEffect, useRef, useState } from "react";
import { fmtIdr, fmtInt, fmtPct, fmtProb, fmtSigned } from "@/lib/format";

type Kind = "int" | "pct" | "signed" | "prob" | "idr" | "fixed";

function format(value: number, kind: Kind, digits: number): string {
  switch (kind) {
    case "int":
      return fmtInt(value);
    case "pct":
      return fmtPct(value, digits);
    case "signed":
      return fmtSigned(value, digits);
    case "prob":
      return fmtProb(value);
    case "idr":
      return fmtIdr(value);
    case "fixed":
      return value.toFixed(digits);
  }
}

/**
 * Angka yang "berjalan" ke nilainya.
 *
 * Di server dirender langsung pada nilai akhirnya, jadi tanpa JavaScript pun
 * angkanya benar dan tidak ada lompatan layout. Setelah hidrasi, angka berjalan
 * dari nol (pemuatan pertama) atau dari nilai sebelumnya (saat data live
 * berubah) — sehingga perubahan kecil pada muat ulang 30 detik terlihat sebagai
 * gerakan, bukan penggantian diam-diam.
 *
 * Menghormati prefers-reduced-motion: nilainya langsung ditampilkan.
 */
export function CountUp({
  value,
  kind = "int",
  digits = 1,
  duration = 900,
  className,
}: {
  value: number;
  kind?: Kind;
  digits?: number;
  duration?: number;
  className?: string;
}) {
  const [shown, setShown] = useState(value);
  const previous = useRef<number | null>(null);

  useEffect(() => {
    const reduce = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const from = previous.current ?? 0;
    previous.current = value;
    if (reduce || !Number.isFinite(value) || from === value) {
      setShown(value);
      return;
    }

    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      // ease-out cubic: cepat di awal, mendarat pelan.
      const eased = 1 - Math.pow(1 - t, 3);
      setShown(from + (value - from) * eased);
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, duration]);

  return (
    <span className={className} aria-label={format(value, kind, digits)}>
      {format(shown, kind, digits)}
    </span>
  );
}
