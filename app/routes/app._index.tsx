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
  if (!name) return { error: "Experiment name is required." };

  const suffix = String(form.get("variantBSuffix") ?? "").trim() || "ab-b";
  if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(suffix)) {
    return {
      error:
        "The template suffix may only contain lowercase letters, numbers and hyphens (it becomes the file name templates/product.<suffix>.json).",
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
        {showForm ? "Cancel" : "New experiment"}
      </s-button>

      {showForm && (
        <s-section heading="New experiment">
          <s-stack direction="block" gap="base">
            <s-text-field
              label="Name"
              value={form.name}
              onInput={set("name")}
              placeholder="PDP redesign — hero + trust badges"
            />
            <s-text-area
              label="Hypothesis"
              value={form.hypothesis}
              onInput={set("hypothesis")}
              placeholder="Moving the trust badges above the fold will raise conversion rate, because doubts about authenticity come up before customers scroll."
            />
            <s-text-field
              label="Variant B template suffix"
              value={form.variantBSuffix}
              onInput={set("variantBSuffix")}
              details="Created as templates/product.<suffix>.json on the live theme."
            />
            <s-number-field
              label="Traffic to variant B (%)"
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
              <s-option value="0.1">10% relative (needs a very large sample)</s-option>
              <s-option value="0.15">15% relative</s-option>
              <s-option value="0.2">20% relative (realistic for a redesign)</s-option>
              <s-option value="0.3">30% relative</s-option>
            </s-select>
            <s-text-field
              label="Baseline conversion rate"
              value={form.baselineCvr}
              onInput={set("baselineCvr")}
              details="Take it from Shopify Analytics. 0.02 = 2%."
            />

            <s-banner tone="info">
              <s-paragraph>
                With these numbers you need <s-text type="strong">{required.toLocaleString("en-US")}</s-text>{" "}
                visitors per group. The primary metric and MDE are locked once the experiment starts. Changing
                them mid-test is p-hacking and makes the result untrustworthy.
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
              Create experiment
            </s-button>
          </s-stack>
        </s-section>
      )}

      <s-section heading="Experiments">
        {experiments.length === 0 ? (
          <s-paragraph>No experiments yet.</s-paragraph>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header>Name</s-table-header>
              <s-table-header>Status</s-table-header>
              <s-table-header>Metric</s-table-header>
              <s-table-header>Split B</s-table-header>
              <s-table-header>Visitors</s-table-header>
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
                  <s-table-cell>{e.visitors.toLocaleString("en-US")}</s-table-cell>
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
