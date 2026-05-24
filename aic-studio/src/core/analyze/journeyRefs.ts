// src/core/analyze/journeyRefs.ts
import type { Reference, ResourceRef } from "./types";

export interface JourneyRefsParams {
  realm: string;
  journeyId: string;
  body: Record<string, unknown>;
}

function nodeTypeId(node: unknown): string | undefined {
  if (typeof node !== "object" || node === null) return undefined;
  const n = node as Record<string, unknown>;
  const t = n._type;
  if (typeof t === "object" && t !== null) {
    const id = (t as Record<string, unknown>)._id;
    return typeof id === "string" ? id : undefined;
  }
  return undefined;
}

function nodeStringField(node: unknown, field: string): string | undefined {
  if (typeof node !== "object" || node === null) return undefined;
  const v = (node as Record<string, unknown>)[field];
  return typeof v === "string" ? v : undefined;
}

export function extractRefs(p: JourneyRefsParams): Reference[] {
  const refs: Reference[] = [];
  const src: ResourceRef = { realm: p.realm, resourceType: "journey", id: p.journeyId };
  const nodes = p.body.nodes;
  if (typeof nodes !== "object" || nodes === null) return refs;

  for (const [nodeId, node] of Object.entries(nodes as Record<string, unknown>)) {
    const type = nodeTypeId(node);
    if (!type) continue;

    // Script-node → script reference
    if (type === "ScriptedDecisionNode" || type === "ScriptNode") {
      const scriptId = nodeStringField(node, "script");
      if (scriptId) {
        refs.push({
          source: src,
          target: { realm: p.realm, resourceType: "script", id: scriptId },
          detail: `node ${nodeId}`
        });
      }
    }

    // Inner-tree node → journey reference
    if (type === "InnerTreeEvaluatorNode") {
      const treeId = nodeStringField(node, "tree");
      if (treeId) {
        refs.push({
          source: src,
          target: { realm: p.realm, resourceType: "journey", id: treeId },
          detail: `node ${nodeId}`
        });
      }
    }

    // SAML2 node → saml2 reference
    if (type === "Saml2Node") {
      const meta = nodeStringField(node, "metaAlias");
      if (meta) {
        // metaAlias is like "/alpha/sp-acme" — extract entity name
        const parts = meta.split("/").filter(Boolean);
        const samlId = parts[parts.length - 1];
        if (samlId) {
          refs.push({
            source: src,
            target: { realm: p.realm, resourceType: "saml2", id: samlId },
            detail: `node ${nodeId}`
          });
        }
      }
      const idp = nodeStringField(node, "idpEntityId");
      if (idp) {
        refs.push({
          source: src,
          target: { realm: p.realm, resourceType: "saml2", id: idp },
          detail: `node ${nodeId}`
        });
      }
    }

    // Social IdP / OAuth2 client node → OAuth2Client reference
    if (type === "SocialProviderHandlerNode" || type === "OAuth2Node") {
      const cid = nodeStringField(node, "clientId");
      if (cid) {
        refs.push({
          source: src,
          target: { realm: p.realm, resourceType: "OAuth2Client", id: cid },
          detail: `node ${nodeId}`
        });
      }
    }
  }

  return refs;
}
