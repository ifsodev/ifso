One file per chain, in the shape contracts/script/Deploy.s.sol writes ({ chainId, contracts: { IfsoEscrow: { address }, ... } }).
Generated: equal copies of contracts/deployments/<chainId>.json (an empty placeholder for a chain not deployed yet).
After a deploy run `bash scripts/sync-deployments.sh` (test/deployments-sync.test.ts checks the copies). NEXT_PUBLIC_CHAIN_ID picks the file.
The site also reads the escrow address from the API (GET /healthz) and refuses to continue if the two disagree.
