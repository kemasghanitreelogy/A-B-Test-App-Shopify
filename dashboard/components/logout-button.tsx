"use client";

import { LogOut } from "lucide-react";
import posthog from "posthog-js";
import { logoutAction } from "@/app/actions";
import { Button } from "@/components/ui/button";
import { useT } from "@/components/lang-provider";

export function LogoutButton() {
  const t = useT();
  return (
    <form
      action={logoutAction}
      onSubmit={() => {
        posthog.capture("user_logged_out");
        posthog.reset();
      }}
    >
      <Button variant="ghost" size="icon" type="submit" aria-label={t("Keluar", "Log out")}>
        <LogOut className="size-4" />
      </Button>
    </form>
  );
}
