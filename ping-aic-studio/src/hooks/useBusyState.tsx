"use client";

import { createContext, useContext, useState, useCallback, ReactNode } from "react";

interface BusyState {
  busy: boolean;
  setBusy: (value: boolean) => void;
  /** True when the user has in-progress work that would be lost on navigation. */
  dirty: boolean;
  setDirty: (value: boolean) => void;
}

const BusyContext = createContext<BusyState>({ busy: false, setBusy: () => {}, dirty: false, setDirty: () => {} });

export function BusyProvider({ children }: { children: ReactNode }) {
  const [busy, setRaw] = useState(false);
  const [dirty, setDirtyRaw] = useState(false);
  const setBusy = useCallback((value: boolean) => setRaw(value), []);
  const setDirty = useCallback((value: boolean) => setDirtyRaw(value), []);
  return (
    <BusyContext.Provider value={{ busy, setBusy, dirty, setDirty }}>
      {children}
    </BusyContext.Provider>
  );
}

export function useBusyState() {
  return useContext(BusyContext);
}
