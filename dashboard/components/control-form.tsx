"use client";

import { useActionState, useEffect, useState } from "react";
import { toast } from "sonner";
import { controlExperimentAction, type FormState } from "@/app/actions";
import { SubmitButton } from "@/components/submit-button";
import { useT } from "@/components/lang-provider";
import type { ComponentProps } from "react";

const initial: FormState = {};

/**
 * Tombol aksi yang menyentuh storefront.
 *
 * Aksi merusak memakai konfirmasi dua-ketuk, bukan dialog: aksi seperti kill
 * switch mengubah apa yang dilihat pelanggan sungguhan seketika, jadi harus ada
 * jeda sadar — tapi dialog modal untuk satu tombol terasa berlebihan dan justru
 * jadi refleks di-klik tanpa dibaca.
 */
export function ControlForm({
  experimentId,
  action,
  label,
  confirmLabel,
  variant = "secondary",
  size,
  disabled,
  className,
}: {
  experimentId?: string;
  action:
    | "start"
    | "pause"
    | "complete"
    | "killswitch"
    | "republish"
    | "posthog.sync"
    | "posthog.recalculate"
    | "pixel.ensure"
    | "health.run";
  label: string;
  confirmLabel?: string;
  variant?: ComponentProps<typeof SubmitButton>["variant"];
  size?: ComponentProps<typeof SubmitButton>["size"];
  disabled?: boolean;
  className?: string;
}) {
  const [state, formAction] = useActionState(controlExperimentAction, initial);
  const [armed, setArmed] = useState(false);
  const t = useT();

  useEffect(() => {
    if (state.ok) toast.success(state.ok);
    if (state.error) toast.error(state.error, { duration: 10000 });
  }, [state]);

  // Batalkan konfirmasi kalau tidak jadi diklik dalam 5 detik.
  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), 5000);
    return () => clearTimeout(timer);
  }, [armed]);

  const needsConfirm = Boolean(confirmLabel);

  return (
    <form
      action={(formData: FormData) => {
        // Submit sudah berjalan di titik ini, jadi aman melucuti tombol.
        setArmed(false);
        formAction(formData);
      }}
      className={className}
    >
      <input type="hidden" name="id" value={experimentId ?? ""} />
      <input type="hidden" name="action" value={action} />
      <SubmitButton
        variant={armed ? "destructive" : variant}
        size={size}
        disabled={disabled}
        className="w-full"
        pendingLabel={t("Memproses…", "Working…")}
        // Ketukan pertama hanya mempersenjatai tombol; ketukan kedua mengirim form.
        // Tombolnya selalu type="submit". Jangan mengubah state di ketukan kedua:
        // React me-render ulang sebelum browser menjalankan submit, dan kalau
        // render itu mengubah tombol menjadi type="button", form tidak pernah
        // terkirim. Tombol dilucuti di action form, setelah submit berjalan.
        onClick={(event: React.MouseEvent) => {
          if (needsConfirm && !armed) {
            event.preventDefault();
            setArmed(true);
          }
        }}
      >
        {armed ? confirmLabel : label}
      </SubmitButton>
    </form>
  );
}
