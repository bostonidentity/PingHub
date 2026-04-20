// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { EnvCard } from "@/components/EnvCard";

const ENV = { name: "dev", label: "dev", color: "blue", envFile: "dev.env", baseUrl: "openam-dev.example.com" } as any;

describe("EnvCard", () => {
  it("renders env name, label, and base URL", () => {
    render(<EnvCard env={ENV} health="healthy" lastPull={null} lastPush={null} />);
    expect(screen.getByText("dev")).toBeInTheDocument();
    expect(screen.getByText("openam-dev.example.com")).toBeInTheDocument();
    expect(screen.getByText("healthy")).toBeInTheDocument();
  });

  it("shows 'stale' pill when health=stale", () => {
    render(<EnvCard env={ENV} health="stale" lastPull={null} lastPush={null} />);
    expect(screen.getByText("stale")).toBeInTheDocument();
  });

  it("shows em-dash when no pull history", () => {
    render(<EnvCard env={ENV} health="healthy" lastPull={null} lastPush={null} />);
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(2);
  });
});
