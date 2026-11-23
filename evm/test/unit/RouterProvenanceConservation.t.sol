// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {RefundFailed} from "../../src/HyperionErrors.sol";
import {Unauthorized} from "../../src/HyperionErrors.sol";
import {OutboundRecord, OutboundRequest, RouteKind} from "../../src/HyperionTypes.sol";
import {OutboundProvenance} from "../../src/OutboundProvenance.sol";
import {Fixture} from "../Fixture.sol";
import {RefundRefuser} from "../mocks/HostileCallers.sol";
import {MockRailAdapter} from "../mocks/MockRailAdapter.sol";

contract RouterProvenanceConservationTest is Fixture {
    function test_actualSupportIdentityRejectsDirectWritesAndHasNoAuthorityMutation() public {
        address child =
            address(uint160(uint256(keccak256(abi.encodePacked(hex"d694", address(router), hex"01")))));
        OutboundProvenance history = OutboundProvenance(child);
        assertEq(history.ROUTER(), address(router));
        OutboundRecord memory record;
        record.nonce = 1;
        vm.expectRevert(Unauthorized.selector);
        history.commit(record);
        assertEq(router.outboundRecord(1).nonce, 0);
        (bool success,) =
            child.call(abi.encodeWithSignature("grantRole(bytes32,address)", adminRole, stranger));
        assertFalse(success);
        assertFalse(router.hasRole(adminRole, stranger));
    }

    function test_bothPaidRailsConserveUniqueAccountsDustAndNativeRemainder() public {
        vm.deal(alice, 2 ether);
        for (uint256 i; i < 2; ++i) {
            RouteKind route = RouteKind(i);
            MockRailAdapter rail = i == 0 ? cctpRail : itsRail;
            rail.setRefund(0.2 ether);
            OutboundRequest memory request = _usdcRequest(1_000_003);
            request.route = route;
            request.destinationDecimals = 4;
            request.destination.remoteDecimals = 4;
            // Same sender and recipient must be counted once in the conservation total.
            BalanceSnapshot memory before_ = _snapshot(alice, alice);
            vm.prank(alice);
            uint64 nonce = router.bridgeOutBounded{value: 0.5 ether}(request, 0.5 ether);
            BalanceSnapshot memory after_ = _snapshot(alice, alice);
            _assertConserved(before_, after_, i == 0 ? "CCTP paid dust/refund" : "ITS paid dust/refund");
            assertEq(before_.sender - after_.sender, 1_000_000, "source dust stays with sender");
            assertEq(after_.treasury - before_.treasury, 1000);
            assertEq(rail.lastCall().amount, 999_000);
            assertEq(before_.senderNative - after_.senderNative, 0.3 ether);
            OutboundRecord memory record = router.outboundRecord(nonce);
            assertEq(record.nonce, nonce);
            assertEq(record.sender, alice);
            assertEq(record.token, address(usdc));
            assertEq(record.grossAmount, 1_000_000);
            assertEq(record.fee, 1000);
            assertEq(record.netAmount, 999_000);
            assertEq(uint256(record.route), i);
            assertEq(record.adapter, address(rail));
            assertEq(record.destinationChain, STELLAR);
            assertEq(record.destinationAddress, G_ADDR);
            assertEq(record.railRef, rail.railRef());
        }
    }

    function test_missingAndFailedDispatchHaveNoCommittedRecord() public {
        assertEq(router.outboundRecord(1).nonce, 0);
        for (uint256 i; i < 2; ++i) {
            MockRailAdapter rail = i == 0 ? cctpRail : itsRail;
            rail.setDispatchReverts(true);
            OutboundRequest memory request = _usdcRequest(1000e6);
            request.route = RouteKind(i);
            BalanceSnapshot memory before_ = _snapshot(alice, bob);
            vm.prank(alice);
            vm.expectRevert(MockRailAdapter.Rejected.selector);
            router.bridgeOutBounded(request, 0);
            _assertConserved(
                before_, _snapshot(alice, bob), i == 0 ? "CCTP failed dispatch" : "ITS failed dispatch"
            );
            assertEq(router.outboundNonce(), 0);
            assertEq(router.outboundRecord(1).nonce, 0);
            assertEq(rail.callCount(), 0);
        }
    }

    function test_failedRefundRollsBackPreviouslyWrittenProvenance() public {
        RefundRefuser refuser = new RefundRefuser();
        usdc.mint(address(refuser), 1000e6);
        refuser.approve(address(usdc), address(router), type(uint256).max);
        cctpRail.setRefund(0.1 ether);
        vm.deal(address(this), 0.5 ether);
        vm.expectRevert(RefundFailed.selector);
        refuser.bridge{value: 0.5 ether}(address(router), _usdcRequest(1000e6), 0.5 ether);
        assertEq(router.outboundRecord(1).nonce, 0);
        assertEq(router.outboundNonce(), 0);
        assertEq(usdc.balanceOf(address(refuser)), 1000e6);
        assertEq(cctpRail.callCount(), 0);
    }

    function test_conservationHarnessRejectsInjectedTokenAndNativeDelta() public {
        BalanceSnapshot memory before_ = _snapshot(alice, bob);
        BalanceSnapshot memory after_ = _snapshot(alice, bob);
        ++after_.total;
        vm.expectRevert();
        this.checkConserved(before_, after_, "CCTP injected token delta");
        after_ = _snapshot(alice, bob);
        ++after_.totalNative;
        vm.expectRevert();
        this.checkConserved(before_, after_, "ITS injected relay delta");
    }

    function checkConserved(
        BalanceSnapshot calldata before_,
        BalanceSnapshot calldata after_,
        string calldata operation
    ) external pure {
        _assertConserved(before_, after_, operation);
    }

    function test_provenanceStorageGasCostIsMeasuredPerDispatch() public {
        vm.startPrank(alice);
        uint256 gasBefore = gasleft();
        router.bridgeOut(_usdcRequest(1000e6));
        uint256 firstCost = gasBefore - gasleft();
        gasBefore = gasleft();
        router.bridgeOut(_usdcRequest(1000e6));
        uint256 subsequentCost = gasBefore - gasleft();
        vm.stopPrank();
        emit log_named_uint("first outbound with provenance gas", firstCost);
        emit log_named_uint("subsequent outbound with provenance gas", subsequentCost);
        assertEq(router.outboundRecord(1).nonce, 1);
        assertEq(router.outboundRecord(2).nonce, 2);
    }
}
