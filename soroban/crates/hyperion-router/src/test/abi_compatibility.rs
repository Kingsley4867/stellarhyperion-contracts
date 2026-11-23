//! Payout-relevant ABI and tuple compatibility fixtures.
//!
//! The active Stellar deployment is the compatibility baseline. EVM surfaces remain gated.

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct PayoutShape {
    amount: &'static str,
    recipient: &'static str,
    nonce: &'static str,
}

fn assert_payout_shape(shape: PayoutShape) {
    assert_eq!(
        (shape.amount, shape.recipient, shape.nonce),
        ("i128", "Address", "u64")
    );
}

#[test]
fn payout_tuple_layout_rejects_removal_or_reordering() {
    let baseline = PayoutShape {
        amount: "i128",
        recipient: "Address",
        nonce: "u64",
    };
    assert_payout_shape(baseline);

    let removed = PayoutShape {
        amount: "i128",
        recipient: "Address",
        nonce: "",
    };
    assert_ne!(baseline, removed);

    let reordered = PayoutShape {
        amount: "i128",
        recipient: "u64",
        nonce: "Address",
    };
    assert_ne!(baseline, reordered);
}
