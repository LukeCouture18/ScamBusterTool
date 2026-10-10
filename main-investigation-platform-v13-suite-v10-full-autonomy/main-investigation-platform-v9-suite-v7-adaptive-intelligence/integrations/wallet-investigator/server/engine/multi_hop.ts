/**
 * Controlled Multi-Hop Graph Expansion Engine
 * Enforces strict hard limits on depth, wallet count, branches, and API budgets.
 */

import { BlockchainNetwork, DataCompleteness } from '../../src/types';
import { queryAll } from '../db/database';
import { globalProviderManager } from '../providers/manager';

export interface MultiHopConfig {
  max_depth: number; // 0, 1, 2, or 3
  max_wallets: number; // e.g. 25
  max_transactions: number; // e.g. 100
  max_api_calls: number; // e.g. 10
  max_branches_per_node: number; // e.g. 5
  timeout_ms: number; // e.g. 15000
}

export const DEFAULT_MULTI_HOP_CONFIG: MultiHopConfig = {
  max_depth: 2,
  max_wallets: 20,
  max_transactions: 100,
  max_api_calls: 5,
  max_branches_per_node: 4,
  timeout_ms: 10000,
};

export interface MultiHopResult {
  root_address: string;
  depth_reached: number;
  wallets_visited: string[];
  total_transactions_retrieved: number;
  api_calls_made: number;
  budget_exhausted: boolean;
  completeness: DataCompleteness;
  warning?: string;
  graph_nodes: Array<{ address: string; depth: number; network: BlockchainNetwork }>;
  graph_edges: Array<{ from: string; to: string; tx_hash: string; asset: string; amount_display: string }>;
}

export async function runControlledMultiHopTrace(
  rootAddress: string,
  network: BlockchainNetwork,
  userConfig: Partial<MultiHopConfig> = {}
): Promise<MultiHopResult> {
  const config: MultiHopConfig = {
    ...DEFAULT_MULTI_HOP_CONFIG,
    ...userConfig,
    max_depth: Math.min(Math.max(userConfig.max_depth ?? DEFAULT_MULTI_HOP_CONFIG.max_depth, 0), 3), // hard ceiling of 3
  };

  const startTime = Date.now();
  const visitedWallets = new Set<string>();
  const nodesMap = new Map<string, { address: string; depth: number; network: BlockchainNetwork }>();
  const edges: MultiHopResult['graph_edges'] = [];

  let apiCallsMade = 0;
  let totalTxs = 0;
  let budgetExhausted = false;

  // BFS Queue: [address, currentDepth]
  const queue: Array<{ address: string; depth: number }> = [{ address: rootAddress, depth: 0 }];
  nodesMap.set(rootAddress.toLowerCase(), { address: rootAddress, depth: 0, network });

  while (queue.length > 0) {
    // Check runtime timeout
    if (Date.now() - startTime > config.timeout_ms) {
      budgetExhausted = true;
      break;
    }

    // Check wallet count ceiling
    if (visitedWallets.size >= config.max_wallets) {
      budgetExhausted = true;
      break;
    }

    const current = queue.shift()!;
    const lowerCurrent = current.address.toLowerCase();

    if (visitedWallets.has(lowerCurrent)) continue;
    visitedWallets.add(lowerCurrent);

    if (current.depth >= config.max_depth) continue;

    // Check local database for transactions first
    let txs = queryAll<{
      from_address: string;
      to_address: string;
      tx_hash: string;
      asset: string;
      display_amount: string;
    }>(
      `SELECT from_address, to_address, tx_hash, asset, display_amount
       FROM transactions
       WHERE LOWER(from_address) = ? OR LOWER(to_address) = ?
       LIMIT ?;`,
      [lowerCurrent, lowerCurrent, config.max_branches_per_node]
    );

    // If not found in local DB and we have remaining API budget, query provider
    if (txs.length === 0 && apiCallsMade < config.max_api_calls) {
      apiCallsMade++;
      try {
        const fetchRes = await globalProviderManager.fetchActivity(current.address, network, { max_pages: 1 });
        txs = fetchRes.transactions.slice(0, config.max_branches_per_node).map((t) => ({
          from_address: t.from_address,
          to_address: t.to_address,
          tx_hash: t.tx_hash,
          asset: t.asset,
          display_amount: t.raw_amount,
        }));
      } catch {
        // Provider fail, proceed
      }
    }

    totalTxs += txs.length;

    // Expand counterparties up to branch limit
    let branchesCreated = 0;
    for (const tx of txs) {
      if (branchesCreated >= config.max_branches_per_node) break;

      const isSender = tx.from_address.toLowerCase() === lowerCurrent;
      const targetNeighbor = isSender ? tx.to_address : tx.from_address;
      const lowerNeighbor = targetNeighbor.toLowerCase();

      edges.push({
        from: tx.from_address,
        to: tx.to_address,
        tx_hash: tx.tx_hash,
        asset: tx.asset,
        amount_display: tx.display_amount,
      });

      if (!nodesMap.has(lowerNeighbor)) {
        nodesMap.set(lowerNeighbor, {
          address: targetNeighbor,
          depth: current.depth + 1,
          network,
        });

        if (current.depth + 1 < config.max_depth) {
          queue.push({ address: targetNeighbor, depth: current.depth + 1 });
        }
        branchesCreated++;
      }
    }
  }

  const completeness: DataCompleteness = budgetExhausted ? 'LIMITED' : 'COMPLETE';
  return {
    root_address: rootAddress,
    depth_reached: Math.max(...Array.from(nodesMap.values()).map((n) => n.depth), 0),
    wallets_visited: Array.from(visitedWallets),
    total_transactions_retrieved: totalTxs,
    api_calls_made: apiCallsMade,
    budget_exhausted: budgetExhausted,
    completeness,
    warning: budgetExhausted ? 'Controlled multi-hop stopped because configured depth or wallet safety limits were reached.' : undefined,
    graph_nodes: Array.from(nodesMap.values()),
    graph_edges: edges,
  };
}
