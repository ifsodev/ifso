// GENERATED from `forge build` (contracts/out/<Name>.sol/<Name>.json .abi). Do not edit.
export const ifsoConditionEvaluatorAbi = [
  {
    "type": "constructor",
    "inputs": [
      {
        "name": "owner_",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "pyth_",
        "type": "address",
        "internalType": "contract IPyth"
      },
      {
        "name": "sequencerUptimeFeed_",
        "type": "address",
        "internalType": "contract AggregatorV3Interface"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "HOLD_CAP",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint32",
        "internalType": "uint32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "MAX_HORIZON",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "MAX_PYTH_CONF_BPS",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "MAX_STALE_CAP",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint32",
        "internalType": "uint32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "MIN_CLAIM_WINDOW",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "MIN_SETTLE_WINDOW",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "PROPOSAL_GRACE",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "SEQUENCER_GRACE",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "acceptOwnership",
    "inputs": [],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "evaluate",
    "inputs": [
      {
        "name": "c",
        "type": "tuple",
        "internalType": "struct Condition",
        "components": [
          {
            "name": "kind",
            "type": "uint8",
            "internalType": "enum Kind"
          },
          {
            "name": "mode",
            "type": "uint8",
            "internalType": "uint8"
          },
          {
            "name": "op",
            "type": "uint8",
            "internalType": "uint8"
          },
          {
            "name": "source",
            "type": "uint8",
            "internalType": "uint8"
          },
          {
            "name": "target",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "stockToken",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "key",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "threshold",
            "type": "int256",
            "internalType": "int256"
          },
          {
            "name": "multiplier",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "outcomeMask",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "start",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "deadline",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "maxStale",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "holdWindow",
            "type": "uint32",
            "internalType": "uint32"
          }
        ]
      },
      {
        "name": "activeFrom",
        "type": "uint64",
        "internalType": "uint64"
      },
      {
        "name": "proof",
        "type": "bytes",
        "internalType": "bytes"
      },
      {
        "name": "refundee",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "v",
        "type": "uint8",
        "internalType": "enum Verdict"
      }
    ],
    "stateMutability": "payable"
  },
  {
    "type": "function",
    "name": "feedAllowed",
    "inputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "feedStockToken",
    "inputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "owner",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "pendingOwner",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "pyth",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "contract IPyth"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "pythIdAllowed",
    "inputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "pythStockToken",
    "inputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "resolverAllowed",
    "inputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "sequencerUptimeFeed",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "contract AggregatorV3Interface"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "setFeed",
    "inputs": [
      {
        "name": "feed",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "allowed",
        "type": "bool",
        "internalType": "bool"
      },
      {
        "name": "stockToken",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "setPythId",
    "inputs": [
      {
        "name": "priceId",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "allowed",
        "type": "bool",
        "internalType": "bool"
      },
      {
        "name": "stockToken",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "setResolver",
    "inputs": [
      {
        "name": "resolver",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "allowed",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "transferOwnership",
    "inputs": [
      {
        "name": "newOwner",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "validate",
    "inputs": [
      {
        "name": "c",
        "type": "tuple",
        "internalType": "struct Condition",
        "components": [
          {
            "name": "kind",
            "type": "uint8",
            "internalType": "enum Kind"
          },
          {
            "name": "mode",
            "type": "uint8",
            "internalType": "uint8"
          },
          {
            "name": "op",
            "type": "uint8",
            "internalType": "uint8"
          },
          {
            "name": "source",
            "type": "uint8",
            "internalType": "uint8"
          },
          {
            "name": "target",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "stockToken",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "key",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "threshold",
            "type": "int256",
            "internalType": "int256"
          },
          {
            "name": "multiplier",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "outcomeMask",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "start",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "deadline",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "maxStale",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "holdWindow",
            "type": "uint32",
            "internalType": "uint32"
          }
        ]
      },
      {
        "name": "expiry",
        "type": "uint64",
        "internalType": "uint64"
      },
      {
        "name": "acceptBy",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "outputs": [],
    "stateMutability": "view"
  },
  {
    "type": "event",
    "name": "FeedSet",
    "inputs": [
      {
        "name": "feed",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "allowed",
        "type": "bool",
        "indexed": false,
        "internalType": "bool"
      },
      {
        "name": "stockToken",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "OwnershipTransferStarted",
    "inputs": [
      {
        "name": "previousOwner",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "newOwner",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "OwnershipTransferred",
    "inputs": [
      {
        "name": "previousOwner",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "newOwner",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "PythIdSet",
    "inputs": [
      {
        "name": "priceId",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "allowed",
        "type": "bool",
        "indexed": false,
        "internalType": "bool"
      },
      {
        "name": "stockToken",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "ResolverSet",
    "inputs": [
      {
        "name": "resolver",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "allowed",
        "type": "bool",
        "indexed": false,
        "internalType": "bool"
      }
    ],
    "anonymous": false
  },
  {
    "type": "error",
    "name": "BadProof",
    "inputs": []
  },
  {
    "type": "error",
    "name": "EthTransferFailed",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InsufficientFee",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvalidCondition",
    "inputs": []
  },
  {
    "type": "error",
    "name": "MultiplierMismatch",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NotEvaluable",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NotOwner",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NotPendingOwner",
    "inputs": []
  },
  {
    "type": "error",
    "name": "SequencerDown",
    "inputs": []
  },
  {
    "type": "error",
    "name": "SourceNotAllowed",
    "inputs": []
  },
  {
    "type": "error",
    "name": "UnprovableRound",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ZeroAddress",
    "inputs": []
  }
] as const;
