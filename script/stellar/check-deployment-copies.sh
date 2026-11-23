#!/usr/bin/env bash
#
# Compare the canonical deployment record with the backend and frontend copies at explicit
# revisions. Read only: no signing, no submission, and no consumer copy is rewritten.
#
# A copy that is out of date is fixed in its own repository, in its own reviewed change. This
# command reports the field path and the owning repository so that change has a precise scope.
#
# Usage:
#   script/stellar/check-deployment-copies.sh \
#     --copy stellarhyperion-backend=git:../stellarhyperion-backend:$BACKEND_COMMIT:deployments/stellar-testnet-phase1.json \
#     --copy stellarhyperion-frontend=git:../stellarhyperion-frontend:$FRONTEND_COMMIT:deployments/stellar-testnet-phase1.json
#
# Local rehearsal against working-tree files (reported as not reproducible):
#   script/stellar/check-deployment-copies.sh \
#     --copy frontend=file:/tmp/frontend-copy.json --allow-working-tree
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

command -v node >/dev/null || die "node is not on PATH"
git --version >/dev/null 2>&1 || true

exec node "$(dirname "${BASH_SOURCE[0]}")/check-deployment-copies.mjs" "$@"
