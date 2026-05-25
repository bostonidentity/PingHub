"use client";

import { useEffect, useState } from "react";

/**
 * useState-like hook that persists the value to localStorage under the given
 * key. The first read happens on mount (SSR-safe); writes happen on every
 * change after the initial load. Strict-mode safe — the saved value is not
 * clobbered by the initial render.
 */
export function usePersistentState<T>(
    key: string,
    initial: T,
): [T, (next: T | ((prev: T) => T)) => void] {
    const [value, setValue] = useState<T>(initial);
    // Gate writes on a state flag (not a ref). With a ref, React strict mode's
    // double-invoked effects can write the initial value back to storage
    // *before* the loaded value is committed, clobbering it. A state flag
    // means the write effect only runs once React has actually re-rendered
    // with `loaded=true`.
    const [loaded, setLoaded] = useState(false);

    useEffect(() => {
        if (typeof window === "undefined") return;
        try {
            const raw = window.localStorage.getItem(key);
            if (raw !== null) {
                setValue(JSON.parse(raw) as T);
            }
        } catch {
            // ignore corrupt entries
        }
        setLoaded(true);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key]);

    useEffect(() => {
        if (!loaded) return;
        if (typeof window === "undefined") return;
        try {
            window.localStorage.setItem(key, JSON.stringify(value));
        } catch {
            // quota / privacy mode — ignore
        }
    }, [key, value, loaded]);

    return [value, setValue];
}
