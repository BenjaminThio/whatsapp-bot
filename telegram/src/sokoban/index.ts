import { type CallbackQueryContext, type CommandContext, Composer, Context, InlineKeyboard } from "grammy";
import { Callback, contains, Coord, Movement } from "../types.js";
import { type SokobanGameData, createNewSokobanGame, deleteSokobanDoc, getSokobanGameData, updateSokobanGame } from "./database.js";
import { SHOP_ITEMS } from '../shop/database.js';
import { CategoryRecord, ensureShopDataInitialized, shops } from "../shop/index.js";

const sokobanModule = new Composer();
const HEIGHT: number = 5;
const WIDTH: number = 7;
function constructKeyboard(userId: number): InlineKeyboard
{
    const KEYBOARD: InlineKeyboard = new InlineKeyboard()
        .text("⬆️", `${Callback.SOKOBAN} ${userId} 0`).row()
        .text("⬅️", `${Callback.SOKOBAN} ${userId} 1`).text("🔄", `${Callback.SOKOBAN} ${userId} 4`).text("➡️", `${Callback.SOKOBAN} ${userId} 3`).row()
        .text("⬇️", `${Callback.SOKOBAN} ${userId} 2`);

    return KEYBOARD;
}

const games: Record<number, SokobanGameData> = {};

const getGame = (userId: number): SokobanGameData => {
    const game: SokobanGameData | undefined = games[userId];

    if (game !== undefined)
        return game;
    else
        throw new Error(`Game not found.`);
};

async function ensureSokobanGameInitialized(userId: number): Promise<void>
{
    if (userId in games) return;

    // One read instead of userExists() + get() - see snake/index.ts
    const stored = await getSokobanGameData(userId);

    if (stored !== null) {
        games[userId] = stored;
        return;
    }

    games[userId] = reshuffle();
    // Awaited: an un-awaited create could still be in flight when the first
    // move tried to update the same row.
    await createNewSokobanGame(userId, getGame(userId));
}

sokobanModule.command("sokoban", async (ctx: CommandContext<Context>): Promise<void> => {
    if (ctx.from === undefined) {
        ctx.reply("`ctx.from` is undefined.");
        return;
    }

    const userId: number = ctx.from.id;

    await ensureShopDataInitialized(userId);
    await ensureSokobanGameInitialized(userId);

    ctx.reply(renderSokobanMap(shops[userId].equippedSkins, getGame(userId)), { reply_markup: constructKeyboard(userId) });
});

sokobanModule.callbackQuery(new RegExp(`^${Callback.SOKOBAN} (\\d+) ([0-4])$`), async (ctx: CallbackQueryContext<Context>): Promise<void> => {
    if (ctx.from === undefined) {
        ctx.editMessageText("`ctx.from` is undefined.");
        return;
    }

    const ownerId: number = Number(ctx.match[1]);
    const userId: number = ctx.from.id;

    if (ownerId !== userId)
    {
        await ctx.answerCallbackQuery({
            text: 'This is not your property.',
            show_alert: true
        });
    }

    await ensureShopDataInitialized(userId);
    await ensureSokobanGameInitialized(userId);

    const direction: number /* Movement */ = Number(ctx.match[2]);

    switch (direction) {
        case Movement.UP:
            movePlayer(userId, 0, -1);
            break;
        case Movement.LEFT:
            movePlayer(userId, -1, 0);
            break;
        case Movement.DOWN:
            movePlayer(userId, 0, 1);
            break;
        case Movement.RIGHT:
            movePlayer(userId, 1, 0);
            break;
        case 4:
            games[userId] = reshuffle();
    }

    ctx.answerCallbackQuery();

    if (gameOver(userId)) {
        await ctx.editMessageText(`<b>Game Over!</b>\n${renderSokobanMap(shops[userId].equippedSkins, getGame(userId))}`, { parse_mode: "HTML" });
        await deleteSokobanDoc(userId);
        return;
    }

    await updateSokobanGame(userId, getGame(userId));
    await ctx.editMessageText(renderSokobanMap(shops[userId].equippedSkins, getGame(userId)), { reply_markup: constructKeyboard(userId) });
});

export function reshuffle(): SokobanGameData {
    const gameData: SokobanGameData = {
        player: new Coord(0, 0),
        boxes: [],
        destinations: [],
        barriers: []
    };
    const availableCoords: Coord[] = [];

    for (let y: number = 0; y < HEIGHT; y++) {
        for (let x: number = 0; x < WIDTH; x++) {
            availableCoords.push(new Coord(x, y));
        }
    }

    for (let i: number = 0; i < 3; i++) {
        const randomBoxIndex: number = Math.floor(Math.random() * availableCoords.length);

        gameData.boxes.push(availableCoords[randomBoxIndex]!);
        availableCoords.splice(randomBoxIndex, 1);

        const randomDstIndex: number = Math.floor(Math.random() * availableCoords.length);

        gameData.destinations.push(availableCoords[randomDstIndex]!);
        availableCoords.splice(randomDstIndex, 1);

        const randomBarrierIndex: number = Math.floor(Math.random() * availableCoords.length);

        gameData.barriers.push(availableCoords[randomBarrierIndex]!);
        availableCoords.splice(randomBarrierIndex, 1);
    }

    gameData.player = availableCoords[Math.floor(Math.random() * availableCoords.length)]!;

    return gameData;
}

function movePlayer(userId: number, x: number, y: number): void {
    let xCoord = getGame(userId).player.x;
    let yCoord = getGame(userId).player.y;

    if (xCoord + x >= 0 && xCoord + x < WIDTH)
        xCoord += x;
    else if (xCoord + x < 0)
        xCoord = WIDTH - 1;
    else
        xCoord = 0;

    if (yCoord + y >= 0 && yCoord + y < HEIGHT)
        yCoord += y;
    else if (yCoord + y < 0)
        yCoord = HEIGHT - 1;
    else
        yCoord = 0;

    if (contains(getGame(userId).destinations, xCoord, yCoord) || contains(getGame(userId).barriers, xCoord, yCoord))
        return;
    else if (contains(getGame(userId).boxes, xCoord, yCoord)) {
        const boxIndex = getGame(userId).boxes.findIndex((coord: Coord) => coord.x === xCoord && coord.y === yCoord);
        const newBoxPos = moveBox(userId, boxIndex, x, y);

        if (newBoxPos) {
            getGame(userId).boxes[boxIndex] = newBoxPos;
        } else {
            return;
        }
    }
    getGame(userId).player = new Coord(xCoord, yCoord);
}

const gameOver = (userId: number): boolean =>
    getGame(userId).boxes.every((boxCoord: Coord) =>
            contains(getGame(userId).destinations, boxCoord));

function moveBox(userId: number, boxIndex: number, x: number, y: number): Coord | undefined {
    // console.log(boxes[boxIndex]);
    let xCoord: number = getGame(userId).boxes[boxIndex]!.x;
    let yCoord: number = getGame(userId).boxes[boxIndex]!.y;

    if (xCoord + x >= 0 && xCoord + x < WIDTH)
        xCoord += x;
    else if (xCoord + x < 0)
        xCoord = WIDTH - 1;
    else
        xCoord = 0;

    if (yCoord + y >= 0 && yCoord + y < HEIGHT)
        yCoord += y;
    else if (yCoord + y < 0)
        yCoord = HEIGHT - 1;
    else
        yCoord = 0;

    if (contains(getGame(userId).boxes, xCoord, yCoord) || contains(getGame(userId).barriers, xCoord, yCoord))
        return;
    else
        return new Coord(xCoord, yCoord);
}

const getBackgroundSkin = (skins: CategoryRecord<number>): string => {
    return SHOP_ITEMS[Callback.SOKOBAN].background[skins[Callback.SOKOBAN].background];
};
const getBarrierSkin = (skins: CategoryRecord<number>): string => {
    return SHOP_ITEMS[Callback.SOKOBAN].barrier[skins[Callback.SOKOBAN].barrier];
};
const getPlayerSkin = (skins: CategoryRecord<number>): string => {
    return SHOP_ITEMS[Callback.SOKOBAN].player[skins[Callback.SOKOBAN].player];
};
const getBoxSkin = (skins: CategoryRecord<number>): string => {
    return SHOP_ITEMS[Callback.SOKOBAN].box[skins[Callback.SOKOBAN].box];
};
const getDestinationSkin = (skins: CategoryRecord<number>): string => {
    return SHOP_ITEMS[Callback.SOKOBAN].destination[skins[Callback.SOKOBAN].destination];
};

export function renderSokobanMap(skins: CategoryRecord<number>, gameData: SokobanGameData): string {
    let renderer: string = "";

    renderer += `${getBarrierSkin(skins).repeat(WIDTH + 2)}\n${getBarrierSkin(skins)}`;
    for (let y: number = 0; y < HEIGHT; y++) {
        for (let x: number = 0; x < WIDTH; x++) {
            if (gameData.player.equals(new Coord(x, y)))
                renderer += getPlayerSkin(skins);
            else if (contains(gameData.barriers, x, y) ||
                    contains(gameData.boxes, x, y) &&
                    contains(gameData.destinations, x, y)
                )
                renderer += getBarrierSkin(skins);
            else if (contains(gameData.boxes, x, y))
                renderer += getBoxSkin(skins);
            else if (contains(gameData.destinations, x, y))
                renderer += getDestinationSkin(skins);
            else
                renderer += getBackgroundSkin(skins);
        }
        renderer += `${getBarrierSkin(skins)}\n${getBarrierSkin(skins)}`;
    }
    renderer += `${getBarrierSkin(skins).repeat(WIDTH + 1)}`;

    return renderer;
}

export default sokobanModule;