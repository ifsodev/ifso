One file per chain, in the shape contracts/script/Deploy.s.sol writes ({ chainId, contracts: { IfsoEscrow: { address }, ... } }).
Empty until the deploy. After a deploy, copy contracts/deployments/<chainId>.json here. NEXT_PUBLIC_CHAIN_ID picks the file.
The site also reads the escrow address from the API (GET /healthz) and refuses to continue if the two disagree.
