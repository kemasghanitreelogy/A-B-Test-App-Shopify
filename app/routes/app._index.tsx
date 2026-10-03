import { useEffect, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useNavigate, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { sampleSizePerArm } from "../lib/stats";

/** Event dari Polaris web component field. `target` bertipe EventTarget sehingga
 *  nilainya perlu dibaca lewat helper ini. */
type FieldEvent = { target: EventTarget | null };
const fieldValue = (e: FieldEvent) => (e.target as { value?: string } | null)?.value ?? "";


export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const experiments = await db.experiment.findMany({
    where: { shop: session.shop },
    orderBy: { createdAt: "desc" },
  });

  const counts = await db.assignment.groupBy({
    by: ["experimentId", "variant"],
    where: { experimentId: { in: experiments.map((e) => e.id) } },
    _count: { _all: true },
  });

  return {
    experiments: experiments.map((e) => ({
      id: e.id,
      name: e.name,
      status: e.status,
      primaryMetric: e.primaryMetric,
      splitPctB: e.splitPctB,
      targetType: e.targetType,
      startedAt: e.startedAt?.toISOString() ?? null,
      visitors: counts
        .filter((c) => c.experimentId === e.id)
        .reduce((sum, c) => sum + c._count._all, 0),
    })),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();

  const name = String(form.get("name") ?? "").trim();
  if (!name) return { error: "Nama eksperimen wajib diisi." };

  const suffix = String(form.get("variantBSuffix") ?? "").trim() || "ab-b";
  if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(suffix)) {
    return {
      error:
        "Template suffix hanya boleh huruf kecil, angka, dan tanda hubung (dipakai sebagai nama file templates/product.<suffix>.json).",
    };
  }

  const mde = Number(form.get("mdeRelative") ?? 0.2);
  const baseline = Number(form.get("baselineCvr") ?? 0.02);

  const experiment = await db.experiment.create({
    data: {
      shop: session.shop,
      name,
      hypothesis: String(form.get("hypothesis") ?? "").trim() || null,
      variantBSuffix: suffix,
      splitPctB: Math.min(95, Math.max(5, Number(form.get("splitPctB") ?? 50))),
      primaryMetric: String(form.get("primaryMetric") ?? "cvr"),
      mdeRelative: mde,
      minSampleArm: sampleSizePerArm(baseline, mde),
    },
  });

  return { id: experiment.id };
};

type Tone = "neutral" | "success" | "warning" | "info";

const STATUS_TONE: Record<string, Tone> = {
  draft: "neutral",
  running: "success",
  paused: "warning",
  completed: "info",
  archived: "neutral",
};

const METRIC_LABEL: Record<string, string> = {
  cvr: "Conversion rate",
  atc_rate: "Add-to-cart rate",
  rpv: "Revenue per visitor",
  aov: "Average order value",
};

export default function Index() {
  const { experiments } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const navigate = useNavigate();
  const [showForm, setShowForm] = useState(false);

  const [form, setForm] = useState({
    name: "",
    hypothesis: "",
    variantBSuffix: "ab-b",
    splitPctB: "50",
    primaryMetric: "cvr",
    mdeRelative: "0.2",
    baselineCvr: "0.02",
  });

  const set = (key: keyof typeof form) => (e: FieldEvent) =>
    setForm((f) => ({ ...f, [key]: fieldValue(e) }));

  const required = sampleSizePerArm(Number(form.baselineCvr) || 0.02, Number(form.mdeRelative) || 0.2);

  const createdId = fetcher.data && "id" in fetcher.data ? fetcher.data.id : null;
  useEffect(() => {
    if (createdId) navigate(`/app/experiments/${createdId}`);
  }, [createdId, navigate]);

  return (
    <s-page heading="A/B Test PDP">
      <s-button slot="primary-action" onClick={() => setShowForm((v) => !v)}>
        {showForm ? "Batal" : "Eksperimen baru"}
      </s-button>

      {showForm && (
        <s-section heading="Eksperimen baru">
          <s-stack direction="block" gap="base">
            <s-text-field
              label="Nama"
              value={form.name}
              onInput={set("name")}
              placeholder="PDP redesign — hero + trust badges"
            />
            <s-text-area
              label="Hipotesis"
              value={form.hypothesis}
              onInput={set("hypothesis")}
              placeholder="Memindahkan trust badge ke atas fold akan menaikkan conversion rate karena keraguan soal keaslian produk muncul sebelum customer scroll."
            />
            <s-text-field
              label="Template suffix variant B"
              value={form.variantBSuffix}
              onInput={set("variantBSuffix")}
              details="Akan dibuat sebagai templates/product.<suffix>.json di live theme."
            />
            <s-number-field
              label="Traffic ke variant B (%)"
              value={form.splitPctB}
              onInput={set("splitPctB")}
              min={5}
              max={95}
            />
            <s-select label="Primary metric" value={form.primaryMetric} onChange={set("primaryMetric")}>
              <s-option value="cvr">Conversion rate (PDP view → purchase)</s-option>
              <s-option value="atc_rate">Add-to-cart rate</s-option>
              <s-option value="rpv">Revenue per visitor</s-option>
              <s-option value="aov">Average order value</s-option>
            </s-select>
            <s-select label="Minimum detectable effect" value={form.mdeRelative} onChange={set("mdeRelative")}>
              <s-option value="0.1">10% relatif — butuh sample sangat besar</s-option>
              <s-option value="0.15">15% relatif</s-option>
              <s-option value="0.2">20% relatif — realistis untuk redesign</s-option>
              <s-option value="0.3">30% relatif</s-option>
            </s-select>
            <s-text-field
              label="Baseline conversion rate"
              value={form.baselineCvr}
              onInput={set("baselineCvr")}
              details="Ambil dari Shopify Analytics. 0.02 = 2%."
            />

            <s-banner tone="info">
              <s-paragraph>
                Dengan angka ini dibutuhkan <s-text type="strong">{required.toLocaleString("id-ID")}</s-text>{" "}
                visitor per grup. Primary metric dan MDE akan dikunci begitu eksperimen mulai berjalan —
                mengubahnya di tengah test adalah p-hacking dan membuat hasilnya tidak bisa dipercaya.
              </s-paragraph>
            </s-banner>

            {fetcher.data && "error" in fetcher.data && fetcher.data.error && (
              <s-banner tone="critical">
                <s-paragraph>{fetcher.data.error}</s-paragraph>
              </s-banner>
            )}

            <s-button
              variant="primary"
              {...(fetcher.state !== "idle" ? { loading: true } : {})}
              onClick={() => fetcher.submit(form, { method: "POST" })}
            >
              Buat eksperimen
            </s-button>
          </s-stack>
        </s-section>
      )}

      <s-section heading="Eksperimen">
        {experiments.length === 0 ? (
          <s-paragraph>Belum ada eksperimen.</s-paragraph>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header>Nama</s-table-header>
              <s-table-header>Status</s-table-header>
              <s-table-header>Metric</s-table-header>
              <s-table-header>Split B</s-table-header>
              <s-table-header>Visitor</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {experiments.map((e) => (
                <s-table-row key={e.id}>
                  <s-table-cell>
                    <s-link href={`/app/experiments/${e.id}`}>{e.name}</s-link>
                  </s-table-cell>
                  <s-table-cell>
                    <s-badge tone={STATUS_TONE[e.status] ?? "neutral"}>{e.status}</s-badge>
                  </s-table-cell>
                  <s-table-cell>{METRIC_LABEL[e.primaryMetric] ?? e.primaryMetric}</s-table-cell>
                  <s-table-cell>{e.splitPctB}%</s-table-cell>
                  <s-table-cell>{e.visitors.toLocaleString("id-ID")}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>
    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
