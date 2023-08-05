const pako = require("pako")
const md5 = require("md5")
const Arweave = require("arweave")
const grpc = require("@grpc/grpc-js")
const protoLoader = require("@grpc/proto-loader")
const { addReflection } = require("grpc-server-reflection")
const PROTO_PATH = __dirname + "/weavedb.proto"
const {
  last,
  keys,
  isNil,
  is,
  pluck,
  o,
  flatten,
  map,
  append,
  includes,
  concat,
  path: _path,
} = require("ramda")
const DB = require("weavedb-offchain")
const Warp = require("weavedb-sdk-node")
const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
})
const { port = 9090, config = "./weavedb.standalone.config.js" } =
  require("yargs")(process.argv.slice(2)).argv
const weavedb = grpc.loadPackageDefinition(packageDefinition).weavedb
const { open } = require("lmdb")
const path = require("path")
const EthCrypto = require("eth-crypto")

class Standalone {
  constructor({ port = 9090, conf }) {
    this.conf = conf
    this.port = port
    this.txs = []
    this.tx_count = 0
    this.bundling = null
    this.bundler = EthCrypto.createIdentity()
    this.kvs = {}
    this.kvs_wal = {}
    this.kvs_plg = {}
    this.dir = this.conf.cacheDir ?? path.resolve(__dirname, "cache")
    this.plugins = {}
    console.log(`Bundler: ${this.bundler.address}`)
  }
  async init() {
    await this.initDB()
    this.startServer()
    if (!isNil(this.conf.contractTxId)) this.bundle()
  }
  startServer() {
    const server = new grpc.Server()
    server.addService(weavedb.DB.service, {
      query: this.query.bind(this),
    })
    server.bindAsync(
      `0.0.0.0:${this.port}`,
      grpc.ServerCredentials.createInsecure(),
      () => {
        addReflection(
          server,
          path.resolve(__dirname, "./static_codegen/descriptor_set.bin")
        )
        server.start()
      }
    )
    console.log(`server ready on ${this.port}!`)
  }
  measureSizes(bundles) {
    let sizes = 0
    let _bundlers = []
    for (let v of bundles) {
      if (isNil(v.data?.param)) continue
      const len = JSON.stringify(v.data.param).length
      if (sizes + len <= 3900) {
        _bundlers.push(v)
        sizes += len
      } else {
        break
      }
    }
    return _bundlers
  }
  async bundle() {
    try {
      const bundling = await this.wal.cget(
        "txs",
        ["commit"],
        ["id"],
        ["commit", "==", false],
        10
      )
      const bundles = this.measureSizes(bundling)
      if (bundles.length > 0) {
        console.log(
          `commiting to Warp...${map(_path(["data", "id"]))(bundles)}`
        )
        const result = await this.warp.bundle(
          map(_path(["data", "param"]))(bundles)
        )
        console.log(`bundle tx result: ${result.success}`)
        if (result.success === true) {
          await this.wal.batch(
            map(
              v => [
                "update",
                { commit: true, warp: result.originalTxId },
                "txs",
                v.id,
              ],
              bundles
            )
          )
        }
      }
    } catch (e) {
      console.log(e)
    }
    setTimeout(() => this.bundle(), 3000)
  }
  async initDB() {
    console.log(`Owner Account: ${this.conf.owner}`)
    await this.initWAL()
    await this.initOffchain()
    await this.initWarp()
    await this.initPlugins()
  }
  async initPlugins() {
    this.plugins.notifications = new DB({
      type: 3,
      noauth: true,
      cache: {
        initialize: async obj => {
          obj.lmdb_plg_notifications = open({
            path: path.resolve(
              this.dir,
              "plugins",
              `${this.conf.dbname ?? "weavedb"}${
                isNil(this.conf.contractTxId)
                  ? ""
                  : `-${this.conf.contractTxId}`
              }-notifications`
            ),
          })
          let saved_state = await obj.lmdb_plg_notifications.get("state")
          if (!isNil(saved_state)) obj.state = saved_state
        },
        onWrite: async (tx, obj, param) => {
          let prs = [obj.lmdb_plg_notifications.put("state", tx.state)]
          for (const k in tx.result.kvs) {
            this.kvs_plg[k] = tx.result.kvs[k]
            prs.push(obj.lmdb_plg_notifications.put(k, tx.result.kvs[k]))
          }
          Promise.all(prs).then(() => {})
        },
        get: async (key, obj) => {
          let val = this.kvs_plg[key]
          if (typeof val === "undefined")
            val = await obj.lmdb_plg_notifications.get(key)
          return val
        },
      },
      state: { owner: this.conf.owner, secure: false },
    })
    await this.plugins.notifications.initialize()
    console.log("plugin initialized")
    const last_wal =
      (await this.plugins.notifications.get("conf", "notifications"))
        ?.last_wal ?? null
    console.log(JSON.stringify(last_wal))
    console.log(`last WAL: ${last_wal}`)
    await this.getWAL(last_wal)
  }
  async execPlugin(v, arts = {}) {
    const func = v.data.input.function
    const data = v.data.input.query[0]
    const col = v.data.input.query[1]
    if (func === "set" && col === "likes") {
      const from = data.user
      arts[data.aid] ??= await this.db.get("posts", data.aid)
      const article = arts[data.aid]
      const to = article.owner
      if (from === to) return
      const date = data.date
      const id = md5(`like:${from}:${to}:${article.id}:${date}`)
      await this.plugins.notifications.set(
        {
          wid: v.data.id,
          type: "like",
          id,
          from,
          to,
          date,
          aid: article.id,
          viewed: from === to,
        },
        "notifications",
        id
      )
      console.log(
        `[${to.slice(0, 5)}] ${article.id} liked by ${from.slice(
          0,
          5
        )} at ${date}`
      )
    }
    if (func === "set" && col === "follows") {
      const from = data.from
      const to = data.to
      const date = data.date
      const id = md5(`follow:${from}:${to}:${date}`)
      await this.plugins.notifications.set(
        {
          wid: v.data.id,
          type: "follow",
          id,
          from,
          to,
          date,
          viewed: from === to,
        },
        "notifications",
        id
      )
      console.log(
        `[${to.slice(0, 5)}] followed by ${from.slice(0, 5)} at ${date}`
      )
    }
    if (func === "set" && col === "posts") {
      if (data.repost !== "") {
        arts[data.aid] ??= await this.db.get("posts", data.repost)
        const article = arts[data.aid]
        const from = data.owner
        const to = article.owner
        if (from === to) return
        const date = data.date
        const id = md5(`repost:${from}:${to}:${article.id}:${data.id}:${date}`)
        await this.plugins.notifications.set(
          {
            wid: v.data.id,
            type: "repost",
            id,
            from,
            to,
            date,
            aid: article.id,
            rid: data.id,
            viewed: from === to,
          },
          "notifications",
          id
        )
        console.log(
          `[${to.slice(0, 5)}] reposted by ${from.slice(0, 5)} at ${date}`
        )
      } else if (data.reply_to !== "") {
        arts[data.reply_to] ??= await this.db.get("posts", data.reply_to)
        const article = arts[data.reply_to]
        const from = data.owner
        const to = article.owner
        const date = data.date
        const id = md5(`reply:${from}:${to}:${article.id}:${data.id}:${date}`)
        await this.plugins.notifications.set(
          {
            wid: v.data.id,
            type: "reply",
            id,
            from,
            to,
            date,
            aid: article.id,
            rid: data.id,
            viewed: from === to,
          },
          "notifications",
          id
        )
        console.log(
          `[${to.slice(0, 5)}] replied by ${from.slice(0, 5)} at ${date}`
        )
      }
    }
  }
  async getWAL(next = null) {
    const limit = 10
    let params = ["txs", ["id"]]
    if (!isNil(next)) params.push(["startAfter", next])
    let arts = {}
    const txs = await this.wal.cget(...params, limit)
    for (let v of txs) await this.execPlugin(v, arts)
    if (txs.length > 0) {
      const last_wal = last(txs).data.id
      await this.plugins.notifications.set(
        { last_wal },
        "conf",
        "notifications"
      )
      if (txs.length === limit) this.getWAL(last(txs))
    }
  }
  async initWAL() {
    this.wal = new DB({
      type: 3,
      noauth: true,
      cache: {
        initialize: async obj => {
          obj.lmdb_wal = open({
            path: path.resolve(
              this.dir,
              "rollup",
              `${this.conf.dbname ?? "weavedb"}${
                isNil(this.conf.contractTxId)
                  ? ""
                  : `-${this.conf.contractTxId}`
              }-wal`
            ),
          })
          let saved_state = await obj.lmdb_wal.get("state")
          if (!isNil(saved_state)) obj.state = saved_state
        },
        onWrite: async (tx, obj, param) => {
          let prs = [obj.lmdb_wal.put("state", tx.state)]
          for (const k in tx.result.kvs) {
            this.kvs_wal[k] = tx.result.kvs[k]
            prs.push(obj.lmdb_wal.put(k, tx.result.kvs[k]))
          }
          Promise.all(prs).then(() => {})
        },
        get: async (key, obj) => {
          let val = this.kvs_wal[key]
          if (typeof val === "undefined") val = await obj.lmdb_wal.get(key)
          return val
        },
      },
      state: { owner: this.conf.owner, secure: false },
    })
    await this.wal.initialize()
    await this.wal.addIndex([["commit"], ["id"]], "txs")
    this.tx_count = (await this.wal.get("txs", ["id", "desc"], 1))[0]?.id ?? 0
    console.log(`${this.tx_count} txs has been cached`)
  }
  async initOffchain() {
    const state = { owner: this.conf.owner, secure: this.conf.secure ?? true }
    this.db = new DB({
      type: 3,
      cache: {
        initialize: async obj => {
          obj.lmdb = open({
            path: path.resolve(
              this.dir,
              "rollup",
              `${this.conf.dbname ?? "weavedb"}${
                isNil(this.conf.contractTxId)
                  ? ""
                  : `-${this.conf.contractTxId}`
              }`
            ),
          })
          let saved_state = await obj.lmdb.get("state")
          if (!isNil(saved_state)) obj.state = saved_state
          console.log(`DB initialized!`)
          console.log(obj.state)
        },
        onWrite: async (tx, obj, param) => {
          let prs = [obj.lmdb.put("state", tx.state)]
          for (const k in tx.result.kvs) {
            this.kvs[k] = tx.result.kvs[k]
            prs.push(obj.lmdb.put(k, tx.result.kvs[k]))
          }
          Promise.all(prs).then(() => {})
          const t = {
            id: ++this.tx_count,
            txid: tx.result.transaction.id,
            commit: false,
            tx_ts: tx.result.block.timestamp,
            input: param,
          }
          await this.wal.set(t, "txs", `${t.id}`)
          this.execPlugin({ id: t.id, data: t })
            .then(async () => {
              await this.plugins.notifications.set(
                { last_wal: t.id },
                "conf",
                "notifications"
              )
            })
            .catch(e => console.log(e))
        },
        get: async (key, obj) => {
          let val = this.kvs[key]
          if (typeof val === "undefined") val = await obj.lmdb.get(key)
          return val
        },
      },
      state,
    })
    await this.db.initialize()
  }
  async initWarp() {
    const contractTxId = this.conf.contractTxId
    if (!isNil(contractTxId)) {
      console.log(`contractTxId: ${contractTxId}`)
      this.warp = new Warp({
        lmdb: { dir: path.resolve(this.dir, "warp") },
        type: 3,
        contractTxId: contractTxId,
        remoteStateSyncEnabled: false,
        nocache: true,
        progress: async input => {
          console.log(
            `loading ${this.conf.contractTxId} [${input.currentInteraction}/${input.allInteractions}]`
          )
        },
      })
      await this.warp.init()
      const _state = await this.warp.readState()
      let len = 0
      try {
        len = keys(_state.cachedValue.validity).length
      } catch (e) {}
      if (this.tx_count === 0 && len > 0) {
        console.log("recovering WAL...")
        const txs = await this.warp.warp.interactionsLoader.load(contractTxId)
        for (let v of txs) {
          for (const tag of v.tags || []) {
            if (tag.name === "Input") {
              const input = JSON.parse(tag.value)
              if (input.function === "bundle") {
                const compressed = new Uint8Array(
                  Buffer.from(input.query, "base64")
                    .toString("binary")
                    .split("")
                    .map(function (c) {
                      return c.charCodeAt(0)
                    })
                )
                for (const input of JSON.parse(
                  pako.inflate(compressed, { to: "string" })
                )) {
                  let t = {
                    id: ++this.tx_count,
                    warp: v.id,
                    commit: true,
                    txid: md5(JSON.stringify({ contractTxId, input })),
                    input,
                    blk_ts: v.block.timestamp,
                  }
                  console.log(`saving... [${this.tx_count}] ${t.txid}`)
                  await this.wal.set(t, "txs", `${t.id}`)
                }
                break
              }
            }
          }
        }
      }
    }
  }
  parseQuery(call, callback) {
    const res = (err, result = null) => {
      callback(null, {
        result: isNil(result) ? null : JSON.stringify(result),
        err,
      })
    }
    const { method, query, nocache } = call.request
    let [func, txid] = method.split("@")
    if (!isNil(txid)) txid = txid.split("@")[0]
    return { nocache, res, txid, func, query, isAdmin: func === "admin" }
  }

  async query(call, callback) {
    let parsed = this.parseQuery(call, callback)
    const { res, nocache, txid, func, query, isAdmin } = parsed
    if (txid === "log" && !includes(func)(["get", "cget"])) {
      res("only get/cget is allowed with log", null)
      return
    }
    this.execUser(parsed)
  }
  async execUser(parsed) {
    const { res, nocache, txid, func, query } = parsed
    const _query = JSON.parse(query)
    const key = DB.getKeyInfo(
      txid,
      !isNil(_query.query) ? _query : { function: func, query: _query },
      this.conf.cache_prefix
    )
    let data = null
    let result, err, dryWrite
    ;({ result, err, dryWrite } = await this.sendQuery(parsed, key))
    //if (!dryWrite) res(err, result)
    res(err, result)
  }
  async sendQuery({ func, txid, nocache, query, res }, key) {
    let result = null
    let err = null
    let dryWrite = false
    let _onDryWrite = null
    const db =
      txid === "log"
        ? this.wal
        : txid === "notifications"
        ? this.plugins.notifications
        : this.db
    try {
      let _query = query === `""` ? [] : JSON.parse(query)
      if (is(Object, _query) && is(Object, _query.dryWrite)) {
        _onDryWrite = _query.dryWrite
        delete _query.dryWirte
      }
      if (func === "getNonce") {
        result = await db.getNonce(..._query)
      } else if (key.func === "cget") {
        if (nocache) {
          result = await db.cget(..._query, true)
        } else {
          result = await db.cget(..._query)
        }
        if (key.type === "collection") {
          if (func === "get") result = pluck("data", result)
        } else {
          if (func === "get") result = isNil(result) ? null : result.data
        }
      } else if (includes(func)(db.reads)) {
        if (includes(func)(["getVersion"]) || nocache) {
          try {
            _query.push(true)
          } catch (e) {
            console.log(e)
          }
        }
        result = await db[key.func](..._query)
      } else {
        dryWrite = !nocache
        let virtual_txid = null
        const cache = _onDryWrite?.cache || true
        const onDryWrite = nocache
          ? null
          : {
              cb: _res => {
                delete _res.state
                res(null, _res)
                virtual_txid = _res?.result?.transaction?.id || null
              },
              cache,
              read: _onDryWrite?.read || null,
            }
        result = await db.write(key.func, _query, true, true, false, onDryWrite)
        //if (!isNil(virtual_txid)) this.results[virtual_txid] = result
      }
    } catch (e) {
      console.log(e)
      err =
        typeof e === "string"
          ? e
          : typeof e.message === "string"
          ? e.message
          : "unknown error"
    }
    return { result, err, dryWrite }
  }
}

const db = new Standalone({ port, conf: require(config) })

db.init()
