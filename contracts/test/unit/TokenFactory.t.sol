// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Test } from "forge-std/Test.sol";

import { LaunchedToken } from "../../src/launch/LaunchedToken.sol";
import { TokenFactory } from "../../src/launch/TokenFactory.sol";

contract TokenFactoryTest is Test {
    TokenFactory internal factory;
    address internal creator = makeAddr("creator");
    address internal safe = makeAddr("safe");
    uint256 internal constant SUPPLY = 1_000_000_000e18;
    bytes32 internal constant SALT = keccak256("nova");

    function setUp() public {
        factory = new TokenFactory();
    }

    function _launch() internal returns (LaunchedToken) {
        vm.prank(creator);
        return LaunchedToken(factory.launch("Nova", "NOVA", SUPPLY, safe, SALT));
    }

    function test_launch_mintsWholeSupplyToRecipientAtPredictedAddress() public {
        address predicted = factory.predict(creator, "Nova", "NOVA", SUPPLY, safe, SALT);
        vm.expectEmit(true, true, true, true, address(factory));
        emit TokenFactory.TokenLaunched(predicted, creator, safe, "Nova", "NOVA", SUPPLY, SALT);
        LaunchedToken token = _launch();

        assertEq(address(token), predicted);
        assertTrue(factory.isLaunched(address(token)));
        assertEq(token.name(), "Nova");
        assertEq(token.symbol(), "NOVA");
        assertEq(token.decimals(), 18);
        assertEq(token.totalSupply(), SUPPLY);
        assertEq(token.balanceOf(safe), SUPPLY);
        assertEq(token.balanceOf(creator), 0);
    }

    function test_launchedToken_hasNoPrivilegedFunctions() public {
        LaunchedToken token = _launch();
        // No owner, mint, burn or pause: each selector is absent from the runtime code.
        bytes4[5] memory absent = [
            bytes4(keccak256("owner()")),
            bytes4(keccak256("mint(address,uint256)")),
            bytes4(keccak256("burn(uint256)")),
            bytes4(keccak256("pause()")),
            bytes4(keccak256("transferOwnership(address)"))
        ];
        for (uint256 i; i < absent.length; ++i) {
            (bool ok,) = address(token).call(abi.encodeWithSelector(absent[i]));
            assertFalse(ok);
        }
    }

    function test_permit_approvesBySignature() public {
        (address holder, uint256 key) = makeAddrAndKey("holder");
        vm.prank(creator);
        LaunchedToken token = LaunchedToken(factory.launch("Nova", "NOVA", SUPPLY, holder, SALT));
        address spender = makeAddr("spender");
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                token.DOMAIN_SEPARATOR(),
                keccak256(
                    abi.encode(
                        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
                        holder,
                        spender,
                        1e18,
                        0,
                        deadline
                    )
                )
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        token.permit(holder, spender, 1e18, deadline, v, r, s);
        assertEq(token.allowance(holder, spender), 1e18);
    }

    function test_salt_isBoundToCreator() public {
        address predicted = factory.predict(creator, "Nova", "NOVA", SUPPLY, safe, SALT);
        // Someone else launching with the same salt and arguments lands elsewhere, so a prediction cannot be squatted.
        vm.prank(makeAddr("squatter"));
        address other = factory.launch("Nova", "NOVA", SUPPLY, safe, SALT);
        assertTrue(other != predicted);
        assertEq(address(_launch()), predicted);
    }

    function test_sameCreatorSaltAndArguments_revert() public {
        _launch();
        vm.prank(creator);
        vm.expectRevert();
        factory.launch("Nova", "NOVA", SUPPLY, safe, SALT);
    }

    function test_rejectsBadNames() public {
        bytes memory long = new bytes(65);
        for (uint256 i; i < long.length; ++i) {
            long[i] = "a";
        }
        string[5] memory names = ["", " Nova", "Nova ", unicode"Növa", string(long)];
        for (uint256 i; i < names.length; ++i) {
            vm.expectRevert(TokenFactory.InvalidName.selector);
            factory.launch(names[i], "NOVA", SUPPLY, safe, SALT);
        }
    }

    function test_rejectsBadSymbols() public {
        string[4] memory symbols = ["", "NO VA", "USDC.e", "ABCDEFGHIJKL"];
        for (uint256 i; i < symbols.length; ++i) {
            vm.expectRevert(TokenFactory.InvalidSymbol.selector);
            factory.launch("Nova", symbols[i], SUPPLY, safe, SALT);
        }
    }

    function test_rejectsBadSupplyAndRecipient() public {
        vm.expectRevert(abi.encodeWithSelector(TokenFactory.InvalidSupply.selector, 0));
        factory.launch("Nova", "NOVA", 0, safe, SALT);
        uint256 tooMuch = factory.MAX_SUPPLY() + 1;
        vm.expectRevert(abi.encodeWithSelector(TokenFactory.InvalidSupply.selector, tooMuch));
        factory.launch("Nova", "NOVA", tooMuch, safe, SALT);
        vm.expectRevert(TokenFactory.ZeroRecipient.selector);
        factory.launch("Nova", "NOVA", SUPPLY, address(0), SALT);
    }

    function testFuzz_predictMatchesLaunch(uint256 supply, bytes32 salt, address recipient) public {
        supply = bound(supply, 1, factory.MAX_SUPPLY());
        vm.assume(recipient != address(0));
        address predicted = factory.predict(creator, "Fuzz Token", "FZZ1", supply, recipient, salt);
        vm.prank(creator);
        address token = factory.launch("Fuzz Token", "FZZ1", supply, recipient, salt);
        assertEq(token, predicted);
        assertEq(LaunchedToken(token).balanceOf(recipient), supply);
    }
}
