(() => {
  "use strict";

  const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const RIPPLE58 = "rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz";
  const MAX_SOURCE_LENGTH = 2_000_000;
  const MAX_CONTEXT_LENGTH = 600;
  const TOKEN_SYMBOLS = ["USDT", "USDC", "DAI", "WBTC", "LINK", "UNI", "SHIB"];

  const PATTERNS = [
    /\bbc1[ac-hj-np-z02-9]{11,71}\b/gi,
    /\b[13][a-km-zA-HJ-NP-Z1-9]{25,34}\b/g,
    /\b0x[a-fA-F0-9]{40}\b/g,
    /\bT[1-9A-HJ-NP-Za-km-z]{33}\b/g,
    /\br[1-9A-HJ-NP-Za-km-z]{24,34}\b/g,
    /\bltc1[ac-hj-np-z02-9]{11,71}\b/gi,
    /\b[LM][1-9A-HJ-NP-Za-km-z]{26,33}\b/g,
    /\bD[1-9A-HJ-NP-Za-km-z]{25,33}\b/g,
    /\bbnb1[ac-hj-np-z02-9]{20,80}\b/gi,
    /(?<![A-Za-z0-9])[1-9A-HJ-NP-Za-km-z]{32,44}(?![A-Za-z0-9])/g
  ];

  function cleanText(value, limit = MAX_CONTEXT_LENGTH) {
    return String(value || "")
      .replace(/[\u200B-\u200D\uFEFF]/g, "")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
      .slice(0, limit);
  }

  function bytesEqual(a, b, count = Math.min(a.length, b.length)) {
    for (let index = 0; index < count; index += 1) if (a[index] !== b[index]) return false;
    return true;
  }

  function decodeBase58(value, alphabet = BASE58) {
    let number = 0n;
    const base = BigInt(alphabet.length);
    for (const char of value) {
      const index = alphabet.indexOf(char);
      if (index < 0) return null;
      number = number * base + BigInt(index);
    }
    const bytes = [];
    while (number > 0n) {
      bytes.push(Number(number & 255n));
      number >>= 8n;
    }
    bytes.reverse();
    let leadingZeroes = 0;
    while (leadingZeroes < value.length && value[leadingZeroes] === alphabet[0]) leadingZeroes += 1;
    return new Uint8Array([...new Array(leadingZeroes).fill(0), ...bytes]);
  }

  async function sha256(bytes) {
    return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  }

  async function validBase58Check(value, alphabet = BASE58, expectedVersions = null) {
    const decoded = decodeBase58(value, alphabet);
    if (!decoded || decoded.length < 5) return false;
    if (expectedVersions && !expectedVersions.includes(decoded[0])) return false;
    const payload = decoded.slice(0, -4);
    const first = await sha256(payload);
    const second = await sha256(first);
    return bytesEqual(decoded.slice(-4), second, 4);
  }

  function bech32Polymod(values) {
    const generator = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
    let checksum = 1;
    for (const value of values) {
      const top = checksum >>> 25;
      checksum = ((checksum & 0x1ffffff) << 5) ^ value;
      for (let index = 0; index < 5; index += 1) if ((top >>> index) & 1) checksum ^= generator[index];
    }
    return checksum >>> 0;
  }

  function bech32ExpandHrp(hrp) {
    return [...hrp].map(char => char.charCodeAt(0) >>> 5).concat([0], [...hrp].map(char => char.charCodeAt(0) & 31));
  }

  function validBech32(value, allowedHrps) {
    if (value !== value.toLowerCase() && value !== value.toUpperCase()) return false;
    const lower = value.toLowerCase();
    const separator = lower.lastIndexOf("1");
    if (separator < 1 || separator + 7 > lower.length) return false;
    const hrp = lower.slice(0, separator);
    if (!allowedHrps.includes(hrp)) return false;
    const charset = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
    const data = [...lower.slice(separator + 1)].map(char => charset.indexOf(char));
    if (data.some(value => value < 0)) return false;
    const check = bech32Polymod(bech32ExpandHrp(hrp).concat(data));
    return check === 1 || check === 0x2bc830a3;
  }

  function contextSignals(context) {
    const text = context.toLowerCase();
    const tokens = TOKEN_SYMBOLS.filter(symbol => new RegExp(`\\b${symbol.toLowerCase()}\\b`, "i").test(text));
    const usdt = tokens.includes("USDT") || /\btether\b/.test(text);
    const erc20 = /\berc[- ]?20\b/.test(text);
    const bep20 = /\bbep[- ]?20\b/.test(text);
    const trc20 = /\btrc[- ]?20\b/.test(text);
    const eth = /\b(ethereum|eth)\b/.test(text);
    const bsc = /\b(bsc|bnb smart chain|binance smart chain)\b/.test(text);
    const tron = /\b(tron|trx)\b/.test(text) || trc20;
    const selectedErc20 = /\bselected\s+(?:network|chain|option)\s*:?\s*(?:ethereum|erc[- ]?20|eth)\b/.test(text);
    const selectedBep20 = /\bselected\s+(?:network|chain|option)\s*:?\s*(?:bsc|bep[- ]?20|bnb smart chain)\b/.test(text);
    const directErc20 = /\b(?:usdt|tether)\b[\s\S]{0,42}\b(?:erc[- ]?20|ethereum|eth)\b|\b(?:erc[- ]?20|ethereum|eth)\b[\s\S]{0,42}\b(?:usdt|tether)\b/.test(text);
    const directBep20 = /\b(?:usdt|tether)\b[\s\S]{0,42}\b(?:bep[- ]?20|bsc|bnb smart chain|binance smart chain)\b|\b(?:bep[- ]?20|bsc|bnb smart chain|binance smart chain)\b[\s\S]{0,42}\b(?:usdt|tether)\b/.test(text);
    return {
      text, tokens, usdt, erc20, bep20, trc20, eth, bsc, tron, selectedErc20, selectedBep20, directErc20, directBep20,
      payment: /\b(deposit|payment|pay to|send to|recipient|receiving|wallet|address|withdraw|withdrawal|funding|top up)\b/.test(text),
      explicitAddress: /\b(?:deposit|wallet|receiving|recipient|payment|withdrawal)\s+(?:wallet\s+)?address\b|\baddress\s+(?:for|to)\s+(?:deposit|receive|payment)\b/.test(text),
      negativeGeneric: /\b(transaction|tx|block|order|request|session|reference|signature|api)\s*(?:id|hash|key|number)?\b/.test(text),
      xrp: /\b(xrp|ripple)\b/.test(text),
      sol: /\b(solana|sol)\b/.test(text),
      btc: /\b(bitcoin|btc)\b/.test(text),
      ltc: /\b(litecoin|ltc)\b/.test(text),
      doge: /\b(dogecoin|doge)\b/.test(text),
      bnb: /\b(bnb|binance chain)\b/.test(text)
    };
  }

  function evidenceTags(signals) {
    const tags = [...signals.tokens];
    const mappings = [
      [signals.erc20, "ERC20"], [signals.bep20, "BEP20"], [signals.trc20, "TRC20"],
      [signals.eth, "Ethereum"], [signals.bsc, "BNB Smart Chain"], [signals.tron, "TRON"],
      [signals.sol, "Solana"], [signals.xrp, "XRP"], [signals.btc, "Bitcoin"],
      [signals.ltc, "Litecoin"], [signals.doge, "Dogecoin"], [signals.payment, "Payment/deposit label"],
      [signals.selectedErc20 || signals.selectedBep20, "Selected network"]
    ];
    for (const [present, label] of mappings) if (present && !tags.includes(label)) tags.push(label);
    return tags.slice(0, 16);
  }

  function evidenceItems(signals, context, meta = {}) {
    const items = Array.isArray(meta.evidenceItems) ? [...meta.evidenceItems] : [];
    const add = item => { if (item && !items.includes(item)) items.push(item); };
    const selectedToken = context.match(/\bselected\s+(?:token|coin|asset)\s*:?\s*([^\n|]{2,48})/i)?.[1];
    const selectedNetwork = context.match(/\bselected\s+(?:network|chain|option)\s*:?\s*([^\n|]{2,64})/i)?.[1];
    const label = context.match(/\b((?:deposit|receiving|recipient|payment|wallet|withdrawal)(?:\s+wallet)?\s+address)\b/i)?.[1];
    const qrScheme = context.match(/\bQR code payload:\s*([a-z][a-z0-9+.-]{1,20}):/i)?.[1];
    if (selectedToken) add(`Selected token: ${cleanText(selectedToken, 48)}`);
    else if (signals.usdt) add("Token label: USDT");
    else if (signals.tokens[0]) add(`Token label: ${signals.tokens[0]}`);
    if (selectedNetwork) add(`Selected network: ${cleanText(selectedNetwork, 64)}`);
    else if (signals.trc20) add("Network label: TRC20");
    else if (signals.erc20) add("Network label: ERC20");
    else if (signals.bep20) add("Network label: BEP20");
    else if (signals.bsc) add("Network label: BNB Smart Chain");
    if (label) add(`Label: ${label.replace(/\b\w/g, character => character.toUpperCase())}`);
    if (qrScheme) add(`QR payload scheme: ${qrScheme.toLowerCase()}`);
    if (meta.type === "deposit-qr") add("Address appeared beside deposit QR code");
    if (meta.type === "deposit-section") add("Inside deposit/payment section");
    if (meta.type === "address-field") add("Address found in input or read-only field");
    if (meta.type === "modal-section") add("Address found in modal or popup");
    if (meta.type === "shadow-section") add("Address found in open Shadow DOM section");
    if (meta.type === "copy-address") add("Copy-address control nearby");
    return items.slice(0, 16);
  }

  function contextScore(signals, context) {
    let score = Math.min(5, Math.floor(cleanText(context).length / 90));
    if (signals.payment) score += 5;
    if (signals.explicitAddress) score += 8;
    if (signals.tokens.length) score += 5;
    if (signals.erc20 || signals.bep20 || signals.trc20 || signals.eth || signals.bsc || signals.tron || signals.xrp || signals.sol || signals.btc || signals.ltc || signals.doge || signals.bnb) score += 6;
    if (signals.selectedErc20 || signals.selectedBep20) score += 7;
    if (signals.directErc20 || signals.directBep20) score += 5;
    if (signals.negativeGeneric) score -= 8;
    return Math.max(0, score);
  }

  function result(network, confidence, specificity) {
    const confidenceBase = { review: 100, medium: 200, high: 300 }[confidence] || 0;
    return { network, confidence, classificationScore: confidenceBase + specificity };
  }

  function namedToken(signals) {
    return signals.tokens.find(token => token !== "USDT") || null;
  }

  async function classify(address, context) {
    const signals = contextSignals(context);
    if (/^0x[a-fA-F0-9]{40}$/.test(address)) {
      const chooseErc20 = signals.selectedErc20 || (signals.directErc20 && !signals.directBep20) || (signals.usdt && signals.erc20 && !signals.bep20 && !signals.bsc);
      const chooseBep20 = signals.selectedBep20 || (signals.directBep20 && !signals.directErc20) || (signals.usdt && (signals.bep20 || signals.bsc) && !signals.erc20);
      if (signals.usdt && chooseErc20 && !chooseBep20) return result("USDT (ERC20)", "high", 40);
      if (signals.usdt && chooseBep20 && !chooseErc20) return result("USDT (BEP20)", "high", 40);

      const token = namedToken(signals);
      if (token && signals.erc20 && !signals.bep20 && !signals.bsc) return result(`${token} (ERC20)`, "high", 38);
      if (token && (signals.bep20 || signals.bsc) && !signals.erc20) return result(`${token} (BEP20)`, "high", 38);
      if (signals.erc20 && !signals.bep20 && !signals.bsc && !signals.usdt) return result("ERC20 token (Ethereum)", "high", 30);
      if ((signals.bep20 || signals.bsc) && !signals.erc20 && !signals.usdt) return result("BNB Smart Chain (BSC/BEP20)", "high", 30);
      if (signals.eth && !signals.erc20 && !signals.bep20 && !signals.bsc && !signals.usdt && !token) return result("Ethereum (ETH)", "high", 30);
      if (signals.bnb && !signals.eth && !signals.erc20 && !signals.usdt) return result("BNB Smart Chain (BSC/BEP20)", "high", 30);
      return result("EVM address (network uncertain)", "review", 5);
    }

    if (/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(address) && await validBase58Check(address, BASE58, [0x41])) {
      if (signals.usdt) return result("USDT (TRC20)", "high", 40);
      return result("TRON (TRC20)", signals.tron ? "high" : "medium", 30);
    }
    if (/^bc1/i.test(address) && validBech32(address, ["bc"])) return result("Bitcoin (BTC)", "high", 35);
    if (/^[13]/.test(address) && await validBase58Check(address, BASE58, [0x00, 0x05])) return result("Bitcoin (BTC)", "high", 35);
    if (/^ltc1/i.test(address) && validBech32(address, ["ltc"])) return result("Litecoin (LTC)", "high", 35);
    if (/^[LM]/.test(address) && await validBase58Check(address, BASE58, [0x30, 0x32])) return result("Litecoin (LTC)", "high", 35);
    if (/^D/.test(address) && await validBase58Check(address, BASE58, [0x1e])) return result("Dogecoin (DOGE)", "high", 35);
    if (/^bnb1/i.test(address) && validBech32(address, ["bnb"])) return result("BNB Beacon Chain", "high", 35);
    if (/^r/.test(address) && await validBase58Check(address, RIPPLE58, [0x00])) return result("XRP Ledger (XRP)", "high", 35);

    const decoded = decodeBase58(address, BASE58);
    if (!decoded || decoded.length !== 32 || signals.negativeGeneric) return null;
    if (signals.sol && signals.usdt) return result("USDT (Solana/SPL)", "high", 40);
    if (signals.sol) return result("Solana (SOL/SPL)", "high", 30);
    if (signals.explicitAddress) return result("Possible Solana/Base58 address", "review", 1);
    return null;
  }

  function contextVariants(source, index, addressLength) {
    const currentStart = source.lastIndexOf("\n", index - 1) + 1;
    const currentEndIndex = source.indexOf("\n", index + addressLength);
    const currentEnd = currentEndIndex < 0 ? source.length : currentEndIndex;
    const paragraphStartIndex = source.lastIndexOf("\n\n", index - 1);
    const paragraphStart = paragraphStartIndex < 0 ? 0 : paragraphStartIndex + 2;
    const paragraphEndIndex = source.indexOf("\n\n", index + addressLength);
    const paragraphEnd = paragraphEndIndex < 0 ? source.length : paragraphEndIndex;
    let precedingStart = currentStart;
    for (let count = 0; count < 4; count += 1) {
      const boundary = source.lastIndexOf("\n", Math.max(0, precedingStart - 2));
      precedingStart = boundary < 0 ? 0 : boundary + 1;
      if (precedingStart === 0) break;
    }
    let followingEnd = currentEnd;
    for (let count = 0; count < 3; count += 1) {
      const boundary = source.indexOf("\n", followingEnd + 1);
      followingEnd = boundary < 0 ? source.length : boundary;
      if (followingEnd === source.length) break;
    }
    return [
      { text: source.slice(currentStart, currentEnd), penalty: 0 },
      { text: source.slice(paragraphStart, paragraphEnd), penalty: 0 },
      { text: source.slice(precedingStart, currentEnd), penalty: 1 },
      { text: source.slice(currentStart, followingEnd), penalty: 1 },
      { text: source.slice(Math.max(0, index - 220), Math.min(source.length, index + addressLength + 220)), penalty: 5 }
    ];
  }

  function betterResult(candidate, current) {
    if (!current) return true;
    if (candidate.classificationScore !== current.classificationScore) return candidate.classificationScore > current.classificationScore;
    if (candidate.evidenceScore !== current.evidenceScore) return candidate.evidenceScore > current.evidenceScore;
    return candidate.context.length > current.context.length;
  }

  async function detect(text, meta = {}) {
    const source = String(text || "").replace(/[\u200B-\u200D\uFEFF]/g, "").slice(0, MAX_SOURCE_LENGTH);
    const occurrences = new Map();
    for (const regex of PATTERNS) {
      regex.lastIndex = 0;
      for (const match of source.matchAll(regex)) {
        const key = `${match[0]}|${match.index}`;
        if (!occurrences.has(key)) occurrences.set(key, { address: match[0], index: match.index });
      }
    }

    const bestByAddress = new Map();
    for (const { address, index } of occurrences.values()) {
      for (const variant of contextVariants(source, index, address.length)) {
        const context = cleanText(variant.text);
        const classification = await classify(address, context);
        if (!classification) continue;
        const signals = contextSignals(context);
        const localScore = Math.max(0, contextScore(signals, context) - variant.penalty);
        const candidate = {
          address,
          context,
          contextScore: localScore,
          evidenceScore: localScore + Math.max(0, Number(meta.priority) || 0),
          evidenceTags: evidenceTags(signals),
          evidenceItems: evidenceItems(signals, context, meta),
          evidenceSource: meta.type || "page",
          detectionMethods: [meta.type || "page"],
          ...classification
        };
        if (betterResult(candidate, bestByAddress.get(address))) bestByAddress.set(address, candidate);
      }
    }
    return [...bestByAddress.values()];
  }

  async function detectSources(sources) {
    const bestByAddress = new Map();
    for (const source of sources || []) {
      const entry = typeof source === "string" ? { text: source, type: "page", priority: 0 } : source;
      for (const candidate of await detect(entry?.text, entry || {})) {
        const current = bestByAddress.get(candidate.address);
        if (!current) {
          bestByAddress.set(candidate.address, candidate);
          continue;
        }
        const combinedTags = [...new Set([...(current.evidenceTags || []), ...(candidate.evidenceTags || [])])].slice(0, 16);
        const combinedItems = [...new Set([...(current.evidenceItems || []), ...(candidate.evidenceItems || [])])].slice(0, 16);
        const combinedMethods = [...new Set([...(current.detectionMethods || []), ...(candidate.detectionMethods || [])])].slice(0, 12);
        const winner = betterResult(candidate, current) ? candidate : current;
        bestByAddress.set(candidate.address, { ...winner, evidenceTags: combinedTags, evidenceItems: combinedItems, detectionMethods: combinedMethods });
      }
    }
    return [...bestByAddress.values()];
  }

  globalThis.WalletDetector = { detect, detectSources, classify, decodeBase58, validBech32 };
})();
