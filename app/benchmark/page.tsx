import type { Metadata } from "next";
import { BenchmarkPage } from "@/components/BenchmarkPage";

export const metadata: Metadata = {
  title: "Model benchmark",
  description:
    "How each worker model has performed across all your Build runs — quality, speed, and reliability, accumulated locally in your browser.",
  alternates: { canonical: "/benchmark" },
};

export default function Benchmark() {
  return <BenchmarkPage />;
}
