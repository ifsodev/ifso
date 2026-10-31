// Fork-only browser wallet for the site: an EIP-6963 provider that signs with the fork's throwaway keys through the dev
// signer (serve.ts, 127.0.0.1 only). Paste it into the page's console, or inject it with the browser tool, BEFORE the
// site looks for wallets; it announces itself again whenever the page asks.
//   window.__forkWallet(<address of one of the fork actors>)    e.g. heidi
(() => {
  const SIGNER = window.__FORK_SIGNER ?? "http://127.0.0.1:8092";
  const RPC = window.__FORK_RPC ?? "http://127.0.0.1:8555";
  const CHAIN_HEX = "0x" + (window.__FORK_CHAIN ?? 4663).toString(16);
  let account = window.__FORK_ACCOUNT;
  const rpc = async (method, params) => {
    const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    const j = await r.json();
    if (j.error) throw Object.assign(new Error(j.error.message), { code: j.error.code });
    return j.result;
  };
  const signer = async (body) => {
    const r = await fetch(SIGNER + "/sign", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address: account, ...body }) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || "signer refused");
    return j;
  };
  const provider = {
    isForkDevWallet: true,
    async request({ method, params = [] }) {
      switch (method) {
        case "eth_requestAccounts":
        case "eth_accounts": return account ? [account] : [];
        case "eth_chainId": return CHAIN_HEX;
        case "net_version": return String(parseInt(CHAIN_HEX, 16));
        case "wallet_switchEthereumChain":
        case "wallet_addEthereumChain": return null;
        case "personal_sign": return (await signer({ kind: "message", message: new TextDecoder().decode(Uint8Array.from((params[0].slice(2).match(/../g) || []).map((h) => parseInt(h, 16)))) })).signature;
        case "eth_signTypedData_v4": {
          const td = typeof params[1] === "string" ? JSON.parse(params[1]) : params[1];
          const types = { ...td.types }; delete types.EIP712Domain;
          return (await signer({ kind: "typed", typedData: { domain: td.domain, types, primaryType: td.primaryType, message: td.message } })).signature;
        }
        case "eth_sendTransaction": return (await signer({ kind: "send", tx: params[0] })).hash;
        default: return rpc(method, params);
      }
    },
    on() {}, removeListener() {},
  };
  const info = { uuid: "fork-dev-wallet-0001", name: "Fork dev wallet", icon: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIzMiIgaGVpZ2h0PSIzMiI+PHJlY3Qgd2lkdGg9IjMyIiBoZWlnaHQ9IjMyIiBmaWxsPSIjMzMzIi8+PC9zdmc+", rdns: "dev.fork.wallet" };
  const announce = () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: Object.freeze({ info, provider }) }));
  window.addEventListener("eip6963:requestProvider", announce);
  window.__forkWallet = (addr) => { account = addr; announce(); };
  announce();
})();
