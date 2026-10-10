import React, { useState, useRef, useEffect } from 'react';
import { Entity, Relationship, Evidence, Hypothesis } from '../../types';
import {
  Globe,
  Server,
  Shield,
  Code,
  Tag,
  Wallet,
  Coins,
  Radio,
  ZoomIn,
  ZoomOut,
  RotateCcw,
  Info,
  Clock,
  Layers,
  Filter
} from 'lucide-react';

interface GraphViewProps {
  entities: Entity[];
  relationships: Relationship[];
  evidenceList: Evidence[];
  hypotheses: Hypothesis[];
  onInspectLineage: (type: 'relationship' | 'entity' | 'conclusion', data: any) => void;
}

interface NodePosition {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

export const GraphView: React.FC<GraphViewProps> = ({
  entities,
  relationships,
  evidenceList,
  hypotheses,
  onInspectLineage
}) => {
  const [selectedEntityId, setSelectedEntityId] = useState<string | null>(null);
  const [selectedRelId, setSelectedRelId] = useState<string | null>(null);
  const [filterType, setFilterType] = useState<string>('all');
  const [filterState, setFilterState] = useState<string>('all');
  const [showActiveOnly, setShowActiveOnly] = useState<boolean>(false);

  // Canvas Viewport transform
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 400, y: 300 });
  const [isPanning, setIsPanning] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });

  // Node positions map
  const [positions, setPositions] = useState<Record<string, { x: number; y: number }>>({});
  const draggingNodeRef = useRef<string | null>(null);

  // Initialize or update node positions using a deterministic radial layout grouped by type
  useEffect(() => {
    const newPos: Record<string, { x: number; y: number }> = { ...positions };
    const radiusMap: Record<string, number> = {
      domain: 140,
      ip: 240,
      asn: 320,
      nameserver: 220,
      certificate: 200,
      template: 180,
      identifier: 260,
      contract: 220,
      wallet: 300
    };

    const countByType: Record<string, number> = {};
    entities.forEach(e => {
      countByType[e.type] = (countByType[e.type] || 0) + 1;
    });

    const indexByType: Record<string, number> = {};

    entities.forEach((entity, idx) => {
      if (!newPos[entity.id]) {
        const typeIndex = indexByType[entity.type] || 0;
        indexByType[entity.type] = typeIndex + 1;
        const totalOfType = countByType[entity.type] || 1;

        // Spread entities on concentric orbits
        const baseAngle = (typeIndex / totalOfType) * (Math.PI * 2);
        const radius = radiusMap[entity.type] || 220;
        const jitter = (idx % 2 === 0 ? 1 : -1) * 25;

        newPos[entity.id] = {
          x: Math.cos(baseAngle) * (radius + jitter),
          y: Math.sin(baseAngle) * (radius + jitter)
        };
      }
    });

    setPositions(newPos);
  }, [entities]);

  // Filter entities & relationships
  const visibleEntities = entities.filter(e => {
    if (showActiveOnly && !e.isActive) return false;
    if (filterType !== 'all') {
      if (filterType === 'domains' && e.type !== 'domain') return false;
      if (filterType === 'infrastructure' && !['ip', 'asn', 'nameserver', 'certificate'].includes(e.type)) return false;
      if (filterType === 'financial' && !['wallet', 'contract'].includes(e.type)) return false;
      if (filterType === 'templates' && !['template', 'identifier'].includes(e.type)) return false;
    }
    return true;
  });

  const visibleEntityIds = new Set(visibleEntities.map(e => e.id));

  const visibleRelationships = relationships.filter(r => {
    if (!visibleEntityIds.has(r.sourceEntityId) || !visibleEntityIds.has(r.targetEntityId)) return false;
    if (filterState !== 'all' && r.state !== filterState) return false;
    return true;
  });

  // Selected item details
  const selectedEntity = entities.find(e => e.id === selectedEntityId);
  const selectedRel = relationships.find(r => r.id === selectedRelId);

  // SVG Pan & Zoom Handlers
  const handleMouseDown = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).tagName === 'svg' || (e.target as HTMLElement).id === 'graph-bg') {
      setIsPanning(true);
      setDragStart({ x: e.clientX - pan.x, y: e.clientY - pan.y });
    }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (isPanning) {
      setPan({ x: e.clientX - dragStart.x, y: e.clientY - dragStart.y });
    } else if (draggingNodeRef.current) {
      const nodeId = draggingNodeRef.current;
      const svgRect = e.currentTarget.getBoundingClientRect();
      const rawX = (e.clientX - svgRect.left - pan.x) / zoom;
      const rawY = (e.clientY - svgRect.top - pan.y) / zoom;
      setPositions(prev => ({ ...prev, [nodeId]: { x: rawX, y: rawY } }));
    }
  };

  const handleMouseUp = () => {
    setIsPanning(false);
    draggingNodeRef.current = null;
  };

  const getNodeIcon = (type: string) => {
    switch (type) {
      case 'domain':
        return <Globe className="w-3.5 h-3.5" />;
      case 'ip':
        return <Server className="w-3.5 h-3.5" />;
      case 'nameserver':
        return <Radio className="w-3.5 h-3.5" />;
      case 'certificate':
        return <Shield className="w-3.5 h-3.5" />;
      case 'template':
        return <Code className="w-3.5 h-3.5" />;
      case 'identifier':
        return <Tag className="w-3.5 h-3.5" />;
      case 'contract':
        return <Coins className="w-3.5 h-3.5" />;
      case 'wallet':
        return <Wallet className="w-3.5 h-3.5" />;
      default:
        return <Layers className="w-3.5 h-3.5" />;
    }
  };

  const getNodeColor = (type: string, isSelected: boolean) => {
    if (isSelected) return 'stroke-blue-400 stroke-[2.5] fill-[#13203c]';
    switch (type) {
      case 'domain':
        return 'stroke-sky-500 fill-[#0d1c33]';
      case 'ip':
        return 'stroke-indigo-500 fill-[#121936]';
      case 'certificate':
        return 'stroke-emerald-500 fill-[#0d2620]';
      case 'template':
        return 'stroke-purple-500 fill-[#201435]';
      case 'identifier':
        return 'stroke-amber-500 fill-[#281d0e]';
      case 'contract':
        return 'stroke-rose-500 fill-[#2b1219]';
      case 'wallet':
        return 'stroke-fuchsia-500 fill-[#2a132e]';
      default:
        return 'stroke-slate-500 fill-[#121724]';
    }
  };

  const getEdgeColor = (state: string, isSelected: boolean) => {
    if (isSelected) return '#60a5fa';
    switch (state) {
      case 'OBSERVED':
        return '#34d399';
      case 'SUPPORTED':
        return '#38bdf8';
      case 'CORRELATED':
        return '#818cf8';
      case 'HYPOTHESIZED':
        return '#fbbf24';
      case 'CONTRADICTED':
        return '#f43f5e';
      default:
        return '#475569';
    }
  };

  return (
    <div className="relative w-full h-[calc(100vh-8.5rem)] rounded-2xl bg-[#080b11] border border-[#162035] overflow-hidden flex flex-col">
      {/* Top Toolbar */}
      <div className="h-14 px-4 bg-[#090d16]/90 backdrop-blur-md border-b border-[#162035] flex items-center justify-between select-none z-10">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5 text-xs text-slate-400">
            <Filter className="w-3.5 h-3.5 text-blue-400" />
            <span className="font-semibold uppercase text-[10px] tracking-wider text-slate-500">Filter:</span>
          </div>

          <select
            value={filterType}
            onChange={e => setFilterType(e.target.value)}
            className="text-xs font-mono px-2.5 py-1 rounded bg-[#0e1422] border border-[#1b253b] text-slate-200"
          >
            <option value="all">All Entities ({entities.length})</option>
            <option value="domains">Domains Only</option>
            <option value="infrastructure">Infrastructure (IP/NS/Cert)</option>
            <option value="financial">Financial (Wallets/Contracts)</option>
            <option value="templates">Templates & Identifiers</option>
          </select>

          <select
            value={filterState}
            onChange={e => setFilterState(e.target.value)}
            className="text-xs font-mono px-2.5 py-1 rounded bg-[#0e1422] border border-[#1b253b] text-slate-200"
          >
            <option value="all">All States ({relationships.length})</option>
            <option value="OBSERVED">OBSERVED</option>
            <option value="SUPPORTED">SUPPORTED</option>
            <option value="CORRELATED">CORRELATED</option>
            <option value="HYPOTHESIZED">HYPOTHESIZED</option>
            <option value="CONTRADICTED">CONTRADICTED</option>
          </select>

          <div className="flex items-center gap-2 pl-2 border-l border-slate-800">
            <input
              type="checkbox"
              id="activeOnly"
              checked={showActiveOnly}
              onChange={e => setShowActiveOnly(e.target.checked)}
              className="rounded bg-[#0e1422] border-slate-700 text-blue-500"
            />
            <label htmlFor="activeOnly" className="text-xs text-slate-400 cursor-pointer">
              Active Infrastructure Only
            </label>
          </div>
        </div>

        {/* View Controls & Legend */}
        <div className="flex items-center gap-2">
          {/* Edge State Legend */}
          <div className="hidden lg:flex items-center gap-2 mr-3 text-[10px] font-mono text-slate-400">
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-emerald-400"></span>Observed</span>
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-sky-400"></span>Supported</span>
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-amber-400"></span>Hypothesized</span>
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-rose-400"></span>Contradicted</span>
          </div>

          <button
            onClick={() => setZoom(z => Math.min(z + 0.15, 2.5))}
            className="p-1.5 rounded bg-[#0e1422] border border-[#1b253b] text-slate-400 hover:text-slate-200"
            title="Zoom In"
          >
            <ZoomIn className="w-4 h-4" />
          </button>
          <button
            onClick={() => setZoom(z => Math.max(z - 0.15, 0.4))}
            className="p-1.5 rounded bg-[#0e1422] border border-[#1b253b] text-slate-400 hover:text-slate-200"
            title="Zoom Out"
          >
            <ZoomOut className="w-4 h-4" />
          </button>
          <button
            onClick={() => {
              setZoom(1);
              setPan({ x: 450, y: 320 });
            }}
            className="p-1.5 rounded bg-[#0e1422] border border-[#1b253b] text-slate-400 hover:text-slate-200"
            title="Reset Canvas View"
          >
            <RotateCcw className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Main SVG Graph Canvas */}
      <div
        className="flex-1 w-full h-full relative cursor-grab active:cursor-grabbing bg-[#080b11]"
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
      >
        <svg
          className="w-full h-full select-none"
          id="graph-bg"
        >
          <defs>
            {/* Grid Pattern */}
            <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
              <path d="M 40 0 L 0 0 0 40" fill="none" stroke="#101726" strokeWidth="0.8" />
            </pattern>

            {/* Arrowhead markers */}
            {['OBSERVED', 'SUPPORTED', 'CORRELATED', 'HYPOTHESIZED', 'CONTRADICTED'].map(st => (
              <marker
                key={st}
                id={`arrow-${st}`}
                viewBox="0 0 10 10"
                refX="22"
                refY="5"
                markerWidth="6"
                markerHeight="6"
                orient="auto-start-reverse"
              >
                <path d="M 0 1 L 9 5 L 0 9 z" fill={getEdgeColor(st, false)} />
              </marker>
            ))}
          </defs>

          {/* Background Grid */}
          <rect width="100%" height="100%" fill="url(#grid)" />

          <g transform={`translate(${pan.x}, ${pan.y}) scale(${zoom})`}>
            {/* Edge Lines */}
            {visibleRelationships.map(rel => {
              const srcPos = positions[rel.sourceEntityId];
              const tgtPos = positions[rel.targetEntityId];
              if (!srcPos || !tgtPos) return null;

              const isSelected = selectedRelId === rel.id;
              const isConnectedToSelectedNode =
                selectedEntityId === rel.sourceEntityId || selectedEntityId === rel.targetEntityId;

              const edgeColor = getEdgeColor(rel.state, isSelected || isConnectedToSelectedNode);

              // Calculate midpoint for label
              const midX = (srcPos.x + tgtPos.x) / 2;
              const midY = (srcPos.y + tgtPos.y) / 2;

              return (
                <g key={rel.id} className="cursor-pointer">
                  {/* Invisible thicker stroke for easier clicking */}
                  <line
                    x1={srcPos.x}
                    y1={srcPos.y}
                    x2={tgtPos.x}
                    y2={tgtPos.y}
                    stroke="transparent"
                    strokeWidth={14}
                    onClick={e => {
                      e.stopPropagation();
                      setSelectedRelId(rel.id);
                      setSelectedEntityId(null);
                    }}
                  />
                  {/* Rendered line */}
                  <line
                    x1={srcPos.x}
                    y1={srcPos.y}
                    x2={tgtPos.x}
                    y2={tgtPos.y}
                    stroke={edgeColor}
                    strokeWidth={isSelected || isConnectedToSelectedNode ? 2.5 : 1.5}
                    strokeDasharray={rel.state === 'HYPOTHESIZED' ? '4 3' : rel.state === 'CONTRADICTED' ? '2 3' : undefined}
                    markerEnd={`url(#arrow-${rel.state})`}
                    opacity={isSelected || isConnectedToSelectedNode ? 1 : 0.75}
                  />
                  {/* Subtle edge type badge */}
                  <text
                    x={midX}
                    y={midY - 4}
                    fill={edgeColor}
                    fontSize="9"
                    fontFamily="monospace"
                    textAnchor="middle"
                    className="select-none pointer-events-none font-bold"
                  >
                    {rel.type} ({Math.round(rel.confidence * 100)}%)
                  </text>
                </g>
              );
            })}

            {/* Nodes */}
            {visibleEntities.map(entity => {
              const pos = positions[entity.id] || { x: 0, y: 0 };
              const isSelected = selectedEntityId === entity.id;

              return (
                <g
                  key={entity.id}
                  transform={`translate(${pos.x}, ${pos.y})`}
                  className="cursor-pointer"
                  onMouseDown={e => {
                    e.stopPropagation();
                    draggingNodeRef.current = entity.id;
                  }}
                  onClick={e => {
                    e.stopPropagation();
                    setSelectedEntityId(entity.id);
                    setSelectedRelId(null);
                  }}
                >
                  {/* Outer circle */}
                  <circle
                    r={isSelected ? 22 : 18}
                    className={`${getNodeColor(entity.type, isSelected)} transition-all`}
                  />

                  {/* Icon */}
                  <foreignObject
                    x={-8}
                    y={-8}
                    width={16}
                    height={16}
                    className="pointer-events-none text-slate-200"
                  >
                    <div className="w-full h-full flex items-center justify-center">
                      {getNodeIcon(entity.type)}
                    </div>
                  </foreignObject>

                  {/* Label */}
                  <text
                    y={28}
                    textAnchor="middle"
                    fill={isSelected ? '#93c5fd' : '#cbd5e1'}
                    fontSize="10"
                    fontFamily="sans-serif"
                    className="font-medium pointer-events-none select-none drop-shadow-md"
                  >
                    {entity.label.length > 22 ? entity.label.slice(0, 20) + '...' : entity.label}
                  </text>

                  {/* Seed Badge */}
                  {entity.isSeed && (
                    <text
                      y={-24}
                      textAnchor="middle"
                      fill="#60a5fa"
                      fontSize="8"
                      fontFamily="monospace"
                      fontWeight="bold"
                    >
                      ★ SEED
                    </text>
                  )}
                </g>
              );
            })}
          </g>
        </svg>

        {/* Selected Entity / Relationship Inspection Card (Bottom Right) */}
        {(selectedEntity || selectedRel) && (
          <div className="absolute right-4 bottom-4 w-96 p-4 rounded-xl bg-[#0d1322]/95 backdrop-blur-md border border-[#1b253b] shadow-2xl z-20 space-y-3">
            {selectedEntity && (
              <>
                <div className="flex items-center justify-between pb-2 border-b border-slate-800">
                  <div className="flex items-center gap-2">
                    <span className="p-1 rounded bg-slate-800 text-slate-300">
                      {getNodeIcon(selectedEntity.type)}
                    </span>
                    <span className="text-xs font-mono uppercase font-bold text-blue-400">
                      {selectedEntity.type}
                    </span>
                  </div>
                  <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-[#162035] text-slate-300">
                    {selectedEntity.isActive ? 'Active Node' : 'Rotated / Historical'}
                  </span>
                </div>

                <div className="text-xs font-mono font-bold text-slate-100 break-all">
                  {selectedEntity.value}
                </div>

                <div className="text-[11px] text-slate-400 space-y-1">
                  <div>First Seen: {new Date(selectedEntity.firstSeen).toLocaleDateString()}</div>
                  <div>Last Seen: {new Date(selectedEntity.lastSeen).toLocaleDateString()}</div>
                </div>

                <button
                  onClick={() => onInspectLineage('entity', selectedEntity)}
                  className="w-full flex items-center justify-center gap-2 py-2 rounded-lg bg-blue-600/30 border border-blue-500/50 text-blue-300 hover:bg-blue-600/40 text-xs font-semibold transition-colors"
                >
                  <Info className="w-3.5 h-3.5" />
                  <span>Why does the system believe this?</span>
                </button>
              </>
            )}

            {selectedRel && (
              <>
                <div className="flex items-center justify-between pb-2 border-b border-slate-800">
                  <span className="text-xs font-mono uppercase font-bold text-blue-400">
                    {selectedRel.type}
                  </span>
                  <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-blue-950/70 border border-blue-700/50 text-blue-300 font-bold">
                    {selectedRel.state}
                  </span>
                </div>

                <div className="text-xs font-mono text-slate-300">
                  Confidence: <strong className="text-blue-400">{Math.round(selectedRel.confidence * 100)}%</strong>
                </div>

                <p className="text-xs text-slate-300 bg-[#080b11] p-2.5 rounded-lg border border-slate-800/80 leading-relaxed">
                  {selectedRel.reasoning}
                </p>

                <button
                  onClick={() => onInspectLineage('relationship', selectedRel)}
                  className="w-full flex items-center justify-center gap-2 py-2 rounded-lg bg-blue-600/30 border border-blue-500/50 text-blue-300 hover:bg-blue-600/40 text-xs font-semibold transition-colors"
                >
                  <Info className="w-3.5 h-3.5" />
                  <span>Inspect Lineage & Evidence ({selectedRel.evidenceIds.length})</span>
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
