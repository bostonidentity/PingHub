// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { ManagedObjectUsagePanel } from "@/app/data/browse/ManagedObjectUsagePanel";

const mockResponse = {
  env: "test-env",
  type: "alpha_user",
  query: "managed/alpha_user",
  scanned: { files: 1284, bytes: 1234567, ms: 200, skipped: 0, errors: 0 },
  truncated: false,
  counts: { byCategory: { journey: 1, "script-library": 1 } },
  hits: [
    {
      category: "journey",
      filePath: "alpha/journeys/tenant_login/tenant_login.json",
      line: 4, column: 24,
      snippet: '"identityResource": "managed/alpha_user",',
      fieldName: "identityResource",
      realmRoot: "alpha",
      isSelfReference: false,
    },
    {
      category: "script-library",
      filePath: "alpha/scripts/scripts-content/AUTH/foo.js",
      line: 1, column: 22,
      snippet: 'var u = openidm.read("managed/alpha_user/" + id);',
      fieldName: null,
      realmRoot: "alpha",
      isSelfReference: false,
    },
  ],
};

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve(mockResponse) }) as any));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ManagedObjectUsagePanel", () => {
  it("renders header and per-category counts after fetch", async () => {
    render(<ManagedObjectUsagePanel env="test-env" type="alpha_user" onClose={() => {}} />);
    expect(await screen.findByText(/Find usage of "alpha_user"/)).toBeInTheDocument();
    expect(await screen.findByText(/Scanned 1,284 files/)).toBeInTheDocument();
    expect(screen.getByText(/Journey \(1\)/)).toBeInTheDocument();
    expect(screen.getByText(/Script library \(1\)/)).toBeInTheDocument();
  });

  it("shows the field name for JSON hits and omits it for JS hits", async () => {
    render(<ManagedObjectUsagePanel env="test-env" type="alpha_user" onClose={() => {}} />);
    expect(await screen.findByText(/field: identityResource/)).toBeInTheDocument();
    expect(screen.getByText(/openidm.read\("managed\/alpha_user/)).toBeInTheDocument();
  });

  it("renders empty state when there are no hits", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ ...mockResponse, hits: [], counts: { byCategory: {} } }),
    }) as any));
    render(<ManagedObjectUsagePanel env="test-env" type="alpha_user" onClose={() => {}} />);
    expect(await screen.findByText(/No usages found/)).toBeInTheDocument();
  });

  it("renders truncation banner when truncated=true", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ ...mockResponse, truncated: true }),
    }) as any));
    render(<ManagedObjectUsagePanel env="test-env" type="alpha_user" onClose={() => {}} />);
    expect(await screen.findByText(/Showing first 2,000 hits/)).toBeInTheDocument();
  });

  it("calls onClose when the close button is clicked", async () => {
    const onClose = vi.fn();
    render(<ManagedObjectUsagePanel env="test-env" type="alpha_user" onClose={onClose} />);
    await waitFor(() => expect(screen.getByLabelText(/close/i)).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText(/close/i));
    expect(onClose).toHaveBeenCalled();
  });
});
