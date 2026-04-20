import { redirect } from "next/navigation";

export default function PushRedirect() {
  redirect("/sync?direction=push");
}
