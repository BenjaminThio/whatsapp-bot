import { type CallbackQueryContext, type CommandContext, Composer, Context, InlineKeyboard } from "grammy";
import { Callback } from "../types.js";
import { type TicTacToeData, createNewTicTacToe, deleteTicTacToeDoc, getTicTacToeData, updateTicTacToe } from "./database.js";

const ticTacToeModule: Composer<Context> = new Composer();
const MARKS: string[] = ["❌", "⭕️"];
const games: Record<number, TicTacToeData> = {};

const getGame = (userId: number): TicTacToeData => {
    const game: TicTacToeData | undefined = games[userId];

    if (game !== undefined)
        return game;
    else
        throw new Error("Game not found.");
};

async function ensureTicTacToeGameInitialized(userId: number): Promise<void>
{
    if (userId in games) return;

    // One read instead of userExists() + get() - see snake/index.ts
    const stored = await getTicTacToeData(userId);

    if (stored !== null) {
        games[userId] = stored;
        return;
    }

    games[userId] = {
        board: new Array(9).fill(null),
        player: false
    };

    await createNewTicTacToe(userId, getGame(userId));
}

ticTacToeModule.command("tictactoe", async (ctx: CommandContext<Context>): Promise<void> => {
    if (ctx.from === undefined) {
        ctx.reply("`ctx.from` is undefined.");
        return;
    }

    const userId: number = ctx.from.id;

    await ensureTicTacToeGameInitialized(userId);

    ctx.reply("Tic Tac Toe", { reply_markup: constructKeyboard(userId) });
});

ticTacToeModule.callbackQuery(new RegExp(`^${Callback.TIC_TAC_TOE} (\\d+) ([0-8])$`), async (ctx: CallbackQueryContext<Context>): Promise<void> => {
    if (ctx.from === undefined)
    {
        console.error('`ctx.from` is undefined.');
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
        return;
    }

    await ensureTicTacToeGameInitialized(userId);

    const idx: number = Number(ctx.match[2]);

    ctx.answerCallbackQuery();

    switch (getGame(userId).board[idx]) {
        case null:
            getGame(userId).board[idx] = getGame(userId).player;
            if (gameOver(userId)) {
                await ctx.editMessageText(`Tic Tac Toe\nGame Over! Player \`${+getGame(userId).player + 1}\` wins.`, { reply_markup: constructKeyboard(userId), parse_mode: "Markdown" });
                await deleteTicTacToeDoc(userId);
                delete games[userId];
                return;
            } else if (!getGame(userId).board.some((mark: (boolean | null)) => mark === null)) {
                await ctx.editMessageText(`Tic Tac Toe\nGame Over! It's a tie.`, { reply_markup: constructKeyboard(userId) });
                await deleteTicTacToeDoc(userId);
                delete games[userId];
                return;
            }
            getGame(userId).player = !getGame(userId).player;
            await updateTicTacToe(userId, getGame(userId));
            await ctx.editMessageText("Tic Tac Toe", { reply_markup: constructKeyboard(userId) });
    }
});

function constructKeyboard(userId: number): InlineKeyboard {
    const keyboard: InlineKeyboard = new InlineKeyboard();
    let counter: number = 1;

    for (let i: number = 0; i < 9; i++, counter++) {
        keyboard.text(getGame(userId).board[i] === null ? " " : MARKS[+(getGame(userId).board[i] as boolean)] as string, `${Callback.TIC_TAC_TOE} ${userId} ${i}`);

        if (counter === 3) {
            keyboard.row();
            counter = 0;
        }
    }
    return keyboard;
}

const gameOver = (userId: number): boolean => 
    getGame(userId).board[0] === getGame(userId).player && getGame(userId).board[1] === getGame(userId).player && getGame(userId).board[2] === getGame(userId).player ||
    getGame(userId).board[3] === getGame(userId).player && getGame(userId).board[4] === getGame(userId).player && getGame(userId).board[5] === getGame(userId).player ||
    getGame(userId).board[6] === getGame(userId).player && getGame(userId).board[7] === getGame(userId).player && getGame(userId).board[8] === getGame(userId).player ||
    getGame(userId).board[0] === getGame(userId).player && getGame(userId).board[3] === getGame(userId).player && getGame(userId).board[6] === getGame(userId).player ||
    getGame(userId).board[1] === getGame(userId).player && getGame(userId).board[4] === getGame(userId).player && getGame(userId).board[7] === getGame(userId).player ||
    getGame(userId).board[2] === getGame(userId).player && getGame(userId).board[5] === getGame(userId).player && getGame(userId).board[8] === getGame(userId).player ||
    getGame(userId).board[0] === getGame(userId).player && getGame(userId).board[4] === getGame(userId).player && getGame(userId).board[8] === getGame(userId).player ||
    getGame(userId).board[2] === getGame(userId).player && getGame(userId).board[4] === getGame(userId).player && getGame(userId).board[6] === getGame(userId).player;

export default ticTacToeModule;