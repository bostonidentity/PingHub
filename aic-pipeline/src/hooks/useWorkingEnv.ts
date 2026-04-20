"use client";
import { useEffect, useState } from "react";

const KEY = "aic:workingEnv";

export function useWorkingEnv() {
  const [env, setEnv] = useState<string | null>(null);
  useEffect(() => {
    setEnv(localStorage.getItem(KEY));
    const onStorage = (e: StorageEvent) => {
      if (e.key === KEY) setEnv(e.newValue);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
  const update = (name: string | null) => {
    if (name) localStorage.setItem(KEY, name);
    else localStorage.removeItem(KEY);
    setEnv(name);
  };
  return [env, update] as const;
}
