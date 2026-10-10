(root => {
  "use strict";

  const SUCCESS_TTL_MS = 6 * 60 * 60 * 1000;
  const FAILURE_TTL_MS = 10 * 60 * 1000;
  const REQUEST_TIMEOUT_MS = 12_000;

  function isoFromUnix(seconds) {
    return Number.isFinite(Number(seconds)) && Number(seconds) > 0 ? new Date(Number(seconds) * 1000).toISOString() : null;
  }

  function isoFromMilliseconds(milliseconds) {
    return Number.isFinite(Number(milliseconds)) && Number(milliseconds) > 0 ? new Date(Number(milliseconds)).toISOString() : null;
  }

  function decimalUnits(rawValue, decimals, maxFraction = 8) {
    const raw = BigInt(rawValue || 0);
    const negative = raw < 0n;
    const absolute = negative ? -raw : raw;
    const divisor = 10n ** BigInt(decimals);
    const whole = absolute / divisor;
    const fraction = (absolute % divisor).toString().padStart(decimals, "0").slice(0, maxFraction).replace(/0+$/, "");
    return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
  }

  async function requestJson(url, options = {}, fetchImpl = fetch) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetchImpl(url, { ...options, signal: controller.signal, cache: "no-store" });
      if (!response.ok) {
        const error = new Error(response.status === 429 ? "Provider rate limit reached. Try again later." : `Provider returned HTTP ${response.status}.`);
        error.status = response.status;
        throw error;
      }
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async function rpc(url, method, params, fetchImpl) {
    const payload = await requestJson(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
    }, fetchImpl);
    if (payload.error) {
      const error = new Error(payload.error.message || "Blockchain RPC returned an error.");
      error.code = payload.error.code;
      throw error;
    }
    if (payload.result?.status === "error" || payload.result?.error) {
      const error = new Error(payload.result.error_message || payload.result.error || "Blockchain RPC returned an error.");
      error.code = payload.result.error;
      throw error;
    }
    return payload.result;
  }

  function base(record, now, source) {
    return {
      status: "UNKNOWN",
      addressValid: true,
      validitySource: "Local format/checksum validation",
      network: record.network,
      activityExists: null,
      transactionCount: null,
      transactionCountLabel: null,
      firstActivity: null,
      lastActivity: null,
      balance: null,
      checkedAt: new Date(now).toISOString(),
      cacheExpiresAt: new Date(now + SUCCESS_TTL_MS).toISOString(),
      source,
      notes: [],
      error: null
    };
  }

  async function verifyBitcoin(record, fetchImpl, now) {
    const result = base(record, now, { name: "Blockstream Esplora", url: "https://blockstream.info" });
    const address = encodeURIComponent(record.address);
    const info = await requestJson(`https://blockstream.info/api/address/${address}`, {}, fetchImpl);
    const confirmed = Number(info.chain_stats?.tx_count || 0);
    const mempool = Number(info.mempool_stats?.tx_count || 0);
    const txCount = confirmed + mempool;
    const satoshis = BigInt(info.chain_stats?.funded_txo_sum || 0) - BigInt(info.chain_stats?.spent_txo_sum || 0) + BigInt(info.mempool_stats?.funded_txo_sum || 0) - BigInt(info.mempool_stats?.spent_txo_sum || 0);
    result.transactionCount = txCount;
    result.activityExists = txCount > 0;
    result.status = txCount > 0 ? "ACTIVE" : "NO ACTIVITY FOUND";
    result.balance = { value: decimalUnits(satoshis, 8), unit: "BTC", raw: satoshis.toString() };
    if (txCount > 0) {
      const transactions = await requestJson(`https://blockstream.info/api/address/${address}/txs`, {}, fetchImpl);
      result.lastActivity = isoFromUnix(transactions[0]?.status?.block_time);
      if (txCount <= transactions.length) result.firstActivity = isoFromUnix(transactions.at(-1)?.status?.block_time);
      else result.notes.push("First activity is unavailable without paging the address's complete history.");
    }
    return result;
  }

  async function verifyBlockCypher(record, chain, unit, fetchImpl, now) {
    const result = base(record, now, { name: "BlockCypher", url: "https://www.blockcypher.com" });
    const data = await requestJson(`https://api.blockcypher.com/v1/${chain}/main/addrs/${encodeURIComponent(record.address)}/balance`, {}, fetchImpl);
    const count = Number(data.n_tx || 0);
    result.transactionCount = count;
    result.activityExists = count > 0;
    result.status = count > 0 ? "ACTIVE" : "NO ACTIVITY FOUND";
    result.balance = { value: decimalUnits(BigInt(data.final_balance || 0), 8), unit, raw: String(data.final_balance || 0) };
    result.notes.push("This provider does not return first/last activity in the balance summary.");
    return result;
  }

  function evmCallData(address) {
    return `0x70a08231${address.toLowerCase().replace(/^0x/, "").padStart(64, "0")}`;
  }

  async function verifyEvm(record, config, fetchImpl, now) {
    const result = base(record, now, config.source);
    const [nativeHex, nonceHex] = await Promise.all([
      rpc(config.rpc, "eth_getBalance", [record.address, "latest"], fetchImpl),
      rpc(config.rpc, "eth_getTransactionCount", [record.address, "latest"], fetchImpl)
    ]);
    const native = BigInt(nativeHex || "0x0");
    const nonce = BigInt(nonceHex || "0x0");
    let balanceRaw = native;
    let balanceUnit = config.nativeUnit;
    let balanceDecimals = 18;
    if (config.usdt && /^USDT\b/i.test(record.network)) {
      const tokenHex = await rpc(config.rpc, "eth_call", [{ to: config.usdt.contract, data: evmCallData(record.address) }, "latest"], fetchImpl);
      balanceRaw = BigInt(tokenHex || "0x0");
      balanceUnit = "USDT";
      balanceDecimals = config.usdt.decimals;
    }
    result.transactionCount = Number(nonce);
    result.transactionCountLabel = "Outgoing account nonce";
    result.balance = { value: decimalUnits(balanceRaw, balanceDecimals), unit: balanceUnit, raw: balanceRaw.toString() };
    const positiveEvidence = nonce > 0n || native > 0n || balanceRaw > 0n;
    result.activityExists = positiveEvidence ? true : null;
    result.status = positiveEvidence ? "ACTIVE" : "UNKNOWN";
    result.notes.push("EVM transaction count is the outgoing account nonce; incoming and token transfers may not be included.");
    if (!positiveEvidence) result.notes.push("A zero nonce and balance cannot prove that this address has never had activity.");
    return result;
  }

  async function verifyTron(record, fetchImpl, now) {
    const result = base(record, now, { name: "TRONGrid", url: "https://www.trongrid.io" });
    const account = await requestJson("https://api.trongrid.io/wallet/getaccount", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address: record.address, visible: true })
    }, fetchImpl);
    const trc20 = await requestJson(`https://api.trongrid.io/v1/accounts/${encodeURIComponent(record.address)}/transactions/trc20?only_confirmed=true&limit=1`, {}, fetchImpl).catch(() => ({ data: [] }));
    const activated = Boolean(account.address);
    const latestToken = trc20.data?.[0]?.block_timestamp;
    result.activityExists = activated || Boolean(latestToken);
    result.status = result.activityExists ? "ACTIVE" : "NO ACTIVITY FOUND";
    result.firstActivity = isoFromMilliseconds(account.create_time);
    result.lastActivity = isoFromMilliseconds(latestToken || account.latest_opration_time);
    result.balance = { value: decimalUnits(BigInt(account.balance || 0), 6), unit: "TRX (native)", raw: String(account.balance || 0) };
    result.notes.push("Native TRX balance does not include TRC20 token balances.");
    return result;
  }

  function rippleDate(value) {
    return value == null ? null : isoFromUnix(Number(value) + 946684800);
  }

  async function verifyXrp(record, fetchImpl, now) {
    const source = { name: "XRPL public server", url: "https://xrpl.org" };
    const result = base(record, now, source);
    let info;
    try {
      info = await rpc("https://s1.ripple.com:51234/", "account_info", [{ account: record.address, ledger_index: "validated", strict: true }], fetchImpl);
    } catch (error) {
      if (/not found|actNotFound/i.test(error.message || "") || error.code === 19 || error.code === "actNotFound") {
        result.activityExists = false;
        result.status = "NO ACTIVITY FOUND";
        result.balance = { value: "0", unit: "XRP", raw: "0" };
        return result;
      }
      throw error;
    }
    const [newest, oldest] = await Promise.all([
      rpc("https://s1.ripple.com:51234/", "account_tx", [{ account: record.address, ledger_index_min: -1, ledger_index_max: -1, binary: false, forward: false, limit: 1 }], fetchImpl),
      rpc("https://s1.ripple.com:51234/", "account_tx", [{ account: record.address, ledger_index_min: -1, ledger_index_max: -1, binary: false, forward: true, limit: 1 }], fetchImpl)
    ]);
    result.activityExists = true;
    result.status = "ACTIVE";
    result.balance = { value: decimalUnits(BigInt(info.account_data?.Balance || 0), 6), unit: "XRP", raw: String(info.account_data?.Balance || 0) };
    result.lastActivity = rippleDate(newest.transactions?.[0]?.tx?.date || newest.transactions?.[0]?.tx_json?.date);
    result.firstActivity = rippleDate(oldest.transactions?.[0]?.tx?.date || oldest.transactions?.[0]?.tx_json?.date);
    return result;
  }

  async function verifySolana(record, fetchImpl, now) {
    const endpoint = "https://api.mainnet-beta.solana.com";
    const result = base(record, now, { name: "Solana mainnet RPC", url: "https://solana.com" });
    const [balanceResponse, signatures] = await Promise.all([
      rpc(endpoint, "getBalance", [record.address, { commitment: "confirmed" }], fetchImpl),
      rpc(endpoint, "getSignaturesForAddress", [record.address, { limit: 100, commitment: "confirmed" }], fetchImpl)
    ]);
    const lamports = BigInt(balanceResponse?.value || 0);
    result.balance = { value: decimalUnits(lamports, 9), unit: "SOL", raw: lamports.toString() };
    result.activityExists = signatures.length > 0;
    result.status = signatures.length > 0 ? "ACTIVE" : "NO ACTIVITY FOUND";
    result.lastActivity = isoFromUnix(signatures[0]?.blockTime);
    if (signatures.length < 100) {
      result.transactionCount = signatures.length;
      result.firstActivity = isoFromUnix(signatures.at(-1)?.blockTime);
    } else {
      result.notes.push("At least 100 signatures were found; full count and first activity were not requested to avoid heavy API use.");
    }
    return result;
  }

  function providerFor(network = "") {
    if (/uncertain|possible/i.test(network)) return null;
    if (/Bitcoin \(BTC\)/i.test(network)) return "bitcoin";
    if (/Litecoin/i.test(network)) return "litecoin";
    if (/Dogecoin/i.test(network)) return "dogecoin";
    if (/TRON|TRC20/i.test(network)) return "tron";
    if (/XRP/i.test(network)) return "xrp";
    if (/Solana/i.test(network)) return "solana";
    if (/BNB Smart Chain|BSC|BEP20/i.test(network)) return "bsc";
    if (/Ethereum|ERC20|EVM/i.test(network)) return "ethereum";
    return null;
  }

  function sourceForProvider(provider) {
    return ({
      bitcoin: { name: "Blockstream Esplora", url: "https://blockstream.info" },
      litecoin: { name: "BlockCypher", url: "https://www.blockcypher.com" },
      dogecoin: { name: "BlockCypher", url: "https://www.blockcypher.com" },
      tron: { name: "TRONGrid", url: "https://www.trongrid.io" },
      xrp: { name: "XRPL public server", url: "https://xrpl.org" },
      solana: { name: "Solana mainnet RPC", url: "https://solana.com" },
      bsc: { name: "BNB Smart Chain public RPC", url: "https://www.bnbchain.org" },
      ethereum: { name: "Cloudflare Ethereum Gateway", url: "https://developers.cloudflare.com/web3" }
    })[provider] || { name: "Blockchain provider", url: null };
  }

  async function verify(record, options = {}) {
    const now = options.now || Date.now();
    const fetchImpl = options.fetchImpl || fetch;
    const provider = providerFor(record.network);
    if (!provider) {
      const unsupported = base(record, now, { name: "No compatible provider", url: null });
      unsupported.notes.push("Automatic blockchain verification is not available for this classification.");
      return unsupported;
    }
    try {
      if (provider === "bitcoin") return await verifyBitcoin(record, fetchImpl, now);
      if (provider === "litecoin") return await verifyBlockCypher(record, "ltc", "LTC", fetchImpl, now);
      if (provider === "dogecoin") return await verifyBlockCypher(record, "doge", "DOGE", fetchImpl, now);
      if (provider === "tron") return await verifyTron(record, fetchImpl, now);
      if (provider === "xrp") return await verifyXrp(record, fetchImpl, now);
      if (provider === "solana") return await verifySolana(record, fetchImpl, now);
      if (provider === "bsc") return await verifyEvm(record, {
        rpc: "https://bsc-dataseed.bnbchain.org", nativeUnit: "BNB",
        usdt: { contract: "0x55d398326f99059fF775485246999027B3197955", decimals: 18 },
        source: { name: "BNB Smart Chain public RPC", url: "https://www.bnbchain.org" }
      }, fetchImpl, now);
      return await verifyEvm(record, {
        rpc: "https://cloudflare-eth.com", nativeUnit: "ETH",
        usdt: { contract: "0xdAC17F958D2ee523a2206206994597C13D831ec7", decimals: 6 },
        source: { name: "Cloudflare Ethereum Gateway", url: "https://developers.cloudflare.com/web3" }
      }, fetchImpl, now);
    } catch (error) {
      const failed = base(record, now, sourceForProvider(provider));
      failed.status = "VERIFICATION FAILED";
      failed.error = error.name === "AbortError" ? "Verification request timed out." : String(error.message || "Verification failed.").slice(0, 240);
      failed.cacheExpiresAt = new Date(now + FAILURE_TTL_MS).toISOString();
      return failed;
    }
  }

  function cacheFresh(verification, now = Date.now()) {
    return Boolean(verification?.cacheExpiresAt && new Date(verification.cacheExpiresAt).getTime() > now);
  }

  root.BlockchainVerifier = { verify, providerFor, sourceForProvider, cacheFresh, decimalUnits, SUCCESS_TTL_MS, FAILURE_TTL_MS };
  if (typeof module !== "undefined" && module.exports) module.exports = root.BlockchainVerifier;
})(globalThis);
