import {
  getGameCatalog,
  getGameDescriptor,
} from "../lib/games/catalog";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`
  );
}

const catalog = getGameCatalog();

check(
  "getGameCatalog includes chess",
  catalog.some((game) => game.id === "chess"),
  catalog
);

const connectFour = catalog.find((game) => game.id === "connect-four");
const battleship = catalog.find((game) => game.id === "battleship");
const codenames = catalog.find((game) => game.id === "codenames");
const fireworks = catalog.find((game) => game.id === "fireworks");
check("getGameCatalog includes connect-four", connectFour !== undefined, catalog);
check(
  "connect-four modes join to pvp,pvai,aivai",
  connectFour?.modes.join(",") === "pvp,pvai,aivai",
  connectFour
);
check("getGameCatalog includes battleship", battleship !== undefined, catalog);
check(
  "battleship modes join to pvp,pvai,aivai",
  battleship?.modes.join(",") === "pvp,pvai,aivai",
  battleship
);
check("getGameCatalog includes codenames", codenames !== undefined, catalog);
check(
  "codenames modes join to pvp,pvai,aivai",
  codenames?.modes.join(",") === "pvp,pvai,aivai",
  codenames
);
check("getGameCatalog includes fireworks", fireworks !== undefined, catalog);
check(
  "fireworks modes join to pvp,pvai,aivai",
  fireworks?.modes.join(",") === "pvp,pvai,aivai",
  fireworks
);
check(
  "getGameDescriptor returns null for missing game",
  getGameDescriptor("missing") === null,
  getGameDescriptor("missing")
);

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);
