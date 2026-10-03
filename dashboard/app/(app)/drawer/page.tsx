import Link from "next/link";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { fmtInt } from "@/lib/format";
import { getLang } from "@/lib/i18n.server";
import { tr } from "@/lib/i18n";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

/**
 * Perilaku cart drawer dari jalur FIRST-PARTY (tabel InteractionEvent) — bukan
 * GA4: data ini tidak bolong karena ad-blocker, jadi inilah angka acuannya.
 * Kontrak event: Treelogy claudedocs/gtm/CART-DRAWER-TRACKING.md
 *
 * Dua kolom = dua implementasi drawer (legacy = varian A, v3 = varian B),
 * diinstrumentasi identik oleh assets/cart-analytics.js.
 */

const PERIODS = [1, 7, 30] as const;
const UIS = ["legacy", "v3"] as const;
type Ui = (typeof UIS)[number];

interface Count {
  ui: string | null;
  name: string;
  action: string | null;
  n: bigint;
  visitors: bigint;
}

export default async function DrawerPage({ searchParams }: { searchParams: Promise<{ days?: string }> }) {
  await requireUser();
  const t = tr(await getLang());
  const sp = await searchParams;
  const days = PERIODS.includes(Number(sp.days) as (typeof PERIODS)[number]) ? Number(sp.days) : 7;

  const [counts, durations, health] = await Promise.all([
    db.$queryRaw<Count[]>`
      SELECT ui, name, action, COUNT(*) AS n, COUNT(DISTINCT "visitorId") AS visitors
      FROM "InteractionEvent"
      WHERE surface = 'cart_drawer' AND internal = false AND "occurredAt" >= now() - make_interval(days => ${days}::int)
      GROUP BY ui, name, action`,
    db.$queryRaw<Array<{ ui: string | null; median: number | null }>>`
      SELECT ui, percentile_cont(0.5) WITHIN GROUP (ORDER BY ms) AS median
      FROM "InteractionEvent"
      WHERE surface = 'cart_drawer' AND internal = false AND name = 'cart_close' AND "occurredAt" >= now() - make_interval(days => ${days}::int)
      GROUP BY ui`,
    db.$queryRaw<Array<{ total: bigint; internal: bigint; late: bigint; last: Date | null }>>`
      SELECT COUNT(*) AS total,
             COUNT(*) FILTER (WHERE internal) AS internal,
             COUNT(*) FILTER (WHERE "receivedAt" - "occurredAt" > interval '60 seconds') AS late,
             MAX("receivedAt") AS last
      FROM "InteractionEvent"
      WHERE surface = 'cart_drawer' AND "occurredAt" >= now() - make_interval(days => ${days}::int)`,
  ]);

  const sum = (ui: Ui, name: string, action?: string, field: "n" | "visitors" = "n") =>
    counts
      .filter((c) => c.ui === ui && c.name === name && (action === undefined || c.action === action))
      .reduce((acc, c) => acc + Number(c[field]), 0);
  const breakdown = (name: string) => {
    const actions = [...new Set(counts.filter((c) => c.name === name).map((c) => c.action ?? "—"))].sort();
    return actions.map((a) => ({
      action: a,
      legacy: sum("legacy", name, a === "—" ? undefined : a),
      v3: sum("v3", name, a === "—" ? undefined : a),
    }));
  };
  const pct = (part: number, whole: number) => (whole > 0 ? `${((part / whole) * 100).toFixed(1)}%` : "—");
  const median = (ui: Ui) => {
    const m = durations.find((d) => d.ui === ui)?.median;
    return m == null ? "—" : `${(Number(m) / 1000).toFixed(1)} s`;
  };

  const funnel = UIS.map((ui) => {
    const opens = sum(ui, "cart_open");
    const offerViews = sum(ui, "cart_offer_view");
    const offerAccepts = sum(ui, "cart_offer_accept");
    const checkouts = sum(ui, "cart_checkout_click");
    return { ui, opens, openers: sum(ui, "cart_open", undefined, "visitors"), offerViews, offerAccepts, checkouts };
  });
  const h = health[0];

  const rows: Array<{ label: string; value: (ui: Ui) => string }> = [
    { label: t("Drawer dibuka", "Drawer opens"), value: (ui) => fmtInt(funnel.find((f) => f.ui === ui)!.opens) },
    { label: t("Pengunjung yang membuka", "Visitors who opened"), value: (ui) => fmtInt(funnel.find((f) => f.ui === ui)!.openers) },
    {
      label: t("Penawaran terlihat / buka", "Offer seen per open"),
      value: (ui) => {
        const f = funnel.find((x) => x.ui === ui)!;
        return pct(f.offerViews, f.opens);
      },
    },
    {
      label: t("Penawaran diambil / terlihat", "Offer taken per view"),
      value: (ui) => {
        const f = funnel.find((x) => x.ui === ui)!;
        return `${pct(f.offerAccepts, f.offerViews)} (${fmtInt(f.offerAccepts)})`;
      },
    },
    {
      label: t("Klik checkout / buka", "Checkout clicks per open"),
      value: (ui) => {
        const f = funnel.find((x) => x.ui === ui)!;
        return `${pct(f.checkouts, f.opens)} (${fmtInt(f.checkouts)})`;
      },
    },
    { label: t("Lama terbuka (median)", "Time open (median)"), value: median },
    { label: t("Ganti paket", "Pack changes"), value: (ui) => fmtInt(sum(ui, "cart_pack_select", "changed")) },
    { label: t("Ubah jumlah / hapus", "Quantity changes / removals"), value: (ui) => fmtInt(sum(ui, "cart_line_change")) },
    { label: t("Error keranjang", "Cart errors"), value: (ui) => fmtInt(sum(ui, "cart_error") + sum(ui, "cart_loading_timeout")) },
  ];

  const sections = [
    { title: t("Apa yang membuka drawer", "What opened the drawer"), name: "cart_open" },
    { title: t("Cara drawer ditutup", "How the drawer was closed"), name: "cart_close" },
    { title: t("Penawaran yang terlihat", "Offers seen"), name: "cart_offer_view" },
    { title: t("Penawaran yang diambil", "Offers taken"), name: "cart_offer_accept" },
    { title: t("Perubahan baris", "Line changes"), name: "cart_line_change" },
    { title: t("Error", "Errors"), name: "cart_error" },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Cart drawer</h1>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            {t(
              "Dari jalur first-party (bukan GA4), jadi tidak bolong karena ad-blocker. Perangkat tim & otomasi dikecualikan. Kolom legacy = drawer sekarang (varian A), v3 = drawer baru (varian B).",
              "From the first-party channel (not GA4), so ad-blockers don't leave gaps. Team devices & automation are excluded. Legacy = current drawer (variant A), v3 = new drawer (variant B).",
            )}
          </p>
        </div>
        <nav className="flex gap-1 text-sm" aria-label={t("Periode", "Period")}>
          {PERIODS.map((d) => (
            <Link
              key={d}
              href={`/drawer?days=${d}`}
              className={cn(
                "rounded-md px-2.5 py-1.5 transition-colors duration-200",
                d === days ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
            >
              {d === 1 ? t("24 jam", "24h") : t(`${d} hari`, `${d} days`)}
            </Link>
          ))}
        </nav>
      </div>

      <section className="surface overflow-x-auto rounded-2xl">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("Metrik", "Metric")}</TableHead>
              <TableHead className="text-right">legacy (A)</TableHead>
              <TableHead className="text-right">v3 (B)</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.label}>
                <TableCell>{r.label}</TableCell>
                <TableCell className="stat-figure text-right">{r.value("legacy")}</TableCell>
                <TableCell className="stat-figure text-right">{r.value("v3")}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        {sections.map((s) => {
          const items = breakdown(s.name);
          return (
            <section key={s.name} className="surface overflow-x-auto rounded-2xl p-4">
              <h2 className="mb-2 text-sm font-semibold">{s.title}</h2>
              {items.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("Belum ada data.", "No data yet.")}</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("Nilai", "Value")}</TableHead>
                      <TableHead className="text-right">legacy</TableHead>
                      <TableHead className="text-right">v3</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {items.map((i) => (
                      <TableRow key={i.action}>
                        <TableCell className="font-mono text-xs">{i.action}</TableCell>
                        <TableCell className="stat-figure text-right">{fmtInt(i.legacy)}</TableCell>
                        <TableCell className="stat-figure text-right">{fmtInt(i.v3)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </section>
          );
        })}
      </div>

      <section className="surface rounded-2xl p-4 text-sm">
        <h2 className="mb-2 font-semibold">{t("Kesehatan data", "Data health")}</h2>
        <p className="text-muted-foreground">
          {t(
            `${fmtInt(Number(h?.total ?? 0))} event diterima dalam periode ini · ${fmtInt(Number(h?.late ?? 0))} tiba lebih dari 60 detik terlambat lewat antrean ulang (data yang di GA4 bisa hilang) · ${fmtInt(Number(h?.internal ?? 0))} dari perangkat tim/otomasi (dikecualikan) · terakhir diterima ${h?.last ? new Date(h.last).toLocaleString("id-ID") : "—"}.`,
            `${fmtInt(Number(h?.total ?? 0))} events received in this period · ${fmtInt(Number(h?.late ?? 0))} arrived more than 60 seconds late through the retry queue (data GA4 may lose) · ${fmtInt(Number(h?.internal ?? 0))} from team/automation devices (excluded) · last received ${h?.last ? new Date(h.last).toLocaleString("en-GB") : "—"}.`,
          )}
        </p>
      </section>
    </div>
  );
}
