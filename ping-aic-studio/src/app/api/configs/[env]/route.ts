import { NextRequest, NextResponse } from "next/server";
import path from "path";
import { existsSync } from "fs";
import fsp from "fs/promises";
import { getConfigDir } from "@/lib/fr-config";

export interface FileNode {
  name: string;
  relativePath: string;
  type: "file" | "dir";
  children?: FileNode[];
}

async function buildTree(dir: string, base: string): Promise<FileNode[]> {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  entries.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  const nodes: FileNode[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const relativePath = path.relative(base, full).split(path.sep).join("/");
    if (entry.isDirectory()) {
      nodes.push({ name: entry.name, relativePath, type: "dir", children: await buildTree(full, base) });
    } else {
      nodes.push({ name: entry.name, relativePath, type: "file" });
    }
  }
  return nodes;
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ env: string }> }
) {
  const { env } = await params;
  const configDir = getConfigDir(env);
  if (!configDir) return NextResponse.json({ error: "Environment not found" }, { status: 404 });
  if (!existsSync(configDir)) return NextResponse.json({ tree: [], configDir });
  const tree = await buildTree(configDir, configDir);
  return NextResponse.json({ tree, configDir });
}
