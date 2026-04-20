"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { createContext, useCallback, useContext, useState } from "react";
import { AlertTriangle, Info, X } from "lucide-react";
import { cn } from "@/lib/utils";

type Variant = "info" | "warning" | "danger";

interface ConfirmOptions {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: Variant;
}

interface PromptOptions {
  title: string;
  message?: string;
  defaultValue?: string;
  placeholder?: string;
  confirmLabel?: string;
  cancelLabel?: string;
}

interface AlertOptions {
  title: string;
  message?: string;
  confirmLabel?: string;
  variant?: Variant;
}

interface DialogContextValue {
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
  prompt: (opts: PromptOptions) => Promise<string | null>;
  alert: (opts: AlertOptions) => Promise<void>;
}

const DialogContext = createContext<DialogContextValue | null>(null);

type State =
  | { kind: "confirm"; opts: ConfirmOptions; resolve: (v: boolean) => void }
  | { kind: "prompt"; opts: PromptOptions; resolve: (v: string | null) => void }
  | { kind: "alert"; opts: AlertOptions; resolve: () => void }
  | null;

function variantStyles(variant: Variant = "info") {
  switch (variant) {
    case "danger":
      return {
        icon: <AlertTriangle className="w-5 h-5" />,
        iconBg: "bg-rose-50 text-rose-600",
        confirmBtn: "bg-rose-600 hover:bg-rose-700 text-white",
      };
    case "warning":
      return {
        icon: <AlertTriangle className="w-5 h-5" />,
        iconBg: "bg-amber-50 text-amber-600",
        confirmBtn: "bg-amber-600 hover:bg-amber-700 text-white",
      };
    default:
      return {
        icon: <Info className="w-5 h-5" />,
        iconBg: "bg-sky-50 text-sky-600",
        confirmBtn: "bg-sky-600 hover:bg-sky-700 text-white",
      };
  }
}

export function DialogProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<State>(null);
  const [promptValue, setPromptValue] = useState("");

  const close = useCallback(() => setState(null), []);

  const confirm = useCallback(
    (opts: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        setState({ kind: "confirm", opts, resolve });
      }),
    [],
  );

  const prompt = useCallback(
    (opts: PromptOptions) =>
      new Promise<string | null>((resolve) => {
        setPromptValue(opts.defaultValue ?? "");
        setState({ kind: "prompt", opts, resolve });
      }),
    [],
  );

  const alert = useCallback(
    (opts: AlertOptions) =>
      new Promise<void>((resolve) => {
        setState({ kind: "alert", opts, resolve });
      }),
    [],
  );

  const handleCancel = () => {
    if (!state) return;
    if (state.kind === "confirm") state.resolve(false);
    else if (state.kind === "prompt") state.resolve(null);
    else state.resolve();
    close();
  };

  const handleConfirm = () => {
    if (!state) return;
    if (state.kind === "confirm") state.resolve(true);
    else if (state.kind === "prompt") state.resolve(promptValue);
    else state.resolve();
    close();
  };

  const open = state !== null;
  const opts = state?.opts;
  const variant =
    state?.kind === "confirm" || state?.kind === "alert"
      ? (state.opts as ConfirmOptions | AlertOptions).variant ?? "info"
      : "info";
  const vs = variantStyles(variant);

  return (
    <DialogContext.Provider value={{ confirm, prompt, alert }}>
      {children}
      <Dialog.Root open={open} onOpenChange={(v) => { if (!v) handleCancel(); }}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 bg-slate-900/55 backdrop-blur-sm z-[100] data-[state=open]:animate-in data-[state=open]:fade-in" />
          <Dialog.Content
            className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-[100] w-[min(460px,calc(100vw-32px))] bg-white rounded-2xl shadow-2xl overflow-hidden"
            onOpenAutoFocus={(e) => {
              if (state?.kind !== "prompt") e.preventDefault();
            }}
          >
            {opts && (
              <>
                <div className="flex items-start gap-4 p-5 border-b border-slate-100">
                  <div className={cn("w-10 h-10 rounded-lg flex items-center justify-center shrink-0", vs.iconBg)}>
                    {vs.icon}
                  </div>
                  <div className="flex-1 min-w-0">
                    <Dialog.Title className="text-[15px] font-semibold text-slate-900">
                      {opts.title}
                    </Dialog.Title>
                    {opts.message && (
                      <Dialog.Description className="text-[13px] text-slate-500 mt-1 whitespace-pre-wrap break-words">
                        {opts.message}
                      </Dialog.Description>
                    )}
                  </div>
                  <button
                    onClick={handleCancel}
                    aria-label="close"
                    className="text-slate-400 hover:text-slate-600 shrink-0"
                  >
                    <X className="w-5 h-5" />
                  </button>
                </div>

                {state?.kind === "prompt" && (
                  <div className="px-5 pt-4">
                    <input
                      autoFocus
                      value={promptValue}
                      onChange={(e) => setPromptValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") handleConfirm();
                        else if (e.key === "Escape") handleCancel();
                      }}
                      placeholder={state.opts.placeholder}
                      className="w-full px-3 py-2 rounded-lg border border-slate-300 text-[13px] text-slate-900 outline-none focus:border-sky-500 focus:ring-1 focus:ring-sky-500"
                    />
                  </div>
                )}

                <div className="flex items-center justify-end gap-2 px-5 py-4 bg-slate-50 border-t border-slate-100">
                  {state && state.kind !== "alert" && (
                    <button
                      type="button"
                      onClick={handleCancel}
                      className="px-3 py-1.5 text-[13px] font-medium rounded-lg border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 transition-colors"
                    >
                      {state.opts.cancelLabel ?? "Cancel"}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={handleConfirm}
                    className={cn(
                      "px-3 py-1.5 text-[13px] font-medium rounded-lg transition-colors",
                      vs.confirmBtn,
                    )}
                  >
                    {opts.confirmLabel ?? "OK"}
                  </button>
                </div>
              </>
            )}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </DialogContext.Provider>
  );
}

export function useDialog(): DialogContextValue {
  const ctx = useContext(DialogContext);
  if (!ctx) throw new Error("useDialog must be used inside <DialogProvider>");
  return ctx;
}
