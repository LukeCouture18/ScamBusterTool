"""Tests for app/investigate/wallet_extractor.py."""
from app.investigate.wallet_extractor import extract_wallets


def test_extracts_eth_address_with_high_confidence_in_context():
    text = "Please send funds to our Deposit Address: 0x71C7656EC7ab88b098defB751B7401B5f6d8976a"
    results = extract_wallets(text)
    assert len(results) == 1
    assert results[0]["network"] == "ETH"
    assert results[0]["confidence"] == 0.9


def test_extracts_tron_address():
    text = "Wallet Address: TN3W4H6rK2ce4vX9YnFQHwKENnHjoxb3m9"
    results = extract_wallets(text)
    trons = [w for w in results if w["network"] == "TRON"]
    assert len(trons) == 1
    assert trons[0]["address"] == "TN3W4H6rK2ce4vX9YnFQHwKENnHjoxb3m9"


def test_relabels_evm_address_as_usdt_from_context():
    text = "USDT (ERC20) Deposit Address: 0xabcdefabcdefabcdefabcdefabcdefabcdefabcd"
    results = extract_wallets(text)
    assert len(results) == 1
    assert results[0]["network"] == "USDT"


def test_relabels_evm_address_as_bnb_from_bep20_context():
    text = "Send BEP20 (BSC) tokens to: 0x1234567890abcdef1234567890abcdef12345678"
    results = extract_wallets(text)
    assert len(results) == 1
    assert results[0]["network"] == "BNB"


def test_relabels_evm_address_as_matic_from_polygon_context():
    text = "Polygon Network Deposit Address: 0x9999888877776666555544443333222211110000"
    results = extract_wallets(text)
    assert len(results) == 1
    assert results[0]["network"] == "MATIC"


def test_plain_eth_address_stays_eth_with_no_special_context():
    text = "Plain ETH wallet address: 0x1111222233334444555566667777888899990000"
    results = extract_wallets(text)
    assert len(results) == 1
    assert results[0]["network"] == "ETH"


def test_multiple_distinct_evm_addresses_labeled_independently():
    """Regression test: a prior bug leaked one address's relabel onto all subsequent
    ETH-format matches in the same extraction pass. This must not recur."""
    text = (
        "USDT (BEP20) Deposit Address: 0x1234567890abcdef1234567890abcdef12345678\n"
        "Network: BEP20 (BSC)\n"
        "\n"
        "Polygon MATIC Deposit Address: 0x9999888877776666555544443333222211110000\n"
        "Network: Polygon\n"
        "\n"
        "Plain ETH wallet address: 0x1111222233334444555566667777888899990000\n"
    )
    results = {w["address"]: w["network"] for w in extract_wallets(text)}
    assert results["0x1234567890abcdef1234567890abcdef12345678"] == "USDT"
    assert results["0x9999888877776666555544443333222211110000"] == "MATIC"
    assert results["0x1111222233334444555566667777888899990000"] == "ETH"


def test_sol_address_rejected_without_context():
    """SOL's base58 pattern is noisy; a bare match with no supporting context
    should not be reported as a wallet at all."""
    text = "Just some random base58-looking noise: 8xJ4nR2kL9mQpVvYbT3sN7cWzXeF6gH1jKdA5oP2qR3s"
    results = extract_wallets(text)
    sols = [w for w in results if w["network"] == "SOL"]
    assert len(sols) == 0


def test_dedup_within_single_extraction():
    text = "Deposit Address: 0xAAAA111122223333444455556666777788889999 " \
           "again our address is 0xAAAA111122223333444455556666777788889999"
    results = extract_wallets(text)
    assert len(results) == 1


def test_no_false_positive_on_short_hex_noise():
    text = "Error code: 0x1A2B (not a wallet address)"
    results = extract_wallets(text)
    assert len(results) == 0


def test_context_window_does_not_bleed_across_unrelated_blocks():
    """A USDT heading two paragraphs above an unrelated plain address should not
    contaminate that address's label."""
    text = (
        "USDT (TRC20) info goes here with lots of extra padding text to push the "
        "next block outside a naive fixed-size window if block-scoping is broken.\n"
        "\n"
        "Totally unrelated ETH address for something else: "
        "0x5555666677778888999900001111222233334444\n"
    )
    results = extract_wallets(text)
    eth_matches = [w for w in results if w["address"].startswith("0x5555")]
    assert len(eth_matches) == 1
    assert eth_matches[0]["network"] == "ETH"
