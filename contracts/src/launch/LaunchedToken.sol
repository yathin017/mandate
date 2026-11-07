// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { ERC20Permit } from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/// @title LaunchedToken
/// @notice A plain fixed-supply ERC-20 created by `TokenFactory`: 18 decimals, EIP-2612 permit, the whole supply
///         minted once to a recipient (normally the issuer's Safe). It has no owner, no mint, no pause, no fees and
///         no upgrade path, so nothing about it can change after launch.
contract LaunchedToken is ERC20, ERC20Permit {
    constructor(
        string memory name,
        string memory symbol,
        uint256 supply,
        address recipient
    )
        ERC20(name, symbol)
        ERC20Permit(name)
    {
        _mint(recipient, supply);
    }
}
