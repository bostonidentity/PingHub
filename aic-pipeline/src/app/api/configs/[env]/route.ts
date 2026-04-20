import { NextRequest, NextResponse } from "next/server";
import path from "path";
import fs from "fs";
import { getConfigDir } from "@/lib/fr-config";

export interface FileNode {
  name: string;
  relativePath: string;
  type: "file" | "dir";
  children?: FileNode[];
}

function buildTree(dir: string, base: string): FileNode[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries
    .sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    })
    .map((entry) => {
      const full = path.join(dir, entry.name);
      const relativePath = path.relative(base, full).split(path.sep).join("/");
      if (entry.isDirectory()) {
        return { name: entry.name, relativePath, type: "dir" as const, children: buildTree(full, base) };
      }
      return { name: entry.name, relativePath, type: "file" as const };
    });
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ env: string }> }
) {
  const { env } = await params;
  const configDir = getConfigDir(env);
  if (!configDir) return NextResponse.json({ error: "Environment not found" }, { status: 404 });
  if (!fs.existsSync(configDir)) return NextResponse.json({ tree: [], configDir });
  const tree = buildTree(configDir, configDir);
  return NextResponse.json({ tree, configDir });
}
