"""
Tests for app/analysis/wallet_validator.py.

These use REAL, well-known addresses (the Bitcoin genesis address, the BIP-173
reference bech32 address) so the checksum maths is verified against ground
truth rather than against addresses I invented — an invented "valid" address
would happily pass a broken validator.
"""
from app.analysis.wallet_validator import (
    validate_format, base58check_valid, bech32_valid, eip55_valid, validate_wallet,
)

# Bitcoin genesis block coinbase address — the most-verified address in existence.
BTC_GENESIS = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa"
# BIP-173 reference test vector.
BTC_BECH32 = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4"
ETH_ADDRESS = "0x71C7656EC7ab88b098defB751B7401B5f6d8976F"
TRON_ADDRESS = "TN3W4H6rK2ce4vX9YnFQHwKENnHjoxb3m9"


def test_bitcoin_genesis_address_validates():
    valid, detail = base58check_valid(BTC_GENESIS)
    assert valid is True, detail


def test_single_character_change_breaks_btc_checksum():
    """The whole point of a checksum: one wrong character must be caught."""
    corrupted = BTC_GENESIS[:-1] + ("b" if BTC_GENESIS[-1] != "b" else "c")
    valid, detail = base58check_valid(corrupted)
    assert valid is False
    assert "checksum" in detail.lower()


def test_bech32_reference_vector_validates():
    valid, detail = bech32_valid(BTC_BECH32)
    assert valid is True, detail


def test_bech32_corrupted_checksum_rejected():
    corrupted = BTC_BECH32[:-1] + ("5" if BTC_BECH32[-1] != "5" else "4")
    valid, _ = bech32_valid(corrupted)
    assert valid is False


def test_tron_address_validates():
    result = validate_format(TRON_ADDRESS, "TRON")
    assert result["format_valid"] == 1


def test_tron_rejects_address_not_starting_with_T():
    """A base58check-valid address that isn't a TRON address must not pass as TRON."""
    result = validate_format(BTC_GENESIS, "TRON")
    assert result["format_valid"] == 0


def test_evm_address_validates():
    result = validate_format(ETH_ADDRESS, "ETH")
    assert result["format_valid"] == 1


def test_evm_rejects_wrong_length():
    result = validate_format("0x71C7656EC7ab88b098defB751B7401B5f6d897", "ETH")
    assert result["format_valid"] == 0


def test_evm_rejects_non_hex():
    result = validate_format("0xZZZZ656EC7ab88b098defB751B7401B5f6d8976F", "ETH")
    assert result["format_valid"] == 0


def test_usdt_on_evm_validates_as_evm_address():
    """USDT is a token on an EVM chain — the address format is still EVM."""
    result = validate_format(ETH_ADDRESS, "USDT")
    assert result["format_valid"] == 1


def test_invalid_base58_characters_rejected():
    """0, O, I and l are not in the base58 alphabet and must be caught."""
    valid, detail = base58check_valid("1A1zP1eP5QGefi2DMPTfTL5SLmv7Div0O0")
    assert valid is False


def test_validate_wallet_skips_activity_when_format_invalid():
    """No point querying a block explorer for an address that can't be real."""
    result = validate_wallet("0xNOTAVALIDADDRESS", "ETH", check_activity=True)
    assert result["format_valid"] == 0
    assert result["activity_checked"] == 0
    assert "skipped" in (result.get("activity_error") or "").lower()


def test_validate_wallet_offline_mode_does_no_network_call():
    result = validate_wallet(TRON_ADDRESS, "TRON", check_activity=False)
    assert result["format_valid"] == 1
    assert result["activity_checked"] == 0


def test_validation_always_returns_a_detail_string():
    """A reviewer must always be able to see WHY something did or didn't validate."""
    for address, network in [(BTC_GENESIS, "BTC"), ("garbage", "BTC"), (ETH_ADDRESS, "ETH")]:
        result = validate_format(address, network)
        assert result["validation_detail"]
