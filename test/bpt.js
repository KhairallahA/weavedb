const { expect } = require("chai")
const BPT = require("../sdk/contracts/weavedb-bpt/lib/BPT")
const {
  get,
  put,
  del,
  range: _range,
  addIndex,
  removeIndex,
  getIndexes,
  mod,
  mod2,
} = require("../sdk/contracts/weavedb-bpt/lib/Collection")
const { randO, shuffle, fuzztest } = require("./utils-bpt")
const { pluck, prop, range, sortWith, ascend, descend } = require("ramda")
const alpha = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"

describe("B+Tree", function () {
  this.timeout(0)

  before(async () => {})

  beforeEach(async () => {})

  it("should return mod stats", async () => {
    const prev = { test: 1, test2: 2, fav2: [1, 2], fav3: 3, fav4: [3] }
    const next = {
      test2: 3,
      test3: 3,
      fav: [1, 2],
      fav2: [2, 3],
      fav3: [3],
      fav4: 3,
    }
    const { dels, changes, news } = mod(prev, next)
    expect(dels).to.eql([
      "test",
      "fav2/array:c4ca4238a0b923820dcc509a6f75849b",
      "fav4/array:eccbc87e4b5ce2fe28308fd9f2a7baf3",
    ])
    expect(changes).to.eql(["test2", "fav2", "fav3", "fav4"])
    expect(news).to.eql([
      "fav2/array:eccbc87e4b5ce2fe28308fd9f2a7baf3",
      "fav3/array:eccbc87e4b5ce2fe28308fd9f2a7baf3",
      "test3",
      "fav",
      "fav/array:c4ca4238a0b923820dcc509a6f75849b",
      "fav/array:c81e728d9d4c2f636f067f89cc14862c",
    ])
  })

  it("should build a tree with numbers [fuzz]", async () => {
    await fuzztest(range(0, 100), "number")
  })

  it("should build a tree with strings [fuzz]", async () => {
    await fuzztest(alpha.split(""), "string")
  })

  it("should build a tree with objects [fuzz]", async () => {
    let items = []
    let nums = range(0, 100)
    shuffle(nums)
    for (const i of range(0, 100)) {
      items.push({ str: randO(alpha), num: nums[i] })
    }
    await fuzztest(
      items,
      [
        ["str", "desc"],
        ["num", "asc"],
      ],
      sortWith([descend(prop("str")), ascend(prop("num"))])
    )
  })

  it("should build a collection", async () => {
    let kvs = {}
    let SW = {
      kv: {
        get: key => kvs[key],
        put: (key, val) => {
          kvs[key] = val
        },
      },
    }
    let temp = {}
    const opt = [["ppl"], temp, SW, "0x"]
    const Bob = { name: "Bob", age: 3, favs: ["apple"] }
    await put(Bob, "Bob", ...opt)
    await put({ name: "Alice", age: 6, favs: ["orange"] }, "Alice", ...opt)
    await put({ name: "Beth", age: 5, favs: ["grapes"] }, "Beth", ...opt)
    expect(pluck("key", await _range([["age", "asc"]], {}, ...opt))).to.eql([
      "Bob",
      "Beth",
      "Alice",
    ])
    expect(
      pluck("key", await _range([["age", "asc"]], { reverse: true }, ...opt))
    ).to.eql(["Alice", "Beth", "Bob"])
    expect(
      pluck(
        "key",
        await _range([["age", "asc"]], { limit: 2, reverse: true }, ...opt)
      )
    ).to.eql(["Alice", "Beth"])
    expect(
      pluck(
        "key",
        await _range(
          [["age", "asc"]],
          { reverse: true, startAt: { age: 3 } },
          ...opt
        )
      )
    ).to.eql(["Bob"])
    expect(
      pluck(
        "key",
        await _range(
          [["name", "asc"]],
          { reverse: true, startAfter: { name: "Bob" } },
          ...opt
        )
      )
    ).to.eql(["Beth", "Alice"])
    expect(
      pluck(
        "key",
        await _range(
          [["name", "asc"]],
          {
            reverse: true,
            startAfter: { name: "Bob" },
            endBefore: { name: "Alice" },
          },
          ...opt
        )
      )
    ).to.eql(["Beth"])
    expect((await get("Bob", ...opt)).val).to.eql(Bob)
    await del("Bob", ...opt)
    expect(
      pluck("key", await _range([["age", "asc"]], { reverse: true }, ...opt))
    ).to.eql(["Alice", "Beth"])
    expect(
      pluck("key", await _range([["__id__", "asc"]], { reverse: true }, ...opt))
    ).to.eql(["Beth", "Alice"])
    await del("Bob", ...opt)
    await put(
      {
        name: "Alice",
        age: 5,
        favs: ["orange", "apple", "grapes"],
      },
      "Alice",
      ...opt
    )
    expect((await get("Alice", ...opt)).val).to.eql({
      name: "Alice",
      age: 5,
      favs: ["orange", "apple", "grapes"],
    })
    const sorter = [
      ["age", "desc"],
      ["name", "desc"],
    ]

    await addIndex(sorter, ...opt)
    expect(pluck("key")(await _range(sorter, {}, ...opt))).to.eql([
      "Beth",
      "Alice",
    ])

    await removeIndex(sorter, ...opt)
    expect(pluck("key")(await _range(sorter, {}, ...opt))).to.eql([])
  })
})
