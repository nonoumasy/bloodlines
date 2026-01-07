import React, { useEffect, useRef, useState } from "react"

const WD_API = "https://www.wikidata.org/w/api.php"
const WP_BASE = "https://en.wikipedia.org/wiki/"
const COMMONS_FILEPATH = "https://commons.wikimedia.org/wiki/Special:FilePath/"
const MAX_DEPTH = 3
const AVATAR_SIZE = 48

// Wikidata properties
const P_BIRTH = "P569" // date of birth
const P_DEATH = "P570" // date of death
const P_INSTANCE_OF = "P31" // instance of
const Q_HUMAN = "Q5" // human

const yearFromWikidataTime = (t) => {
  if (!t) return null
  const m = String(t).match(/^([+-])(\d{4,})-/)
  if (!m) return null
  const sign = m[1] === "-" ? -1 : 1
  const year = parseInt(m[2], 10)
  if (Number.isNaN(year)) return null
  return sign * year
}

const formatYear = (y) => {
  if (y == null) return ""
  if (y < 0) return `${Math.abs(y)} BCE`
  return `${y}`
}

// ✅ Only compute age if BOTH birth and death exist.
const calcAgeYears = (birthYear, deathYear) => {
  if (birthYear == null) return null
  if (deathYear == null) return null
  if (birthYear < 0 || deathYear < 0) return null
  const age = deathYear - birthYear
  if (!Number.isFinite(age) || age < 0) return null
  return age
}

const firstStringFromClaims = (claims, prop) => {
  const arr = claims?.[prop]
  if (!Array.isArray(arr)) return ""
  for (const c of arr) {
    const v = c?.mainsnak?.datavalue?.value
    if (typeof v === "string" && v.trim()) return v.trim()
  }
  return ""
}

// ✅ Strict: only accept time values with year-or-better precision (>= 9)
const yearFromClaimsStrict = (claims, prop) => {
  const arr = claims?.[prop]
  if (!Array.isArray(arr)) return null

  for (const c of arr) {
    const v = c?.mainsnak?.datavalue?.value
    const time = v?.time
    const precision = v?.precision

    if (
      typeof time === "string" &&
      typeof precision === "number" &&
      precision >= 9
    ) {
      const y = yearFromWikidataTime(time)
      if (y != null) return y
    }
  }

  return null
}

const isHumanEntity = (entity) => {
  const claims = entity?.claims || {}
  const arr = claims?.[P_INSTANCE_OF]
  if (!Array.isArray(arr)) return false
  for (const c of arr) {
    const id = c?.mainsnak?.datavalue?.value?.id
    if (id === Q_HUMAN) return true
  }
  return false
}

const App = () => {
  const [q, setQ] = useState("")
  const [searchStatus, setSearchStatus] = useState("idle") // idle | loading | error
  const [searchErr, setSearchErr] = useState("")
  const [results, setResults] = useState([])
  const [rootId, setRootId] = useState(null)

  // ✅ useRef so mutating it doesn't trip compiler/lint rules
  const cacheRef = useRef(new Map())

  const buildUrl = (params) => {
    const u = new URL(WD_API)
    Object.entries(params).forEach(([k, v]) => u.searchParams.set(k, v))
    u.searchParams.set("origin", "*")
    return u.toString()
  }

  const fetchJson = async (url, signal) => {
    const r = await fetch(url, { signal })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    return r.json()
  }

  // ✅ Search + filter to PEOPLE ONLY (P31=Q5)
  const searchEntities = async (query, signal) => {
    const searchUrl = buildUrl({
      action: "wbsearchentities",
      format: "json",
      language: "en",
      uselang: "en",
      type: "item",
      search: query,
      limit: "12",
    })

    const searchJson = await fetchJson(searchUrl, signal)
    const hits = Array.isArray(searchJson.search) ? searchJson.search : []
    if (!hits.length) return []

    const ids = hits
      .map((x) => x.id)
      .filter(Boolean)
      .join("|")
    const entsUrl = buildUrl({
      action: "wbgetentities",
      format: "json",
      languages: "en",
      props: "claims",
      ids,
    })

    const entsJson = await fetchJson(entsUrl, signal)
    const entities = entsJson?.entities || {}

    const peopleHits = hits.filter((h) => isHumanEntity(entities[h.id]))

    return peopleHits.map((x) => ({
      id: x.id,
      label: x.label || x.id,
      description: x.description || "",
    }))
  }

  const getEntity = async (qid, signal) => {
    const cache = cacheRef.current
    if (cache.has(qid)) return cache.get(qid)

    const url = buildUrl({
      action: "wbgetentities",
      format: "json",
      languages: "en",
      props: "labels|descriptions|claims|sitelinks",
      ids: qid,
    })
    const json = await fetchJson(url, signal)
    const entity = json?.entities?.[qid] || null
    cache.set(qid, entity)
    return entity
  }

  const qidsFromClaims = (claims, prop) => {
    const arr = claims?.[prop]
    if (!Array.isArray(arr)) return []
    const out = []
    for (const c of arr) {
      const id = c?.mainsnak?.datavalue?.value?.id
      if (id) out.push(id)
    }
    return out
  }

  const makeCommonsImageUrl = (filename, width) => {
    const safe = encodeURIComponent(String(filename || "").replace(/ /g, "_"))
    if (!safe) return ""
    return `${COMMONS_FILEPATH}${safe}?width=${width}`
  }

  const getLabelDescClaimsAndWiki = async (qid, signal) => {
    const e = await getEntity(qid, signal)
    if (!e) throw new Error(`No entity for ${qid}`)

    const label =
      e.labels?.en?.value || Object.values(e.labels || {})[0]?.value || qid
    const description =
      e.descriptions?.en?.value ||
      Object.values(e.descriptions || {})[0]?.value ||
      ""
    const claims = e.claims || {}

    const enTitle = e.sitelinks?.enwiki?.title || ""
    const wikipediaUrl = enTitle
      ? `${WP_BASE}${encodeURIComponent(enTitle.replace(/ /g, "_"))}`
      : ""

    const imageFilename = firstStringFromClaims(claims, "P18")
    const imageUrl = imageFilename
      ? makeCommonsImageUrl(imageFilename, AVATAR_SIZE * 2)
      : ""

    let birthYear = yearFromClaimsStrict(claims, P_BIRTH)
    let deathYear = yearFromClaimsStrict(claims, P_DEATH)

    // reject impossible
    if (birthYear != null && deathYear != null && birthYear > deathYear) {
      birthYear = null
      deathYear = null
    }

    const age = calcAgeYears(birthYear, deathYear)

    return {
      id: qid,
      label,
      description,
      claims,
      wikipediaUrl,
      imageUrl,
      birthYear,
      deathYear,
      age,
    }
  }

  const uniqQids = (arr) =>
    Array.from(
      new Set(arr.filter((x) => typeof x === "string" && /^Q\d+$/.test(x)))
    )

  // ✅ Effect does ONLY the async search (no synchronous resets)
  useEffect(() => {
    if (!q.trim() || rootId) return

    const ac = new AbortController()
    const t = setTimeout(async () => {
      try {
        setSearchStatus("loading")
        setSearchErr("")
        const r = await searchEntities(q.trim(), ac.signal)
        setResults(r)
        setSearchStatus("idle")
      } catch (e) {
        if (e?.name === "AbortError") return
        setSearchStatus("error")
        setSearchErr(e?.message || "Search failed")
      }
    }, 250)

    return () => {
      clearTimeout(t)
      ac.abort()
    }
  }, [q, rootId])

  return (
    <div style={styles.page}>
      <div style={styles.header}>
        <div style={styles.h1}>People of History</div>
      </div>

      <div style={styles.card}>
        <div style={styles.searchRow}>
          <div style={styles.inputWrap}>
            <input
              style={styles.input}
              value={q}
              onChange={(e) => {
                const next = e.target.value
                setQ(next)

                // ✅ resets happen in handlers, not in effects
                if (!next.trim()) {
                  setResults([])
                  setSearchStatus("idle")
                  setSearchErr("")
                }

                if (rootId) setRootId(null)
              }}
              placeholder="Search (e.g. Justinian, Charlemagne, Taejo of Joseon)…"
            />
            {q ? (
              <button
                style={styles.clearX}
                onClick={() => {
                  setQ("")
                  setRootId(null)
                  setResults([])
                  setSearchStatus("idle")
                  setSearchErr("")
                }}
                title="Clear"
              >
                ×
              </button>
            ) : null}
          </div>
        </div>

        {searchStatus === "loading" && !rootId ? (
          <div style={styles.muted}>Searching…</div>
        ) : null}
        {searchStatus === "error" && !rootId ? (
          <div style={styles.err}>{searchErr}</div>
        ) : null}

        {!rootId ? (
          results.length ? (
            <div style={styles.results}>
              {results.map((r) => (
                <button
                  key={r.id}
                  style={styles.resultBtn}
                  onClick={() => {
                    setRootId(r.id)
                    setResults([])
                    setSearchStatus("idle")
                    setSearchErr("")
                  }}
                  title={r.description || ""}
                >
                  <div style={styles.resultTitle}>{r.label}</div>
                  <div style={styles.resultMeta}>
                    {r.description ? (
                      <span style={styles.desc}>{r.description}</span>
                    ) : null}
                  </div>
                </button>
              ))}
            </div>
          ) : q.trim() && searchStatus !== "loading" ? (
            <div style={styles.muted}>No results.</div>
          ) : null
        ) : null}
      </div>

      {rootId && (
        <div style={styles.card}>
          <PersonNode
            qid={rootId}
            depth={0}
            getLabelDescClaimsAndWiki={getLabelDescClaimsAndWiki}
            qidsFromClaims={qidsFromClaims}
            uniqQids={uniqQids}
          />
        </div>
      )}
    </div>
  )
}

const LifeMeta = ({ birthYear, deathYear, age }) => {
  if (birthYear == null && deathYear == null) return null

  const both = birthYear != null && deathYear != null

  return (
    <div style={styles.lifeRow}>
      <span style={styles.lifeText}>
        {both
          ? `${formatYear(birthYear)} – ${formatYear(deathYear)}`
          : birthYear != null
          ? `born ${formatYear(birthYear)}`
          : `died ${formatYear(deathYear)}`}
      </span>

      {both && age != null ? (
        <span style={styles.lifeBadge}>died at {age}</span>
      ) : null}
    </div>
  )
}

const PersonNode = ({
  qid,
  depth,
  getLabelDescClaimsAndWiki,
  qidsFromClaims,
  uniqQids,
}) => {
  const [status, setStatus] = useState("loading")
  const [err, setErr] = useState("")
  const [p, setP] = useState(null)

  useEffect(() => {
    const ac = new AbortController()
    const run = async () => {
      try {
        setStatus("loading")
        setErr("")
        setP(null)
        const core = await getLabelDescClaimsAndWiki(qid, ac.signal)
        setP(core)
        setStatus("ready")
      } catch (e) {
        if (e?.name === "AbortError") return
        setStatus("error")
        setErr(e?.message || "Load failed")
      }
    }
    run()
    return () => ac.abort()
  }, [qid, getLabelDescClaimsAndWiki])

  if (status === "loading") return <div style={styles.muted}>Loading…</div>
  if (status === "error") return <div style={styles.err}>{err}</div>
  if (!p) return null

  const parents = uniqQids([
    ...qidsFromClaims(p.claims, "P22"), // father
    ...qidsFromClaims(p.claims, "P25"), // mother
  ])

  const children = uniqQids(qidsFromClaims(p.claims, "P40"))

  return (
    <div style={styles.node}>
      <div style={styles.personHeader}>
        {p.imageUrl ? (
          <img
            src={p.imageUrl}
            alt={p.label}
            width={AVATAR_SIZE}
            height={AVATAR_SIZE}
            style={styles.avatar}
            loading="lazy"
          />
        ) : (
          <span style={styles.avatarSmallPh} aria-hidden="true" />
        )}

        <div style={styles.personHeaderText}>
          <div style={styles.nodeTitle}>{p.label}</div>

          {p.description ? (
            <div style={styles.muted}>{p.description}</div>
          ) : null}
        </div>
      </div>

      <details style={styles.acc}>
        <summary style={styles.sum}>
          <span>Parents</span>
          <span style={styles.count}>{parents.length}</span>
        </summary>

        <div style={styles.body}>
          {!parents.length ? (
            <div style={styles.muted}>No parents found.</div>
          ) : depth >= MAX_DEPTH ? (
            <div style={styles.muted}>Depth limit reached.</div>
          ) : (
            <div style={styles.nested}>
              {parents.map((relId) => (
                <RelativeRow
                  key={relId}
                  relId={relId}
                  depth={depth}
                  getLabelDescClaimsAndWiki={getLabelDescClaimsAndWiki}
                />
              ))}
            </div>
          )}
        </div>
      </details>

      <details style={styles.acc}>
        <summary style={styles.sum}>
          <span>Children</span>
          <span style={styles.count}>{children.length}</span>
        </summary>

        <div style={styles.body}>
          {!children.length ? (
            <div style={styles.muted}>No children found.</div>
          ) : depth >= MAX_DEPTH ? (
            <div style={styles.muted}>Depth limit reached.</div>
          ) : (
            <div style={styles.nested}>
              {children.map((relId) => (
                <RelativeRow
                  key={relId}
                  relId={relId}
                  depth={depth}
                  getLabelDescClaimsAndWiki={getLabelDescClaimsAndWiki}
                />
              ))}
            </div>
          )}
        </div>
      </details>
    </div>
  )
}

const RelativeRow = ({ relId, depth, getLabelDescClaimsAndWiki }) => {
  const [status, setStatus] = useState("loading")
  const [p, setP] = useState(null)

  useEffect(() => {
    const ac = new AbortController()
    const run = async () => {
      try {
        setStatus("loading")
        const core = await getLabelDescClaimsAndWiki(relId, ac.signal)
        setP(core)
        setStatus("ready")
      } catch (_) {
        setP(null)
        setStatus("error")
      }
    }
    run()
    return () => ac.abort()
  }, [relId, getLabelDescClaimsAndWiki])

  const label = p?.label || relId
  const wikiUrl = p?.wikipediaUrl || ""
  const imageUrl = p?.imageUrl || ""
  const birthYear = p?.birthYear ?? null
  const deathYear = p?.deathYear ?? null
  const age = p?.age ?? null

  const both = birthYear != null && deathYear != null

  return (
    <details style={styles.childAcc}>
      <summary style={styles.sumSmall}>
        <span style={styles.childLeft}>
          {imageUrl ? (
            <img
              src={imageUrl}
              alt={label}
              width={22}
              height={22}
              style={styles.avatarSmall}
              loading="lazy"
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            <span style={styles.avatarSmallPh} aria-hidden="true" />
          )}

          <span style={styles.childTitle}>{label}</span>

          {birthYear != null || deathYear != null ? (
            <span style={styles.inlineLife}>
              {both
                ? `${formatYear(birthYear)} – ${formatYear(deathYear)}`
                : birthYear != null
                ? `born ${formatYear(birthYear)}`
                : `died ${formatYear(deathYear)}`}
            </span>
          ) : null}

          {both && age != null ? (
            <span style={styles.inlineAge}>died at {age}</span>
          ) : null}
        </span>

        <span style={styles.childRight}>
          {wikiUrl ? (
            <a
              href={wikiUrl}
              target="_blank"
              rel="noreferrer"
              style={styles.linkSmall}
              onClick={(e) => e.stopPropagation()}
              title="Open Wikipedia"
            >
              Wiki ↗
            </a>
          ) : (
            <span style={styles.mutedSmall}>
              {status === "loading" ? "…" : "No Wiki"}
            </span>
          )}
        </span>
      </summary>

      <div style={styles.body}>
        {depth + 1 >= MAX_DEPTH ? (
          <div style={styles.muted}>Depth limit reached.</div>
        ) : status === "loading" ? (
          <div style={styles.muted}>Loading…</div>
        ) : status === "error" ? (
          <div style={styles.muted}>Couldn’t load.</div>
        ) : (
          <PersonNode
            qid={relId}
            depth={depth + 1}
            getLabelDescClaimsAndWiki={getLabelDescClaimsAndWiki}
            qidsFromClaims={(claims, prop) => {
              const arr = claims?.[prop]
              if (!Array.isArray(arr)) return []
              const out = []
              for (const c of arr) {
                const id = c?.mainsnak?.datavalue?.value?.id
                if (id) out.push(id)
              }
              return out
            }}
            uniqQids={(arr) =>
              Array.from(
                new Set(
                  arr.filter((x) => typeof x === "string" && /^Q\d+$/.test(x))
                )
              )
            }
          />
        )}
      </div>
    </details>
  )
}

const styles = {
  page: {
    maxWidth: "100dvw",
    margin: "0 auto",
    padding: 20,
    fontFamily:
      'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial',

    minHeight: "100dvh",
  },
  header: { marginBottom: 12 },
  h1: { fontSize: 20, fontWeight: 800 },

  card: {
    border: "1px solid",
    borderRadius: 5,
    padding: 12,
    marginBottom: 12,
  },

  searchRow: { display: "flex", gap: 10, alignItems: "center" },
  inputWrap: { position: "relative", width: "100%" },

  input: {
    width: "100%",
    padding: "10px 38px 10px 12px",
    borderRadius: 5,
    border: "1px solid",
    outline: "none",
  },

  clearX: {
    position: "absolute",
    right: 10,
    top: "50%",
    transform: "translateY(-50%)",
    background: "transparent",
    border: "none",
    fontSize: 18,
    cursor: "pointer",
    lineHeight: 1,
  },

  results: { marginTop: 10, display: "grid", gap: 8 },
  resultBtn: {
    textAlign: "left",
    padding: "10px 12px",
    borderRadius: 5,
    border: "1px solid",
    cursor: "pointer",
    background: "transparent", // or "#fff"
    appearance: "none",
    WebkitAppearance: "none",
    outline: "none",
  },
  resultTitle: { fontWeight: 800, marginBottom: 4 },
  resultMeta: {
    display: "flex",
    gap: 8,
    alignItems: "center",
    flexWrap: "wrap",
  },
  desc: { fontSize: 12 },

  muted: { marginTop: 8 },
  mutedSmall: { fontSize: 12 },
  err: { color: "red", marginTop: 8 },

  node: { paddingTop: 2 },

  personHeader: { display: "flex", gap: 10, alignItems: "center" },
  personHeaderText: { minWidth: 0, flex: 1 },
  nodeTitle: { fontSize: 16, fontWeight: 800, lineHeight: 1.1 },
  headerLinks: { marginTop: 6 },

  lifeRow: {
    marginTop: 8,
    display: "flex",
    gap: 8,
    alignItems: "center",
    flexWrap: "wrap",
  },
  lifeText: { fontSize: 13, fontWeight: 700 },
  lifeBadge: {
    border: "1px solid",
    borderRadius: 999,
    padding: "2px 8px",
    fontSize: 12,

    fontWeight: 800,
  },

  avatar: {
    width: AVATAR_SIZE,
    height: AVATAR_SIZE,
    borderRadius: 5,
    objectFit: "cover",
    border: "1px solid",
    flex: "0 0 auto",
  },
  avatarPh: {
    width: AVATAR_SIZE,
    height: AVATAR_SIZE,
    borderRadius: 5,
    border: "1px solid",
    flex: "0 0 auto",
  },

  avatarSmall: {
    width: 18,
    height: 18,
    borderRadius: 5,
    objectFit: "cover",
    border: "1px solid",
    flex: "0 0 auto",
  },
  avatarSmallPh: {
    width: 18,
    height: 18,
    borderRadius: 5,
    border: "1px solid",
    display: "inline-block",
    flex: "0 0 auto",
  },

  link: {
    color: "#000",
    textDecoration: "none",
    fontWeight: 800,
    fontSize: 13,
    whiteSpace: "nowrap",
  },
  linkSmall: {
    color: "#000",
    textDecoration: "none",
    fontWeight: 800,
    fontSize: 12,
    whiteSpace: "nowrap",
  },

  acc: {
    marginTop: 10,
    border: "1px solid",
    borderRadius: 5,
    overflow: "hidden",
  },
  sum: {
    cursor: "pointer",
    padding: "10px 12px",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    userSelect: "none",
    fontWeight: 800,
  },
  body: { padding: "10px 12px" },
  count: {
    border: "1px solid",
    borderRadius: 5,
    padding: "2px 8px",
    fontSize: 12,
    fontWeight: 800,
  },

  nested: { display: "grid", gap: 10 },

  childAcc: {
    border: "1px dashed #333333",
    borderRadius: 5,
    background: "transparent",
    overflow: "hidden",
  },
  sumSmall: {
    cursor: "pointer",
    padding: "8px 10px",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    userSelect: "none",
    fontWeight: 800,
    fontSize: 13,
    gap: 10,
  },
  childLeft: {
    display: "inline-flex",
    gap: 8,
    alignItems: "center",
    minWidth: 0,
    flex: 1,
    flexWrap: "wrap",
  },
  childTitle: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    maxWidth: 220,
  },
  childRight: { display: "inline-flex", gap: 8, alignItems: "center" },

  inlineLife: {
    fontSize: 12,
    fontWeight: 700,
    whiteSpace: "nowrap",
  },
  inlineAge: {
    border: "1px solid",
    borderRadius: 999,
    padding: "2px 8px",
    fontSize: 12,
    fontWeight: 800,
    whiteSpace: "nowrap",
  },
}

export default App
