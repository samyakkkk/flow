// Adapted from flow/dashboard/src/components/BrainGraph.tsx (AGPL-3.0-only).
// Keep Flow's renderer and stable-node update behavior; T3 supplies data and theme.
import { useEffect, useRef, useState } from "react";
import type { FalkorDBCanvas, GraphNode } from "@falkordb/canvas";
import type { BrainKnowledge } from "@t3tools/contracts";
import { useTheme } from "../../hooks/useTheme";
import { Button } from "../ui/button";
import { XIcon } from "lucide-react";

const colors = ["#d39c38", "#64a58a", "#8296d9", "#b28bc5", "#62a5bb", "#c48180"];
export function BrainGraph({
  knowledge,
  compact = false,
}: {
  knowledge: Pick<BrainKnowledge, "entities" | "edges">;
  compact?: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<FalkorDBCanvas | null>(null);
  const numericIds = useRef(new Map<string, number>());
  const topology = useRef("");
  const signature = useRef("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const { theme, resolvedTheme } = useTheme();
  const types = [...new Set(knowledge.entities.map((entry) => entry.kind))].sort();
  const selected = knowledge.entities.find((entry) => entry.id === selectedId);
  useEffect(() => {
    let cancelled = false;
    let fitTimer: ReturnType<typeof setTimeout> | undefined;
    void import("@falkordb/canvas")
      .then(() => {
        if (cancelled || !host.current) return;
        const numId = (id: string) => {
          let numeric = numericIds.current.get(id);
          if (numeric === undefined) {
            numeric = numericIds.current.size + 1;
            numericIds.current.set(id, numeric);
          }
          return numeric;
        };
        const degree = new Map<string, number>();
        for (const edge of knowledge.edges) {
          degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1);
          degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1);
        }
        const nodeTypes = [...new Set(knowledge.entities.map((entry) => entry.kind))].sort();
        const data = {
          nodes: knowledge.entities.map((entry) => ({
            id: numId(entry.id),
            labels: [entry.kind],
            color: colors[nodeTypes.indexOf(entry.kind) % colors.length]!,
            visible: true,
            size: 8 + Math.min(degree.get(entry.id) ?? 0, 20) * 0.8,
            data: { name: entry.name, displayId: entry.id },
          })),
          links: knowledge.edges.map((edge, i) => ({
            id: i + 1,
            relationship: edge.label,
            source: numId(edge.from),
            target: numId(edge.to),
            color: resolvedTheme === "dark" ? "rgba(220,220,230,.25)" : "rgba(80,80,100,.25)",
            visible: true,
            data: {},
          })),
        };
        let canvas = canvasRef.current;
        const firstPaint = !canvas;
        if (!canvas) {
          canvas = document.createElement("falkordb-canvas");
          Object.assign(canvas.style, {
            display: "block",
            position: "absolute",
            inset: "0",
            width: "100%",
            height: "100%",
            overflow: "hidden",
          });
          host.current.appendChild(canvas);
          canvasRef.current = canvas;
        }
        const style = getComputedStyle(host.current);
        canvas.setBackgroundColor(style.backgroundColor);
        canvas.setForegroundColor(style.color);
        canvas.setConfig({
          captionsKeys: [["name", true]],
          showPropertyKeyPrefix: false,
          nodeStyle: { fontFamily: style.fontFamily },
          eventHandlers: {
            onNodeClick: (node: GraphNode) => setSelectedId(String(node.data?.displayId ?? "")),
            onBackgroundClick: () => setSelectedId(null),
          },
        });
        const nextTopology = JSON.stringify([
          knowledge.entities.map((entry) => entry.id).sort(),
          knowledge.edges,
        ]);
        const nextSignature = JSON.stringify([knowledge, theme, resolvedTheme]);
        if (firstPaint || topology.current !== nextTopology) canvas.setData(data);
        else if (signature.current !== nextSignature) canvas.setGraphData(data);
        topology.current = nextTopology;
        signature.current = nextSignature;
        if (firstPaint) {
          const connected = new Set(data.links.flatMap((edge) => [edge.source, edge.target]));
          if (connected.size > 0)
            fitTimer = setTimeout(() => {
              if (canvasRef.current === canvas)
                canvas.zoomToFit(1, (node: GraphNode) => connected.has(node.id as number));
            }, 900);
        }
      })
      .catch(() => {
        if (!cancelled) setError("The graph could not be displayed. Reload this page to retry.");
      });
    return () => {
      cancelled = true;
      clearTimeout(fitTimer);
    };
  }, [knowledge, theme, resolvedTheme]);
  useEffect(
    () => () => {
      canvasRef.current?.remove();
      canvasRef.current = null;
    },
    [],
  );
  return (
    <div>
      <div
        className={
          compact ? "relative h-[220px] overflow-hidden" : "relative h-[340px] overflow-hidden"
        }
      >
        <div ref={host} className="absolute inset-0 bg-card text-foreground" />
        {error && (
          <p role="alert" className="absolute inset-x-4 top-4 text-sm text-destructive">
            {error}
          </p>
        )}
        {selected && (
          <article className="absolute bottom-4 right-4 left-4 z-10 max-h-[280px] overflow-y-auto rounded-lg border border-border bg-popover p-4 text-popover-foreground shadow-lg md:left-auto md:w-72">
            <div className="flex items-start justify-between gap-3">
              <span className="text-xs text-muted-foreground">{selected.kind}</span>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Close entity details"
                onClick={() => setSelectedId(null)}
              >
                <XIcon size={12} />
              </Button>
            </div>
            <h3 className="mt-1 text-sm font-medium">{selected.name}</h3>
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
              {selected.description}
            </p>
            {selected.properties && (
              <dl className="mt-3 space-y-2 text-xs">
                {Object.entries(selected.properties).map(([key, value]) => (
                  <div key={key}>
                    <dt className="font-medium capitalize">{key.replaceAll("_", " ")}</dt>
                    <dd className="mt-0.5 whitespace-pre-wrap break-words text-muted-foreground">
                      {value}
                    </dd>
                  </div>
                ))}
              </dl>
            )}
            {selected.source.startsWith("https://github.com/") ? (
              <a
                href={selected.source}
                target="_blank"
                rel="noreferrer"
                className="mt-3 inline-block text-xs underline"
              >
                View source ↗
              </a>
            ) : (
              <p className="mt-3 text-xs text-muted-foreground">{selected.source}</p>
            )}
          </article>
        )}
      </div>
      <footer className="flex flex-wrap items-center gap-4 border-t border-border px-4 py-2 text-[11px] text-muted-foreground">
        {types.map((type, i) => (
          <span key={type} className="flex items-center gap-1.5">
            <span
              className="size-2 rounded-full"
              style={{ background: colors[i % colors.length] }}
            />
            {type}
          </span>
        ))}
        <span className="ml-auto">Drag to explore · Scroll to zoom</span>
      </footer>
    </div>
  );
}
