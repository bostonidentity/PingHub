// src/providers/virtualDocs.ts
import * as vscode from "vscode";
import { readJourneyFromLatest } from "../core/snapshots/reader";

export const AIC_SCHEME = "aic";

export interface ParsedAicUri {
  envName: string;
  realm: string;
  resourceType: string;
  id: string;
}

/** Parse aic://<env>/<realm>/<type>/<id> */
export function parseAicUri(uri: vscode.Uri): ParsedAicUri | undefined {
  if (uri.scheme !== AIC_SCHEME) return undefined;
  const segments = uri.path.split("/").filter(Boolean);
  if (segments.length !== 3) return undefined;
  return {
    envName: uri.authority,
    realm: segments[0],
    resourceType: segments[1],
    id: segments[2]
  };
}

export function makeAicUri(envName: string, realm: string, resourceType: string, id: string): vscode.Uri {
  return vscode.Uri.from({
    scheme: AIC_SCHEME,
    authority: envName,
    path: `/${realm}/${resourceType}/${id}`
  });
}

export class AicDocumentContentProvider implements vscode.TextDocumentContentProvider {
  constructor(private readonly globalStoragePath: string) {}

  provideTextDocumentContent(uri: vscode.Uri): string {
    const parsed = parseAicUri(uri);
    if (!parsed) return "// not an aic:// URI";
    if (parsed.resourceType !== "journey") {
      return `// resource type '${parsed.resourceType}' not supported in M2`;
    }
    const body = readJourneyFromLatest(
      this.globalStoragePath,
      parsed.envName,
      parsed.realm,
      parsed.id
    );
    if (!body) {
      return `// no snapshot for ${parsed.envName}/${parsed.realm}/${parsed.id}\n// run: AIC Studio: Pull from environment`;
    }
    return JSON.stringify(body, null, 2);
  }
}
