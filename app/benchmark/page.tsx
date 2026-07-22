import { BenchmarkPage } from "@/components/BenchmarkPage";
import { pageMetadata } from "@/lib/site";

export const metadata = pageMetadata({
  title: "Model benchmark",
  description:
    "How each model has performed across your Build runs — reviewed quality, speed, and reliability, accumulated locally in your browser.",
  path: "/benchmark",
  // Same category as /settings and /discussion: the page renders per-user data
  // held in this browser, so there is nothing stable for search engines to index.
  noindex: true,
});

export default function Benchmark() {
  return <BenchmarkPage />;
}
