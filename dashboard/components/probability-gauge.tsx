import { tr, type Lang } from "@/lib/i18n";

/**
 * Peluang B mengalahkan A, digambar di atas sumbu keputusan.
 *
 * Angkanya sendiri sulit dikalibrasi — 91% terdengar meyakinkan padahal masih di
 * zona "belum pasti". Menempatkannya di sumbu yang zonanya sudah diberi batas
 * membuat pertanyaannya berubah dari "apakah 91% cukup besar" menjadi "sudah
 * masuk zona mana", yang jauh lebih sulit disalahbaca.
 *
 * Zona di kedua ujung sengaja terlihat sempit: 5% di tiap sisi memang porsi kecil
 * dari seluruh ruang kemungkinan, dan itu memang yang ingin ditunjukkan.
 */
export function ProbabilityGauge({
  value,
  threshold = 0.05,
  lang = "id",
}: {
  /** P(B > A), 0..1 */
  value: number;
  threshold?: number;
  lang?: Lang;
}) {
  const t = tr(lang);
  const pct = Math.min(100, Math.max(0, value * 100));
  const edge = threshold * 100;
  const zone = value >= 1 - threshold ? "B" : value <= threshold ? "A" : null;

  return (
    <div className="space-y-2">
      <div
        className="relative"
        role="img"
        aria-label={t(
          `Peluang variant B lebih baik dari A: ${pct.toFixed(1)} persen. Zona keputusan mulai di ${(100 - edge).toFixed(0)} persen.`,
          `Chance variant B beats A: ${pct.toFixed(1)} percent. The decision zone starts at ${(100 - edge).toFixed(0)} percent.`,
        )}
      >
        {/* Jarak 2px antar segmen: pemisah dibuat dari latar, bukan dari garis tepi. */}
        <div className="flex h-2.5 gap-0.5">
          <div
            className="rounded-l-full transition-opacity duration-300"
            style={{
              width: `${edge}%`,
              background: "var(--variant-a)",
              opacity: zone === "A" ? 1 : 0.3,
            }}
          />
          <div className="flex-1 bg-muted" />
          <div
            className="rounded-r-full transition-opacity duration-300"
            style={{
              width: `${edge}%`,
              background: "var(--variant-b)",
              opacity: zone === "B" ? 1 : 0.3,
            }}
          />
        </div>

        <div
          className="pointer-events-none absolute top-1/2 h-5 w-[3px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground ring-2 ring-card transition-[left] duration-700"
          style={{ left: `${pct}%` }}
        />
      </div>

      <div className="flex justify-between text-[10px] font-medium uppercase tracking-[0.1em] text-muted-foreground">
        <span className={zone === "A" ? "text-[var(--variant-a)]" : undefined}>{t("A menang", "A wins")}</span>
        <span>{t("belum pasti", "not yet clear")}</span>
        <span className={zone === "B" ? "text-[var(--variant-b)]" : undefined}>{t("B menang", "B wins")}</span>
      </div>
    </div>
  );
}
