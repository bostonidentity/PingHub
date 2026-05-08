import { describe, it, expect } from "vitest";
import { categorizeFilePath } from "./managed-object-usage";

describe("categorizeFilePath", () => {
  it.each([
    ["alpha/journeys/tenant_loginMain/tenant_loginMain.json", "journey"],
    ["realms/alpha/journeys/foo/foo.json", "journey"],
    ["alpha/scripts/scripts-content/AUTH/foo.js", "script-library"],
    ["alpha/scripts/scripts-config/abc-uuid.json", "script-library-config"],
    ["endpoints/loginprerequisite/loginprerequisite.json", "custom-endpoint"],
    ["endpoints/loginprerequisite/loginprerequisite.js", "custom-endpoint"],
    ["iga/workflows/foo/foo.json", "workflow"],
    ["iga/assignments/Internal-Med.json", "iga-assignment"],
    ["iga/forms/MyForm.json", "iga-form"],
    ["alpha/managed-objects/alpha_user/alpha_user.json", "managed-object-config"],
    ["alpha/managed-objects/alpha_user/alpha_user.onCreate.js", "managed-object-config"],
    ["sync/mappings/WidgetDataFix/WidgetDataFix.json", "sync-mapping"],
    ["schedules/job_x/job_x.json", "scheduler"],
    ["internal-roles/admin.json", "internal-role"],
    ["access-config/policy.json", "access-config"],
    ["agents/connector1/config.json", "connector-agent"],
    ["random/file.json", "other"],
    ["alpha/something-unknown/x.json", "other"],
    ["alpha/managed-objects/alpha_user/scripts/foo.js", "managed-object-config"],
  ])("%s -> %s", (relPath, expected) => {
    expect(categorizeFilePath(relPath)).toBe(expected);
  });
});
