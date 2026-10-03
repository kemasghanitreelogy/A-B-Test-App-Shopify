"use client";

import { useActionState, useEffect, useState } from "react";
import { Lock } from "lucide-react";
import { toast } from "sonner";
import { updateExperimentAction, type FormState } from "@/app/actions";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { SubmitButton } from "@/components/submit-button";
import { useT } from "@/components/lang-provider";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const initial: FormState = {};

export interface SerializedExperiment {
  id: string;
  name: string;
  hypothesis: string;
  targetType: string;
  targetHandles: string;
  excludeHandles: string;
  splitPctB: string;
  primaryMetric: string;
  mdeRelative: string;
}

export function ExperimentSettings({
  experiment,
  locked,
}: {
  experiment: SerializedExperiment;
  locked: boolean;
}) {
  const [state, formAction] = useActionState(updateExperimentAction, initial);
  const [targetType, setTargetType] = useState(experiment.targetType);
  const t = useT();

  useEffect(() => {
    if (state.ok) toast.success(state.ok);
    if (state.error) toast.error(state.error, { duration: 10000 });
  }, [state]);

  return (
    <form action={formAction} className="space-y-5 surface rounded-2xl p-5">
      <input type="hidden" name="id" value={experiment.id} />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold">{t("Pengaturan", "Settings")}</h2>
        {locked ? (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground">
            <Lock className="size-3" />
            {t("Parameter statistik terkunci selama berjalan", "Statistical parameters are locked while running")}
          </span>
        ) : null}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="name">{t("Nama", "Name")}</Label>
          <Input id="name" name="name" defaultValue={experiment.name} />
        </div>

        <div className="space-y-2">
          <Label htmlFor="targetType">{t("Cakupan", "Scope")}</Label>
          <Select name="targetType" value={targetType} onValueChange={setTargetType} disabled={locked}>
            <SelectTrigger id="targetType">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all_products">{t("Semua produk", "All products")}</SelectItem>
              <SelectItem value="products">{t("Produk tertentu", "Specific products")}</SelectItem>
              <SelectItem value="collections">{t("Collection tertentu", "Specific collections")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="hypothesis">{t("Hipotesis", "Hypothesis")}</Label>
        <Textarea id="hypothesis" name="hypothesis" rows={3} defaultValue={experiment.hypothesis} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="targetHandles">{t("Handle produk yang ikut test", "Product handles in the test")}</Label>
          <Textarea
            id="targetHandles"
            name="targetHandles"
            rows={3}
            className="font-mono text-sm"
            defaultValue={experiment.targetHandles}
          />
          <p className="text-xs text-muted-foreground">
            {t(
              "Boleh diubah walau test berjalan, tapi produk yang baru masuk mulai dari nol sample.",
              "Can be changed while the test runs, but newly added products start from zero samples.",
            )}
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="excludeHandles">{t("Dikecualikan", "Excluded")}</Label>
          <Textarea
            id="excludeHandles"
            name="excludeHandles"
            rows={3}
            className="font-mono text-sm"
            defaultValue={experiment.excludeHandles}
          />
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <div className="space-y-2">
          <Label htmlFor="splitPctB">{t("Traffic ke B (%)", "Traffic to B (%)")}</Label>
          <Input
            id="splitPctB"
            name="splitPctB"
            type="number"
            min={5}
            max={95}
            defaultValue={experiment.splitPctB}
            disabled={locked}
            className="font-mono"
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="primaryMetric">Primary metric</Label>
          <Select name="primaryMetric" defaultValue={experiment.primaryMetric} disabled={locked}>
            <SelectTrigger id="primaryMetric">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="cvr">Conversion rate</SelectItem>
              <SelectItem value="atc_rate">Add-to-cart rate</SelectItem>
              <SelectItem value="rpv">Revenue per visitor</SelectItem>
              <SelectItem value="aov">Average order value</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <Label htmlFor="mdeRelative">MDE</Label>
          <Select name="mdeRelative" defaultValue={experiment.mdeRelative} disabled={locked}>
            <SelectTrigger id="mdeRelative">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="0.3">{t("30% relatif", "30% relative")}</SelectItem>
              <SelectItem value="0.2">{t("20% relatif", "20% relative")}</SelectItem>
              <SelectItem value="0.15">{t("15% relatif", "15% relative")}</SelectItem>
              <SelectItem value="0.1">{t("10% relatif", "10% relative")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <SubmitButton variant="secondary" pendingLabel={t("Menyimpan…", "Saving…")}>
        {t("Simpan perubahan", "Save changes")}
      </SubmitButton>
    </form>
  );
}
