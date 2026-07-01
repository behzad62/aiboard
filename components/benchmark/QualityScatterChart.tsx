"use client";

import {
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { CHART_COLORS, EmptyChart } from "@/components/benchmark/chart-utils";

type QualityPoint = {
  modelId: string;
  displayName: string;
  quality: number;
  cost?: number;
  latency?: number;
};

export function QualityScatterChart({
  title,
  description,
  data,
  xKey,
  xLabel,
  emptyLabel,
  onSelectModel,
}: {
  title: string;
  description: string;
  data: QualityPoint[];
  xKey: "cost" | "latency";
  xLabel: string;
  emptyLabel: string;
  onSelectModel: (modelId: string) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>
          {description} Select a model from the Scorecards table below.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {data.length > 0 ? (
          <div className="h-[280px]">
            <ResponsiveContainer>
              <ScatterChart>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey={xKey} name={xLabel} type="number" />
                <YAxis
                  dataKey="quality"
                  name="Architect-reviewed quality"
                  type="number"
                  domain={[0, 100]}
                />
                <Tooltip
                  cursor={{ strokeDasharray: "3 3" }}
                  formatter={(value, name) => [value, name]}
                  labelFormatter={(_, payload) =>
                    payload?.[0]?.payload?.displayName ?? "Model"
                  }
                />
                <Scatter name={title} data={data} fill="#38bdf8">
                  {data.map((item, index) => (
                    <Cell
                      key={item.modelId}
                      fill={CHART_COLORS[index % CHART_COLORS.length]}
                      onClick={() => onSelectModel(item.modelId)}
                    />
                  ))}
                </Scatter>
              </ScatterChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <EmptyChart label={emptyLabel} />
        )}
      </CardContent>
    </Card>
  );
}
