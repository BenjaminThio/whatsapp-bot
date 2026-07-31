import { type CallbackQueryContext, type CommandContext, Context, InlineKeyboard, Composer } from "grammy";
import { type SnakeGameData, createNewSnakeGame, deleteSnakeDoc, getSnakeGameData, updateSnakeGame } from "./database.js";
import { Movement, Coord, contains, Callback } from "../types.js";
import { SHOP_ITEMS } from "../shop/database.js";
import { CategoryRecord, ensureShopDataInitialized, shops } from "../shop/index.js";

const snakeModule = new Composer();
const HEIGHT: number = 10;
const WIDTH: number = 10;
const games: Record<number, SnakeGameData> = {};
const getHead = (userId: number) => getGame(userId).parts[0]!;
const getBody = (userId: number) => getGame(userId).parts.slice(1);

const getGame = (userId: number) => {
    const game: SnakeGameData | undefined = games[userId];

    if (game !== undefined)
        return game;
    else
        throw new Error("Game not found!");
};

async function ensureSnakeGameDataInitialized(userId: number): Promise<void>
{
    if (userId in games) return;

    /*
    One read, not two. This used to call userExists() and then getSnakeGameData(),
    which is a wasted round trip and a race: a game deleted between the two calls
    made the second return nothing, and the result was stored as if it were a
    live game.
    */
    const stored = await getSnakeGameData(userId);

    if (stored !== null) {
        games[userId] = stored;
        return;
    }

    reshuffle(userId);
    await createNewSnakeGame(userId, getGame(userId));
}

function constructKeyboard(userId: number): InlineKeyboard
{
    const KEYBOARD: InlineKeyboard = new InlineKeyboard()
        .text("⬆️", `${Callback.SNAKE} ${userId} ${Movement.UP}`).row()
        .text("⬅️", `${Callback.SNAKE} ${userId} ${Movement.LEFT}`).text("🔄", `${Callback.SNAKE} ${userId} 4`).text("➡️", `${Callback.SNAKE} ${userId} ${Movement.RIGHT}`).row()
        .text("⬇️", `${Callback.SNAKE} ${userId} ${Movement.DOWN}`);

    return KEYBOARD;
}

function reshuffle(userId: number): void
{
    games[userId] = {
        parts: [],
        foodCoord: new Coord(0, 0),
    };
    getGame(userId).parts = [new Coord(Math.floor(Math.random() * WIDTH), Math.floor(Math.random() * HEIGHT))];
    generateFood(userId);
}

snakeModule.command("snake", async (ctx: CommandContext<Context>): Promise<void> => {
    if (!ctx.from) {
        ctx.reply("`ctx.from` is undefined.");
        return;
    }

    const userId: number = ctx.from.id;

    await ensureShopDataInitialized(userId);
    await ensureSnakeGameDataInitialized(userId);
    await ctx.reply(renderSnakeMap(shops[userId].equippedSkins, getGame(userId)), {reply_markup: constructKeyboard(userId)});
});

snakeModule.callbackQuery(new RegExp(`^${Callback.SNAKE} (\\d+) ([0-4])$`), async (ctx: CallbackQueryContext<Context>): Promise<void> => {
    const ownerId: number = Number(ctx.match[1]);
    const direction: number /* Movement */ = Number(ctx.match[2]);
    const userId: number = ctx.from.id;

    if (ownerId !== userId)
    {
        await ctx.answerCallbackQuery({
            text: 'This is not your property.',
            show_alert: true
        });
        return;
    }

    await ensureShopDataInitialized(userId);
    await ensureSnakeGameDataInitialized(userId);

    switch (direction) {
        case Movement.UP:
            await move(ctx, 0, -1);
            break;
        case Movement.LEFT:
            await move(ctx, -1, 0);
            break;
        case Movement.DOWN:
            await move(ctx, 0, 1);
            break;
        case Movement.RIGHT:
            await move(ctx, 1, 0);
            break;
        case 4:
            reshuffle(userId);
            await updateSnakeGame(userId, getGame(userId));
            await ctx.editMessageText(renderSnakeMap(shops[userId].equippedSkins, getGame(userId)), {reply_markup: constructKeyboard(userId)});
    }
});

async function move(ctx: CallbackQueryContext<Context>, x: number, y: number) {
    if (!ctx.from) {
        ctx.reply("`ctx.from` is undefined.");
        return;
    }

    const userId: number = ctx.from.id;

    if (x < 0 || x > 0) {
        if (getHead(userId).x + x >= 0 && getHead(userId).x + x < WIDTH)
            getGame(userId).parts.splice(0, 0, new Coord(getHead(userId).x + x, getHead(userId).y));
        else if (getHead(userId).x + x >= 0)
            getGame(userId).parts.splice(0, 0, new Coord(0, getHead(userId).y));
        else
            getGame(userId).parts.splice(0, 0, new Coord(WIDTH - 1, getHead(userId).y));
    }

    if (y < 0 || y > 0) {
        if (getHead(userId).y + y >= 0 && getHead(userId).y + y < HEIGHT)
            getGame(userId).parts.splice(0, 0, new Coord(getHead(userId).x, getHead(userId).y + y));
        else if (getHead(userId).y + y >= 0)
            getGame(userId).parts.splice(0, 0, new Coord(getHead(userId).x, 0));
        else
            getGame(userId).parts.splice(0, 0, new Coord(getHead(userId).x, HEIGHT - 1));
    }

    ctx.answerCallbackQuery();

    if (getHead(userId).equals(getGame(userId).foodCoord)) {
        if (generateFood(userId) === 0) {
            await ctx.editMessageText(`<b>Game Over!</b>\n${renderSnakeMap(shops[userId].equippedSkins, getGame(userId))}`, { parse_mode: "HTML" });
            await deleteSnakeDoc(userId);
            delete games[userId];
            return;
        }
    } else if (contains(getBody(userId), getHead(userId))) {
        await ctx.editMessageText(`<b>Game Over!\nScore: ${getGame(userId).parts.length - 1}</b>\n${renderSnakeMap(shops[userId].equippedSkins, getGame(userId))}`, { parse_mode: "HTML" });
        await deleteSnakeDoc(userId);
        delete games[userId];
        return;
    } else
        getGame(userId).parts.pop();

    await updateSnakeGame(userId, getGame(userId));
    await ctx.editMessageText(renderSnakeMap(shops[userId].equippedSkins, getGame(userId)), {reply_markup: constructKeyboard(userId)});
}

function getBackgroundSkin(skins: CategoryRecord<number>): string {
    return SHOP_ITEMS[Callback.SNAKE].background[skins[Callback.SNAKE].background];
}
function getBarrierSkin(skins: CategoryRecord<number>): string {
    return SHOP_ITEMS[Callback.SNAKE].barrier[skins[Callback.SNAKE].barrier];
}
function getHeadSkin(skins: CategoryRecord<number>): string {
    return SHOP_ITEMS[Callback.SNAKE].head[skins[Callback.SNAKE].head];
}
function getBodySkin(skins: CategoryRecord<number>): string {
    return SHOP_ITEMS[Callback.SNAKE].body[skins[Callback.SNAKE].body];
}
function getFoodSkin(skins: CategoryRecord<number>): string {
    return SHOP_ITEMS[Callback.SNAKE].food[skins[Callback.SNAKE].food];
}

export function renderSnakeMap(skins: CategoryRecord<number>, gameData: SnakeGameData): string {
    let renderer: string = "";

    renderer += `${getBarrierSkin(skins).repeat(WIDTH + 2)}\n${getBarrierSkin(skins)}`;
    for (let y: number = 0; y < HEIGHT; y++) {
        for (let x: number = 0; x < WIDTH; x++) {
            if (gameData.parts[0].equals(new Coord(x, y)))
                renderer += getHeadSkin(skins);
            else if (contains(gameData.parts, x, y))
                renderer += getBodySkin(skins);
            else if (gameData.foodCoord.equals(new Coord(x, y)))
                renderer += getFoodSkin(skins);
            else
                renderer += getBackgroundSkin(skins);
        }
        renderer += `${getBarrierSkin(skins)}\n${getBarrierSkin(skins)}`;
    }
    renderer += getBarrierSkin(skins).repeat(WIDTH + 1);

    return renderer;
}

function generateFood(userId: number): number {
    const availableCoords: Coord[] = [];

    for (let y: number = 0; y < HEIGHT; y++) {
        for (let x: number = 0; x < WIDTH; x++) {
            if (!contains(getGame(userId).parts, x, y)) {
                availableCoords.push(new Coord(x, y));
            }
        }
    }

    switch (availableCoords.length) {
        case 0:
            break;
        default:
            getGame(userId).foodCoord = availableCoords[Math.floor(Math.random() * availableCoords.length)]!; // randomCoord
    }

    return availableCoords.length;
}

export default snakeModule;