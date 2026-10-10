/**
 * Path Finder Engine
 * Evaluates whether Wallet A is connected to Wallet B within N hops.
 * Searches local database graph first, followed by controlled provider expansion.
 */

import { BlockchainNetwork, DataCompleteness, PathFinderQuery, PathResult } from '../../src/types';
import { queryAll } from '../db/database';
import { globalProviderManager } from '../providers/manager';

interface GraphEdgeDetail {
  from: string;
  to: string;
  asset: string;
  amount_display: string;
  tx_hash: string;
  timestamp: number;
  evidence_id?: string;
}

export async function findPathBetweenWallets(query: PathFinderQuery): Promise<PathResult> {
  const maxHops = Math.min(Math.max(query.max_hops || 2, 1), 4);
  const startAddr = query.source_address.trim().toLowerCase();
  const targetAddr = query.target_address.trim().toLowerCase();

  if (startAddr === targetAddr) {
    return {
      found: true,
      hops: 0,
      path_addresses: [query.source_address],
      edges: [],
      evidence_ids: [],
      completeness: 'COMPLETE',
    };
  }

  // BFS search queue: [currentAddress, pathAddresses, edges, evidenceIds]
  const queue: Array<{
    current: string;
    path: string[];
    edges: GraphEdgeDetail[];
    evidenceIds: string[];
  }> = [
    {
      current: startAddr,
      path: [query.source_address],
      edges: [],
      evidenceIds: [],
    },
  ];

  const visited = new Set<string>([startAddr]);
  let apiCallsUsed = 0;
  const maxApiCalls = query.allow_provider_expansion ? 4 : 0;

  while (queue.length > 0) {
    const item = queue.shift()!;
    const currentHops = item.edges.length;

    if (currentHops >= maxHops) continue;

    // Search local database edges
    let outgoingTxs = queryAll<{
      from_address: string;
      to_address: string;
      asset: string;
      display_amount: string;
      tx_hash: string;
      timestamp: number;
      evidence_id: string;
    }>(
      `SELECT from_address, to_address, asset, display_amount, tx_hash, timestamp, evidence_id
       FROM transactions
       WHERE LOWER(from_address) = ? OR LOWER(to_address) = ?
       LIMIT 20;`,
      [item.current, item.current]
    );

    // If no local txs and provider expansion allowed
    if (outgoingTxs.length === 0 && apiCallsUsed < maxApiCalls) {
      apiCallsUsed++;
      try {
        const net = query.networks?.[0] || 'bitcoin';
        const res = await globalProviderManager.fetchActivity(item.current, net, { max_pages: 1 });
        outgoingTxs = res.transactions.slice(0, 10).map((t) => ({
          from_address: t.from_address,
          to_address: t.to_address,
          asset: t.asset,
          display_amount: t.raw_amount,
          tx_hash: t.tx_hash,
          timestamp: t.timestamp,
          evidence_id: 'provider_evidence',
        }));
      } catch {
        // proceed
      }
    }

    for (const tx of outgoingTxs) {
      const isFrom = tx.from_address.toLowerCase() === item.current;
      const neighbor = isFrom ? tx.to_address : tx.from_address;
      const lowerNeighbor = neighbor.toLowerCase();

      const edgeDetail: GraphEdgeDetail = {
        from: tx.from_address,
        to: tx.to_address,
        asset: tx.asset,
        amount_display: tx.display_amount,
        tx_hash: tx.tx_hash,
        timestamp: tx.timestamp,
        evidence_id: tx.evidence_id,
      };

      const newEdges = [...item.edges, edgeDetail];
      const newPath = [...item.path, neighbor];
      const newEvidences = tx.evidence_id ? [...item.evidenceIds, tx.evidence_id] : item.evidenceIds;

      // Check if target reached!
      if (lowerNeighbor === targetAddr) {
        return {
          found: true,
          hops: newEdges.length,
          path_addresses: newPath,
          edges: newEdges,
          evidence_ids: newEvidences,
          completeness: 'COMPLETE',
        };
      }

      if (!visited.has(lowerNeighbor) && currentHops + 1 < maxHops) {
        visited.add(lowerNeighbor);
        queue.push({
          current: lowerNeighbor,
          path: newPath,
          edges: newEdges,
          evidenceIds: newEvidences,
        });
      }
    }
  }

  return {
    found: false,
    hops: 0,
    path_addresses: [],
    edges: [],
    evidence_ids: [],
    completeness: apiCallsUsed >= maxApiCalls && query.allow_provider_expansion ? 'LIMITED' : 'COMPLETE',
  };
}
