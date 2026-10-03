"use client";

import { useState } from "react";
import { LayoutTemplate, ShoppingBag } from "lucide-react";
import { NewExperimentWizard } from "./new-experiment-wizard";
import { ComponentExperimentWizard } from "./component-experiment-wizard";
import { cn } from "@/lib/utils";
import { useT } from "@/components/lang-provider";

/**
 * Langkah nol: APA yang dites. Halaman (template alternatif, wizard lama) atau
 * komponen situs yang dirender di setiap halaman (cart drawer, …) — dua
 * mekanisme berbeda, jadi dua wizard terpisah.
 */
export function NewExperimentChooser() {
  const t = useT();
  const [kind, setKind] = useState<"template" | "component" | null>(null);

  if (kind === "template") return <NewExperimentWizard />;
  if (kind === "component") return <ComponentExperimentWizard />;

  const options = [
    {
      key: "template" as const,
      icon: LayoutTemplate,
      title: t("Halaman", "Page"),
      desc: t(
        "Desain halaman lain lewat template alternatif (mis. halaman produk v4).",
        "A different page design through an alternate template (e.g. product page v4).",
      ),
    },
    {
      key: "component" as const,
      icon: ShoppingBag,
      title: t("Komponen situs", "Site component"),
      desc: t(
        "Bagian yang muncul di semua halaman, seperti cart drawer.",
        "Something that appears on every page, like the cart drawer.",
      ),
    },
  ];

  return (
    <section className="grid gap-3 sm:grid-cols-2" aria-label={t("Jenis eksperimen", "Experiment type")}>
      {options.map(({ key, icon: Icon, title, desc }) => (
        <button
          key={key}
          type="button"
          onClick={() => setKind(key)}
          className={cn(
            "surface flex cursor-pointer items-start gap-3 rounded-2xl p-5 text-left transition-colors duration-200 hover:bg-muted/60",
          )}
        >
          <Icon className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
          <span className="space-y-1">
            <span className="block text-sm font-semibold">{title}</span>
            <span className="block text-sm text-muted-foreground">{desc}</span>
          </span>
        </button>
      ))}
    </section>
  );
}
