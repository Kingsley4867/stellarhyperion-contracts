// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {
    TimelockAlreadyExecuted,
    TimelockExpired,
    TimelockNotQueued,
    TimelockNotReady,
    Unauthorized
} from "../src/HyperionErrors.sol";
import {HyperionRouter} from "../src/HyperionRouter.sol";
import {ActionKind, AdminAction, QueuedAction} from "../src/HyperionTypes.sol";
import {Fixture} from "./Fixture.sol";
import {IAccessControl} from "openzeppelin/access/IAccessControl.sol";

/// @title Actual EVM administration compared with the independent Rust authority model
/// @notice Generated full proposals and exact outcomes preserve additive grants until renounced.
contract AuthorityModelTest is Fixture {
    function _actor(uint256 index) private view returns (address) {
        if (index == 0) return admin;
        if (index == 1) return guardian;
        if (index == 2) return stranger;
        // The generated actor indices are bounded to eight entries.
        // forge-lint: disable-next-line(unsafe-typecast)
        return address(uint160(0xA000 + index));
    }

    function test_shared_generated_authority_sequences() public {
        string memory path = "../testdata/router-authority-evm.csv";
        vm.readLine(path);
        HyperionRouter actual;
        for (uint256 seed; seed < 12; ++seed) {
            actual = _freshRouter();
            vm.warp(1_701_000_000);
            for (uint256 step; step < 38; ++step) {
                uint256[18] memory row = _parse(vm.readLine(path));
                assertEq(row[0], seed);
                assertEq(row[1], step);
                _transition(actual, row);
            }
        }
        assertEq(bytes(vm.readLine(path)).length, 0, "complete authority corpus");
        vm.closeFile(path);
    }

    function _transition(HyperionRouter actual, uint256[18] memory row) private {
        bytes memory payload;
        AdminAction memory action;
        if (row[2] <= 2) {
            action = _empty(
                row[2] == 0
                    ? ActionKind.SetFeeBps
                    : row[2] == 1 ? ActionKind.SetAdmin : ActionKind.SetGuardian
            );
            if (row[2] == 0) action.amount = row[4];
            else action.subject = _actor(row[4]);
            payload = abi.encodeCall(HyperionRouter.queueAction, (action));
        } else if (row[2] == 3) {
            payload = abi.encodeCall(HyperionRouter.pause, ());
        } else if (row[2] == 4) {
            payload = abi.encodeCall(HyperionRouter.unpause, ());
        } else if (row[2] == 5 || row[2] == 6) {
            QueuedAction memory queued = actual.queuedAction(uint64(row[4]));
            action = queued.action;
            assertEq(queued.eta, row[16], "independent referenced action eta");
            assertEq(
                uint256(action.kind),
                uint256(
                    row[14] == 0
                        ? ActionKind.SetFeeBps
                        : row[14] == 1 ? ActionKind.SetAdmin : ActionKind.SetGuardian
                )
            );
            if (row[14] == 0) assertEq(action.amount, row[15]);
            else assertEq(action.subject, _actor(row[15]));
            assertEq(!queued.executed && !actual.actionCancelled(uint64(row[4])), row[17] != 0);
            payload = row[2] == 5
                ? abi.encodeCall(HyperionRouter.executeAction, (uint64(row[4])))
                : abi.encodeCall(HyperionRouter.cancelAction, (uint64(row[4])));
        } else if (row[2] == 7) {
            vm.warp(block.timestamp + row[4]);
        } else {
            payload = abi.encodeCall(
                IAccessControl.renounceRole, (row[2] == 8 ? adminRole : guardianRole, _actor(row[3]))
            );
        }
        string memory trace = string.concat(
            "seed=",
            vm.toString(row[0]),
            " step=",
            vm.toString(row[1]),
            " chain_time=",
            vm.toString(block.timestamp),
            " full_action=",
            vm.toString(abi.encode(action)),
            " operation=",
            vm.toString(payload)
        );
        if (row[2] != 7) {
            vm.prank(_actor(row[3]));
            (bool ok, bytes memory result) = address(actual).call(payload);
            assertEq(ok, row[5] == 0, trace);
            if (ok && row[2] <= 2) assertEq(abi.decode(result, (uint64)), row[6], trace);
            if (!ok) _checkFailure(row, result, trace);
        }
        for (uint256 actor; actor < 8; ++actor) {
            assertEq(actual.hasRole(adminRole, _actor(actor)), row[9] & (2 ** actor) != 0, trace);
            assertEq(actual.hasRole(guardianRole, _actor(actor)), row[10] & (2 ** actor) != 0, trace);
        }
        assertEq(block.timestamp, row[7], trace);
        assertEq(actual.feeBps(), row[11], trace);
        assertEq(actual.paused(), row[12] != 0, trace);
        assertEq(actual.actionCount(), row[13], trace);
    }

    function _checkFailure(uint256[18] memory row, bytes memory result, string memory trace) private view {
        // An EVM revert selector is exactly the first four bytes.
        // forge-lint: disable-next-line(unsafe-typecast)
        bytes4 selector = bytes4(result);
        if (row[5] == 1) {
            if (row[2] == 3 || row[2] == 6) {
                assertEq(result, abi.encodeWithSelector(Unauthorized.selector), trace);
            } else {
                assertEq(
                    result,
                    abi.encodeWithSelector(
                        IAccessControl.AccessControlUnauthorizedAccount.selector, _actor(row[3]), adminRole
                    ),
                    trace
                );
            }
        } else if (row[5] == 2) {
            assertEq(result, abi.encodeWithSelector(TimelockNotReady.selector, uint64(row[16])), trace);
        } else if (row[5] == 3) {
            assertEq(
                result, abi.encodeWithSelector(TimelockExpired.selector, uint64(row[16] + 604_800)), trace
            );
        } else {
            assertTrue(
                selector == TimelockNotQueued.selector || selector == TimelockAlreadyExecuted.selector, trace
            );
        }
    }

    function _parse(string memory line) private pure returns (uint256[18] memory values) {
        bytes memory raw = bytes(line);
        uint256 column;
        for (uint256 i; i < raw.length; ++i) {
            if (raw[i] == ",") {
                ++column;
                require(column < 18, "authority corpus columns");
            } else {
                require(raw[i] >= "0" && raw[i] <= "9", "authority corpus integer");
                values[column] = values[column] * 10 + uint8(raw[i]) - 48;
            }
        }
        require(column == 17, "authority corpus row");
    }
}
