import { describe, it, expect } from "vitest";
import { deriveDisplayFields, fallbackDisplayFields } from "./display-fields";

describe("deriveDisplayFields", () => {
  it("uses lower-case 'name' from schema when present", () => {
    const schema = {
      schema: { properties: { name: { type: "string" }, description: { type: "string" } } },
    };
    expect(deriveDisplayFields(schema)).toEqual({ title: "name", searchFields: ["name"] });
  });

  it("is case-insensitive: matches Name / NAME / nAmE", () => {
    for (const key of ["Name", "NAME", "nAmE"]) {
      const schema = { schema: { properties: { [key]: { type: "string" } } } };
      expect(deriveDisplayFields(schema).title).toBe(key);
    }
  });

  it("falls back to _id when no 'name' attribute exists", () => {
    const schema = { schema: { properties: { userName: { type: "string" }, mail: { type: "string" } } } };
    expect(deriveDisplayFields(schema)).toEqual({ title: "_id", searchFields: ["_id"] });
  });

  it("falls back to _id when schema has no properties", () => {
    expect(deriveDisplayFields({})).toEqual({ title: "_id", searchFields: ["_id"] });
  });
});

describe("fallbackDisplayFields", () => {
  it("uses 'name' from the record when present (case-insensitive)", () => {
    expect(fallbackDisplayFields({ _id: "abc", Name: "Alice" })).toEqual({
      title: "Name",
      searchFields: ["Name"],
    });
  });

  it("falls back to _id when record has no 'name'", () => {
    expect(fallbackDisplayFields({ _id: "abc", label: "Alice" })).toEqual({
      title: "_id",
      searchFields: ["_id"],
    });
  });
});
