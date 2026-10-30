// Optional: runs the same test/*.t.sol suites with Hardhat 3 (EDR supports the Foundry cheatcodes used in
// test/utils/TestBase.sol). Primary toolchain is Foundry (foundry.toml).
// If binaries.soliditylang.org is unreachable, point SOLC_JS at a local soljson.js (e.g. node_modules/solc/soljson.js).
import { defineConfig } from "hardhat/config";

export default defineConfig({
  solidity: {
    version: "0.8.28",
    ...(process.env.SOLC_JS ? { path: process.env.SOLC_JS } : {}),
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "cancun" },
  },
  paths: { sources: "src", tests: { solidity: "test" } },
  test: { solidity: { fuzz: { runs: 256 } } },
});
