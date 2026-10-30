import ConnectClient from "./connect-client";
import { pageMetadata } from "@/lib/site";

export const metadata = pageMetadata({
  title: "Connect a local Runner",
  description: "Connect this tab to the Runner V2 started by `aiboard` on your computer.",
  path: "/connect",
  noindex: true,
});

export default function ConnectPage() {
  return <ConnectClient />;
}
