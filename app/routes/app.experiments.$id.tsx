import { useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { computeResults } from "../lib/results.server";
import { getMainTheme, themeEditorUrl } from "../lib/theme.server";
import { detectTemplateDrift, republishConfig, setStatus, startExperiment } from "../lib/experiment.server";

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
      // Matikan seluruh config di storefront tanpa mengubah status eksperimen,
      // supaya bisa dihidupkan lagi tanpa kehilangan data.
      await republishConfig(admin, session.shop, false);
      return { ok: "Kill switch aktif. Semua visitor melihat variant A." };
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


const fmtPct = (n: number) => `${(n * 100).toFixed(2)}%`;
const fmtIdr = (n: number) =>
  new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(n);

export default function ExperimentDetail() {
  const { experiment, results, editorUrl, templateDrift } = useLoaderData<typeof loader>();
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
  const test = primary === "rpv" || primary === "aov" ? null : primary === "atc_rate" ? results.atcRate : results.cvr;

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

      <s-section heading="Hasil">
        <s-stack direction="block" gap="base">
          <s-table>
            <s-table-header-row>
              <s-table-header>Metric</s-table-header>
              <s-table-header>A (kontrol)</s-table-header>
              <s-table-header>B (variant)</s-table-header>
            </s-table-header-row>
            <s-table-body>
              <s-table-row>
                <s-table-cell>Visitor</s-table-cell>
                <s-table-cell>{results.A.visitors.toLocaleString("id-ID")}</s-table-cell>
                <s-table-cell>{results.B.visitors.toLocaleString("id-ID")}</s-table-cell>
              </s-table-row>
              <s-table-row>
                <s-table-cell>Add to cart</s-table-cell>
                <s-table-cell>{results.A.addToCarts.toLocaleString("id-ID")}</s-table-cell>
                <s-table-cell>{results.B.addToCarts.toLocaleString("id-ID")}</s-table-cell>
              </s-table-row>
              <s-table-row>
                <s-table-cell>Order</s-table-cell>
                <s-table-cell>{results.A.orders.toLocaleString("id-ID")}</s-table-cell>
                <s-table-cell>{results.B.orders.toLocaleString("id-ID")}</s-table-cell>
              </s-table-row>
              <s-table-row>
                <s-table-cell>Conversion rate</s-table-cell>
                <s-table-cell>{results.cvr ? fmtPct(results.cvr.rateA) : "—"}</s-table-cell>
                <s-table-cell>{results.cvr ? fmtPct(results.cvr.rateB) : "—"}</s-table-cell>
              </s-table-row>
              <s-table-row>
                <s-table-cell>Revenue per visitor</s-table-cell>
                <s-table-cell>{results.revenue ? fmtIdr(results.revenue.rpvA) : "—"}</s-table-cell>
                <s-table-cell>{results.revenue ? fmtIdr(results.revenue.rpvB) : "—"}</s-table-cell>
              </s-table-row>
              <s-table-row>
                <s-table-cell>Average order value</s-table-cell>
                <s-table-cell>{results.revenue ? fmtIdr(results.revenue.aovA) : "—"}</s-table-cell>
                <s-table-cell>{results.revenue ? fmtIdr(results.revenue.aovB) : "—"}</s-table-cell>
              </s-table-row>
            </s-table-body>
          </s-table>

          {test && (
            <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
              <s-stack direction="block" gap="small-200">
                <s-heading>
                  Uplift {test.upliftRelative >= 0 ? "+" : ""}
                  {(test.upliftRelative * 100).toFixed(1)}%
                </s-heading>
                <s-paragraph>
                  Interval kepercayaan 95%: {(test.ciLow * 100).toFixed(1)}% s/d {(test.ciHigh * 100).toFixed(1)}%
                </s-paragraph>
                <s-paragraph>
                  p-value {test.pValue.toFixed(4)} · P(B lebih baik dari A) ={" "}
                  {(test.probBBeatsA * 100).toFixed(1)}%
                </s-paragraph>
              </s-stack>
            </s-box>
          )}

          {results.readyToConclude ? (
            <s-banner tone="success" heading="Siap disimpulkan">
              <s-paragraph>
                Sample size dan durasi minimum sudah terpenuhi, dan tidak ada tanda data rusak.
              </s-paragraph>
            </s-banner>
          ) : (
            <s-banner tone="warning" heading="Belum boleh disimpulkan">
              <s-unordered-list>
                {results.blockers.map((b, i) => (
                  <s-list-item key={i}>{b.id}</s-list-item>
                ))}
              </s-unordered-list>
            </s-banner>
          )}

          <s-paragraph>
            <s-text tone="neutral">
              Metric selain primary metric ({experiment.primaryMetric}) hanya untuk diagnosis. Mengambil
              keputusan berdasarkan metric mana pun yang kebetulan menang adalah p-hacking.
            </s-text>
          </s-paragraph>
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
            Kill switch — semua ke variant A
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
