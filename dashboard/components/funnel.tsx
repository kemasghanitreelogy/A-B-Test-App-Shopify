import { fmtPct } from "@/lib/format";
import { CountUp } from "@/components/count-up";
import { pick, tr, type Lang } from "@/lib/i18n";

interface Arm {
  visitors: number;
  addToCarts: number;
  checkoutStarts: number;
  orders: number;
}

const STEPS = [
  { key: "visitors" as const, label: { id: "Melihat halaman produk", en: "Viewed product page" } },
  { key: "addToCarts" as const, label: { id: "Masuk keranjang", en: "Added to cart" } },
  { key: "checkoutStarts" as const, label: { id: "Mulai checkout", en: "Started checkout" } },
  { key: "orders" as const, label: { id: "Membeli", en: "Purchased" } },
];

/**
 * Funnel berdampingan A vs B.
 *
 * Lebar bar dinormalkan terhadap jumlah pengunjung masing-masing grup, bukan
 * terhadap angka absolut. Kalau tidak, grup dengan traffic lebih banyak akan
 * selalu terlihat "lebih baik" padahal yang dibandingkan adalah rasio.
 *
 * "Mulai checkout" datang dari web pixel dan ikut terpotong ad-blocker, jadi
 * angkanya lebih rendah dari kenyataan di KEDUA grup. Ia dipakai untuk melihat di
 * mana funnel bocor, bukan untuk menyimpulkan pemenang — itu tetap dari baris
 * "Membeli", yang bersumber dari webhook order.
 */
export function Funnel({ a, b, lang }: { a: Arm; b: Arm; lang: Lang }) {
  const t = tr(lang);
  return (
    <div className="space-y-5">
      {STEPS.map((step, si) => {
        const rateA = a.visitors > 0 ? a[step.key] / a.visitors : 0;
        const rateB = b.visitors > 0 ? b[step.key] / b.visitors : 0;

        return (
          <div key={step.key} className="reveal space-y-2" style={{ "--i": si } as React.CSSProperties}>
            <div className="flex items-baseline justify-between">
              <span className="text-xs font-medium text-muted-foreground">{pick(lang, step.label)}</span>
              <span className="font-mono text-[10px] text-muted-foreground/70">{t(`langkah ${si + 1}`, `step ${si + 1}`)}</span>
            </div>

            {(
              [
                { name: "A", value: a[step.key], rate: rateA, color: "var(--variant-a)" },
                { name: "B", value: b[step.key], rate: rateB, color: "var(--variant-b)" },
              ] as const
            ).map((row, ri) => (
              <div key={row.name} className="flex items-center gap-3">
                <span className="w-3 shrink-0 font-mono text-xs text-muted-foreground">{row.name}</span>
                <div className="h-6 flex-1 overflow-hidden rounded-md bg-muted/80">
                  <div
                    className="bar-grow h-full rounded-md"
                    style={{
                      "--i": si * 2 + ri,
                      width: `${Math.max(row.rate * 100, row.value > 0 ? 1.5 : 0)}%`,
                      background: `linear-gradient(90deg, color-mix(in oklab, ${row.color} 65%, transparent), ${row.color})`,
                    } as React.CSSProperties}
                  />
                </div>
                <span className="w-28 shrink-0 text-right font-mono text-xs tabular-nums">
                  <CountUp value={row.value} kind="int" />
                  <span className="ml-1.5 text-muted-foreground">{fmtPct(row.rate, 1)}</span>
                </span>
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}
