import React, { useState, useEffect, useRef } from 'react';
import { Share2, ZoomIn, ZoomOut, RotateCcw, Filter, Download, Info } from 'lucide-react';
import { WalletEntity } from '../types';

interface GraphViewProps {
  wallets: WalletEntity[];
  selectedWalletId?: string;
  onSelectWallet: (walletId: string) => void;
}

interface GraphNode {
  id: string;
  label: string;
  address: string;
  network: string;
  node_type: string;
  is_source: boolean;
  tx_count: number;
  completeness: string;
  x?: number;
  y?: number;
}

interface GraphEdge {
  id: string;
  source: string;
  target: string;
  asset: string;
  display_amount: string;
  tx_count: number;
  latest_timestamp: number;
}

export const GraphView: React.FC<GraphViewProps> = ({
  wallets,
  selectedWalletId,
  onSelectWallet,
}) => {
  const [currentWalletId, setCurrentWalletId] = useState<string>(
    selectedWalletId || (wallets[0]?.id ?? '')
  );
  const [nodes, setNodes] = useState<GraphNode[]>([]);
  const [edges, setEdges] = useState<GraphEdge[]>([]);
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<GraphEdge | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (!currentWalletId && wallets.length > 0) {
      const initial = window.setTimeout(() => setCurrentWalletId(wallets[0].id), 0);
      return () => window.clearTimeout(initial);
    }
  }, [wallets]);

  useEffect(() => {
    if (!currentWalletId) return;

    const pending = window.setTimeout(() => setIsLoading(true), 0);
    fetch(`/api/graph/${currentWalletId}`)
      .then((res) => res.json())
      .then((data) => {
        // Layout nodes in a radial formation
        const rawNodes: GraphNode[] = data.nodes || [];
        const width = 800;
        const height = 500;
        const centerX = width / 2;
        const centerY = height / 2;
        const radius = Math.min(width, height) * 0.35;

        const positioned = rawNodes.map((node, idx) => {
          if (node.is_source) {
            return { ...node, x: centerX, y: centerY };
          }
          const angle = (idx / (rawNodes.length - 1 || 1)) * 2 * Math.PI;
          return {
            ...node,
            x: centerX + radius * Math.cos(angle),
            y: centerY + radius * Math.sin(angle),
          };
        });

        setNodes(positioned);
        setEdges(data.edges || []);
      })
      .catch((err) => console.error(err))
      .finally(() => setIsLoading(false));
    return () => window.clearTimeout(pending);
  }, [currentWalletId]);

  const handleMouseDown = (e: React.MouseEvent) => {
    setIsDragging(true);
    setDragStart({ x: e.clientX - pan.x, y: e.clientY - pan.y });
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDragging) return;
    setPan({ x: e.clientX - dragStart.x, y: e.clientY - dragStart.y });
  };

  const handleMouseUp = () => {
    setIsDragging(false);
  };

  const resetView = () => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };

  const exportSvg = () => {
    const svgEl = document.getElementById('blockchain-graph-svg');
    if (!svgEl) return;
    const serializer = new XMLSerializer();
    const source = serializer.serializeToString(svgEl);
    const blob = new Blob([source], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `fund_flow_graph_${currentWalletId}.svg`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div id="graph-view-container" className="space-y-4">
      
      {/* Graph Toolbar */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-3.5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <Share2 className="w-4 h-4 text-cyan-400" />
            <span className="text-xs font-bold text-slate-100 uppercase tracking-wider">
              Fund-Flow Graph:
            </span>
          </div>

          <select
            value={currentWalletId}
            onChange={(e) => setCurrentWalletId(e.target.value)}
            className="bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-cyan-300 font-mono focus:outline-none"
          >
            {wallets.map((w) => (
              <option key={w.id} value={w.id}>
                {w.address.slice(0, 10)}... ({w.resolved_network})
              </option>
            ))}
          </select>
        </div>

        {/* View & Export Controls */}
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => setZoom((z) => Math.min(z + 0.2, 2.5))}
            className="p-1.5 rounded bg-slate-950 border border-slate-800 text-slate-300 hover:bg-slate-800"
            title="Zoom In"
          >
            <ZoomIn className="w-4 h-4" />
          </button>
          <button
            onClick={() => setZoom((z) => Math.max(z - 0.2, 0.4))}
            className="p-1.5 rounded bg-slate-950 border border-slate-800 text-slate-300 hover:bg-slate-800"
            title="Zoom Out"
          >
            <ZoomOut className="w-4 h-4" />
          </button>
          <button
            onClick={resetView}
            className="p-1.5 rounded bg-slate-950 border border-slate-800 text-slate-300 hover:bg-slate-800"
            title="Reset View"
          >
            <RotateCcw className="w-4 h-4" />
          </button>
          <button
            onClick={exportSvg}
            className="flex items-center gap-1 px-2.5 py-1 rounded bg-slate-950 border border-slate-800 text-xs text-slate-300 hover:bg-slate-800 ml-2"
          >
            <Download className="w-3.5 h-3.5 text-cyan-400" />
            <span>Export SVG</span>
          </button>
        </div>
      </div>

      {/* SVG Canvas Container */}
      <div
        className="bg-slate-950 border border-slate-800 rounded-xl overflow-hidden relative cursor-grab active:cursor-grabbing select-none h-[540px]"
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
      >
        {isLoading && (
          <div className="absolute inset-0 bg-slate-950/70 z-20 flex items-center justify-center text-xs text-cyan-300">
            Rendering blockchain fund-flow graph...
          </div>
        )}

        <svg
          id="blockchain-graph-svg"
          className="w-full h-full"
          viewBox="0 0 800 500"
        >
          <defs>
            <marker
              id="arrowhead"
              markerWidth="10"
              markerHeight="7"
              refX="18"
              refY="3.5"
              orient="auto"
            >
              <polygon points="0 0, 10 3.5, 0 7" fill="#06b6d4" />
            </marker>
          </defs>

          <g transform={`translate(${pan.x}, ${pan.y}) scale(${zoom})`}>
            {/* Edges */}
            {edges.map((edge, i) => {
              const sourceNode = nodes.find((n) => n.address.toLowerCase() === edge.source.toLowerCase());
              const targetNode = nodes.find((n) => n.address.toLowerCase() === edge.target.toLowerCase());
              if (!sourceNode || !targetNode) return null;

              const isSelected = selectedEdge?.id === edge.id;

              return (
                <g key={edge.id || i} onClick={(e) => { e.stopPropagation(); setSelectedEdge(edge); setSelectedNode(null); }}>
                  <line
                    x1={sourceNode.x}
                    y1={sourceNode.y}
                    x2={targetNode.x}
                    y2={targetNode.y}
                    stroke={isSelected ? '#38bdf8' : '#334155'}
                    strokeWidth={isSelected ? 2.5 : 1.5}
                    markerEnd="url(#arrowhead)"
                    className="hover:stroke-cyan-400 transition-colors cursor-pointer"
                  />
                  {/* Midpoint amount label */}
                  <text
                    x={((sourceNode.x || 0) + (targetNode.x || 0)) / 2}
                    y={((sourceNode.y || 0) + (targetNode.y || 0)) / 2 - 4}
                    fill="#94a3b8"
                    fontSize="9"
                    fontFamily="monospace"
                    textAnchor="middle"
                  >
                    {edge.display_amount} {edge.asset}
                  </text>
                </g>
              );
            })}

            {/* Nodes */}
            {nodes.map((node) => {
              const isSelected = selectedNode?.id === node.id;
              const isSource = node.is_source;

              return (
                <g
                  key={node.id}
                  transform={`translate(${node.x}, ${node.y})`}
                  onClick={(e) => {
                    e.stopPropagation();
                    setSelectedNode(node);
                    setSelectedEdge(null);
                  }}
                  className="cursor-pointer group"
                >
                  <circle
                    r={isSource ? 22 : 16}
                    fill={isSource ? '#083344' : node.node_type === 'known_site_wallet' ? '#450a0a' : '#0f172a'}
                    stroke={
                      isSelected
                        ? '#38bdf8'
                        : isSource
                        ? '#06b6d4'
                        : node.node_type === 'known_site_wallet'
                        ? '#ef4444'
                        : '#475569'
                    }
                    strokeWidth={isSelected ? 3 : isSource ? 2.5 : 1.5}
                  />

                  {/* Node Label */}
                  <text
                    y={isSource ? 32 : 26}
                    fill="#e2e8f0"
                    fontSize="10"
                    fontFamily="monospace"
                    textAnchor="middle"
                    className="font-medium pointer-events-none"
                  >
                    {node.label}
                  </text>

                  {/* Network subtitle */}
                  <text
                    y={isSource ? 42 : 36}
                    fill="#64748b"
                    fontSize="8"
                    fontFamily="monospace"
                    textAnchor="middle"
                    className="uppercase pointer-events-none"
                  >
                    {node.network}
                  </text>
                </g>
              );
            })}
          </g>
        </svg>

        {/* Floating Node Inspection Panel */}
        {selectedNode && (
          <div className="absolute bottom-4 left-4 z-30 w-80 bg-slate-900/95 backdrop-blur border border-slate-700 rounded-xl p-4 shadow-xl space-y-2 text-xs">
            <div className="flex items-center justify-between border-b border-slate-800 pb-2">
              <span className="font-bold text-slate-100 uppercase tracking-wider">Node Details</span>
              <button onClick={() => setSelectedNode(null)} className="text-slate-400 hover:text-slate-200">
                ✕
              </button>
            </div>
            <div className="font-mono text-slate-300 break-all">{selectedNode.address}</div>
            <div className="flex justify-between text-slate-400">
              <span>Network:</span>
              <span className="text-slate-200 font-mono capitalize">{selectedNode.network}</span>
            </div>
            <div className="flex justify-between text-slate-400">
              <span>Type:</span>
              <span className="text-cyan-300 font-mono">{selectedNode.node_type}</span>
            </div>
            <div className="flex justify-between text-slate-400">
              <span>Recorded Txs:</span>
              <span className="text-slate-200 font-mono">{selectedNode.tx_count}</span>
            </div>
          </div>
        )}

        {/* Floating Edge Inspection Panel */}
        {selectedEdge && (
          <div className="absolute bottom-4 right-4 z-30 w-80 bg-slate-900/95 backdrop-blur border border-slate-700 rounded-xl p-4 shadow-xl space-y-2 text-xs">
            <div className="flex items-center justify-between border-b border-slate-800 pb-2">
              <span className="font-bold text-slate-100 uppercase tracking-wider">Transfer Edge</span>
              <button onClick={() => setSelectedEdge(null)} className="text-slate-400 hover:text-slate-200">
                ✕
              </button>
            </div>
            <div className="text-slate-400">
              Amount: <span className="font-mono font-bold text-cyan-300">{selectedEdge.display_amount} {selectedEdge.asset}</span>
            </div>
            <div className="text-[11px] font-mono text-slate-400 truncate">
              From: {selectedEdge.source}
            </div>
            <div className="text-[11px] font-mono text-slate-400 truncate">
              To: {selectedEdge.target}
            </div>
          </div>
        )}

        {/* Legend */}
        <div className="absolute top-4 left-4 z-10 bg-slate-900/90 backdrop-blur border border-slate-800 rounded-lg p-2.5 text-[11px] text-slate-400 space-y-1">
          <div className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full bg-cyan-400 border border-cyan-300 inline-block" />
            <span>Target Wallet</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full bg-slate-700 border border-slate-500 inline-block" />
            <span>Counterparty</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full bg-rose-500 border border-rose-400 inline-block" />
            <span>Known Scam Website Wallet</span>
          </div>
        </div>
      </div>

    </div>
  );
};
