"use client";

import { useCallback, useEffect, useState } from "react";
import { GitSettings } from "@/lib/git-settings";
import { useDialog } from "@/components/ConfirmDialog";
import { cn } from "@/lib/utils";

interface Props {
  initialSettings: GitSettings;
  targetDirAbsolute: string;
  initialHasGit: boolean;
}

interface Commit {
  hash: string;
  shortHash: string;
  authorName: string;
  authorEmail: string;
  timestamp: number;
  subject: string;
}

interface DirtyFile {
  path: string;
  status: string;
  label: string;
}

interface UnpushedCommit {
  hash: string;
  subject: string;
  date: string;
  author: string;
}

interface StatusInfo {
  initialized: boolean;
  targetDir?: string;
  branch?: string | null;
  remote?: string | null;
  dirtyCount?: number;
  dirtyFiles?: DirtyFile[];
  ahead?: number;
  behind?: number;
  unpushedCommits?: UnpushedCommit[];
  message?: string;
}

export function SettingsForm({ initialSettings, targetDirAbsolute, initialHasGit }: Props) {
  const { confirm, prompt } = useDialog();
  const [settings, setSettings] = useState<GitSettings>(initialSettings);
  const [savedSettings, setSavedSettings] = useState<GitSettings>(initialSettings);
  const [hasGit, setHasGit] = useState(initialHasGit);
  const [targetAbs, setTargetAbs] = useState(targetDirAbsolute);

  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [busy, setBusy] = useState<"init" | "push" | "pull" | "status" | "commit" | null>(null);

  const [toast, setToast] = useState<{
    kind: "ok" | "err";
    text: string;
    steps?: { cmd: string; ok: boolean; out: string }[];
  } | null>(null);
  const [status, setStatus] = useState<StatusInfo | null>(null);

  const [commits, setCommits] = useState<Commit[]>([]);
  const [commitsLoading, setCommitsLoading] = useState(false);
  const [commitsHasMore, setCommitsHasMore] = useState(false);
  const [commitsError, setCommitsError] = useState<string | null>(null);
  const COMMITS_PAGE_SIZE = 25;

  const dirty = JSON.stringify(settings) !== JSON.stringify(savedSettings);

  const update = <K extends keyof GitSettings>(key: K, value: GitSettings[K]) =>
    setSettings((prev) => ({ ...prev, [key]: value }));

  const flash = (
    kind: "ok" | "err",
    text: string,
    steps?: { cmd: string; ok: boolean; out: string }[],
  ) => {
    setToast({ kind, text, steps });
    // Persist error toasts (with details) until the next action; auto-clear successes.
    if (kind === "ok") setTimeout(() => setToast(null), 4000);
  };

  async function handleSave() {
    setSaving(true);
    try {
      const res = await fetch("/api/git/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Save failed");
      setSettings(data.settings);
      setSavedSettings(data.settings);
      flash("ok", "Settings saved.");
      await refreshStatus();
    } catch (e) {
      flash("err", (e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function handleTest() {
    setTesting(true);
    try {
      const res = await fetch("/api/git/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ remoteUrl: settings.remoteUrl }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error ?? "Connection failed");
      flash("ok", `Connected. ${data.branches?.length ?? 0} branch(es) on remote.`);
    } catch (e) {
      flash("err", (e as Error).message);
    } finally {
      setTesting(false);
    }
  }

  async function refreshStatus() {
    setBusy("status");
    try {
      const res = await fetch("/api/git/status");
      const data = await res.json();
      setStatus(data);
      setHasGit(Boolean(data.initialized));
      if (data.targetDir) setTargetAbs(data.targetDir);
    } finally {
      setBusy(null);
    }
  }

  async function handleCommit() {
    const message = await prompt({
      title: "Commit changes",
      message: "Enter a commit message:",
      defaultValue: "Manual snapshot from Settings",
      confirmLabel: "Commit",
    });
    if (message === null) return;
    setBusy("commit");
    try {
      const res = await fetch("/api/git/commit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error ?? "Commit failed");
      flash("ok", `Committed ${data.hash ?? ""}`.trim());
      await refreshStatus();
      await loadCommits(0, true);
    } catch (e) {
      flash("err", (e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function handleAction(action: "init" | "push" | "pull") {
    setBusy(action);
    try {
      let res = await fetch(`/api/git/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      let data = await res.json();

      if (data.needsConfirm && data.preflight?.message) {
        const proceed = await confirm({
          title: `Confirm ${action}`,
          message: data.preflight.message,
          confirmLabel: "Proceed",
          variant: "warning",
        });
        if (!proceed) {
          flash("err", `${action} canceled.`);
          return;
        }
        res = await fetch(`/api/git/${action}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ confirm: true }),
        });
        data = await res.json();
      }

      if (!data.ok) {
        const msg = data.error ?? data.stderr ?? `${action} failed`;
        flash("err", msg, Array.isArray(data.steps) ? data.steps : undefined);
        return;
      }
      flash("ok", `${action} succeeded.`);
      await refreshStatus();
      await loadCommits(0, true);
    } catch (e) {
      flash("err", (e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const loadCommits = useCallback(
    async (skip: number, replace: boolean) => {
      setCommitsLoading(true);
      setCommitsError(null);
      try {
        const res = await fetch(`/api/git/log?limit=${COMMITS_PAGE_SIZE}&skip=${skip}`);
        const data = await res.json();
        if (!data.ok) throw new Error(data.error ?? "Failed to load commits");
        setCommits((prev) => (replace ? data.commits : [...prev, ...data.commits]));
        setCommitsHasMore(Boolean(data.hasMore));
      } catch (e) {
        setCommitsError((e as Error).message);
      } finally {
        setCommitsLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    // History card is collapsed by default; only reset when the repo goes away.
    if (!hasGit) {
      setCommits([]);
      setCommitsHasMore(false);
    }
  }, [hasGit]);

  // Load status badges (branch, ahead/behind, dirty count) on first mount.
  useEffect(() => {
    if (initialHasGit) void refreshStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-6 items-start">
      {/* LEFT RAIL — connection settings */}
      <section className="card-padded space-y-4 lg:sticky lg:top-4">
        <div>
          <h2 className="text-sm font-semibold text-slate-900">Connection</h2>
          <p className="text-xs text-slate-500 mt-1">
            Configs under <code className="bg-slate-100 px-1 rounded">{settings.targetDir}</code> commit
            here. Auth uses your local git credential helper / SSH agent.
          </p>
        </div>

        <Field label="Remote URL" description="SSH or HTTPS URL of the git remote.">
          <input
            type="text"
            value={settings.remoteUrl}
            onChange={(e) => update("remoteUrl", e.target.value)}
            placeholder="git@github.com:org/repo.git"
            className={inputCls}
          />
        </Field>

        <div className="grid grid-cols-2 gap-4">
          <Field label="Branch">
            <input
              type="text"
              value={settings.branch}
              onChange={(e) => update("branch", e.target.value)}
              className={inputCls}
            />
          </Field>
          <Field
            label="Target directory"
            description="Relative to project root, or absolute."
          >
            <input
              type="text"
              value={settings.targetDir}
              onChange={(e) => update("targetDir", e.target.value)}
              className={inputCls}
            />
          </Field>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <Field label="Author name">
            <input
              type="text"
              value={settings.authorName}
              onChange={(e) => update("authorName", e.target.value)}
              className={inputCls}
            />
          </Field>
          <Field label="Author email">
            <input
              type="email"
              value={settings.authorEmail}
              onChange={(e) => update("authorEmail", e.target.value)}
              className={inputCls}
            />
          </Field>
        </div>

        <Field
          label="Commit message template"
          description="Tokens: {op}, {tenant}, {scopes}, {timestamp}."
        >
          <input
            type="text"
            value={settings.commitTemplate}
            onChange={(e) => update("commitTemplate", e.target.value)}
            className={inputCls}
          />
        </Field>

        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={settings.autoPush}
            onChange={(e) => update("autoPush", e.target.checked)}
          />
          Automatically push after each commit
        </label>

        <div className="flex items-center gap-2 pt-2 border-t border-slate-100">
          <button type="button" onClick={handleSave} disabled={saving} className={btnPrimary}>
            {saving ? "Saving…" : "Save settings"}
          </button>
          <button
            type="button"
            onClick={handleTest}
            disabled={testing || !settings.remoteUrl}
            className={btnSecondary}
          >
            {testing ? "Testing…" : "Test connection"}
          </button>
          {dirty && <span className="text-xs text-amber-600">Unsaved changes</span>}
        </div>
      </section>

      {/* RIGHT RAIL — activity (status, working tree, history) */}
      <div className="space-y-6 min-w-0">
        {/* Action bar + status header */}
        <section className="card-padded space-y-4">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-slate-900">Repository</h2>
              <p className="text-xs text-slate-500 mt-1 font-mono break-all">{targetAbs}</p>
            </div>
            <button
              type="button"
              onClick={refreshStatus}
              disabled={busy === "status"}
              className={btnSecondary}
            >
              {busy === "status" ? "Refreshing…" : "Refresh"}
            </button>
          </div>

          {hasGit && (
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => handleAction("pull")}
                disabled={busy !== null}
                className={btnSecondary}
              >
                {busy === "pull" ? "Pulling…" : "Pull"}
              </button>
              <button
                type="button"
                onClick={handleCommit}
                disabled={busy !== null || (status?.dirtyCount ?? 0) === 0}
                className={btnSecondary}
              >
                {busy === "commit" ? "Committing…" : "Commit all"}
              </button>
              <button
                type="button"
                onClick={() => handleAction("push")}
                disabled={busy !== null}
                className={btnPrimary}
              >
                {busy === "push" ? "Pushing…" : "Push"}
              </button>

              {/* compact status badges */}
              <div className="ml-auto flex items-center gap-2 text-[11px]">
                {status?.branch && (
                  <span className="px-2 py-0.5 rounded-full bg-slate-100 text-slate-700 font-mono">
                    {status.branch}
                  </span>
                )}
                {(status?.ahead ?? 0) > 0 && (
                  <span className="px-2 py-0.5 rounded-full bg-sky-50 text-sky-700">
                    ↑ {status?.ahead} ahead
                  </span>
                )}
                {(status?.behind ?? 0) > 0 && (
                  <span className="px-2 py-0.5 rounded-full bg-amber-50 text-amber-700">
                    ↓ {status?.behind} behind
                  </span>
                )}
                {(status?.dirtyCount ?? 0) > 0 && (
                  <span className="px-2 py-0.5 rounded-full bg-orange-50 text-orange-700">
                    {status?.dirtyCount} dirty
                  </span>
                )}
                {status &&
                  (status.ahead ?? 0) === 0 &&
                  (status.behind ?? 0) === 0 &&
                  (status.dirtyCount ?? 0) === 0 && (
                    <span className="px-2 py-0.5 rounded-full bg-green-50 text-green-700">
                      ✓ clean
                    </span>
                  )}
              </div>
            </div>
          )}

          {!hasGit ? (
            <div className="rounded border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 space-y-2">
              <p>
                Target directory is not a git repository yet. Save your remote URL on the left, then
                initialize.
              </p>
              <button
                type="button"
                onClick={() => handleAction("init")}
                disabled={busy !== null || dirty || !savedSettings.remoteUrl}
                className={btnPrimary}
              >
                {busy === "init" ? "Initializing…" : "Initialize repository"}
              </button>
            </div>
          ) : status ? (
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
              <dt className="text-slate-500">Remote</dt>
              <dd className="text-slate-900 font-mono break-all">{status.remote ?? "—"}</dd>
              <dt className="text-slate-500">Ahead / behind</dt>
              <dd className="text-slate-900 font-mono">
                {status.ahead ?? 0} / {status.behind ?? 0}
              </dd>
              <dt className="text-slate-500">Uncommitted</dt>
              <dd className="text-slate-900 font-mono">{status.dirtyCount ?? 0} file(s)</dd>
            </dl>
          ) : (
            <p className="text-xs text-slate-500">Click Refresh to load status.</p>
          )}

          {/* Toast / error panel — sits next to the buttons that triggered it */}
          {toast && (
            <div
              className={cn(
                "rounded border px-3 py-2 text-sm space-y-2",
                toast.kind === "ok"
                  ? "border-green-200 bg-green-50 text-green-800"
                  : "border-red-200 bg-red-50 text-red-800",
              )}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="whitespace-pre-wrap break-words">{toast.text}</div>
                {toast.kind === "err" && (
                  <button
                    type="button"
                    onClick={() => setToast(null)}
                    className="text-xs text-red-700 underline shrink-0"
                  >
                    Dismiss
                  </button>
                )}
              </div>
              {toast.steps && toast.steps.length > 0 && (
                <details className="text-xs">
                  <summary className="cursor-pointer select-none">
                    Show details ({toast.steps.length} step
                    {toast.steps.length === 1 ? "" : "s"})
                  </summary>
                  <ol className="mt-2 space-y-1 font-mono">
                    {toast.steps.map((s, i) => (
                      <li key={i} className="rounded bg-white/60 border border-red-100 p-2">
                        <div className="flex items-center gap-2">
                          <span className={s.ok ? "text-green-700" : "text-red-700"}>
                            {s.ok ? "\u2713" : "\u2717"}
                          </span>
                          <span className="text-slate-700 break-all">{s.cmd}</span>
                        </div>
                        {s.out && (
                          <pre className="mt-1 whitespace-pre-wrap break-words text-slate-600">
                            {s.out}
                          </pre>
                        )}
                      </li>
                    ))}
                  </ol>
                </details>
              )}
            </div>
          )}
        </section>

        {/* Working tree (collapsible) */}
        {hasGit && status && (status.dirtyFiles?.length || status.unpushedCommits?.length) ? (
          <section className="card-padded space-y-3">
            <details open>
              <summary className="text-sm font-semibold text-slate-900 cursor-pointer select-none">
                Working tree changes
                <span className="ml-2 text-xs font-normal text-slate-500">
                  {status.dirtyCount ?? 0} dirty · {status.unpushedCommits?.length ?? 0} unpushed
                </span>
              </summary>

              {status.dirtyFiles && status.dirtyFiles.length > 0 && (
                <div className="mt-3 border border-slate-100 rounded max-h-64 overflow-auto">
                  <ul className="divide-y divide-slate-100">
                    {status.dirtyFiles.map((f) => (
                      <li
                        key={f.path}
                        className="flex items-center gap-2 px-3 py-1.5 text-xs font-mono"
                      >
                        <span
                          className={cn(
                            "inline-block w-20 shrink-0 text-[10px] uppercase tracking-wide font-sans font-medium",
                            dirtyColor(f.label),
                          )}
                        >
                          {f.label}
                        </span>
                        <span className="text-slate-700 truncate" title={f.path}>
                          {f.path}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {status.unpushedCommits && status.unpushedCommits.length > 0 && (
                <div className="mt-3 space-y-1.5">
                  <p className="text-xs font-medium text-slate-600">
                    Unpushed commits ({status.unpushedCommits.length})
                  </p>
                  <div className="border border-slate-100 rounded max-h-64 overflow-auto">
                    <ul className="divide-y divide-slate-100">
                      {status.unpushedCommits.map((c) => (
                        <li key={c.hash} className="flex items-center gap-2 px-3 py-1.5 text-xs">
                          <span className="font-mono text-sky-600 shrink-0">{c.hash}</span>
                          <span
                            className="text-slate-700 truncate flex-1"
                            title={c.subject}
                          >
                            {c.subject}
                          </span>
                          <span className="text-slate-400 shrink-0 text-[10px]">
                            {c.date.slice(0, 10)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              )}
            </details>
          </section>
        ) : null}

        {/* Commit history (collapsed by default) */}
        {hasGit && (
          <section className="card-padded space-y-3">
            <details>
              <summary className="flex items-center justify-between gap-3 cursor-pointer select-none">
                <div>
                  <h2 className="text-sm font-semibold text-slate-900 inline">Commit history</h2>
                  <span className="ml-2 text-xs text-slate-500">
                    {commits.length === 0
                      ? "click to load"
                      : `${commits.length} loaded${commitsHasMore ? "+" : ""}`}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    void loadCommits(0, true);
                  }}
                  disabled={commitsLoading}
                  className={btnSecondary}
                >
                  {commitsLoading && commits.length === 0 ? "Loading…" : "Refresh"}
                </button>
              </summary>

              <div className="mt-3 space-y-3">
                {commitsError && (
                  <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
                    {commitsError}
                  </div>
                )}

                {commits.length === 0 && !commitsLoading && !commitsError ? (
                  <p className="text-xs text-slate-500">No commits loaded.</p>
                ) : (
                  <ul className="divide-y divide-slate-100 border border-slate-100 rounded max-h-[28rem] overflow-auto">
                    {commits.map((c) => (
                      <li key={c.hash} className="px-3 py-2 text-xs">
                        <div className="flex items-baseline gap-2">
                          <code className="text-slate-500">{c.shortHash}</code>
                          <span className="text-slate-900 font-medium truncate">{c.subject}</span>
                        </div>
                        <div className="text-[11px] text-slate-500 mt-0.5">
                          {c.authorName} · {new Date(c.timestamp).toLocaleString()}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}

                {commitsHasMore && (
                  <button
                    type="button"
                    onClick={() => loadCommits(commits.length, false)}
                    disabled={commitsLoading}
                    className={btnSecondary}
                  >
                    {commitsLoading ? "Loading…" : "Load more"}
                  </button>
                )}
              </div>
            </details>
          </section>
        )}
      </div>
    </div>
  );
}

function Field({
  label,
  description,
  children,
}: {
  label: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="label-xs mb-1 block">{label}</label>
      {children}
      {description && <p className="text-[11px] text-slate-500 mt-1">{description}</p>}
    </div>
  );
}

function dirtyColor(label: string): string {
  switch (label) {
    case "added":
    case "untracked":
      return "text-green-600";
    case "modified":
      return "text-amber-600";
    case "deleted":
      return "text-red-600";
    case "renamed":
    case "copied":
      return "text-blue-600";
    case "conflict":
      return "text-red-700";
    default:
      return "text-slate-500";
  }
}

const inputCls =
  "w-full px-3 py-2.5 rounded-lg border border-slate-200 text-[13px] outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 bg-white text-slate-900";

const btnPrimary =
  "btn-primary disabled:cursor-not-allowed disabled:opacity-50";

const btnSecondary =
  "btn-secondary disabled:cursor-not-allowed disabled:opacity-50";
