import { Type } from "@sinclair/typebox";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";

type PluginConfig = {
  agentKeypairPath: string;
  baseRpcUrl: string;
  erRpcUrl: string;
  worldManifestPathOrUrl: string;
  defaultPlayerMint?: string;
};

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details: unknown;
};

type BoltResult = {
  transaction?: Transaction;
  instruction?: TransactionInstruction;
  entityPda?: PublicKey;
  componentPda?: PublicKey;
};

type WorldManifest = {
  worldPda: string;
  terrainTypes?: Array<{
    terrainTypeId: number;
    componentPda: string;
  }>;
  farmTypes?: Array<{
    farmTypeId: number;
    componentPda: string;
  }>;
  tileTerrains?: Array<{
    x: number;
    y: number;
    terrainTypeId: number;
    componentPda: string;
  }>;
  tileItems?: Array<{
    x: number;
    y: number;
    itemId?: number;
    quantity?: number;
    entityPda: string;
    componentPda: string;
  }>;
};

type PlayerSessionState = {
  publicKey: PublicKey;
  playerMint: PublicKey;
  owner: PublicKey;
  delegate: PublicKey;
  scopes: number;
  revoked: boolean;
  createdAt: number;
};

type Runtime = {
  config: PluginConfig;
  agent: Keypair;
  baseConnection: Connection;
  erConnection: Connection;
  manifest: WorldManifest;
};

type PlayerRefs = {
  session: PlayerSessionState;
  worldPda: PublicKey;
  entityPda: PublicKey;
};

type GridPoint = { x: number; y: number };
type PlayerParam = { playerMint?: string };
type MoveParams = PlayerParam & GridPoint;
type FarmParams = PlayerParam &
  GridPoint & {
    action: "till" | "water" | "plant" | "harvest" | "chop";
    farmTypeId?: number;
  };
type InventoryParams = PlayerParam &
  GridPoint & {
    action: "grab" | "drop";
    itemId?: number;
    quantity?: number;
  };
type SetupParams = {
  createIfMissing?: boolean;
  overwrite?: boolean;
};
type PrepareSessionParams = {
  ownerPublicKey: string;
  validUntilUnixSeconds?: number;
};

const PROGRAMS = {
  openWilds: new PublicKey("Dv88ch6oXorTqWcZxw5C8VPH5jiWagDJgWd8fvBmXzc6"),
  position: new PublicKey("7ebGfNj5knjG33XBSUdfYAYtXsner8rQzLYSFuURSicZ"),
  energy: new PublicKey("EXfYuzbCqe3VoUrG37gvkhxMmCMBKfvj5DRodsjmG6Pg"),
  activeAction: new PublicKey("g9Y3zHKWC9kJ9CYLQuDkZP7qVwhh6yu2swhxrXn7sVn"),
  inventory: new PublicKey("GkbbrRx8N4XsM6ELpKPQVaSvtU7mpNaKdUYh8X14ddCq"),
  playerOwner: new PublicKey("DRtu8UJRPVQFyVboeX9uzx5qdgsGC9bVyViRCxHSgZwJ"),
  tileFarm: new PublicKey("HtQi1ESxw8jY5383gaTwtv8vwJbSKfZcFuRb3vPq86KU"),
  tileItem: new PublicKey("6RLX336UuzR9yU4FCrLcTc1SE62YyPc57L8pqjk3xdwP"),
  movement: new PublicKey("pVHBNGmKR8BtfokRF1gsS8t766ukFdqn6cV1hY9tMP5"),
  sleep: new PublicKey("AHpcKdhujpiTq8oGbxbCknEfmQQwya6cmvywFL89iZUs"),
  tillTile: new PublicKey("GGf7T4KZ2sJGwiuu6e7bTAc17VwQAR5xKmp9NvF9CmUN"),
  waterTile: new PublicKey("Cp5YRnmvnbRPsCucPAGVh6Sorbd5wjDma8sGKYAuveuu"),
  plantTile: new PublicKey("8g6H4M8cKkieF65YkUDqyJ4AqEFytFUnGEQzrvGc3wkq"),
  harvestTile: new PublicKey("BGdMrM8tY4myjV3iddnPH4mKpZ8LoaABjY1eoyuqfknp"),
  chopTile: new PublicKey("GctbHkUcDA9AHkDeLtJ1P1sE1oSLoncDGMBYiYPzMAgs"),
  grabTile: new PublicKey("3UEFZZDhmaMh1mBZYvxZxk2PZ2Zb4niHg4wpg2iYiW8J"),
  dropTile: new PublicKey("ENLdCrebMYYvRQFaMCNJAn3DCzEZSJ8JXpwVBFX9R7NH"),
};

const PLAYER_SESSION_SIZE = 118;
const PLAYER_SESSION_DELEGATE_OFFSET = 72;
const PLAYER_SESSION_DISCRIMINATOR = Buffer.from([
  89, 95, 51, 45, 127, 42, 173, 223,
]);
const PLAYER_SESSION_SCOPE_MOVE = 1 << 0;
const PLAYER_SESSION_SCOPE_SLEEP = 1 << 1;
const PLAYER_SESSION_SCOPE_FARM = 1 << 2;
const PLAYER_SESSION_SCOPE_HARVEST = 1 << 3;
const PLAYER_SESSION_SCOPE_INVENTORY = 1 << 4;
const PLAYER_SESSION_SCOPE_TRADE = 1 << 5;
const PLAYER_SESSION_SCOPE_SPEND = 1 << 6;
const PLAYER_SESSION_SCOPE_ALL =
  PLAYER_SESSION_SCOPE_MOVE |
  PLAYER_SESSION_SCOPE_SLEEP |
  PLAYER_SESSION_SCOPE_FARM |
  PLAYER_SESSION_SCOPE_HARVEST |
  PLAYER_SESSION_SCOPE_INVENTORY |
  PLAYER_SESSION_SCOPE_TRADE |
  PLAYER_SESSION_SCOPE_SPEND;

const toolResponse = (details: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(details, null, 2) }],
  details,
});

const expandPath = (path: string) =>
  path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : resolve(path);

const runtimeFromApi = async (api: unknown): Promise<Runtime> => {
  const config = readPluginConfig(
    (api as { pluginConfig?: unknown }).pluginConfig
  );
  const agentKeypairPath = expandPath(config.agentKeypairPath);
  process.env.ANCHOR_WALLET ??= agentKeypairPath;
  const agent = await loadKeypair(agentKeypairPath);

  return {
    config,
    agent,
    baseConnection: new Connection(config.baseRpcUrl, "confirmed"),
    erConnection: new Connection(config.erRpcUrl, "confirmed"),
    manifest: await loadManifest(config.worldManifestPathOrUrl),
  };
};

const readPluginConfig = (config: unknown): PluginConfig => {
  if (!config || typeof config !== "object") {
    throw new Error(
      "Open Wilds plugin config is missing. Set plugins.entries.open-wilds.config."
    );
  }

  const value = config as Partial<PluginConfig>;
  for (const key of [
    "agentKeypairPath",
    "baseRpcUrl",
    "erRpcUrl",
    "worldManifestPathOrUrl",
  ] as const) {
    if (typeof value[key] !== "string" || value[key].length === 0) {
      throw new Error(`Open Wilds plugin config is missing ${key}.`);
    }
  }

  return value as PluginConfig;
};

const loadKeypair = async (path: string) => {
  const raw = JSON.parse(await readFile(path, "utf8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(raw));
};

const ensureAgentKeypair = async (
  config: PluginConfig,
  options: SetupParams = {}
) => {
  const keypairPath = expandPath(config.agentKeypairPath);
  const exists = await fileExists(keypairPath);

  if (exists && !options.overwrite) {
    const agent = await loadKeypair(keypairPath);
    return {
      created: false,
      overwritten: false,
      keypairPath,
      publicKey: agent.publicKey.toBase58(),
    };
  }

  if (!exists && !options.createIfMissing) {
    throw new Error(
      "Agent keypair is missing. Run open_wilds_agent_setup with createIfMissing=true."
    );
  }

  await mkdir(dirname(keypairPath), { recursive: true, mode: 0o700 });
  const agent = Keypair.generate();
  const secret = JSON.stringify(Array.from(agent.secretKey));

  await writeFile(keypairPath, secret, {
    encoding: "utf8",
    flag: options.overwrite ? "w" : "wx",
    mode: 0o600,
  });
  await chmod(keypairPath, 0o600);

  return {
    created: !exists,
    overwritten: exists && Boolean(options.overwrite),
    keypairPath,
    publicKey: agent.publicKey.toBase58(),
  };
};

const fileExists = async (path: string) => {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
};

const getAgentStatus = async (api: unknown) => {
  const config = readPluginConfig(
    (api as { pluginConfig?: unknown }).pluginConfig
  );
  const keypairPath = expandPath(config.agentKeypairPath);
  const keypairExists = await fileExists(keypairPath);
  const agent = keypairExists ? await loadKeypair(keypairPath) : null;
  const manifest = await loadManifest(config.worldManifestPathOrUrl);
  const runtime = agent
    ? {
        config,
        agent,
        baseConnection: new Connection(config.baseRpcUrl, "confirmed"),
        erConnection: new Connection(config.erRpcUrl, "confirmed"),
        manifest,
      }
    : null;

  return {
    configured: true,
    keypair: {
      exists: keypairExists,
      path: keypairPath,
      publicKey: agent?.publicKey.toBase58() ?? null,
      secretExported: false,
    },
    rpc: {
      baseRpcUrl: config.baseRpcUrl,
      erRpcUrl: config.erRpcUrl,
    },
    manifest: {
      worldPda: manifest.worldPda,
      source: config.worldManifestPathOrUrl,
    },
    sessions: runtime ? await describeSessions(runtime) : [],
    nextStep: agent
      ? "Run open_wilds_prepare_session with the player owner wallet, paste the returned transaction into Open Wilds, then grant Full control."
      : "Create the agent keypair with open_wilds_agent_setup createIfMissing=true.",
  };
};

const describeSessions = async (runtime: Runtime) => {
  const sessions = await listSessions(runtime);

  return Promise.all(
    sessions.map(async (session) => {
      const boltSessionToken = await deriveBoltSessionToken(
        runtime.agent.publicKey,
        session.owner
      );

      return {
        session: session.publicKey.toBase58(),
        playerMint: session.playerMint.toBase58(),
        owner: session.owner.toBase58(),
        delegate: session.delegate.toBase58(),
        scopes: session.scopes,
        scopeLabels: scopeLabels(session.scopes),
        boltSessionToken: boltSessionToken.toBase58(),
        boltSessionActive: Boolean(await getAccount(runtime, boltSessionToken)),
      };
    })
  );
};

const prepareBoltSession = async (
  runtime: Runtime,
  input: PrepareSessionParams
) => {
  const owner = new PublicKey(input.ownerPublicKey);
  const bolt = await import("@magicblock-labs/bolt-sdk");
  const validity =
    input.validUntilUnixSeconds === undefined
      ? undefined
      : new bolt.BN(input.validUntilUnixSeconds);
  const result = await bolt.CreateSession({
    sessionSigner: runtime.agent,
    authority: owner,
    validity,
  });
  const latest = await runtime.baseConnection.getLatestBlockhash("confirmed");
  result.transaction.feePayer = owner;
  result.transaction.recentBlockhash = latest.blockhash;
  result.transaction.partialSign(runtime.agent);

  return {
    agentPublicKey: runtime.agent.publicKey.toBase58(),
    sessionSignerPublicKey: runtime.agent.publicKey.toBase58(),
    owner: owner.toBase58(),
    sessionToken: result.session.token.toBase58(),
    validUntilUnixSeconds: input.validUntilUnixSeconds ?? null,
    partiallySignedTransaction: result.transaction
      .serialize({
        requireAllSignatures: false,
        verifySignatures: false,
      })
      .toString("base64"),
    nextStep:
      "Paste partiallySignedTransaction into the Open Wilds Agent Mode BOLT Session Tx field, then enable Agent Mode. The game owner wallet will co-sign and send it.",
  };
};

const loadManifest = async (pathOrUrl: string): Promise<WorldManifest> => {
  if (/^https?:\/\//.test(pathOrUrl)) {
    const response = await fetch(pathOrUrl);
    if (!response.ok) {
      throw new Error(`Failed to load world manifest: ${response.status}`);
    }
    return (await response.json()) as WorldManifest;
  }

  return JSON.parse(await readFile(pathOrUrl, "utf8")) as WorldManifest;
};

const listSessions = async (runtime: Runtime) => {
  const accounts = await runtime.baseConnection.getProgramAccounts(
    PROGRAMS.openWilds,
    {
      filters: [
        { dataSize: PLAYER_SESSION_SIZE },
        {
          memcmp: {
            offset: PLAYER_SESSION_DELEGATE_OFFSET,
            bytes: runtime.agent.publicKey.toBase58(),
          },
        },
      ],
    }
  );

  return accounts
    .map(({ pubkey, account }) => decodePlayerSession(pubkey, account.data))
    .filter((session): session is PlayerSessionState => Boolean(session))
    .filter((session) => !session.revoked)
    .filter((session) =>
      runtime.config.defaultPlayerMint
        ? session.playerMint.equals(
            new PublicKey(runtime.config.defaultPlayerMint)
          )
        : true
    );
};

const decodePlayerSession = (
  publicKey: PublicKey,
  data: Uint8Array
): PlayerSessionState | null => {
  if (
    data.byteLength < PLAYER_SESSION_SIZE ||
    !Buffer.from(data.slice(0, 8)).equals(PLAYER_SESSION_DISCRIMINATOR)
  ) {
    return null;
  }

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    publicKey,
    playerMint: new PublicKey(data.slice(8, 40)),
    owner: new PublicKey(data.slice(40, 72)),
    delegate: new PublicKey(data.slice(72, 104)),
    scopes: view.getUint32(104, true),
    revoked: data[108] !== 0,
    createdAt: Number(view.getBigInt64(109, true)),
  };
};

const requirePlayer = async (
  runtime: Runtime,
  playerMint?: string
): Promise<PlayerRefs> => {
  const sessions = await listSessions(runtime);
  const session =
    (playerMint
      ? sessions.find((candidate) =>
          candidate.playerMint.equals(new PublicKey(playerMint))
        )
      : sessions[0]) ?? null;

  if (!session) {
    throw new Error("No active Open Wilds PlayerSession for this agent key.");
  }

  const worldPda = new PublicKey(runtime.manifest.worldPda);
  return {
    session,
    worldPda,
    entityPda: await deriveEntity(
      runtime,
      worldPda,
      session.playerMint.toBytes()
    ),
  };
};

const deriveEntity = async (
  runtime: Runtime,
  worldPda: PublicKey,
  seed: Uint8Array
) => {
  const { AddEntity } = await import("@magicblock-labs/bolt-sdk");
  const result = (await AddEntity({
    payer: runtime.agent.publicKey,
    world: worldPda,
    seed,
    connection: runtime.baseConnection,
  })) as BoltResult;

  if (!result.entityPda) {
    throw new Error("BOLT did not return an entity PDA.");
  }

  return result.entityPda;
};

const deriveComponent = async (
  runtime: Runtime,
  entity: PublicKey,
  componentId: PublicKey
) => {
  const { InitializeComponent } = await import("@magicblock-labs/bolt-sdk");
  const result = (await InitializeComponent({
    payer: runtime.agent.publicKey,
    entity,
    componentId,
    authority: runtime.agent.publicKey,
  })) as BoltResult;

  if (!result.componentPda) {
    throw new Error("BOLT did not return a component PDA.");
  }

  return result.componentPda;
};

const deriveTileFarmEntity = (playerMint: PublicKey, point: GridPoint) => {
  const seed = Buffer.alloc(32);
  seed.set(playerMint.toBytes().slice(0, 20), 0);
  seed.write("farm", 20, "utf8");
  seed.writeInt32LE(point.x, 24);
  seed.writeInt32LE(point.y, 28);
  return seed;
};

const deriveTileItemEntity = (point: GridPoint) => {
  const seed = Buffer.alloc(32);
  seed.write("tile-item", 0, "utf8");
  seed.writeInt32LE(point.x, 24);
  seed.writeInt32LE(point.y, 28);
  return seed;
};

const getManifestTileItem = (runtime: Runtime, point: GridPoint) =>
  runtime.manifest.tileItems?.find(
    (item) => item.x === point.x && item.y === point.y
  );

const getTileItemRefs = async (runtime: Runtime, player: PlayerRefs, point: GridPoint) => {
  const manifestItem = getManifestTileItem(runtime, point);
  if (manifestItem) {
    return { entity: new PublicKey(manifestItem.entityPda) };
  }

  const entity = await deriveEntity(
    runtime,
    player.worldPda,
    deriveTileItemEntity(point)
  );
  return { entity };
};

const getPlayerComponents = async (runtime: Runtime, player: PlayerRefs) => ({
  playerOwner: await deriveComponent(
    runtime,
    player.entityPda,
    PROGRAMS.playerOwner
  ),
  position: await deriveComponent(runtime, player.entityPda, PROGRAMS.position),
  energy: await deriveComponent(runtime, player.entityPda, PROGRAMS.energy),
  activeAction: await deriveComponent(
    runtime,
    player.entityPda,
    PROGRAMS.activeAction
  ),
  inventory: await deriveComponent(
    runtime,
    player.entityPda,
    PROGRAMS.inventory
  ),
});

const readPlayerState = async (runtime: Runtime, player: PlayerRefs) => {
  const components = await getPlayerComponents(runtime, player);
  const [
    positionAccount,
    energyAccount,
    activeActionAccount,
    inventoryAccount,
  ] = await Promise.all([
    getAccount(runtime, components.position),
    getAccount(runtime, components.energy),
    getAccount(runtime, components.activeAction),
    getAccount(runtime, components.inventory),
  ]);

  return {
    playerMint: player.session.playerMint.toBase58(),
    owner: player.session.owner.toBase58(),
    delegate: player.session.delegate.toBase58(),
    session: {
      publicKey: player.session.publicKey.toBase58(),
      scopes: player.session.scopes,
      scopeLabels: scopeLabels(player.session.scopes),
      createdAt: player.session.createdAt,
    },
    world: player.worldPda.toBase58(),
    entity: player.entityPda.toBase58(),
    components: Object.fromEntries(
      Object.entries(components).map(([key, value]) => [key, value.toBase58()])
    ),
    position: positionAccount ? decodePosition(positionAccount.data) : null,
    energy: energyAccount ? decodeEnergy(energyAccount.data) : null,
    activeAction: activeActionAccount
      ? decodeActiveAction(activeActionAccount.data)
      : null,
    inventory: inventoryAccount ? decodeInventory(inventoryAccount.data) : null,
    nearbyTiles: await getNearbyTiles(runtime, positionAccount),
  };
};

const getAccount = async (runtime: Runtime, pubkey: PublicKey) =>
  (await runtime.erConnection.getAccountInfo(pubkey)) ??
  (await runtime.baseConnection.getAccountInfo(pubkey));

const deriveBoltSessionToken = async (
  sessionSigner: PublicKey,
  authority: PublicKey
) => {
  const { FindSessionTokenPda } = await import("@magicblock-labs/bolt-sdk");
  return FindSessionTokenPda({ sessionSigner, authority }) as PublicKey;
};

const scopeLabels = (scopes: number) =>
  [
    [PLAYER_SESSION_SCOPE_MOVE, "MOVE"],
    [PLAYER_SESSION_SCOPE_SLEEP, "SLEEP"],
    [PLAYER_SESSION_SCOPE_FARM, "FARM"],
    [PLAYER_SESSION_SCOPE_HARVEST, "HARVEST"],
    [PLAYER_SESSION_SCOPE_INVENTORY, "INVENTORY"],
    [PLAYER_SESSION_SCOPE_TRADE, "TRADE"],
    [PLAYER_SESSION_SCOPE_SPEND, "SPEND"],
  ]
    .filter(([scope]) => (scopes & Number(scope)) === Number(scope))
    .map(([, label]) => label);

const getNearbyTiles = async (
  runtime: Runtime,
  positionAccount: { data: Uint8Array } | null
) => {
  if (!positionAccount) {
    return [];
  }

  const position = decodePosition(positionAccount.data);
  const tiles = runtime.manifest.tileTerrains ?? [];
  return tiles
    .filter(
      (tile) =>
        Math.abs(tile.x - position.x) <= 1 && Math.abs(tile.y - position.y) <= 1
    )
    .slice(0, 9);
};

const applySystem = async (
  runtime: Runtime,
  player: PlayerRefs,
  systemId: PublicKey,
  entities: Array<{
    entity: PublicKey;
    components: Array<{ componentId: PublicKey }>;
  }>,
  args?: Record<string, number>
) => {
  const { ApplySystem, Session } = await import("@magicblock-labs/bolt-sdk");
  const boltSessionToken = await deriveBoltSessionToken(
    runtime.agent.publicKey,
    player.session.owner
  );
  const hasSession = await getAccount(runtime, boltSessionToken);

  if (!hasSession) {
    throw new Error(
      `Missing BOLT session token ${boltSessionToken.toBase58()} for owner ${player.session.owner.toBase58()}. Run open_wilds_prepare_session and grant it in the game UI.`
    );
  }

  const result = (await ApplySystem({
    authority: runtime.agent.publicKey,
    systemId,
    world: player.worldPda,
    entities,
    session: new Session(runtime.agent, boltSessionToken),
    extraAccounts: [
      { pubkey: player.session.publicKey, isSigner: false, isWritable: false },
    ],
    args,
  })) as BoltResult;

  return sendBoltResult(runtime, result);
};

const sendBoltResult = async (runtime: Runtime, result: BoltResult) => {
  const transaction =
    result.transaction ??
    (result.instruction ? new Transaction().add(result.instruction) : null);

  if (!transaction) {
    throw new Error("BOLT did not return a transaction or instruction.");
  }

  const latest = await runtime.erConnection.getLatestBlockhash("confirmed");
  transaction.feePayer = runtime.agent.publicKey;
  transaction.recentBlockhash = latest.blockhash;
  transaction.sign(runtime.agent);

  return runtime.erConnection.sendRawTransaction(transaction.serialize(), {
    skipPreflight: true,
  });
};

const playerEntity = (player: PlayerRefs, componentIds: PublicKey[]) => ({
  entity: player.entityPda,
  components: componentIds.map((componentId) => ({ componentId })),
});

const executeMove = async (
  runtime: Runtime,
  playerMint: string | undefined,
  point: GridPoint
) => {
  const player = await requirePlayer(runtime, playerMint);
  const signature = await applySystem(
    runtime,
    player,
    PROGRAMS.movement,
    [
      playerEntity(player, [
        PROGRAMS.playerOwner,
        PROGRAMS.position,
        PROGRAMS.energy,
        PROGRAMS.activeAction,
      ]),
    ],
    point
  );

  return { signature, ...(await readPlayerState(runtime, player)) };
};

const executeSleep = async (runtime: Runtime, playerMint?: string) => {
  const player = await requirePlayer(runtime, playerMint);
  const signature = await applySystem(runtime, player, PROGRAMS.sleep, [
    playerEntity(player, [
      PROGRAMS.playerOwner,
      PROGRAMS.energy,
      PROGRAMS.activeAction,
    ]),
  ]);

  return { signature, ...(await readPlayerState(runtime, player)) };
};

const executeFarmAction = async (
  runtime: Runtime,
  playerMint: string | undefined,
  action: string,
  point: GridPoint,
  farmTypeId?: number
) => {
  const player = await requirePlayer(runtime, playerMint);
  const tileFarmEntity = await deriveEntity(
    runtime,
    player.worldPda,
    deriveTileFarmEntity(player.session.playerMint, point)
  );
  const entities = [
    playerEntity(player, [
      PROGRAMS.playerOwner,
      PROGRAMS.position,
      PROGRAMS.energy,
      PROGRAMS.activeAction,
    ]),
    {
      entity: tileFarmEntity,
      components: [{ componentId: PROGRAMS.tileFarm }],
    },
  ];
  const systemId = farmSystem(action);
  const args =
    action === "plant"
      ? { x: point.x, y: point.y, farm_type_id: farmTypeId ?? 0 }
      : point;

  if (action === "plant" || action === "harvest" || action === "chop") {
    entities.push(playerEntity(player, [PROGRAMS.inventory]));
  }

  const signature = await applySystem(
    runtime,
    player,
    systemId,
    entities,
    args
  );
  return { signature, action, ...(await readPlayerState(runtime, player)) };
};

const executeInventoryAction = async (
  runtime: Runtime,
  playerMint: string | undefined,
  action: string,
  point: GridPoint,
  itemId?: number,
  quantity?: number
) => {
  const player = await requirePlayer(runtime, playerMint);
  const tileItem = await getTileItemRefs(runtime, player, point);
  const systemId = action === "drop" ? PROGRAMS.dropTile : PROGRAMS.grabTile;
  const args =
    action === "drop"
      ? {
          x: point.x,
          y: point.y,
          item_id: itemId ?? 0,
          quantity: quantity ?? 1,
        }
      : point;
  const signature = await applySystem(
    runtime,
    player,
    systemId,
    [
      playerEntity(player, [
        PROGRAMS.playerOwner,
        PROGRAMS.position,
        PROGRAMS.activeAction,
      ]),
      {
        entity: tileItem.entity,
        components: [{ componentId: PROGRAMS.tileItem }],
      },
      playerEntity(player, [PROGRAMS.inventory]),
    ],
    args
  );

  return { signature, action, ...(await readPlayerState(runtime, player)) };
};

const farmSystem = (action: string) => {
  switch (action) {
    case "till":
      return PROGRAMS.tillTile;
    case "water":
      return PROGRAMS.waterTile;
    case "plant":
      return PROGRAMS.plantTile;
    case "harvest":
      return PROGRAMS.harvestTile;
    case "chop":
      return PROGRAMS.chopTile;
    default:
      throw new Error(`Unsupported farm action: ${action}`);
  }
};

const decodePosition = (data: Uint8Array) => {
  const view = dataView(data);
  return { x: readI64(view, 8), y: readI64(view, 16) };
};

const decodeEnergy = (data: Uint8Array) => {
  const view = dataView(data);
  return { current: readU64(view, 8), max: readU64(view, 16) };
};

const decodeActiveAction = (data: Uint8Array) => {
  const view = dataView(data);
  return {
    action: view.getUint8(8),
    startedAt: readI64(view, 9),
    endsAt: readI64(view, 17),
  };
};

const decodeInventory = (data: Uint8Array) => {
  const view = dataView(data);
  const slots: Array<{ itemId: number; quantity: number }> = [];

  for (let index = 0; index < 16; index += 1) {
    const itemId = view.getUint16(8 + index * 2, true);
    const quantity = view.getUint16(40 + index * 2, true);
    if (itemId !== 0 && quantity > 0) {
      slots.push({ itemId, quantity });
    }
  }

  return { slots };
};

const dataView = (data: Uint8Array) =>
  new DataView(data.buffer, data.byteOffset, data.byteLength);

const readI64 = (view: DataView, offset: number) =>
  view.getInt32(offset + 4, true) * 0x100000000 + view.getUint32(offset, true);

const readU64 = (view: DataView, offset: number) =>
  view.getUint32(offset + 4, true) * 0x100000000 + view.getUint32(offset, true);

export default definePluginEntry({
  id: "open-wilds",
  name: "Open Wilds",
  description:
    "Lets an OpenClaw agent discover and control delegated Open Wilds players.",
  register(api) {
    api.registerTool({
      name: "open_wilds_agent_setup",
      label: "Set Up Open Wilds Agent",
      description:
        "Create or load the local agent keypair and return the public key to paste into Open Wilds Agent Mode.",
      parameters: Type.Object({
        createIfMissing: Type.Optional(Type.Boolean()),
        overwrite: Type.Optional(Type.Boolean()),
      }),
      async execute(_toolCallId, params, signal) {
        signal?.throwIfAborted();
        const input = params as SetupParams;
        const config = readPluginConfig(
          (api as { pluginConfig?: unknown }).pluginConfig
        );
        const keypair = await ensureAgentKeypair(config, input);

        return toolResponse({
          ...keypair,
          secretExported: false,
          sessionSignerPublicKey: keypair.publicKey,
          nextStep:
            "Ask OpenClaw to run open_wilds_prepare_session with the player owner wallet. Paste the returned transaction into Open Wilds, then grant Full control.",
        });
      },
    });

    api.registerTool({
      name: "open_wilds_prepare_session",
      label: "Prepare Open Wilds BOLT Session",
      description:
        "Create an agent-signed BOLT session transaction for the player owner to co-sign in the Open Wilds Agent Mode panel.",
      parameters: Type.Object({
        ownerPublicKey: Type.String(),
        validUntilUnixSeconds: Type.Optional(Type.Number()),
      }),
      async execute(_toolCallId, params, signal) {
        signal?.throwIfAborted();
        return toolResponse(
          await prepareBoltSession(
            await runtimeFromApi(api),
            params as PrepareSessionParams
          )
        );
      },
    });

    api.registerTool({
      name: "open_wilds_agent_status",
      label: "Check Open Wilds Agent Status",
      description:
        "Check the agent keypair, world manifest, RPC config, and granted player sessions.",
      parameters: Type.Object({}),
      async execute(_toolCallId, _params, signal) {
        signal?.throwIfAborted();
        return toolResponse(await getAgentStatus(api));
      },
    });

    api.registerTool({
      name: "open_wilds_list_players",
      label: "List Open Wilds Players",
      description:
        "List active Open Wilds PlayerSession delegations for this agent key.",
      parameters: Type.Object({}),
      async execute(_toolCallId, _params, signal) {
        signal?.throwIfAborted();
        const runtime = await runtimeFromApi(api);
        return toolResponse({
          agent: runtime.agent.publicKey.toBase58(),
          players: await describeSessions(runtime),
        });
      },
    });

    api.registerTool({
      name: "open_wilds_get_player_state",
      label: "Get Open Wilds Player State",
      description:
        "Read the current ER/base state for a delegated Open Wilds player.",
      parameters: Type.Object({
        playerMint: Type.Optional(Type.String()),
      }),
      async execute(_toolCallId, params, signal) {
        signal?.throwIfAborted();
        const input = params as PlayerParam;
        const runtime = await runtimeFromApi(api);
        return toolResponse(
          await readPlayerState(
            runtime,
            await requirePlayer(runtime, input.playerMint)
          )
        );
      },
    });

    api.registerTool({
      name: "open_wilds_move",
      label: "Move Open Wilds Player",
      description: "Move a delegated Open Wilds player on the ER grid.",
      parameters: Type.Object({
        x: Type.Number(),
        y: Type.Number(),
        playerMint: Type.Optional(Type.String()),
      }),
      async execute(_toolCallId, params, signal) {
        signal?.throwIfAborted();
        const input = params as MoveParams;
        const runtime = await runtimeFromApi(api);
        return toolResponse(
          await executeMove(runtime, input.playerMint, {
            x: input.x,
            y: input.y,
          })
        );
      },
    });

    api.registerTool({
      name: "open_wilds_sleep",
      label: "Sleep Open Wilds Player",
      description: "Recover energy for a delegated Open Wilds player.",
      parameters: Type.Object({
        playerMint: Type.Optional(Type.String()),
      }),
      async execute(_toolCallId, params, signal) {
        signal?.throwIfAborted();
        const input = params as PlayerParam;
        return toolResponse(
          await executeSleep(await runtimeFromApi(api), input.playerMint)
        );
      },
    });

    api.registerTool({
      name: "open_wilds_farm_action",
      label: "Run Open Wilds Farm Action",
      description:
        "Run till, water, plant, harvest, or chop for a delegated player.",
      parameters: Type.Object({
        action: Type.Union([
          Type.Literal("till"),
          Type.Literal("water"),
          Type.Literal("plant"),
          Type.Literal("harvest"),
          Type.Literal("chop"),
        ]),
        x: Type.Number(),
        y: Type.Number(),
        farmTypeId: Type.Optional(Type.Number()),
        playerMint: Type.Optional(Type.String()),
      }),
      async execute(_toolCallId, params, signal) {
        signal?.throwIfAborted();
        const input = params as FarmParams;
        return toolResponse(
          await executeFarmAction(
            await runtimeFromApi(api),
            input.playerMint,
            input.action,
            { x: input.x, y: input.y },
            input.farmTypeId
          )
        );
      },
    });

    api.registerTool({
      name: "open_wilds_inventory_action",
      label: "Run Open Wilds Inventory Action",
      description: "Grab or drop an item for a delegated Open Wilds player.",
      parameters: Type.Object({
        action: Type.Union([Type.Literal("grab"), Type.Literal("drop")]),
        x: Type.Number(),
        y: Type.Number(),
        itemId: Type.Optional(Type.Number()),
        quantity: Type.Optional(Type.Number()),
        playerMint: Type.Optional(Type.String()),
      }),
      async execute(_toolCallId, params, signal) {
        signal?.throwIfAborted();
        const input = params as InventoryParams;
        return toolResponse(
          await executeInventoryAction(
            await runtimeFromApi(api),
            input.playerMint,
            input.action,
            { x: input.x, y: input.y },
            input.itemId,
            input.quantity
          )
        );
      },
    });

    api.registerTool({
      name: "open_wilds_trade_or_spend",
      label: "Open Wilds Trade Or Spend",
      description: "Report trade/spend readiness for the delegated player.",
      parameters: Type.Object({
        playerMint: Type.Optional(Type.String()),
      }),
      async execute(_toolCallId, params, signal) {
        signal?.throwIfAborted();
        const input = params as PlayerParam;
        const runtime = await runtimeFromApi(api);
        const player = await requirePlayer(runtime, input.playerMint);
        return toolResponse({
          supported: false,
          reason:
            "Trade/spend tools need the Open Wilds trade offer/finalize instructions to accept delegate signer sessions. Gameplay systems are delegate-ready.",
          playerMint: player.session.playerMint.toBase58(),
          scopes: scopeLabels(player.session.scopes),
        });
      },
    });

    api.registerTool({
      name: "open_wilds_play_turn",
      label: "Play Open Wilds Turn",
      description: "Choose a safe next action for the delegated player.",
      parameters: Type.Object({
        playerMint: Type.Optional(Type.String()),
      }),
      async execute(_toolCallId, params, signal) {
        signal?.throwIfAborted();
        const input = params as PlayerParam;
        const runtime = await runtimeFromApi(api);
        const player = await requirePlayer(runtime, input.playerMint);
        const state = await readPlayerState(runtime, player);
        const energy = state.energy as { current: number; max: number } | null;

        if (!energy || energy.current < 5) {
          return toolResponse({
            decision: "sleep",
            result: await executeSleep(runtime, input.playerMint),
          });
        }

        const position = state.position as GridPoint | null;
        const next = position
          ? { x: Math.min(19, position.x + 1), y: position.y }
          : { x: 10, y: 10 };

        return toolResponse({
          decision: "move",
          target: next,
          result: await executeMove(runtime, input.playerMint, next),
        });
      },
    });
  },
});
