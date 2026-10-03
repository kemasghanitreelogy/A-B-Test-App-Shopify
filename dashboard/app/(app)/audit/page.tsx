import Link from "next/link";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { fmtDate } from "@/lib/format";
import { getLang } from "@/lib/i18n.server";
import { intlLocale, pick, tr, type Bi } from "@/lib/i18n";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const ACTION_LABEL: Record<string, Bi> = {
  "experiment.create": { id: "Membuat eksperimen", en: "Created experiment" },
  "experiment.update": { id: "Mengubah pengaturan", en: "Changed settings" },
  "experiment.start": { id: "Menjalankan", en: "Started" },
  "experiment.pause": { id: "Menjeda", en: "Paused" },
  "experiment.complete": { id: "Menutup", en: "Completed" },
  killswitch: { id: "Kill switch", en: "Kill switch" },
  republish: { id: "Menerbitkan ulang config", en: "Republished config" },
};

export default async function AuditPage() {
  await requireUser();
  const lang = await getLang();
  const t = tr(lang);

  const [logs, experiments] = await Promise.all([
    db.auditLog.findMany({ orderBy: { createdAt: "desc" }, take: 200 }),
    db.experiment.findMany({ select: { id: true, name: true } }),
  ]);
  const names = new Map(experiments.map((e) => [e.id, e.name]));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Audit</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t(
            "Setiap aksi yang mengubah apa yang dilihat pelanggan tercatat di sini. Tanpa catatan ini, \u201ckenapa test ini berhenti hari Selasa\u201d tidak akan pernah bisa dijawab.",
            "Every action that changes what customers see is logged here. Without this log, \u201cwhy did this test stop on Tuesday?\u201d could never be answered.",
          )}
        </p>
      </div>

      {logs.length === 0 ? (
        <div className="rounded-xl border border-dashed p-12 text-center text-sm text-muted-foreground">
          {t("Belum ada aktivitas.", "No activity yet.")}
        </div>
      ) : (
        <div className="overflow-x-auto surface rounded-2xl">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-40">{t("Waktu", "Time")}</TableHead>
                <TableHead className="w-56">{t("Oleh", "By")}</TableHead>
                <TableHead className="w-48">{t("Aksi", "Action")}</TableHead>
                <TableHead>{t("Eksperimen", "Experiment")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {logs.map((log) => (
                <TableRow key={String(log.id)}>
                  <TableCell className="whitespace-nowrap font-mono text-xs text-muted-foreground">
                    {fmtDate(log.createdAt, lang)}{" "}
                    {new Intl.DateTimeFormat(intlLocale(lang), { timeStyle: "short" }).format(log.createdAt)}
                  </TableCell>
                  <TableCell className="truncate text-sm">{log.actorEmail}</TableCell>
                  <TableCell className="text-sm">{ACTION_LABEL[log.action] ? pick(lang, ACTION_LABEL[log.action]) : log.action}</TableCell>
                  <TableCell className="text-sm">
                    {log.experimentId ? (
                      <Link
                        href={`/experiments/${log.experimentId}`}
                        className="text-primary underline-offset-4 hover:underline"
                      >
                        {names.get(log.experimentId) ?? log.experimentId}
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                    {log.detail ? (
                      <span className="ml-2 text-xs text-muted-foreground">{log.detail}</span>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
