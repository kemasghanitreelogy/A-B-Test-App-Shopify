import { Fragment, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { computeResults } from "../lib/results.server";
import { getMainTheme, themeEditorUrl } from "../lib/theme.server";
import { detectTemplateDrift, killSwitch, republishConfig, setStatus, startExperiment } from "../lib/experiment.server";
import type { ExperimentResults } from "../lib/results.server";
import {
  AB_COLORS,
  chartStyles,
  fmt,
  ForestPlot,
  FunnelChart,
  ProbabilityBar,
  ProgressRow,
  TrendChart,
  type ForestRow,
  type TrendPoint,
} from "../components/ExperimentCharts";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const experiment = await db.experiment.findFirstOrThrow({
    where: { id: params.id, shop: session.shop },
  });

  const results = await computeResults(experiment.id);

  let editorUrl: string | null = null;
  let templateDrift = false;
  try {
    const theme = await getMainTheme(admin);
    editorUrl = themeEditorUrl(session.shop, theme.id, experiment.variantBSuffix);
    templateDrift = await detectTemplateDrift(admin, experiment.id);
  } catch {
    // Akses theme belum tersedia (scope belum di-approve). Halaman tetap harus
    // bisa dibuka supaya hasil test tidak ikut terkunci.
  }

  return {
    experiment: {
      ...experiment,
      startedAt: experiment.startedAt?.toISOString() ?? null,
      endedAt: experiment.endedAt?.toISOString() ?? null,
      createdAt: experiment.createdAt.toISOString(),
      updatedAt: experiment.updatedAt.toISOString(),
    },
    results,
    editorUrl,
    templateDrift,
    shop: session.shop,
    // Dihitung di server: render harus murni, dan jam di sini sama untuk semua.
    hoursRunning: experiment.startedAt ? (Date.now() - experiment.startedAt.getTime()) / 36e5 : 0,
  };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = String(form.get("intent"));
  const id = String(params.id);

  const experiment = await db.experiment.findFirstOrThrow({
    where: { id, shop: session.shop },
  });

  try {
    if (intent === "save") {
      // Field yang mempengaruhi validitas statistik tidak boleh berubah setelah
      // test berjalan — mengubahnya di tengah jalan membuat data sebelum dan
      // sesudahnya tidak bisa digabungkan.
      const locked = experiment.status === "running";
      await db.experiment.update({
        where: { id },
        data: {
          name: String(form.get("name") ?? experiment.name),
          hypothesis: String(form.get("hypothesis") ?? "") || null,
          targetType: locked ? experiment.targetType : String(form.get("targetType") ?? experiment.targetType),
          targetIds: locked
            ? experiment.targetIds
            : String(form.get("targetIds") ?? "").split(",").map((s) => s.trim()).filter(Boolean),
          targetHandles: String(form.get("targetHandles") ?? "")
            .split(/[\s,]+/)
            .map((s) => s.trim())
            .filter(Boolean),
          excludeHandles: String(form.get("excludeHandles") ?? "")
            .split(/[\s,]+/)
            .map((s) => s.trim())
            .filter(Boolean),
          ...(locked
            ? {}
            : {
                splitPctB: Math.min(95, Math.max(5, Number(form.get("splitPctB") ?? experiment.splitPctB))),
                primaryMetric: String(form.get("primaryMetric") ?? experiment.primaryMetric),
                mdeRelative: Number(form.get("mdeRelative") ?? experiment.mdeRelative),
              }),
        },
      });
      if (experiment.status === "running") await republishConfig(admin, session.shop);
      return { ok: "Tersimpan." };
    }

    if (intent === "start") {
      const res = await startExperiment(admin, session.shop, id);
      const base = res.templateCreated
        ? `Eksperimen jalan. templates/product.${res.themeEditorSuffix}.json dibuat sebagai salinan template produk saat ini — sekarang garap desain B di theme editor.`
        : `Eksperimen jalan. Menggunakan templates/product.${res.themeEditorSuffix}.json yang sudah ada.`;
      // Terjemahan template tidak ikut tersalin sendiri; kalau ada yang tertinggal,
      // variant B tampil berbahasa Inggris tanpa satu pun error muncul.
      return { ok: [base, translationNote(res), ...res.warnings].filter(Boolean).join(" ") };
    }

    if (intent === "pause" || intent === "complete") {
      await setStatus(admin, session.shop, id, intent === "pause" ? "paused" : "completed");
      return { ok: intent === "pause" ? "Dijeda — semua visitor kembali ke variant A." : "Eksperimen ditutup." };
    }

    if (intent === "killswitch") {
      // Menjeda semua eksperimen yang berjalan; data yang terkumpul tetap utuh.
      const { paused } = await killSwitch(admin, session.shop);
      return { ok: `Kill switch aktif. ${paused.length} eksperimen dijeda, semua visitor melihat variant A.` };
    }

    if (intent === "republish") {
      await republishConfig(admin, session.shop);
      return { ok: "Config storefront diterbitkan ulang." };
    }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }

  return { error: "Aksi tidak dikenal." };
};

/** Event dari Polaris web component field. `target` bertipe EventTarget sehingga
 *  nilainya perlu dibaca lewat helper ini. */
type FieldEvent = { target: EventTarget | null };
const fieldValue = (e: FieldEvent) => (e.target as { value?: string } | null)?.value ?? "";


/** Sama dengan MIN_RUNTIME_DAYS di results.server.ts. */
const MIN_DAYS = 14;

/** Bentuk bersama uji proporsi dan uji pendapatan yang dipakai grafik. */
type UpliftTest = { upliftRelative: number; ciLow: number; ciHigh: number; pValue: number } & (
  | { rateA: number; rateB: number; probBBeatsA: number }
  | { rpvA: number; rpvB: number }
);

const metricLabel = (m: string) =>
  ({ cvr: "Conversion rate", atc_rate: "Add-to-cart rate", rpv: "Revenue per visitor", aov: "Average order value" })[m] ?? m;

type BadgeTone = "success" | "critical" | "warning" | "neutral" | "info";

/** Status keputusan: badge, kalimat pembuka. Urutan: data rusak > siap > belum. */
function verdictFor(results: ExperimentResults, test: UpliftTest | null): { tone: BadgeTone; badge: string; lead: string } {
  if (results.srm?.mismatch) return { tone: "critical", badge: "Data bermasalah", lead: "Jangan ambil kesimpulan" };
  const wins = test ? (test.ciLow > 0 ? "B" : test.ciHigh < 0 ? "A" : null) : null;
  if (results.readyToConclude) {
    if (wins === "B") return { tone: "success", badge: "B menang", lead: "B lebih baik dari A" };
    if (wins === "A") return { tone: "critical", badge: "A menang", lead: "B lebih buruk dari A" };
    return { tone: "neutral", badge: "Tidak ada beda", lead: "Tidak ada beda bermakna" };
  }
  const lead = !test
    ? "Belum ada data"
    : test.upliftRelative > 0
      ? "B sementara unggul"
      : test.upliftRelative < 0
        ? "A sementara unggul"
        : "Belum ada beda";
  return { tone: "warning", badge: "Belum boleh disimpulkan", lead };
}

export default function ExperimentDetail() {
  const { experiment, results, editorUrl, templateDrift, hoursRunning } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const running = experiment.status === "running";

  const [form, setForm] = useState({
    name: experiment.name,
    hypothesis: experiment.hypothesis ?? "",
    targetType: experiment.targetType,
    targetIds: experiment.targetIds.join(","),
    targetHandles: experiment.targetHandles.join("\n"),
    excludeHandles: experiment.excludeHandles.join("\n"),
    splitPctB: String(experiment.splitPctB),
    primaryMetric: experiment.primaryMetric,
    mdeRelative: String(experiment.mdeRelative),
  });
  const set = (k: keyof typeof form) => (e: FieldEvent) => setForm((f) => ({ ...f, [k]: fieldValue(e) }));
  const submit = (intent: string) => fetcher.submit({ ...form, intent }, { method: "POST" });

  async function pickResources() {
    const type = form.targetType === "collections" ? "collection" : "product";
    const selection = await shopify.resourcePicker({ type, multiple: true });
    if (!selection) return;
    setForm((f) => ({ ...f, targetIds: selection.map((s) => s.id).join(",") }));
  }

  const primary = experiment.primaryMetric;
  const test: UpliftTest | null =
    primary === "aov"
      ? null
      : primary === "rpv"
        ? results.revenue
        : primary === "atc_rate"
          ? results.atcRate
          : results.cvr;
  const probB = test && "probBBeatsA" in test ? test.probBBeatsA : null;
  const verdict = verdictFor(results, test);

  const least = Math.min(results.A.visitors, results.B.visitors);
  const etaDays =
    hoursRunning > 1 && least > 0 && least < results.requiredPerArm
      ? (results.requiredPerArm - least) / ((least / hoursRunning) * 24)
      : null;

  const useHourly = results.hourly.length > 0;
  const trend: TrendPoint[] = useHourly
    ? results.hourly.map((h) => ({ t: h.hour, variant: h.variant, visitors: h.visitors, orders: h.orders }))
    : results.daily.map((d) => ({ t: `${d.date}T00:00:00Z`, variant: d.variant, visitors: d.visitors, orders: d.orders }));

  const significant = (t: UpliftTest | null) => Boolean(t && (t.ciLow > 0 || t.ciHigh < 0));
  const kpis = [
    { label: "Visitor", a: fmt.int(results.A.visitors), b: fmt.int(results.B.visitors), delta: null, significant: false },
    {
      label: "Conversion rate",
      a: results.cvr ? fmt.pct(results.cvr.rateA) : "—",
      b: results.cvr ? fmt.pct(results.cvr.rateB) : "—",
      delta: results.cvr?.upliftRelative ?? null,
      significant: significant(results.cvr),
    },
    {
      label: "Revenue per visitor",
      a: results.revenue ? fmt.idr(results.revenue.rpvA) : "—",
      b: results.revenue ? fmt.idr(results.revenue.rpvB) : "—",
      delta: results.revenue?.upliftRelative ?? null,
      significant: significant(results.revenue),
    },
    { label: "Order", a: fmt.int(results.A.orders), b: fmt.int(results.B.orders), delta: null, significant: false },
  ];

  const forest: ForestRow[] = [
    { key: "cvr", label: "Conversion rate", t: results.cvr as UpliftTest | null, kind: "rate" as const },
    { key: "rpv", label: "Revenue per visitor", t: results.revenue as UpliftTest | null, kind: "money" as const },
    { key: "checkout", label: "Mulai checkout", t: results.checkoutRate as UpliftTest | null, kind: "rate" as const },
    { key: "atc_rate", label: "Add-to-cart rate", t: results.atcRate as UpliftTest | null, kind: "rate" as const },
  ]
    .filter((r): r is typeof r & { t: UpliftTest } => r.t !== null && Number.isFinite(r.t.upliftRelative))
    .map((r) => ({
      key: r.key,
      label: r.label,
      primary: r.key === primary || (primary === "rpv" && r.key === "rpv"),
      uplift: r.t.upliftRelative,
      lo: r.t.ciLow,
      hi: r.t.ciHigh,
      detail: [
        `Kenaikan ${fmt.signed(r.t.upliftRelative)} · p = ${r.t.pValue.toFixed(3)}`,
        `Rentang 95%: ${fmt.signed(r.t.ciLow)} s/d ${fmt.signed(r.t.ciHigh)}`,
        ...("rateA" in r.t ? [`A ${fmt.pct(r.t.rateA)} · B ${fmt.pct(r.t.rateB)}`] : []),
        ...("rpvA" in r.t ? [`A ${fmt.idr(r.t.rpvA)} · B ${fmt.idr(r.t.rpvB)}`] : []),
        ...("probBBeatsA" in r.t ? [`Peluang B lebih baik ${fmt.pct(r.t.probBBeatsA, 0)}`] : []),
      ],
    }));

  const detailRows: Array<[string, string, string]> = [
    ["Visitor", fmt.int(results.A.visitors), fmt.int(results.B.visitors)],
    ["Add to cart", fmt.int(results.A.addToCarts), fmt.int(results.B.addToCarts)],
    ["Mulai checkout", fmt.int(results.A.checkoutStarts), fmt.int(results.B.checkoutStarts)],
    ["Order", fmt.int(results.A.orders), fmt.int(results.B.orders)],
    ["Conversion rate", results.cvr ? fmt.pct(results.cvr.rateA) : "—", results.cvr ? fmt.pct(results.cvr.rateB) : "—"],
    ["Revenue", fmt.idr(results.A.revenue), fmt.idr(results.B.revenue)],
    ["Revenue per visitor", results.revenue ? fmt.idr(results.revenue.rpvA) : "—", results.revenue ? fmt.idr(results.revenue.rpvB) : "—"],
    ["Average order value", results.revenue ? fmt.idr(results.revenue.aovA) : "—", results.revenue ? fmt.idr(results.revenue.aovB) : "—"],
  ];

  return (
    <s-page heading={experiment.name}>
      <s-button slot="primary-action" onClick={() => submit("save")} {...(fetcher.state !== "idle" ? { loading: true } : {})}>
        Simpan
      </s-button>

      {fetcher.data && "error" in fetcher.data && fetcher.data.error && (
        <s-banner tone="critical"><s-paragraph>{fetcher.data.error}</s-paragraph></s-banner>
      )}
      {fetcher.data && "ok" in fetcher.data && fetcher.data.ok && (
        <s-banner tone="success"><s-paragraph>{fetcher.data.ok}</s-paragraph></s-banner>
      )}

      {results.srm?.mismatch && (
        <s-banner tone="critical" heading="Sample Ratio Mismatch">
          <s-paragraph>
            Split teramati {results.srm.observedPctB.toFixed(1)}% padahal seharusnya {results.srm.expectedPctB}%
            (p = {results.srm.pValue.toExponential(2)}). Penyimpangan sebesar ini hampir tidak pernah terjadi karena
            kebetulan — kemungkinan besar redirect gagal di sebagian visitor, atau bot ikut masuk bucket.
            Jangan ambil kesimpulan apa pun dari eksperimen ini sampai penyebabnya ketemu.
          </s-paragraph>
        </s-banner>
      )}

      {templateDrift && (
        <s-banner tone="warning" heading="Template variant B berubah saat test berjalan">
          <s-paragraph>
            Isi templates/product.{experiment.variantBSuffix}.json berbeda dari saat eksperimen dimulai.
            Data sebelum dan sesudah perubahan tidak sebanding. Pertimbangkan untuk mulai ulang eksperimen.
          </s-paragraph>
        </s-banner>
      )}

      <style>{chartStyles}</style>

      <s-section heading="Ringkasan">
        <s-grid gridTemplateColumns="@container (inline-size <= 640px) 1fr, 3fr 2fr" gap="large-200">
          <s-stack direction="block" gap="small-300">
            <s-stack direction="inline" gap="small-200" alignItems="center">
              <s-badge tone={verdict.tone} size="large">{verdict.badge}</s-badge>
              <s-text color="subdued">Metrik utama: {metricLabel(primary)}</s-text>
            </s-stack>
            {test ? (
              <>
                <s-text color="subdued">{verdict.lead}</s-text>
                <span className="ab-hero-value" style={{ color: test.upliftRelative >= 0 ? AB_COLORS.b : AB_COLORS.text }}>
                  {fmt.signed(test.upliftRelative)}
                </span>
                <s-paragraph>
                  Rentang 95%: {fmt.signed(test.ciLow)} s/d {fmt.signed(test.ciHigh)}.{" "}
                  {test.ciLow > 0 || test.ciHigh < 0
                    ? "Seluruh rentang di satu sisi nol, jadi bedanya nyata secara statistik."
                    : "Rentang masih memotong nol, jadi bisa saja tidak ada beda."}
                </s-paragraph>
              </>
            ) : (
              <s-paragraph>Uji statistik untuk metrik ini belum tersedia atau belum ada data.</s-paragraph>
            )}
            {!results.readyToConclude && (
              <s-unordered-list>
                {results.blockers.map((b, i) => (
                  <s-list-item key={i}>{b.id}</s-list-item>
                ))}
              </s-unordered-list>
            )}
          </s-stack>

          <s-stack direction="block" gap="base">
            {probB !== null && (
              <s-stack direction="block" gap="small-200">
                <s-text type="strong">Peluang B lebih baik dari A</s-text>
                <ProbabilityBar probB={probB} />
              </s-stack>
            )}
            <s-stack direction="block" gap="small-200">
              <s-text type="strong">Kemajuan</s-text>
              <ProgressRow
                label="Sampel A"
                value={results.A.visitors}
                target={results.requiredPerArm}
                color={AB_COLORS.a}
                suffix={`${fmt.int(results.A.visitors)} / ${fmt.int(results.requiredPerArm)}`}
              />
              <ProgressRow
                label="Sampel B"
                value={results.B.visitors}
                target={results.requiredPerArm}
                color={AB_COLORS.b}
                suffix={`${fmt.int(results.B.visitors)} / ${fmt.int(results.requiredPerArm)}`}
              />
              <ProgressRow
                label="Durasi"
                value={results.daysRunning}
                target={MIN_DAYS}
                color={AB_COLORS.text}
                suffix={`${results.daysRunning} / ${MIN_DAYS} hari`}
              />
              {etaDays !== null && (
                <s-text color="subdued">Dengan laju sekarang, sampel cukup sekitar {fmt.int(etaDays)} hari lagi.</s-text>
              )}
            </s-stack>
          </s-stack>
        </s-grid>
      </s-section>

      <s-section accessibilityLabel="Angka utama">
        <s-grid gridTemplateColumns="@container (inline-size <= 520px) 1fr 1fr, 1fr auto 1fr auto 1fr auto 1fr" gap="base">
          {kpis.map((k, i) => (
            <Fragment key={k.label}>
              {i > 0 && <s-divider direction="block" />}
              <s-stack direction="block" gap="small-200">
                <s-text color="subdued">{k.label}</s-text>
                <span className="ab-kpi-value" style={{ color: AB_COLORS.b }}>{k.b}</span>
                <span className="ab-kpi-sub">A: {k.a}</span>
                {k.delta !== null && (
                  <s-stack direction="inline">
                    <s-badge tone={k.significant ? (k.delta > 0 ? "success" : "critical") : "neutral"} icon={k.delta >= 0 ? "arrow-up" : "arrow-down"}>
                      {fmt.signed(k.delta)}
                    </s-badge>
                  </s-stack>
                )}
              </s-stack>
            </Fragment>
          ))}
        </s-grid>
      </s-section>

      <s-section heading="Kenaikan B dibanding A per metrik">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            <s-text color="subdued">
              Titik = perkiraan kenaikan, batang = rentang 95%. Kanan dari garis nol berarti B lebih baik. Hanya metrik
              utama yang dipakai untuk memutuskan; metrik lain untuk diagnosis.
            </s-text>
          </s-paragraph>
          <div className="ab-legend">
            <span><i className="ab-swatch" style={{ background: AB_COLORS.a }} />A · kontrol</span>
            <span><i className="ab-swatch" style={{ background: AB_COLORS.b }} />B · variant</span>
            <span><i className="ab-swatch" style={{ background: AB_COLORS.ok }} />Nyata lebih baik</span>
            <span><i className="ab-swatch" style={{ background: AB_COLORS.bad }} />Nyata lebih buruk</span>
          </div>
          {forest.length > 0 ? <ForestPlot rows={forest} /> : <s-paragraph>Belum ada data.</s-paragraph>}
        </s-stack>
      </s-section>

      <s-grid gridTemplateColumns="@container (inline-size <= 800px) 1fr, 1fr 1fr" gap="base">
        <s-section heading="Funnel">
          <s-stack direction="block" gap="base">
            <s-paragraph>
              <s-text color="subdued">Visitor unik per langkah dan persentasenya dari semua visitor grup.</s-text>
            </s-paragraph>
            <FunnelChart
              steps={[
                { label: "Visitor", a: results.A.visitors, b: results.B.visitors },
                { label: "Add to cart", a: results.A.addToCarts, b: results.B.addToCarts },
                { label: "Mulai checkout", a: results.A.checkoutStarts, b: results.B.checkoutStarts },
                { label: "Order", a: results.A.orders, b: results.B.orders },
              ]}
            />
          </s-stack>
        </s-section>
        <s-section heading="Konversi kumulatif">
          <s-stack direction="block" gap="base">
            <s-paragraph>
              <s-text color="subdued">
                Order ÷ visitor sejak test mulai, {useHourly ? "per jam (3 hari pertama)" : "per hari"}, waktu WIB. Garis
                yang masih naik-turun tajam berarti sampel masih kecil.
              </s-text>
            </s-paragraph>
            <TrendChart points={trend} hourly={useHourly} />
          </s-stack>
        </s-section>
      </s-grid>

      <s-section heading="Detail angka">
        <s-stack direction="block" gap="base">
          <s-table>
            <s-table-header-row>
              <s-table-header>Metric</s-table-header>
              <s-table-header format="numeric">A (kontrol)</s-table-header>
              <s-table-header format="numeric">B (variant)</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {detailRows.map(([label, a, b]) => (
                <s-table-row key={label}>
                  <s-table-cell>{label}</s-table-cell>
                  <s-table-cell>{a}</s-table-cell>
                  <s-table-cell>{b}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
          {test && (
            <s-paragraph>
              <s-text color="subdued">
                {metricLabel(primary)}: p-value {test.pValue.toFixed(4)}
                {probB !== null ? ` · P(B lebih baik dari A) = ${fmt.pct(probB, 1)}` : ""}. Mengambil keputusan dari
                metrik lain yang kebetulan menang adalah p-hacking.
              </s-text>
            </s-paragraph>
          )}
        </s-stack>
      </s-section>

      <s-section heading="Pengaturan">
        <s-stack direction="block" gap="base">
          {running && (
            <s-banner tone="info">
              <s-paragraph>
                Eksperimen sedang berjalan. Split, primary metric, MDE, dan targeting terkunci —
                mengubahnya sekarang akan membuat hasilnya tidak valid.
              </s-paragraph>
            </s-banner>
          )}

          <s-text-field label="Nama" value={form.name} onInput={set("name")} />
          <s-text-area label="Hipotesis" value={form.hypothesis} onInput={set("hypothesis")} />

          <s-select label="Cakupan" value={form.targetType} onChange={set("targetType")} {...(running ? { disabled: true } : {})}>
            <s-option value="all_products">Semua produk</s-option>
            <s-option value="products">Produk tertentu</s-option>
            <s-option value="collections">Collection tertentu</s-option>
          </s-select>

          {form.targetType !== "all_products" && (
            <>
              <s-stack direction="inline" gap="base">
                <s-button onClick={pickResources} {...(running ? { disabled: true } : {})}>
                  Pilih {form.targetType === "collections" ? "collection" : "produk"}
                </s-button>
                <s-text tone="neutral">{form.targetIds ? `${form.targetIds.split(",").filter(Boolean).length} dipilih` : "belum ada"}</s-text>
              </s-stack>
              <s-text-area
                label="Atau tulis handle produk manual (satu per baris)"
                value={form.targetHandles}
                onInput={set("targetHandles")}
                details="Dipakai kalau scope read_products belum di-approve sehingga resource picker tidak bisa jalan."
              />
            </>
          )}

          <s-text-area
            label="Handle produk yang dikecualikan (satu per baris)"
            value={form.excludeHandles}
            onInput={set("excludeHandles")}
          />

          <s-number-field
            label="Traffic ke variant B (%)"
            value={form.splitPctB}
            onInput={set("splitPctB")}
            min={5}
            max={95}
            {...(running ? { disabled: true } : {})}
          />

          <s-select label="Primary metric" value={form.primaryMetric} onChange={set("primaryMetric")} {...(running ? { disabled: true } : {})}>
            <s-option value="cvr">Conversion rate</s-option>
            <s-option value="atc_rate">Add-to-cart rate</s-option>
            <s-option value="rpv">Revenue per visitor</s-option>
            <s-option value="aov">Average order value</s-option>
          </s-select>

          <s-select label="Minimum detectable effect" value={form.mdeRelative} onChange={set("mdeRelative")} {...(running ? { disabled: true } : {})}>
            <s-option value="0.1">10% relatif</s-option>
            <s-option value="0.15">15% relatif</s-option>
            <s-option value="0.2">20% relatif</s-option>
            <s-option value="0.3">30% relatif</s-option>
          </s-select>
        </s-stack>
      </s-section>

      <s-section slot="aside" heading="Aksi">
        <s-stack direction="block" gap="base">
          {!running && (
            <s-button variant="primary" onClick={() => submit("start")}>
              {experiment.startedAt ? "Lanjutkan" : "Jalankan"}
            </s-button>
          )}
          {running && <s-button onClick={() => submit("pause")}>Jeda</s-button>}
          <s-button onClick={() => submit("complete")}>Tutup eksperimen</s-button>
          <s-button tone="critical" onClick={() => submit("killswitch")}>
            Kill switch — jeda semua, semua ke variant A
          </s-button>
          <s-button variant="tertiary" onClick={() => submit("republish")}>
            Terbitkan ulang config
          </s-button>
        </s-stack>
      </s-section>

      <s-section slot="aside" heading="Desain variant B">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Template: <s-text type="strong">templates/product.{experiment.variantBSuffix}.json</s-text>
          </s-paragraph>
          {editorUrl && (
            <s-link href={editorUrl} target="_blank">
              Buka theme editor untuk variant B
            </s-link>
          )}
          <s-paragraph>
            <s-text tone="neutral">
              Untuk QA tanpa terkena bucketing, tambahkan <s-text type="strong">?_tl_ab_off=1</s-text> di URL.
            </s-text>
          </s-paragraph>
        </s-stack>
      </s-section>
    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);

/** Ringkasan penyalinan terjemahan untuk ditempel pada pesan "eksperimen jalan". */
function translationNote(res: { translationsCopied: number; translationsNeedManual: number }): string {
  if (res.translationsNeedManual > 0) {
    return `${res.translationsCopied} terjemahan disalin, tapi ${res.translationsNeedManual} teks variant B belum diterjemahkan dan akan tampil dalam bahasa Inggris.`;
  }
  return res.translationsCopied > 0 ? `${res.translationsCopied} terjemahan template ikut disalin.` : "";
}
