import { cn } from "@/lib/utils";
import { tr, type Lang } from "@/lib/i18n";

export type CiTone = "positive" | "negative" | "neutral";

/** Warna ditentukan oleh posisi interval terhadap nol, bukan oleh titik estimasinya. */
export function ciTone(low: number, high: number): CiTone {
  if (low > 0 && high > 0) return "positive";
  if (low < 0 && high < 0) return "negative";
  return "neutral";
}

const TONE_COLOR: Record<CiTone, string> = {
  positive: "var(--positive)",
  negative: "var(--destructive)",
  neutral: "var(--muted-foreground)",
};

/**
 * Interval kepercayaan pada satu sumbu horizontal dengan nol di tengah.
 *
 * Ini satu-satunya gambar yang menjawab "sudah boleh disimpulkan atau belum"
 * tanpa perlu membaca angka: selama batangnya masih menyentuh garis nol, arah
 * uplift belum ditentukan. Titik estimasi digambar terpisah dari batangnya supaya
 * terlihat bahwa yang diukur adalah rentang, bukan satu angka tunggal.
 *
 * Semua baris memakai `domain` yang sama supaya panjang batang antar metric bisa
 * dibandingkan langsung. Interval yang melampaui domain dipotong dan ujungnya
 * digambar rata (tanpa tutup bulat) sebagai tanda bahwa ia berlanjut.
 */
export function CiPlot({
  low,
  high,
  point,
  domain,
  label,
  className,
  lang = "id",
}: {
  low: number;
  high: number;
  point: number;
  /** setengah lebar sumbu dalam satuan uplift relatif, mis. 0.5 = -50%..+50% */
  domain: number;
  label?: string;
  className?: string;
  /** bahasa aria-label bawaan; default Indonesia untuk pemanggil lama */
  lang?: Lang;
}) {
  const t = tr(lang);
  const span = domain > 0 ? domain : 1;
  const pos = (v: number) => Math.min(100, Math.max(0, 50 + (v / span) * 50));

  const left = pos(low);
  const right = pos(high);
  const tone = ciTone(low, high);
  const color = TONE_COLOR[tone];
  const clippedLeft = low < -span;
  const clippedRight = high > span;

  return (
    <div
      className={cn("relative h-7 w-full", className)}
      role="img"
      aria-label={
        label ??
        t(
          `Interval kepercayaan 95% dari ${(low * 100).toFixed(1)} persen sampai ${(high * 100).toFixed(1)} persen`,
          `95% confidence interval from ${(low * 100).toFixed(1)} percent to ${(high * 100).toFixed(1)} percent`,
        )
      }
      title={`95% CI ${low >= 0 ? "+" : ""}${(low * 100).toFixed(1)}% … ${high >= 0 ? "+" : ""}${(high * 100).toFixed(1)}%`}
    >
      {/* Sumbu: hairline solid, satu tingkat di atas latar. */}
      <div className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-border" />

      {/* Garis nol — satu-satunya acuan yang menentukan menang atau tidak. */}
      <div className="absolute inset-y-1 left-1/2 w-px -translate-x-1/2 bg-foreground/25" />

      <div
        className="absolute top-1/2 h-1.5 -translate-y-1/2 transition-[left,width] duration-500"
        style={{
          left: `${left}%`,
          width: `${Math.max(right - left, 0.6)}%`,
          background: color,
          opacity: 0.55,
          borderTopLeftRadius: clippedLeft ? 0 : 999,
          borderBottomLeftRadius: clippedLeft ? 0 : 999,
          borderTopRightRadius: clippedRight ? 0 : 999,
          borderBottomRightRadius: clippedRight ? 0 : 999,
        }}
      />

      {/* Cincin sewarna latar memisahkan titik dari batangnya tanpa menambah garis tepi. */}
      <div
        className="absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-card transition-[left] duration-500"
        style={{ left: `${pos(point)}%`, background: color }}
      />
    </div>
  );
}
