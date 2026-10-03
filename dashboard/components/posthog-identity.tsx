"use client";

import { useEffect } from "react";
import posthog from "posthog-js";

interface PostHogIdentityProps {
  user: {
    id: string;
    email: string;
    name: string | null;
    role: string;
  };
}

export function PostHogIdentity({ user }: PostHogIdentityProps) {
  useEffect(() => {
    posthog.identify(user.id, {
      email: user.email,
      name: user.name,
      role: user.role,
    });
  }, [user.email, user.id, user.name, user.role]);

  return null;
}
