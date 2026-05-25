import { redirect } from "next/navigation";

export default function MonitorIndex() {
    redirect("/monitor/server-status");
}
