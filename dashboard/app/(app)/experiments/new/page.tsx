import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { requireAdmin } from "@/lib/session";
import { NewExperimentChooser } from "@/components/wizard/new-experiment-chooser";
import { tr } from "@/lib/i18n";
import { getLang } from "@/lib/i18n.server";

export default async function NewExperimentPage() {
  await requireAdmin();
  const t = tr(await getLang());

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <Link
        href="/"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors duration-200 hover:text-foreground"
      >
        <ChevronLeft className="size-4" />
        {t("Eksperimen", "Experiments")}
      </Link>

      <div>
        <h1 className="text-xl font-semibold tracking-tight">{t("Eksperimen baru", "New experiment")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t(
            "Pilih halaman, lihat tampilannya, periksa apa saja yang dilacak — baru jalankan test. Sampai langkah terakhir, tidak ada yang berubah di toko.",
            "Pick a page, preview it, check what's being tracked — then run the test. Nothing changes in the store until the last step.",
          )}
        </p>
      </div>

      <NewExperimentChooser />
    </div>
  );
}
