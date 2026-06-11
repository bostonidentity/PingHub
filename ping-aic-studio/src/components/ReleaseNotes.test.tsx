// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { ReleaseNotes } from "./ReleaseNotes";

afterEach(cleanup);

describe("ReleaseNotes", () => {
    it("renders headings and bullets as elements, not raw markdown text", () => {
        const { container } = render(<ReleaseNotes notes={"# v0.4.0\n\n## Highlights\n\n- **faster** pulls\n- fixed `truncated` flag"} />);
        expect(screen.getByRole("heading", { name: "v0.4.0" })).toBeInTheDocument();
        expect(screen.getByRole("heading", { name: "Highlights" })).toBeInTheDocument();
        expect(screen.getAllByRole("listitem")).toHaveLength(2);
        expect(container.querySelector("strong")).toHaveTextContent("faster");
        expect(container.querySelector("code")).toHaveTextContent("truncated");
        expect(container.textContent).not.toContain("# v0.4.0");
        expect(container.textContent).not.toContain("**faster**");
    });

    it("opens links in a new tab", () => {
        render(<ReleaseNotes notes={"See [the docs](https://example.com/docs)."} />);
        const link = screen.getByRole("link", { name: "the docs" });
        expect(link).toHaveAttribute("href", "https://example.com/docs");
        expect(link).toHaveAttribute("target", "_blank");
        expect(link).toHaveAttribute("rel", "noreferrer");
    });

    it("does not render embedded raw HTML", () => {
        const { container } = render(<ReleaseNotes notes={'before <script>window.x=1</script> <img src=x onerror="x()"> after'} />);
        expect(container.querySelector("script")).toBeNull();
        expect(container.querySelector("img")).toBeNull();
        expect(container.textContent).toContain("before");
        expect(container.textContent).toContain("after");
    });
});
