# Chef AI Workspace — system overview (M9)

Maintainable source of the architecture diagram. Dashed edges are
unconnected or unverified paths -- they must not be read as working.

```mermaid
flowchart TB
    subgraph Browser["Browser (Web UI)"]
        VW["VoiceWorkspace / VoiceInput"]
        AE["AIEditor (proposal diff)"]
        PB["PriceBell (notifications)"]
        SS["SourcingSuggestions"]
    end
    subgraph Next["Next.js (web/)"]
        PX["API proxy routes (/api/*)\npreview gate + X-Demo-Access"]
    end
    subgraph FastAPI["FastAPI (chef_ai_workspace/)"]
        API["api.py\n/health, /recipes confirm"]
        DEMO["demo_api.py (/demo/*)\nrecipes, ingredients, observations,\nnotifications, sourcing-suggestions"]
        HG["Human Gate: explicit approval only\nconfirm endpoints"]
    end
    subgraph Domain["Domain logic (pure)"]
        MUT["mutations.py\nproposal validation"]
        COST["costing.py\ndeterministic food cost"]
        M5["price_history.py (M5)\ncompare + impact"]
        M6["price_notifications.py (M6)\nnotify rules"]
        M7["substitute_sourcing.py (M7)\ncandidate classification"]
        M4["ingredient_assist.py (M4)\nreuse candidates"]
        PS["persistence_service.py\nsave_recipe_with_ledger"]
    end
    subgraph Repo["Repository"]
        SA["SupabasePersistence\nowner-scoped reads/writes\nRPC: commit_recipe_with_ledger"]
    end
    subgraph SB["Supabase (project dfvryaybdelgjxihdmth)"]
        AUTH["Auth"]
        PG[("Postgres + RLS\nrecipes / ingredients / suppliers /\noffers / price_observations /\nprice_notifications\nmigrations 0001-0004")]
    end
    subgraph Meta["Meta Muse (server-side only)"]
        VT["Voice Transcribe"]
        SP["Spark (proposals)"]
    end
    EXT["External price retrieval\n(no confirmed means)"]

    VW --> PX
    AE --> PX
    PB --> PX
    SS --> PX
    PX --> API
    PX --> DEMO
    DEMO --> HG
    API --> HG
    HG --> MUT
    MUT --> PS
    DEMO --> M5
    DEMO --> M6
    DEMO --> M7
    DEMO --> M4
    M5 --> COST
    PS --> SA
    M6 --> SA
    M7 --> SA
    SA --> AUTH
    SA --> PG
    DEMO -.->|"MODEL_API_KEY (server-only)"| VT
    DEMO -.->|"MODEL_API_KEY (server-only)"| SP
    SP -.->|"proposal only, never writes"| MUT
    M7 -.->|"unavailable: no credentials/clearance\nnever invented"| EXT
    PG -.->|"applied versions not introspectable\nvia API (unverified)"| SA
```

## Data-flow notes

- Voice/text becomes a proposal; the chef's explicit approval is the only
  path to `confirm`/save (Human Gate). Transcription never authorizes.
- SSOT: recipe state, owned ledger rows and saved cost snapshots.
  Reads never adopt prices; notification acknowledgement never switches
  suppliers; suggestions never write.
- Auth boundaries: preview gate (Basic + `DEMO_PREVIEW_PASSWORD`) →
  `X-Demo-Access` demo token → server-only service-role client → RLS
  owner policies. No secret is `NEXT_PUBLIC_`.
- Unverified at M9: live-DB writes, applied-migration status, external
  retrieval, live Meta inference, real-voice runs (see M8_ACCEPTANCE.md).
- Wiring boundary: the voice registration UI saves via `/demo/recipes/full`,
  which creates unlinked material lines (`/api/voice-recipe` carries no
  ingredient IDs or past-recipe context). M4 reuse (search → ingredient-assist
  → ledger confirm) is a demo-API flow, not a voice auto-link. The diagram
  edge DEMO → M4 is that API flow; it must not be read as voice auto-reuse.
