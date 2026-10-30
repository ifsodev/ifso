// GENERATED from `forge build` (contracts/out/<Name>.sol/<Name>.json .abi). Do not edit.
export const ifsoEscrowAbi = [
  {
    "type": "constructor",
    "inputs": [
      {
        "name": "owner_",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "usdg_",
        "type": "address",
        "internalType": "contract IUSDG"
      },
      {
        "name": "evaluator_",
        "type": "address",
        "internalType": "contract IIfsoConditionEvaluator"
      },
      {
        "name": "feeRouter_",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "creationFee_",
        "type": "uint96",
        "internalType": "uint96"
      },
      {
        "name": "resolverFee_",
        "type": "uint96",
        "internalType": "uint96"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "ACCEPT_AUTH_TAG",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "ACCEPT_TYPEHASH",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "ACTION_DECLINE",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint8",
        "internalType": "uint8"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "ACTION_OK",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint8",
        "internalType": "uint8"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "ACTION_REFEREE_RELEASE",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint8",
        "internalType": "uint8"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "ACTION_REFEREE_RETURN",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint8",
        "internalType": "uint8"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "CLAIM_TYPEHASH",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "CREATE_AUTH_TAG",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "DECISION_TYPEHASH",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "DOMAIN_SEPARATOR",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "MAX_AMOUNT_CAP",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint96",
        "internalType": "uint96"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "MAX_CREATION_FEE",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint96",
        "internalType": "uint96"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "MAX_DURATION",
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
    "name": "MAX_RESOLVER_FEE",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint96",
        "internalType": "uint96"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "MIN_AMOUNT",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint96",
        "internalType": "uint96"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "MIN_EXPIRY_DELAY",
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
    "name": "REFUND_REDIRECT_TYPEHASH",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "accept",
    "inputs": [
      {
        "name": "id",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "linkSig",
        "type": "bytes",
        "internalType": "bytes"
      },
      {
        "name": "counterRefundTo",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "acceptAuthNonce",
    "inputs": [
      {
        "name": "id",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "acceptor",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "counterRefundTo",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "pure"
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
    "name": "acceptWithAuthorization",
    "inputs": [
      {
        "name": "id",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "acceptor",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "linkSig",
        "type": "bytes",
        "internalType": "bytes"
      },
      {
        "name": "counterRefundTo",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "validAfter",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "validBefore",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "authSig",
        "type": "bytes",
        "internalType": "bytes"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "approve",
    "inputs": [
      {
        "name": "id",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "cancel",
    "inputs": [
      {
        "name": "id",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "claim",
    "inputs": [
      {
        "name": "id",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "recipient",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "linkSig",
        "type": "bytes",
        "internalType": "bytes"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "claimVoid",
    "inputs": [
      {
        "name": "id",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "counterSide",
        "type": "bool",
        "internalType": "bool"
      },
      {
        "name": "alt",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "conditionHashOf",
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
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "pure"
  },
  {
    "type": "function",
    "name": "create",
    "inputs": [
      {
        "name": "p",
        "type": "tuple",
        "internalType": "struct CreateParams",
        "components": [
          {
            "name": "amount",
            "type": "uint96",
            "internalType": "uint96"
          },
          {
            "name": "counterAmount",
            "type": "uint96",
            "internalType": "uint96"
          },
          {
            "name": "recipient",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "linkKey",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "refundTo",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "altRefundTo",
            "type": "address",
            "internalType": "address"
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
          },
          {
            "name": "twoSided",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "cancellable",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "salt",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "condition",
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
          }
        ]
      }
    ],
    "outputs": [
      {
        "name": "id",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "createAuthNonce",
    "inputs": [
      {
        "name": "from",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "p",
        "type": "tuple",
        "internalType": "struct CreateParams",
        "components": [
          {
            "name": "amount",
            "type": "uint96",
            "internalType": "uint96"
          },
          {
            "name": "counterAmount",
            "type": "uint96",
            "internalType": "uint96"
          },
          {
            "name": "recipient",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "linkKey",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "refundTo",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "altRefundTo",
            "type": "address",
            "internalType": "address"
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
          },
          {
            "name": "twoSided",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "cancellable",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "salt",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "condition",
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
          }
        ]
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "pure"
  },
  {
    "type": "function",
    "name": "createBatch",
    "inputs": [
      {
        "name": "ps",
        "type": "tuple[]",
        "internalType": "struct CreateParams[]",
        "components": [
          {
            "name": "amount",
            "type": "uint96",
            "internalType": "uint96"
          },
          {
            "name": "counterAmount",
            "type": "uint96",
            "internalType": "uint96"
          },
          {
            "name": "recipient",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "linkKey",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "refundTo",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "altRefundTo",
            "type": "address",
            "internalType": "address"
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
          },
          {
            "name": "twoSided",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "cancellable",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "salt",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "condition",
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
          }
        ]
      }
    ],
    "outputs": [
      {
        "name": "ids",
        "type": "uint256[]",
        "internalType": "uint256[]"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "createWithAuthorization",
    "inputs": [
      {
        "name": "p",
        "type": "tuple",
        "internalType": "struct CreateParams",
        "components": [
          {
            "name": "amount",
            "type": "uint96",
            "internalType": "uint96"
          },
          {
            "name": "counterAmount",
            "type": "uint96",
            "internalType": "uint96"
          },
          {
            "name": "recipient",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "linkKey",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "refundTo",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "altRefundTo",
            "type": "address",
            "internalType": "address"
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
          },
          {
            "name": "twoSided",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "cancellable",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "salt",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "condition",
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
          }
        ]
      },
      {
        "name": "from",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "validAfter",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "validBefore",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "authSig",
        "type": "bytes",
        "internalType": "bytes"
      }
    ],
    "outputs": [
      {
        "name": "id",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "createWithPermit",
    "inputs": [
      {
        "name": "p",
        "type": "tuple",
        "internalType": "struct CreateParams",
        "components": [
          {
            "name": "amount",
            "type": "uint96",
            "internalType": "uint96"
          },
          {
            "name": "counterAmount",
            "type": "uint96",
            "internalType": "uint96"
          },
          {
            "name": "recipient",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "linkKey",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "refundTo",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "altRefundTo",
            "type": "address",
            "internalType": "address"
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
          },
          {
            "name": "twoSided",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "cancellable",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "salt",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "condition",
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
          }
        ]
      },
      {
        "name": "permitDeadline",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "v",
        "type": "uint8",
        "internalType": "uint8"
      },
      {
        "name": "r",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "s",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "id",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "creationFee",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint96",
        "internalType": "uint96"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "creationPaused",
    "inputs": [],
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
    "name": "decideBySig",
    "inputs": [
      {
        "name": "id",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "signer",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "action",
        "type": "uint8",
        "internalType": "uint8"
      },
      {
        "name": "deadline",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "sig",
        "type": "bytes",
        "internalType": "bytes"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "decline",
    "inputs": [
      {
        "name": "id",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "evaluator",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "contract IIfsoConditionEvaluator"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "feeFor",
    "inputs": [
      {
        "name": "kind",
        "type": "uint8",
        "internalType": "enum Kind"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "uint96",
        "internalType": "uint96"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "feeRouter",
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
    "name": "getCondition",
    "inputs": [
      {
        "name": "id",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "",
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
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "getEscrow",
    "inputs": [
      {
        "name": "id",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "tuple",
        "internalType": "struct IIfsoEscrow.Escrow",
        "components": [
          {
            "name": "sender",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "amount",
            "type": "uint96",
            "internalType": "uint96"
          },
          {
            "name": "recipient",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "counterAmount",
            "type": "uint96",
            "internalType": "uint96"
          },
          {
            "name": "linkKey",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "activeFrom",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "status",
            "type": "uint8",
            "internalType": "enum Status"
          },
          {
            "name": "flags",
            "type": "uint8",
            "internalType": "uint8"
          },
          {
            "name": "refundTo",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "expiry",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "altRefundTo",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "acceptBy",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "counterRefundTo",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "conditionHash",
            "type": "bytes32",
            "internalType": "bytes32"
          }
        ]
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "hashAccept",
    "inputs": [
      {
        "name": "id",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "acceptor",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "conditionHash",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "hashClaim",
    "inputs": [
      {
        "name": "id",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "recipient",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "conditionHash",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "hashDecision",
    "inputs": [
      {
        "name": "id",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "action",
        "type": "uint8",
        "internalType": "uint8"
      },
      {
        "name": "nonce",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "deadline",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "hashRefundRedirect",
    "inputs": [
      {
        "name": "id",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "refundTo",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "altRefundTo",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "nonce",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "deadline",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "idFor",
    "inputs": [
      {
        "name": "sender",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "salt",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "pure"
  },
  {
    "type": "function",
    "name": "maxAmount",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint96",
        "internalType": "uint96"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "nonces",
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
        "type": "uint256",
        "internalType": "uint256"
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
    "name": "refereeDecide",
    "inputs": [
      {
        "name": "id",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "toRecipient",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "refund",
    "inputs": [
      {
        "name": "id",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "senderAlt",
        "type": "bool",
        "internalType": "bool"
      },
      {
        "name": "counterAlt",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "resolverFee",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint96",
        "internalType": "uint96"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "setCounterRefundTo",
    "inputs": [
      {
        "name": "id",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "counterRefundTo",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "setCreationPaused",
    "inputs": [
      {
        "name": "paused",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "setFees",
    "inputs": [
      {
        "name": "creationFee_",
        "type": "uint96",
        "internalType": "uint96"
      },
      {
        "name": "resolverFee_",
        "type": "uint96",
        "internalType": "uint96"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "setMaxAmount",
    "inputs": [
      {
        "name": "maxAmount_",
        "type": "uint96",
        "internalType": "uint96"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "setRefundAddresses",
    "inputs": [
      {
        "name": "id",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "refundTo",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "altRefundTo",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "setRefundAddressesBySig",
    "inputs": [
      {
        "name": "id",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "refundTo",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "altRefundTo",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "deadline",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "sig",
        "type": "bytes",
        "internalType": "bytes"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "settle",
    "inputs": [
      {
        "name": "id",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "proof",
        "type": "bytes",
        "internalType": "bytes"
      },
      {
        "name": "senderAlt",
        "type": "bool",
        "internalType": "bool"
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
    "name": "usdg",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "contract IUSDG"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "event",
    "name": "Accepted",
    "inputs": [
      {
        "name": "id",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      },
      {
        "name": "acceptor",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "counterRefundTo",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "Approved",
    "inputs": [
      {
        "name": "id",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      },
      {
        "name": "party",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "Cancelled",
    "inputs": [
      {
        "name": "id",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      },
      {
        "name": "to",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "amount",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "Claimed",
    "inputs": [
      {
        "name": "id",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      },
      {
        "name": "recipient",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "CounterRefundChanged",
    "inputs": [
      {
        "name": "id",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      },
      {
        "name": "counterRefundTo",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "Created",
    "inputs": [
      {
        "name": "id",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      },
      {
        "name": "sender",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "recipient",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "linkKey",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      },
      {
        "name": "amount",
        "type": "uint96",
        "indexed": false,
        "internalType": "uint96"
      },
      {
        "name": "counterAmount",
        "type": "uint96",
        "indexed": false,
        "internalType": "uint96"
      },
      {
        "name": "kind",
        "type": "uint8",
        "indexed": false,
        "internalType": "enum Kind"
      },
      {
        "name": "conditionHash",
        "type": "bytes32",
        "indexed": false,
        "internalType": "bytes32"
      },
      {
        "name": "expiry",
        "type": "uint64",
        "indexed": false,
        "internalType": "uint64"
      },
      {
        "name": "twoSided",
        "type": "bool",
        "indexed": false,
        "internalType": "bool"
      },
      {
        "name": "feePaid",
        "type": "uint96",
        "indexed": false,
        "internalType": "uint96"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "CreationPaused",
    "inputs": [
      {
        "name": "paused",
        "type": "bool",
        "indexed": false,
        "internalType": "bool"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "Declined",
    "inputs": [
      {
        "name": "id",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      },
      {
        "name": "recipient",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "FeesUpdated",
    "inputs": [
      {
        "name": "creationFee",
        "type": "uint96",
        "indexed": false,
        "internalType": "uint96"
      },
      {
        "name": "resolverFee",
        "type": "uint96",
        "indexed": false,
        "internalType": "uint96"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "MaxAmountUpdated",
    "inputs": [
      {
        "name": "maxAmount",
        "type": "uint96",
        "indexed": false,
        "internalType": "uint96"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "Met",
    "inputs": [
      {
        "name": "id",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
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
    "name": "RefereeDecided",
    "inputs": [
      {
        "name": "id",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      },
      {
        "name": "referee",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "toRecipient",
        "type": "bool",
        "indexed": false,
        "internalType": "bool"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "RefundAddressesChanged",
    "inputs": [
      {
        "name": "id",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      },
      {
        "name": "refundTo",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      },
      {
        "name": "altRefundTo",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "Released",
    "inputs": [
      {
        "name": "id",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      },
      {
        "name": "to",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "amount",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "Returned",
    "inputs": [
      {
        "name": "id",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      },
      {
        "name": "to",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "amount",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "reason",
        "type": "uint8",
        "indexed": false,
        "internalType": "uint8"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "VoidClaimed",
    "inputs": [
      {
        "name": "id",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      },
      {
        "name": "to",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "amount",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "Voided",
    "inputs": [
      {
        "name": "id",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      },
      {
        "name": "senderTo",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      },
      {
        "name": "senderAmount",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "counterTo",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      },
      {
        "name": "counterAmount",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "error",
    "name": "AcceptWindowClosed",
    "inputs": []
  },
  {
    "type": "error",
    "name": "AlreadyAccepted",
    "inputs": []
  },
  {
    "type": "error",
    "name": "AlreadyClaimed",
    "inputs": []
  },
  {
    "type": "error",
    "name": "AlreadyExists",
    "inputs": []
  },
  {
    "type": "error",
    "name": "AmountAboveCap",
    "inputs": []
  },
  {
    "type": "error",
    "name": "BadRecipient",
    "inputs": []
  },
  {
    "type": "error",
    "name": "BadSignature",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ConditionPending",
    "inputs": []
  },
  {
    "type": "error",
    "name": "CreationIsPaused",
    "inputs": []
  },
  {
    "type": "error",
    "name": "Expired",
    "inputs": []
  },
  {
    "type": "error",
    "name": "FeeTooHigh",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvalidParams",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvalidSignatureLength",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvalidSignatureS",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvalidSignatureV",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvalidSigner",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NoAlternate",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NoChange",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NotALink",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NotAccepted",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NotAuthorized",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NotCancellable",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NotExpired",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NotOpen",
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
    "name": "NotTwoSided",
    "inputs": []
  },
  {
    "type": "error",
    "name": "Reentrancy",
    "inputs": []
  },
  {
    "type": "error",
    "name": "SignatureExpired",
    "inputs": []
  },
  {
    "type": "error",
    "name": "TransferFailed",
    "inputs": []
  },
  {
    "type": "error",
    "name": "TransferFromFailed",
    "inputs": []
  },
  {
    "type": "error",
    "name": "UseDecision",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ZeroAddress",
    "inputs": []
  }
] as const;
