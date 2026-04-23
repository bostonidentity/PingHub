"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { Environment, EnvironmentType } from "@/lib/fr-config-types";
import { EnvironmentBadge } from "@/components/EnvironmentBadge";
import { EnvEditor, type EnvEditorHandle, type EnvSaveState, type EnvMeta } from "./EnvEditor";
import { cn } from "@/lib/utils";
import { ServiceAccountScopeSelector } from "@/components/ServiceAccountScopeSelector";
import { StatusPill } from "@/components/ui/StatusPill";
import { useDialog } from "@/components/ConfirmDialog";
import type { ReleaseCacheEntry } from "@/lib/release/types";
import { classifyUpgrade, daysUntil } from "@/lib/release/urgency";

const COLOR_OPTIONS: { value: Environment["color"]; label: string }[] = [
  { value: "green",  label: "Green" },
  { value: "blue",   label: "Blue" },
  { value: "teal",   label: "Teal" },
  { value: "indigo", label: "Indigo" },
  { value: "purple", label: "Purple" },
  { value: "pink",   label: "Pink" },
  { value: "yellow", label: "Yellow" },
  { value: "orange", label: "Orange" },
  { value: "red",    label: "Red (Production)" },
  { value: "gray",   label: "Gray" },
];

const COLOR_SWATCHES: Record<Environment["color"], string> = {
  green:  "bg-green-400",
  blue:   "bg-blue-400",
  teal:   "bg-teal-400",
  indigo: "bg-indigo-400",
  purple: "bg-purple-400",
  pink:   "bg-pink-400",
  yellow: "bg-yellow-400",
  orange: "bg-orange-400",
  red:    "bg-red-400",
  gray:   "bg-gray-400",
};

interface NewEnvForm {
  name: string;
  label: string;
  color: Environment["color"];
  type: EnvironmentType;
  devEnvironment: boolean;
  TENANT_BASE_URL: string;
  SERVICE_ACCOUNT_CLIENT_ID: string;
  SERVICE_ACCOUNT_ID: string;
  SERVICE_ACCOUNT_SCOPE: string;
  SERVICE_ACCOUNT_KEY: string;
  CONFIG_DIR: string;
  REALMS: string;
  SCRIPT_PREFIXES: string;
}

const EMPTY_FORM: NewEnvForm = {
  name: "",
  label: "",
  color: "green",
  type: "sandbox",
  devEnvironment: false,
  TENANT_BASE_URL: "",
  SERVICE_ACCOUNT_CLIENT_ID: "service-account",
  SERVICE_ACCOUNT_ID: "",
  SERVICE_ACCOUNT_SCOPE: "fr:am:* fr:idm:* fr:idc:esv:* fr:idc:direct-configuration:session:*",
  SERVICE_ACCOUNT_KEY: "",
  CONFIG_DIR: "./config",
  REALMS: '["alpha"]',
  SCRIPT_PREFIXES: '[""]',
};

function buildEnvContent(form: NewEnvForm): string {
  const q = (v: string) => (v.includes("\n") ? `'${v}'` : v);
  const lines = [
    `TENANT_BASE_URL=${q(form.TENANT_BASE_URL)}`,
    `SERVICE_ACCOUNT_CLIENT_ID=${q(form.SERVICE_ACCOUNT_CLIENT_ID)}`,
    `SERVICE_ACCOUNT_ID=${q(form.SERVICE_ACCOUNT_ID)}`,
    `SERVICE_ACCOUNT_SCOPE=${q(form.SERVICE_ACCOUNT_SCOPE)}`,
    `SERVICE_ACCOUNT_KEY=${q(form.SERVICE_ACCOUNT_KEY)}`,
    `CONFIG_DIR=${q(form.CONFIG_DIR)}`,
    `REALMS=${q(form.REALMS)}`,
    `SCRIPT_PREFIXES=${q(form.SCRIPT_PREFIXES)}`,
  ];
  return lines.join("\n") + "\n";
}

type AddStep = "meta" | "connection" | "repo";

const STEP_LABELS: Record<AddStep, string> = {
  meta: "1. Name & Color",
  connection: "2. Tenant Connection",
  repo: "3. Repository",
};

const STEPS: AddStep[] = ["meta", "connection", "repo"];

export function EnvironmentsManager({
  initialEnvironments,
}: {
  initialEnvironments: Environment[];
}) {
  const { confirm } = useDialog();
  const [environments, setEnvironments] = useState(initialEnvironments);
  const [editing, setEditing] = useState<Environment | null>(null);
  const [editorSave, setEditorSave] = useState<EnvSaveState>({ saving: false, saved: false, loading: false, error: "" });
  const [editorMeta, setEditorMeta] = useState<EnvMeta | null>(null);
  const editorRef = useRef<EnvEditorHandle>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [addStep, setAddStep] = useState<AddStep>("meta");
  const [form, setForm] = useState<NewEnvForm>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [addError, setAddError] = useState("");
  const [showKeyInput, setShowKeyInput] = useState(false);
  const dragIdx = useRef<number | null>(null);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);

  const [releases, setReleases] = useState<Record<string, ReleaseCacheEntry | null>>({});

  useEffect(() => {
    // Pulls the current cache and kicks the server-side auto-refresh for any
    // env that hasn't been updated today. A page reload a few seconds later
    // will reflect the newly-written values.
    fetch("/api/release", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { envs: [] }))
      .then((data: { envs: Array<{ env: string; info: ReleaseCacheEntry | null }> }) => {
        const next: Record<string, ReleaseCacheEntry | null> = {};
        for (const e of data.envs) next[e.env] = e.info;
        setReleases(next);
      })
      .catch(() => {});
  }, []);

  const setF = (key: keyof NewEnvForm, value: string | boolean) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const handleDragStart = (idx: number) => {
    dragIdx.current = idx;
  };

  const handleDragOver = (e: React.DragEvent, idx: number) => {
    e.preventDefault();
    setDragOverIdx(idx);
  };

  const handleDrop = async (idx: number) => {
    const from = dragIdx.current;
    dragIdx.current = null;
    setDragOverIdx(null);
    if (from === null || from === idx) return;

    const reordered = [...environments];
    const [moved] = reordered.splice(from, 1);
    reordered.splice(idx, 0, moved);
    setEnvironments(reordered);

    // Persist the new order
    try {
      await fetch("/api/environments/reorder", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ order: reordered.map((e) => e.name) }),
      });
    } catch { /* ignore */ }
  };

  const handleDragEnd = () => {
    dragIdx.current = null;
    setDragOverIdx(null);
  };

  const openAdd = () => {
    setForm(EMPTY_FORM);
    setAddStep("meta");
    setAddError("");
    setShowAdd(true);
  };

  const cancelAdd = () => {
    setShowAdd(false);
    setAddError("");
  };

  const handleAddEnv = async () => {
    setSaving(true);
    setAddError("");
    const res = await fetch("/api/environments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: form.name,
        label: form.label,
        color: form.color,
        type: form.type,
        devEnvironment: form.type === "controlled" ? form.devEnvironment : undefined,
        envContent: buildEnvContent(form),
      }),
    });
    if (res.ok) {
      const created: Environment = await res.json();
      setEnvironments((prev) => [...prev, created]);
      setShowAdd(false);
    } else {
      const data = await res.json();
      setAddError(data.error ?? "Failed to create environment.");
    }
    setSaving(false);
  };

  const handleDelete = async (name: string) => {
    const ok = await confirm({
      title: "Delete environment",
      message: `Delete environment "${name}"? This cannot be undone.`,
      confirmLabel: "Delete",
      variant: "danger",
    });
    if (!ok) return;
    const res = await fetch(`/api/environments/${name}`, { method: "DELETE" });
    if (res.ok) {
      setEnvironments((prev) => prev.filter((e) => e.name !== name));
      if (editing?.name === name) openEditor(null);
    }
  };

  const handleEnvUpdated = (updated: Environment) => {
    setEnvironments((prev) => prev.map((e) => (e.name === updated.name ? updated : e)));
    setEditing(updated);
  };

  // Open/close the editor while keeping live meta + save state in sync with
  // the env being edited (avoids a stale badge flash when switching envs).
  const openEditor = useCallback((env: Environment | null) => {
    setEditorMeta(null);
    setEditorSave({ saving: false, saved: false, loading: false, error: "" });
    setEditing(env);
  }, []);

  const handleSaveStateChange = useCallback((s: EnvSaveState) => setEditorSave(s), []);
  const handleMetaChange = useCallback((m: EnvMeta) => setEditorMeta(m), []);

  const editingDisplay: Environment | null = editing
    ? (editorMeta ? { ...editing, label: editorMeta.label, color: editorMeta.color } : editing)
    : null;

  const stepIdx = STEPS.indexOf(addStep);

  return (
    <div className="space-y-6">
      {/* Card grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {environments.map((env, idx) => (
          <div
            key={env.name}
            draggable
            onDragStart={() => handleDragStart(idx)}
            onDragOver={(e) => handleDragOver(e, idx)}
            onDrop={() => handleDrop(idx)}
            onDragEnd={handleDragEnd}
            className={cn(
              "group card-padded text-left cursor-pointer transition-shadow hover:shadow-[0_2px_8px_rgba(15,23,42,0.06)]",
              dragOverIdx === idx && "ring-2 ring-indigo-400 ring-offset-1"
            )}
            onClick={() => { openEditor(env); setShowAdd(false); }}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2.5 min-w-0 flex-1">
                <span className={cn("w-2.5 h-2.5 rounded-full shrink-0", COLOR_SWATCHES[env.color])} />
                <div className="min-w-0 flex-1">
                  <div className="font-semibold text-[14px] text-slate-900 truncate">{env.label}</div>
                  <div className="text-[11px] text-slate-500 font-mono truncate">{env.name}</div>
                </div>
              </div>
              <span
                className="text-slate-300 group-hover:text-slate-400 text-base cursor-grab select-none shrink-0"
                title="Drag to reorder"
                onClick={(e) => e.stopPropagation()}
              >
                ⋮⋮
              </span>
            </div>
            <div className="flex items-center gap-1.5 mt-3">
              <span
                className={cn(
                  "inline-flex items-center text-[10px] font-medium px-2 py-0.5 rounded-full ring-1",
                  env.type === "controlled"
                    ? "bg-amber-50 text-amber-700 ring-amber-200"
                    : "bg-slate-50 text-slate-600 ring-slate-200"
                )}
              >
                {env.type === "controlled" ? "controlled" : "sandbox"}
              </span>
              {env.type === "controlled" && env.devEnvironment && (
                <span className="inline-flex items-center text-[10px] font-medium px-2 py-0.5 rounded-full ring-1 bg-indigo-50 text-indigo-700 ring-indigo-200">
                  dev
                </span>
              )}
            </div>
            <ReleaseStrip release={releases[env.name]} />
          </div>
        ))}

        {/* Add environment card */}
        <button
          type="button"
          onClick={showAdd ? cancelAdd : openAdd}
          className={cn(
            "card-padded border-2 border-dashed flex flex-col items-center justify-center gap-2 min-h-[100px] transition-colors text-sm",
            showAdd
              ? "border-slate-300 text-slate-400 hover:bg-slate-50"
              : "border-slate-300 text-slate-400 hover:border-indigo-400 hover:text-indigo-600"
          )}
        >
          <span className="text-2xl leading-none">{showAdd ? "✕" : "+"}</span>
          <span>{showAdd ? "Cancel" : "Add environment"}</span>
        </button>
      </div>

      {/* Add wizard — shown below grid when active */}
      {showAdd && (
        <div className="bg-white rounded-lg border border-slate-200 overflow-hidden">
          {/* Stepper header */}
          <div className="flex border-b border-slate-200">
            {STEPS.map((step, i) => (
              <button
                key={step}
                onClick={() => i < stepIdx && setAddStep(step)}
                className={cn(
                  "flex-1 px-3 py-3 text-xs font-medium transition-colors text-center",
                  addStep === step
                    ? "bg-sky-50 text-sky-700 border-b-2 border-sky-500"
                    : i < stepIdx
                    ? "text-slate-600 hover:bg-slate-50 cursor-pointer"
                    : "text-slate-400 cursor-default"
                )}
              >
                {STEP_LABELS[step]}
              </button>
            ))}
          </div>

          <div className="p-6 space-y-5">
            {/* Step 1: meta */}
            {addStep === "meta" && (
              <>
                <h2 className="text-base font-semibold text-slate-800">Environment Details</h2>
                <div className="space-y-4">
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium text-slate-700">
                      Name <span className="text-red-500">*</span>
                    </label>
                    <p className="text-xs text-slate-400">
                      Slug used internally and as the .env filename. Lowercase, no spaces.
                    </p>
                    <input
                      value={form.name}
                      onChange={(e) => setF("name", e.target.value.toLowerCase().replace(/[^a-z0-9-_]/g, ""))}
                      placeholder="e.g. staging"
                      className="block w-full rounded border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium text-slate-700">
                      Display Label <span className="text-red-500">*</span>
                    </label>
                    <input
                      value={form.label}
                      onChange={(e) => setF("label", e.target.value)}
                      placeholder="e.g. Staging"
                      className="block w-full rounded border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium text-slate-700">Color</label>
                    <div className="flex gap-3 flex-wrap">
                      {COLOR_OPTIONS.map((opt) => (
                        <label key={opt.value} className="flex items-center gap-2 cursor-pointer text-sm">
                          <input
                            type="radio"
                            name="color"
                            value={opt.value}
                            checked={form.color === opt.value}
                            onChange={() => setF("color", opt.value)}
                            className="sr-only"
                          />
                          <span
                            className={cn(
                              "w-4 h-4 rounded-full inline-block ring-2 ring-offset-1",
                              COLOR_SWATCHES[opt.value],
                              form.color === opt.value ? "ring-slate-600" : "ring-transparent"
                            )}
                          />
                          <span className={form.color === opt.value ? "font-medium text-slate-800" : "text-slate-500"}>
                            {opt.label}
                          </span>
                        </label>
                      ))}
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium text-slate-700">Environment Type</label>
                    <p className="text-xs text-slate-400">
                      Sandbox is for internal development. Controlled Environment is used for system integration before Prod.
                    </p>
                    <select
                      value={form.type}
                      onChange={(e) => setF("type", e.target.value as EnvironmentType)}
                      className="block rounded border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500"
                    >
                      <option value="sandbox">Sandbox Environment</option>
                      <option value="controlled">Controlled Environment</option>
                    </select>
                  </div>
                  {form.type === "controlled" && (
                    <label className="flex items-center gap-2.5 cursor-pointer text-sm text-slate-700">
                      <input
                        type="checkbox"
                        checked={form.devEnvironment}
                        onChange={(e) => setF("devEnvironment", e.target.checked)}
                        className="accent-sky-600 w-4 h-4"
                      />
                      <span>Dev Environment</span>
                      <span className="text-xs text-slate-400">(first environment in the pipeline)</span>
                    </label>
                  )}
                </div>
              </>
            )}

            {/* Step 2: connection */}
            {addStep === "connection" && (
              <>
                <h2 className="text-base font-semibold text-slate-800">Tenant Connection</h2>
                <div className="space-y-4">
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium text-slate-700">
                      Tenant Base URL <span className="text-red-500">*</span>
                    </label>
                    <p className="text-xs text-slate-400">
                      Root URL of the tenant — do <strong>not</strong> include <code className="bg-slate-100 px-1 rounded">/am</code> (the CLI appends it automatically).
                    </p>
                    <input
                      value={form.TENANT_BASE_URL}
                      onChange={(e) => setF("TENANT_BASE_URL", e.target.value)}
                      placeholder="https://your-tenant.forgeblocks.com"
                      className="block w-full font-mono text-sm rounded border border-slate-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-sky-500"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium text-slate-700">
                      Service Account Client ID <span className="text-red-500">*</span>
                    </label>
                    <p className="text-xs text-slate-400">OAuth2 client ID for the service account.</p>
                    <input
                      value={form.SERVICE_ACCOUNT_CLIENT_ID}
                      onChange={(e) => setF("SERVICE_ACCOUNT_CLIENT_ID", e.target.value)}
                      placeholder="service-account"
                      className="block w-full font-mono text-sm rounded border border-slate-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-sky-500"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium text-slate-700">
                      Service Account ID <span className="text-red-500">*</span>
                    </label>
                    <p className="text-xs text-slate-400">UUID of the service account (JWT issuer).</p>
                    <input
                      value={form.SERVICE_ACCOUNT_ID}
                      onChange={(e) => setF("SERVICE_ACCOUNT_ID", e.target.value)}
                      placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                      className="block w-full font-mono text-sm rounded border border-slate-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-sky-500"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium text-slate-700">
                      Service Account Scope <span className="text-red-500">*</span>
                    </label>
                    <p className="text-xs text-slate-400">Select the OAuth2 scopes to request for this service account.</p>
                    <ServiceAccountScopeSelector
                      value={form.SERVICE_ACCOUNT_SCOPE}
                      onChange={(v) => setF("SERVICE_ACCOUNT_SCOPE", v)}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <div className="flex items-center gap-2">
                      <label className="text-sm font-medium text-slate-700">
                        Service Account Private Key <span className="text-red-500">*</span>
                      </label>
                      <span className="text-xs text-slate-400 bg-slate-100 px-1.5 py-0.5 rounded">sensitive</span>
                      <button
                        type="button"
                        onClick={() => setShowKeyInput((v) => !v)}
                        className="text-xs text-slate-400 hover:text-slate-700 ml-auto"
                      >
                        {showKeyInput ? "Hide" : "Show"}
                      </button>
                    </div>
                    <p className="text-xs text-slate-400">
                      PEM-encoded private key (include header and footer lines).
                    </p>
                    <textarea
                      rows={4}
                      value={form.SERVICE_ACCOUNT_KEY}
                      onChange={(e) => setF("SERVICE_ACCOUNT_KEY", e.target.value)}
                      placeholder={"-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"}
                      className="w-full font-mono text-xs rounded border border-slate-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-sky-500 resize-none"
                      style={{ filter: showKeyInput ? "none" : "blur(3px)", userSelect: showKeyInput ? "auto" : "none" }}
                    />
                  </div>
                </div>
              </>
            )}

            {/* Step 3: repo */}
            {addStep === "repo" && (
              <>
                <h2 className="text-base font-semibold text-slate-800">Repository Settings</h2>
                <div className="space-y-4">
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium text-slate-700">
                      Config Directory <span className="text-red-500">*</span>
                    </label>
                    <p className="text-xs text-slate-400">
                      Path to the local directory where fr-config-manager reads/writes config files.
                    </p>
                    <input
                      value={form.CONFIG_DIR}
                      onChange={(e) => setF("CONFIG_DIR", e.target.value)}
                      placeholder="./config"
                      className="block w-full font-mono text-sm rounded border border-slate-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-sky-500"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium text-slate-700">
                      Realms <span className="text-red-500">*</span>
                    </label>
                    <p className="text-xs text-slate-400">
                      JSON array of realm names to manage, e.g. <code className="bg-slate-100 px-1 rounded">{`["alpha"]`}</code>
                    </p>
                    <input
                      value={form.REALMS}
                      onChange={(e) => setF("REALMS", e.target.value)}
                      placeholder='["alpha"]'
                      className="block w-full font-mono text-sm rounded border border-slate-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-sky-500"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium text-slate-700">
                      Script Prefixes <span className="text-red-500">*</span>
                    </label>
                    <p className="text-xs text-slate-400">
                      JSON array of script name prefixes to include, e.g. <code className="bg-slate-100 px-1 rounded">{`["MyOrg-"]`}</code>. Use <code className="bg-slate-100 px-1 rounded">{`[""]`}</code> to include all.
                    </p>
                    <input
                      value={form.SCRIPT_PREFIXES}
                      onChange={(e) => setF("SCRIPT_PREFIXES", e.target.value)}
                      placeholder='["MyOrg-"]'
                      className="block w-full font-mono text-sm rounded border border-slate-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-sky-500"
                    />
                  </div>
                </div>
                {addError && (
                  <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2">
                    {addError}
                  </p>
                )}
              </>
            )}

            {/* Nav buttons */}
            <div className="flex justify-between pt-2">
              <button
                type="button"
                onClick={() => stepIdx > 0 && setAddStep(STEPS[stepIdx - 1])}
                disabled={stepIdx === 0}
                className="btn-secondary disabled:opacity-30"
              >
                Back
              </button>

              {addStep !== "repo" ? (
                <button
                  type="button"
                  onClick={() => setAddStep(STEPS[stepIdx + 1])}
                  disabled={
                    (addStep === "meta" && (!form.name || !form.label)) ||
                    (addStep === "connection" && !form.TENANT_BASE_URL)
                  }
                  className="btn-primary"
                >
                  Next
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handleAddEnv}
                  disabled={saving || !form.CONFIG_DIR || !form.REALMS}
                  className="btn-primary"
                >
                  {saving ? "Creating..." : "Create Environment"}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Edit dialog */}
      <Dialog.Root open={editing !== null} onOpenChange={(open) => { if (!open) openEditor(null); }}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm z-50 data-[state=open]:animate-in data-[state=open]:fade-in" />
          <Dialog.Content
            className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-[min(900px,calc(100vw-32px))] max-h-[calc(100vh-48px)] overflow-y-auto bg-white rounded-2xl shadow-2xl"
          >
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
              <div className="flex items-center gap-3 min-w-0">
                {editingDisplay && <EnvironmentBadge env={editingDisplay} />}
                <Dialog.Title className="text-sm font-semibold text-slate-700">
                  Edit Environment
                </Dialog.Title>
                {editing && (
                  <span className="text-xs font-mono text-slate-400 truncate">{editing.name}</span>
                )}
              </div>
              <div className="flex items-center gap-2">
                {editorSave.error && <span className="text-xs text-red-600">{editorSave.error}</span>}
                {editorSave.saved && <StatusPill tone="success">Saved</StatusPill>}
                <button
                  type="button"
                  onClick={() => editorRef.current?.save()}
                  disabled={editorSave.saving || editorSave.loading}
                  className="btn-primary text-xs px-3 py-1.5"
                >
                  {editorSave.saving ? "Saving..." : "Save"}
                </button>
                {editing && (
                  <button
                    type="button"
                    onClick={() => handleDelete(editing.name)}
                    className="btn-danger-outline text-xs px-3 py-1.5"
                  >
                    Delete
                  </button>
                )}
                <Dialog.Close asChild>
                  <button aria-label="Close" className="text-slate-400 hover:text-slate-600 p-1 rounded">
                    <X className="w-4 h-4" />
                  </button>
                </Dialog.Close>
              </div>
            </div>
            <Dialog.Description className="sr-only">
              Edit the selected environment configuration.
            </Dialog.Description>
            <div className="p-5">
              {editing && (
                <EnvEditor
                  ref={editorRef}
                  env={editing}
                  onUpdate={handleEnvUpdated}
                  onSaveStateChange={handleSaveStateChange}
                  onMetaChange={handleMetaChange}
                />
              )}
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}

function ReleaseStrip({ release }: { release: ReleaseCacheEntry | null | undefined }) {
  if (!release) {
    return (
      <div className="border-t border-slate-100 pt-2.5 mt-3 text-[11px] text-slate-400">
        Version unknown — fetching…
      </div>
    );
  }
  if (release.error || !release.info) {
    return (
      <div
        className="border-t border-slate-100 pt-2.5 mt-3 text-[11px] text-rose-600 truncate"
        title={release.error ?? "unknown error"}
      >
        fetch failed: {release.error ?? "unknown error"}
      </div>
    );
  }
  const { channel, currentVersion, nextUpgrade } = release.info;
  const urgency = classifyUpgrade(nextUpgrade);
  const days = daysUntil(nextUpgrade);
  const urgencyText =
    urgency === "overdue" ? <span className="text-rose-600 font-medium">overdue</span>
    : urgency === "soon" ? <span className="text-amber-700 font-medium">upgrade in {days}d</span>
    : urgency === "later" ? <span className="text-slate-500">upgrade in {days}d</span>
    : <span className="text-slate-400">no upgrade scheduled</span>;
  return (
    <div className="border-t border-slate-100 pt-2.5 mt-3 flex items-center gap-1.5 text-[11px] min-w-0">
      <span className="font-mono text-slate-700 truncate" title={currentVersion}>v{currentVersion}</span>
      <span
        className={cn(
          "inline-block px-1.5 py-0.5 rounded text-[10px] border shrink-0",
          channel === "rapid"
            ? "bg-indigo-50 text-indigo-700 border-indigo-200"
            : "bg-emerald-50 text-emerald-700 border-emerald-200",
        )}
      >
        {channel}
      </span>
      <span className="ml-auto shrink-0">{urgencyText}</span>
    </div>
  );
}
