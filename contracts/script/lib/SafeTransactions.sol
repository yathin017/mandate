// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Vm } from "forge-std/Vm.sol";

import { ISafe } from "../../src/interfaces/ISafe.sol";

/// @notice Fork/test owner and factory interfaces, verified against Safe v1.4.1 source.
/// @dev Production ISafe deliberately exposes only the two module operations it needs.
interface ISafeAccount is ISafe {
    function VERSION() external view returns (string memory);
    function nonce() external view returns (uint256);
    function getThreshold() external view returns (uint256);
    function getOwners() external view returns (address[] memory);

    function setup(
        address[] calldata owners,
        uint256 threshold,
        address to,
        bytes calldata data,
        address fallbackHandler,
        address paymentToken,
        uint256 payment,
        address payable paymentReceiver
    )
        external;

    function enableModule(address module) external;
    function disableModule(address prevModule, address module) external;

    function getTransactionHash(
        address to,
        uint256 value,
        bytes calldata data,
        Operation operation,
        uint256 safeTxGas,
        uint256 baseGas,
        uint256 gasPrice,
        address gasToken,
        address refundReceiver,
        uint256 nonce_
    )
        external
        view
        returns (bytes32);

    function execTransaction(
        address to,
        uint256 value,
        bytes calldata data,
        Operation operation,
        uint256 safeTxGas,
        uint256 baseGas,
        uint256 gasPrice,
        address gasToken,
        address payable refundReceiver,
        bytes calldata signatures
    )
        external
        payable
        returns (bool success);
}

interface ISafeProxyFactory {
    function createProxyWithNonce(
        address singleton,
        bytes calldata initializer,
        uint256 saltNonce
    )
        external
        returns (address proxy);
}

/// @notice Creates real Safe proxies and signs owner transactions with local development keys.
/// @dev Never impersonates the Safe: issuer actions pass through its EIP-712 signature and nonce checks.
library SafeTransactions {
    Vm private constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function create(
        address singleton,
        address factory,
        address[] memory owners,
        uint256 threshold,
        uint256 saltNonce
    )
        internal
        returns (ISafeAccount)
    {
        // Initialize in the factory call so there is no uninitialized proxy to take over.
        bytes memory initializer = abi.encodeCall(
            ISafeAccount.setup, (owners, threshold, address(0), "", address(0), address(0), 0, payable(address(0)))
        );
        return ISafeAccount(ISafeProxyFactory(factory).createProxyWithNonce(singleton, initializer, saltNonce));
    }

    /// @dev Signatures must be ordered by ascending owner address, as required by Safe.checkNSignatures.
    function signatures(
        ISafeAccount safe,
        address to,
        bytes memory data,
        uint256[] memory sortedKeys
    )
        internal
        view
        returns (bytes memory packed)
    {
        bytes32 digest =
            safe.getTransactionHash(to, 0, data, ISafe.Operation.Call, 0, 0, 0, address(0), address(0), safe.nonce());
        for (uint256 i; i < sortedKeys.length; ++i) {
            (uint8 v, bytes32 r, bytes32 s) = VM.sign(sortedKeys[i], digest);
            packed = bytes.concat(packed, abi.encodePacked(r, s, v));
        }
    }

    function execute(
        ISafeAccount safe,
        address to,
        bytes memory data,
        uint256[] memory sortedKeys
    )
        internal
        returns (bool)
    {
        bytes memory sigs = signatures(safe, to, data, sortedKeys);
        return safe.execTransaction(to, 0, data, ISafe.Operation.Call, 0, 0, 0, address(0), payable(address(0)), sigs);
    }
}
