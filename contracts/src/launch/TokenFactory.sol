// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { LaunchedToken } from "./LaunchedToken.sol";

/// @title TokenFactory
/// @notice Permissionless launcher for `LaunchedToken`s. Each launch deploys one fixed-supply token with CREATE2, so
///         its address is known before the transaction, and records it so apps can tell a factory token from a
///         look-alike.
/// @dev The CREATE2 salt mixes in the caller, so nobody can take an address another creator predicted. Names and
///      symbols are restricted to printable ASCII (symbols to letters and digits) to keep look-alike tricks with
///      invisible or confusable characters out of wallets and explorers.
contract TokenFactory {
    /// @notice Largest supply a launch accepts: one quadrillion whole tokens (1e15 × 1e18 base units).
    uint256 public constant MAX_SUPPLY = 1e33;
    uint256 internal constant MAX_NAME_LENGTH = 64;
    uint256 internal constant MAX_SYMBOL_LENGTH = 11;

    /// @notice True for every token this factory deployed.
    mapping(address token => bool) public isLaunched;

    event TokenLaunched(
        address indexed token,
        address indexed creator,
        address indexed recipient,
        string name,
        string symbol,
        uint256 supply,
        bytes32 salt
    );

    error InvalidName();
    error InvalidSymbol();
    error InvalidSupply(uint256 supply);
    error ZeroRecipient();

    /// @notice Deploys a token and mints `supply` (base units, 18 decimals) to `recipient`.
    /// @param salt Any value the creator picks; the same creator cannot reuse a salt for identical arguments.
    function launch(
        string calldata name,
        string calldata symbol,
        uint256 supply,
        address recipient,
        bytes32 salt
    )
        external
        returns (address token)
    {
        _validate(name, symbol, supply, recipient);
        token = address(new LaunchedToken{ salt: _salt(msg.sender, salt) }(name, symbol, supply, recipient));
        isLaunched[token] = true;
        emit TokenLaunched(token, msg.sender, recipient, name, symbol, supply, salt);
    }

    /// @notice Address `launch` deploys to when `creator` calls it with these arguments.
    function predict(
        address creator,
        string calldata name,
        string calldata symbol,
        uint256 supply,
        address recipient,
        bytes32 salt
    )
        external
        view
        returns (address)
    {
        bytes32 initCodeHash =
            keccak256(abi.encodePacked(type(LaunchedToken).creationCode, abi.encode(name, symbol, supply, recipient)));
        bytes32 digest = keccak256(abi.encodePacked(bytes1(0xff), address(this), _salt(creator, salt), initCodeHash));
        return address(uint160(uint256(digest)));
    }

    function _salt(address creator, bytes32 salt) private pure returns (bytes32) {
        return keccak256(abi.encode(creator, salt));
    }

    function _validate(string calldata name, string calldata symbol, uint256 supply, address recipient) private pure {
        bytes calldata n = bytes(name);
        require(n.length > 0 && n.length <= MAX_NAME_LENGTH, InvalidName());
        for (uint256 i; i < n.length; ++i) {
            require(n[i] >= 0x20 && n[i] <= 0x7e, InvalidName());
        }
        // No leading or trailing space: "USDC " must not pass for "USDC".
        require(n[0] != 0x20 && n[n.length - 1] != 0x20, InvalidName());

        bytes calldata s = bytes(symbol);
        require(s.length > 0 && s.length <= MAX_SYMBOL_LENGTH, InvalidSymbol());
        for (uint256 i; i < s.length; ++i) {
            bytes1 c = s[i];
            require((c >= "0" && c <= "9") || (c >= "A" && c <= "Z") || (c >= "a" && c <= "z"), InvalidSymbol());
        }

        require(supply > 0 && supply <= MAX_SUPPLY, InvalidSupply(supply));
        require(recipient != address(0), ZeroRecipient());
    }
}
