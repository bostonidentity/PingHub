"use client";

import { useEffect, useRef, useState } from "react";
import type { SnapshotRecordPage } from "@/lib/data/types";

export function useSnapshotRecords(env: string, type: string | null, titleField?: string) {
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [limit] = useState(50);
  const [data, setData] = useState<SnapshotRecordPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!type) { setData(null); return; }
    let cancelled = false;

    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(async () => {
      if (cancelled) return;
      setLoading(true);
      try {
        const params = new URLSearchParams({ q, page: String(page), limit: String(limit) });
        if (titleField) params.set("titleField", titleField);
        const res = await fetch(`/api/data/records/${env}/${type}?${params.toString()}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        if (!cancelled) {
          setData(json);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 200);

    return () => {
      cancelled = true;
      if (debounce.current) clearTimeout(debounce.current);
    };
  }, [env, type, q, page, limit, titleField]);

  return { q, setQ, page, setPage, limit, data, loading, error };
}
