import Link from "next/link";
import { FlaskConical, ShoppingBag, ScrollText } from "lucide-react";
import { requireUser } from "@/lib/session";
import { ThemeToggle } from "@/components/theme-toggle";
import { PostHogIdentity } from "@/components/posthog-identity";
import { LogoutButton } from "@/components/logout-button";
import { LangToggle } from "@/components/lang-toggle";
import { getLang } from "@/lib/i18n.server";
import { tr } from "@/lib/i18n";

export default async function AppLayout({ children }: LayoutProps<"/">) {
  const user = await requireUser();
  const t = tr(await getLang());

  return (
    <div className="flex min-h-dvh flex-col">
      <PostHogIdentity user={user} />
      {/* Bar navigasi mengambang: terpisah dari tepi layar dan tembus pandang,
          supaya konten yang lewat di belakangnya terlihat samar — halaman terasa
          punya kedalaman, bukan ditumpuk kotak. */}
      <header className="sticky top-3 z-20 px-3 sm:px-4">
        <div className="surface mx-auto flex h-14 max-w-[1400px] items-center gap-6 rounded-2xl bg-background/70! px-4 backdrop-blur-xl sm:px-5">
          <Link href="/" className="flex items-center gap-2.5">
            <span
              className="flex size-8 items-center justify-center rounded-lg text-primary-foreground"
              style={{
                background: "linear-gradient(135deg, var(--primary), color-mix(in oklab, var(--primary) 55%, var(--variant-b)))",
                boxShadow: "0 0 18px color-mix(in oklab, var(--primary) 45%, transparent)",
              }}
            >
              <FlaskConical className="size-4" />
            </span>
            <span className="text-sm font-semibold tracking-tight">Treelogy A/B</span>
          </Link>

          <nav className="flex items-center gap-1 text-sm">
            <Link
              href="/"
              className="rounded-md px-2.5 py-1.5 text-muted-foreground transition-colors duration-200 hover:bg-accent hover:text-foreground"
            >
              {t("Eksperimen", "Experiments")}
            </Link>
            <Link
              href="/drawer"
              className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-muted-foreground transition-colors duration-200 hover:bg-accent hover:text-foreground"
            >
              <ShoppingBag className="size-3.5" />
              Cart drawer
            </Link>
            <Link
              href="/audit"
              className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-muted-foreground transition-colors duration-200 hover:bg-accent hover:text-foreground"
            >
              <ScrollText className="size-3.5" />
              Audit
            </Link>
          </nav>

          <div className="ml-auto flex items-center gap-2">
            <span className="hidden text-xs text-muted-foreground sm:inline">
              {user.name || user.email}
              {user.role !== "admin" ? ` · ${user.role}` : ""}
            </span>
            <LangToggle />
            <ThemeToggle />
            <LogoutButton />
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[1400px] flex-1 px-4 py-8 sm:px-6 sm:py-10">{children}</main>
    </div>
  );
}
