// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { DangerousConfirmDialog } from "@/components/DangerousConfirmDialog";

const diff = [{ scope: "journeys", added: 2, modified: 5, removed: 1 }];

describe("DangerousConfirmDialog", () => {
  afterEach(() => cleanup());
  it("disables Confirm until exact tenant name is typed", async () => {
    const onConfirm = vi.fn();
    render(
      <DangerousConfirmDialog
        open
        title="Push to prod"
        subtitle="Test subtitle"
        tenantName="prod"
        requireTypeToConfirm={true}
        blockUntilDiffLoaded={false}
        diffLoader={async () => diff}
        onConfirm={onConfirm}
        onCancel={() => {}}
      />
    );

    await waitFor(() => expect(screen.getByText(/journeys/i)).toBeInTheDocument());
    const confirm = screen.getByRole("button", { name: /confirm/i });
    expect(confirm).toBeDisabled();

    const input = screen.getByPlaceholderText(/type/i);
    fireEvent.change(input, { target: { value: "pro" } });
    expect(confirm).toBeDisabled();

    fireEvent.change(input, { target: { value: "prod" } });
    expect(confirm).toBeEnabled();

    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it("shows banner when diff loader fails", async () => {
    render(
      <DangerousConfirmDialog
        open
        title="Push to prod"
        subtitle=""
        tenantName="prod"
        requireTypeToConfirm={true}
        blockUntilDiffLoaded={true}
        diffLoader={async () => { throw new Error("boom"); }}
        onConfirm={() => {}}
        onCancel={() => {}}
      />
    );
    await waitFor(() => expect(screen.getByText(/Diff unavailable/i)).toBeInTheDocument());
  });

  it("enables Confirm immediately when type-to-confirm is disabled and diff loads", async () => {
    const onConfirm = vi.fn();
    render(
      <DangerousConfirmDialog
        open
        title="Push to dev"
        subtitle=""
        tenantName="dev"
        requireTypeToConfirm={false}
        blockUntilDiffLoaded={false}
        diffLoader={async () => diff}
        onConfirm={onConfirm}
        onCancel={() => {}}
      />
    );
    await waitFor(() => expect(screen.getByText(/journeys/i)).toBeInTheDocument());
    const confirm = screen.getByRole("button", { name: /confirm/i });
    expect(confirm).toBeEnabled();
    // Should be no type-to-confirm input visible
    expect(screen.queryByPlaceholderText(/type/i)).not.toBeInTheDocument();
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it("blocks Confirm while diff is null when blockUntilDiffLoaded is true", async () => {
    let resolveDiff!: (v: typeof diff) => void;
    const slow = new Promise<typeof diff>((resolve) => { resolveDiff = resolve; });

    render(
      <DangerousConfirmDialog
        open
        title="Push to prod"
        subtitle=""
        tenantName="prod"
        requireTypeToConfirm={true}
        blockUntilDiffLoaded={true}
        diffLoader={async () => slow}
        onConfirm={() => {}}
        onCancel={() => {}}
      />
    );

    // While loading, confirm must be disabled, and no type input is rendered yet
    const confirm = screen.getByRole("button", { name: /confirm/i });
    expect(confirm).toBeDisabled();

    // Resolve diff and wait for re-render
    resolveDiff(diff);
    await waitFor(() => expect(screen.getByText(/journeys/i)).toBeInTheDocument());

    // Type-to-confirm now becomes the only remaining gate
    const input = screen.getByPlaceholderText(/type/i);
    expect(confirm).toBeDisabled();
    fireEvent.change(input, { target: { value: "prod" } });
    expect(confirm).toBeEnabled();
  });
});
