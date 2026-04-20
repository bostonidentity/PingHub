import { redirect } from "next/navigation";

export default function PullRedirect() {
  redirect("/sync?direction=pull");
}
