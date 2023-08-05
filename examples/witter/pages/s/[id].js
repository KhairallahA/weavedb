import { useRouter } from "next/router"
import { useState, useEffect } from "react"
import { Box, Flex, ChakraProvider, Image } from "@chakra-ui/react"
import Link from "next/link"
import {
  assoc,
  assocPath,
  last,
  concat,
  path,
  difference,
  __,
  keys,
  uniq,
  compose,
  mergeRight,
  prepend,
  clone,
  mergeLeft,
  isNil,
  map,
  pluck,
  filter,
  propEq,
  values,
  indexBy,
  prop,
} from "ramda"
import { timeline, users, tweets, body } from "../../lib/tweets"
import Tweet from "../../components/Tweet"
import Article from "../../components/Article"
import Header from "../../components/Header"
import SDK from "weavedb-client"
import { initDB, checkUser } from "../../lib/db"
import EditUser from "../../components/EditUser"
import EditStatus from "../../components/EditStatus"
const limit = 10

function StatusPage() {
  const router = useRouter()
  const [tweet, setTweet] = useState(null)
  const [users, setUsers] = useState({})
  const [likes, setLikes] = useState({})
  const [comments, setComments] = useState([])
  const [user, setUser] = useState(null)
  const [identity, setIdentity] = useState(null)
  const [editUser, setEditUser] = useState(false)
  const [editStatus, setEditStatus] = useState(false)
  const [replyTo, setReplyTo] = useState(null)
  const [reposted, setReposted] = useState(false)
  const [reposts, setReposts] = useState({})
  const [isNextComment, setIsNextComment] = useState(false)
  const [tweets, setTweets] = useState({})

  const getUsers = async __users => {
    const db = await initDB()
    const _users = compose(difference(__, keys(users)), uniq)(__users)
    if (_users.length > 0) {
      setUsers(
        compose(
          mergeRight(users),
          indexBy(prop("address"))
        )(await db.get("users", ["address", "in", _users]))
      )
    }
  }

  useEffect(() => {
    if (!isNil(router.query.id)) {
      ;(async () => {
        const db = await initDB()
        let post = await db.cget("posts", router.query.id)
        if (!isNil(post)) {
          setTweet(post)
          await getUsers([post.data.owner])
          const _comments = await db.cget(
            "posts",
            ["reply_to", "==", post.data.id],
            ["date", "desc"],
            limit
          )
          setComments(_comments)
          setIsNextComment(_comments.length >= limit)
          if (!isNil(post.data.body)) {
            try {
              const json = await fetch(post.data.body, { mode: "cors" }).then(
                v => v.json()
              )
              setTweet(assocPath(["data", "content"], json.content)(post))
            } catch (e) {}
          }
        }
      })()
    }
  }, [router])
  useEffect(() => {
    ;(async () => {
      const { user, identity } = await checkUser()
      setUser(user)
    })()
  }, [])
  useEffect(() => {
    ;(async () => {
      await getUsers(map(path(["data", "owner"]))(values(tweets)))
    })()
  }, [tweets])

  useEffect(() => {
    ;(async () => {
      let _tweets = indexBy(prop("id"))(comments)
      if (!isNil(tweet)) {
        _tweets = assoc(tweet.data.id, tweet)(_tweets)
      }
      setTweets(_tweets)
    })()
  }, [tweet, comments])

  useEffect(() => {
    ;(async () => {
      if (!isNil(user)) {
        await getUsers(compose(pluck("owner"), values)(tweets))
        const db = await initDB()
        const ids = difference(keys(tweets), keys(reposts))
        if (ids.length > 0) {
          let new_reposts = indexBy(prop("repost"))(
            await db.get(
              "posts",
              ["owner", "==", user.address],
              ["repost", "in", ids]
            )
          )
          for (let v of ids) {
            if (isNil(new_reposts[v])) new_reposts[v] = null
          }
          setReposts(mergeLeft(new_reposts, reposts))
        }
      }
    })()
  }, [tweets, user])

  useEffect(() => {
    ;(async () => {
      if (!isNil(user)) {
        await getUsers(compose(pluck("owner"), values)(tweets))
        const db = await initDB()
        const ids = difference(keys(tweets), keys(likes))
        if (ids.length > 0) {
          let new_likes = indexBy(prop("aid"))(
            await db.get(
              "likes",
              ["user", "==", user.address],
              ["aid", "in", ids]
            )
          )
          for (let v of ids) {
            if (isNil(new_likes[v])) new_likes[v] = null
          }
          setLikes(mergeLeft(new_likes, likes))
        }
      }
    })()
  }, [tweets, user])
  return (
    <ChakraProvider>
      <style jsx global>{`
        html,
        body,
        #__next {
          height: 100%;
          color: #333;
        }
      `}</style>
      {isNil(tweet) ? null : (
        <Flex justify="center" minH="100%" pb={10}>
          <Box flex={1}></Box>
          <Box w="100%" maxW="760px" minH="100%">
            <Header
              {...{
                setReplyTo,
                user,
                setUser,
                setEditUser,
                identity,
                setIdentity,
                setEditStatus,
              }}
            />
            <Box
              pb={3}
              maxW="760px"
              w="100%"
              display="flex"
              px={[2, 4, 6]}
              sx={{ borderBottom: "1px solid #ccc" }}
            >
              <Article
                {...{
                  reposted: reposts[tweet.data.id],
                  likes,
                  setLikes,
                  setTweet: () => {
                    setTweet(
                      assocPath(["data", "likes"], tweet.data.likes + 1, tweet)
                    )
                  },
                  setRetweet: repost => {
                    setTweet(
                      assocPath(
                        ["data", "reposts"],
                        tweet.data.reposts + 1,
                        tweet
                      )
                    )
                    setReposts(mergeLeft({ [tweet.data.id]: repost }, reposts))
                  },
                }}
                post={{
                  id: tweet.data.id,
                  title: tweet.data.title,
                  description: tweet.data.description,
                  body: tweet.data.content,
                  cover: tweet.data.cover,
                  likes: tweet.data.likes,
                  reposts: tweet.data.reposts,
                  comments: tweet.data.comments,
                }}
                user={user}
                puser={users[tweet.data.owner]}
              />
            </Box>
            {isNil(user) ? null : (
              <Flex
                p={4}
                onClick={() => {
                  setReplyTo(tweet.data.id)
                  setEditStatus(true)
                }}
                sx={{
                  cursor: "pointer",
                  ":hover": { opacity: 0.75 },
                  borderBottom: "1px solid #ccc",
                }}
                align="center"
              >
                <Image
                  src={user.image ?? "/images/default-icon.png"}
                  boxSize="35px"
                  m={1}
                  sx={{ borderRadius: "50%" }}
                />
                <Box flex={1} color="#666" pl={4}>
                  Write your reply!
                </Box>
                <Flex
                  mx={2}
                  px={8}
                  py={2}
                  bg="#333"
                  color="white"
                  height="auto"
                  align="center"
                  sx={{
                    borderRadius: "20px",
                  }}
                >
                  Reply
                </Flex>
              </Flex>
            )}
            {map(v => (
              <Tweet
                {...{
                  user,
                  likes,
                  setLikes,
                  setTweet: () => {
                    let _comments = clone(comments)
                    for (let v2 of _comments) {
                      if (v2.id === v.id) v2.data.likes += 1
                    }
                    setComments(_comments)
                  },
                  tweet: {
                    body: v.description,
                    id: v.id,
                    date: v.date,
                    user: v.owner,
                    reposts: v.reposts,
                    likes: v.likes,
                    comments: v.comments,
                  },
                  users,
                  reply: true,
                }}
              />
            ))(pluck("data")(comments))}
            {!isNextComment ? null : (
              <Flex p={4} justify="center">
                <Flex
                  justify="center"
                  w="300px"
                  py={2}
                  bg="#333"
                  color="white"
                  height="auto"
                  align="center"
                  sx={{
                    borderRadius: "20px",
                    cursor: "pointer",
                    ":hover": { opacity: 0.75 },
                  }}
                  onClick={async () => {
                    const db = await initDB()
                    const _comments = await db.cget(
                      "posts",
                      ["reply_to", "==", tweet.data.id],
                      ["date", "desc"],
                      ["startAfter", last(comments)],
                      limit
                    )
                    setComments(concat(comments, _comments))
                    setIsNextComment(_comments.length >= limit)
                  }}
                >
                  Load More
                </Flex>
              </Flex>
            )}
          </Box>
          <Box flex={1}></Box>
        </Flex>
      )}
      <EditUser {...{ setEditUser, editUser, identity, setUser, user }} />
      <EditStatus
        {...{
          setEditStatus,
          editStatus,
          user,
          replyTo,
          setPost: isNil(replyTo)
            ? null
            : post => {
                setTweet(
                  assocPath(
                    ["data", "comments"],
                    tweet.data.comments + 1,
                    tweet
                  )
                )
                setComments(prepend({ id: post.id, data: post }, comments))
              },
        }}
      />
    </ChakraProvider>
  )
}

export default StatusPage