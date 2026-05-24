// src/commands/dashboard.ts
import * as vscode from "vscode";
import type { DashboardHost } from "../webviews/host/dashboardHost";

export function registerDashboardCommands(ctx: vscode.ExtensionContext, host: DashboardHost): void {
  ctx.subscriptions.push(
    vscode.commands.registerCommand("aic-studio.view.openDashboard", () => host.open())
  );
}
