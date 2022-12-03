const { Ed25519KeyIdentity } = require("@dfinity/identity")
import arweave from "arweave"
import client from "weavedb-client"
import lf from "localforage"
import SDK from "weavedb-sdk"
import { ethers } from "ethers"
import { AuthClient } from "@dfinity/auth-client"
import { WarpFactory } from "warp-contracts"
import {
  is,
  includes,
  difference,
  keys,
  compose,
  map,
  clone,
  indexBy,
  prop,
  pluck,
  mergeLeft,
  isNil,
  concat,
  last,
  path,
} from "ramda"
import { Buffer } from "buffer"
import weavedb from "lib/weavedb.json"
let sdk

const weavedbSrcTxId = "7vXOxkxZ_eG0mwBO4pc_mB_oh1MY4pmHXzRQJfdMGCw"
const intmaxSrcTxId = "OTfBnNttwsi8b_95peWJ53eJJRqPrVh0s_0V-e5-s94"
const dfinitySrcTxId = "RQpDSz3PSyYSn6LRzWnX85bu6iGqCZKLxkdwQVoKzTI"
const ethereumSrcTxId = "dtLqn4y5fFD5xyiRCzaYjWxz5k8I6VxoVeARFphhuY4"

export const setupWeaveDB = async ({
  conf,
  set,
  val: { network, contractTxId },
}) => {
  let arweave = {
    Localhost: {
      host: "localhost",
      port: weavedb.port || 1820,
      protocol: "http",
    },
    Testnet: {
      host: "testnet.redstone.tools",
      port: 443,
      protocol: "https",
    },
    Mainnet: {
      host: "arweave.net",
      port: 443,
      protocol: "https",
    },
  }
  sdk = new SDK({
    wallet: weavedb.arweave,
    name: weavedb.weavedb.name,
    version: weavedb.weavedb.version,
    contractTxId: contractTxId,
    arweave: arweave[network],
  })
  window.Buffer = Buffer
  set(true, "initWDB")
  return sdk
}

export const createTempAddressWithII = async ({
  conf,
  set,
  val: { contractTxId },
}) => {
  const iiUrl = `http://localhost:8000/?canisterId=rwlgt-iiaaa-aaaaa-aaaaa-cai`
  console.log(iiUrl)
  const authClient = await AuthClient.create()
  await new Promise((resolve, reject) => {
    authClient.login({
      identityProvider: iiUrl,
      onSuccess: resolve,
      onError: reject,
    })
  })
  const ii = authClient.getIdentity()
  if (isNil(ii._inner)) return
  const addr = ii._inner.toJSON()[0]
  const ex_identity = await lf.getItem(`temp_address:${contractTxId}:${addr}`)
  let identity = ex_identity
  let tx
  identity = ii._inner.toJSON()
  await lf.setItem("temp_address:current", addr)
  set(addr, "temp_current")
  await lf.setItem("temp_address:current", addr)
  await lf.setItem(`temp_address:${contractTxId}:${addr}`, identity)
  set(addr, "temp_current")
}

export const createTempAddressWithAR = async ({
  conf,
  set,
  val: { contractTxId },
}) => {
  const wallet = window.arweaveWallet
  await wallet.connect(["SIGNATURE", "ACCESS_PUBLIC_KEY", "ACCESS_ADDRESS"])
  let addr = await wallet.getActiveAddress()
  const ex_identity = await lf.getItem(`temp_address:${contractTxId}:${addr}`)
  let identity = ex_identity
  let tx
  if (isNil(identity)) {
    ;({ tx, identity } = await sdk.createTempAddressWithAR(wallet))
  } else {
    await lf.setItem("temp_address:current", addr)
    set(addr, "temp_current")
    return
  }
  if (!isNil(tx) && isNil(tx.err)) {
    identity.tx = tx
    identity.linked_address = addr
    await lf.setItem("temp_address:current", addr)
    await lf.setItem(`temp_address:${contractTxId}:${addr}`, identity)
    set(addr, "temp_current")
  }
}

export const createTempAddress = async ({
  conf,
  set,
  val: { contractTxId },
}) => {
  const provider = new ethers.providers.Web3Provider(window.ethereum, "any")
  await provider.send("eth_requestAccounts", [])
  const signer = provider.getSigner()
  const addr = await signer.getAddress()
  const ex_identity = await lf.getItem(`temp_address:${contractTxId}:${addr}`)
  let identity = ex_identity
  let tx
  if (isNil(identity)) {
    ;({ tx, identity } = await sdk.createTempAddress(addr))
  } else {
    await lf.setItem("temp_address:current", addr)
    set(addr, "temp_current")
    return
  }
  if (!isNil(tx) && isNil(tx.err)) {
    identity.tx = tx
    identity.linked_address = addr
    await lf.setItem("temp_address:current", addr)
    await lf.setItem(`temp_address:${contractTxId}:${addr}`, identity)
    set(addr, "temp_current")
  }
}

export const switchTempAddress = async function ({
  conf,
  set,
  val: { contractTxId },
}) {
  const current = await lf.getItem(`temp_address:current`)
  if (!isNil(current)) {
    const identity = await lf.getItem(`temp_address:${contractTxId}:${current}`)
    set(!isNil(identity) ? current : null, "temp_current")
  } else {
    set(null, "temp_current")
  }
}

export const checkTempAddress = async function ({
  conf,
  set,
  val: { contractTxId },
}) {
  const current = await lf.getItem(`temp_address:current`)
  if (!isNil(current)) {
    const identity = await lf.getItem(`temp_address:${contractTxId}:${current}`)
    if (!isNil(identity)) set(current, "temp_current")
  }
}

export const logoutTemp = async ({ conf, set }) => {
  await lf.removeItem("temp_address:current")
  set(null, "temp_current")
}

export const queryDB = async ({
  val: { query, method, contractTxId },
  global,
  set,
  fn,
  conf,
  get,
}) => {
  try {
    const current = get("temp_current")
    let q
    eval(`q = [${query}]`)
    const identity = isNil(current)
      ? null
      : await lf.getItem(`temp_address:${contractTxId}:${current}`)
    let ii = null
    if (is(Array)(identity)) {
      ii = Ed25519KeyIdentity.fromJSON(JSON.stringify(identity))
    }
    const opt = !isNil(ii)
      ? { ii }
      : !isNil(identity) && !isNil(identity.tx)
      ? {
          wallet: current,
          privateKey: identity.privateKey,
        }
      : {
          privateKey: weavedb.ethereum.privateKey,
        }
    const res = await sdk[method](...q, opt)
    if (!isNil(res.err)) {
      return `Error: ${res.err.errorMessage}`
    } else {
      return JSON.stringify(res)
    }
  } catch (e) {
    console.log(e)
    return `Error: Something went wrong`
  }
}

const Constants = require("lib/poseidon_constants_opt.js")

async function deploy({ src, warp, init, extra, arweave }) {
  const contractSrc = await fetch(`/static/${src}.js`).then(v => v.text())
  const stateFromFile = JSON.parse(
    await fetch(`/static/${init}.json`).then(v => v.text())
  )
  const initialState = mergeLeft(extra, stateFromFile)
  const { contractTxId } = await warp.createContract.deploy({
    initState: JSON.stringify(initialState),
    src: contractSrc,
  })
  if (!isNil(arweave)) await arweave.api.get("mine")
  return contractTxId
}

async function deployFromSrc({ src, warp, init, extra }) {
  const stateFromFile = JSON.parse(
    await fetch(`/static/${init}.json`).then(v => v.text())
  )
  const initialState = mergeLeft(extra, stateFromFile)
  const { contractTxId } = await warp.createContract.deployFromSourceTx({
    initState: JSON.stringify(initialState),
    srcTxId: src,
  })
  return contractTxId
}

export const deployDB = async ({
  val: { owner, network, port },
  global,
  set,
  fn,
  conf,
  get,
}) => {
  if (isNil(owner)) {
    alert("Contract Owner is missing")
    return {}
  }
  if (network === "Mainnet") {
    const warp = WarpFactory.forMainnet()
    const contractTxId = await deployFromSrc({
      src: weavedbSrcTxId,
      init: "initial-state",
      warp,
      extra: {
        secure: false,
        owner,
        contracts: {
          intmax: intmaxSrcTxId,
          dfinity: dfinitySrcTxId,
          ethereum: ethereumSrcTxId,
        },
      },
    })
    return { contractTxId, network }
  } else {
    const warp = WarpFactory.forLocal(port)
    const poseidon1TxId = await deploy({
      src: "poseidonConstants",
      init: "initial-state-poseidon-constants",
      warp,
      arweave: sdk.arweave,
      extra: {
        owner,
        poseidonConstants: {
          C: Constants.C,
          M: Constants.M,
          P: Constants.P,
        },
      },
    })
    const poseidon2TxId = await deploy({
      src: "poseidonConstants",
      init: "initial-state-poseidon-constants",
      warp,
      arweave: sdk.arweave,
      extra: {
        owner: walletAddress,
        poseidonConstants: {
          S: Constants.S,
        },
      },
    })
    const intmaxSrcTxId = await deploy({
      src: "intmax",
      init: "initial-state-intmax",
      warp,
      arweave: sdk.arweave,
      extra: {
        owner: walletAddress,
        contracts: {
          poseidonConstants1: poseidon1TxId,
          poseidonConstants2: poseidon2TxId,
        },
      },
    })
    const dfinitySrcTxId = await deploy({
      src: "ii",
      init: "initial-state-ii",
      warp,
      arweave: sdk.arweave,
      extra: {
        owner: walletAddress,
      },
    })
    const ethereumSrcTxId = await deploy({
      src: "eth",
      init: "initial-state-eth",
      warp,
      arweave: sdk.arweave,
      extra: {
        owner: walletAddress,
      },
    })
    const contractTxId = await deploy({
      src: "contract",
      init: "initial-state",
      warp,
      arweave: sdk.arweave,
      extra: {
        secure: false,
        owner: walletAddress,
        contracts: {
          intmax: intmaxSrcTxId,
          dfinity: dfinitySrcTxId,
          ethereum: ethereumSrcTxId,
        },
      },
    })

    return { contractTxId, network }
  }
}
