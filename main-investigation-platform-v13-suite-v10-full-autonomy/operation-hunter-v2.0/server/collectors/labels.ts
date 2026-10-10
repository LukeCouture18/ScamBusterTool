/**
 * A deliberately small set of well-known public address labels used to
 * recognise shared services (exchanges, mixers, token contracts, protocol
 * routers) so pursuit does not wander into them and so cash-out points can be
 * described. Source: public block-explorer tags. Analysts can add more labels
 * in Settings; collector responses (e.g. Blockscout names) add labels too.
 */
export const BUNDLED_LABELS: Array<{ value: string; label: string; kind: string }> = [
  { value: '0xd90e2f925da726b50c4ed8d0fb90ad053324f31', label: 'Tornado Cash Router', kind: 'mixer' },
  { value: '0xa160cdab225685da1d56aa342ad8841c3b53f291', label: 'Tornado Cash 100 ETH pool', kind: 'mixer' },
  { value: '0x910cbd523d972eb0a6f4cae4618ad62622b39dbf', label: 'Tornado Cash 10 ETH pool', kind: 'mixer' },
  { value: '0x47ce0c6ed5b0ce3d3a51fdb1c52dc66a7c3c2936', label: 'Tornado Cash 1 ETH pool', kind: 'mixer' },
  { value: '0x28c6c06298d514db089934071355e5743bf21d60', label: 'Binance 14 (hot wallet)', kind: 'exchange' },
  { value: '0x21a31ee1afc51d94c2efccaa2092ad1028285549', label: 'Binance 15 (hot wallet)', kind: 'exchange' },
  { value: '0xdfd5293d8e347dfe59e90efd55b2956a1343963d', label: 'Binance 16 (hot wallet)', kind: 'exchange' },
  { value: '0x6cc5f688a315f3dc28a7781717a9a798a59fda7b', label: 'OKX (hot wallet)', kind: 'exchange' },
  { value: '0x000000000022d473030f116ddee9f6b43ac78ba3', label: 'Uniswap Permit2', kind: 'protocol' },
  { value: '0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad', label: 'Uniswap Universal Router', kind: 'protocol' },
  { value: '0xdac17f958d2ee523a2206206994597c13d831ec7', label: 'Tether USD (USDT) token contract', kind: 'token' },
  { value: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', label: 'USD Coin (USDC) token contract', kind: 'token' },
  { value: 'tr7nhqjekqxgtci8q8zy4pl8otszgjlj6t', label: 'Tether USD (USDT-TRC20) token contract', kind: 'token' },
];

export const LABEL_SOURCE = 'bundled public explorer tag (verify before relying on it)';
