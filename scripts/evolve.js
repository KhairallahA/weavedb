const EthCrypto = require("eth-crypto")
require("dotenv").config()
const fs = require("fs")
const path = require("path")
const wallet_name = process.argv[2]
const contractTxId = process.argv[3] || process.env.CONTRACT_TX_ID
const newContractSrcTxId = process.argv[4] || process.env.NEW_SOURCE_TX_ID
const { isNil } = require("ramda")
const SDK = require("../sdk")

if (isNil(wallet_name)) {
  console.log("no wallet name given")
  process.exit()
}

if (isNil(contractTxId)) {
  console.log("contract not specified")
  process.exit()
}

const setup = async () => {
  const wallet_path = path.resolve(
    __dirname,
    ".wallets",
    `wallet-${wallet_name}.json`
  )
  if (!fs.existsSync(wallet_path)) {
    console.log("wallet doesn't exist")
    process.exit()
  }
  const wallet = JSON.parse(fs.readFileSync(wallet_path, "utf8"))
  const sdk = new SDK({
    wallet,
    contractTxId,
  })
  console.log("evolve WeaveDB..." + contractTxId + " to " + newContractSrcTxId)
  await sdk.evolve(newContractSrcTxId, { ar: wallet })
  console.log("evolved!")
  process.exit()
}

setup()
