"use client";

import { useActionState } from "react";
import { AlertCircle, FlaskConical } from "lucide-react";
import { loginAction, type FormState } from "@/app/actions";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SubmitButton } from "@/components/submit-button";
import { useT } from "@/components/lang-provider";

const initial: FormState = {};

export default function LoginPage() {
  const [state, formAction] = useActionState(loginAction, initial);
  const t = useT();

  return (
    <main className="relative flex min-h-dvh items-center justify-center px-4">
      <div className="grid-backdrop pointer-events-none absolute inset-0" aria-hidden="true" />

      <div className="relative w-full max-w-sm">
        <div className="mb-8 flex items-center gap-2.5">
          <span className="flex size-9 items-center justify-center rounded-lg bg-primary/12 text-primary">
            <FlaskConical className="size-[18px]" />
          </span>
          <div>
            <div className="text-sm font-semibold leading-tight">Treelogy A/B</div>
            <div className="text-xs text-muted-foreground">{t("Kontrol eksperimen halaman produk", "Product page experiment control")}</div>
          </div>
        </div>

        <form action={formAction} className="space-y-4 surface rounded-2xl p-6">
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              required
              autoFocus
              placeholder={t("nama@treelogy.com", "name@treelogy.com")}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
            />
          </div>

          {state.error ? (
            <p
              role="alert"
              className="flex items-start gap-2 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              <AlertCircle className="mt-0.5 size-4 shrink-0" />
              {state.error}
            </p>
          ) : null}

          <SubmitButton className="w-full" pendingLabel={t("Memeriksa…", "Checking…")}>
            {t("Masuk", "Log in")}
          </SubmitButton>
        </form>

        <p className="mt-4 text-center text-xs text-muted-foreground">
          {t("Akun dibuat lewat", "Accounts are created with")}{" "}
          <code className="font-mono">npm run create-user</code>{" "}
          {t("di server.", "on the server.")}
        </p>
      </div>
    </main>
  );
}
