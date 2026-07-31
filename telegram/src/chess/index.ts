import { CallbackQueryContext, CommandContext, Composer, Context, InlineKeyboard, InputFile, InputMediaBuilder } from "grammy";
import { Callback } from "../types.js";
import { generateImage, isRendererReady } from "../pixelforge/index.js";

type Rank = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;
type File = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;
type RankDirection = -1 | 0 | 1;
type FileDirection = -1 | 0 | 1;
export type Position = `${Rank},${File}`;
type PositionArray = [Rank, File];
type Direction = [RankDirection, FileDirection]; // Direction Vector

export enum Piece {
    WHITE_PAWN,
    WHITE_ROOK,
    WHITE_KNIGHT,
    WHITE_BISHOP,
    WHITE_QUEEN,
    WHITE_KING,
    BLACK_PAWN,
    BLACK_ROOK,
    BLACK_KNIGHT,
    BLACK_BISHOP,
    BLACK_QUEEN,
    BLACK_KING
};
enum Color {
    WHITE,
    BLACK
}

const chessModule: Composer<Context> = new Composer();
const MAX_RANK_VALUE: number = 8;
const MAX_FILE_VALUE: number = 8;
const WHITE: string = "⬜️";
const BLACK: string = "⬛️";
const PIECES: string[] = ['♙', '♖', '♘', '♗', '♕', '♔', '♟️', '♜', '♞', '♝', '♛', '♚'];
const PIECE_VALUES: Record<Piece, number> = {
    [Piece.WHITE_PAWN]: 1,
    [Piece.BLACK_PAWN]: 1,
    [Piece.WHITE_KNIGHT]: 3,
    [Piece.BLACK_KNIGHT]: 3,
    [Piece.WHITE_BISHOP]: 3,
    [Piece.BLACK_BISHOP]: 3,
    [Piece.WHITE_ROOK]: 5,
    [Piece.BLACK_ROOK]: 5,
    [Piece.WHITE_QUEEN]: 9,
    [Piece.BLACK_QUEEN]: 9,
    [Piece.WHITE_KING]: Number.POSITIVE_INFINITY,
    [Piece.BLACK_KING]: Number.POSITIVE_INFINITY
};

// The board only store piece's position.
const board: Record<Position, Piece> = {} as Record<Position, Piece>;
let focusPos: Position | undefined = undefined;
let availablePos: Position[] = [];
// Player is stored as boolean which false (0) is represented as white and true (1) as black.
let player: boolean = false;
const captured: Record<Color, Piece[]> = {
   [Color.WHITE]: [],
   [Color.BLACK]: []
};

chessModule.command("chess", async (ctx: CommandContext<Context>): Promise<void> => {
    /*
    Checked up front rather than letting the first render throw. Without the
    native renderer every move would fail the same way, so say it once, clearly,
    instead of once per tap.
    */
    if (!isRendererReady()) {
        await ctx.reply(
            "♟️ Chess is unavailable - the native board renderer isn't built for this host.\n" +
            "Build it with: cd src/pixelforge && npx cmake-js compile --CDCMAKE_BUILD_TYPE=Release"
        );
        return;
    }

    generatePieces();
    await ctx.replyWithPhoto(new InputFile(await generateImage(board)), { caption: `***Chess***\n\nMaterial: ${getMaterial(!!Color.BLACK)}\n${renderCaptured(!!Color.BLACK)}\n${renderChess()}Material: ${getMaterial(!!Color.WHITE)}\n${renderCaptured(!!Color.WHITE)}\n\nSelected: ${focusPos === undefined ? "None" : positionToAlgebraicNotation(focusPos)}`, reply_markup: updateKeyboard(), parse_mode: "Markdown" });
});

chessModule.callbackQuery(new RegExp(`^${Callback.CHESS} ([0-${MAX_RANK_VALUE}],[0-${MAX_FILE_VALUE}])$`), async (ctx: CallbackQueryContext<Context>): Promise<void> => {
    const pos: Position = ctx.match[1] as Position;

    switch (focusPos) {
        case undefined:
            focusPiece(pos);
            break;
        case pos:
            focusPos = undefined;
            availablePos = [];
            break;
        default:
            if (availablePos.includes(pos)) {
                if (isOccupied(pos))
                    // material[+player] = PIECE_VALUES[board[pos]];
                    captured[+player as Color].push(board[pos]);
                board[pos] = board[focusPos];
                delete board[focusPos];
                availablePos = [];
                focusPos = undefined;
                player = !player;
            } else
                availablePos = [];
                focusPiece(pos);
    }
   
    await ctx.editMessageMedia(InputMediaBuilder.photo(new InputFile(await generateImage(board)), { caption: `***Chess***\n\nMaterial: ${getMaterial(!!Color.BLACK)}\n${renderCaptured(!!Color.BLACK)}\n${renderChess()}Material: ${getMaterial(!!Color.WHITE)}\n${renderCaptured(!!Color.WHITE)}\n\nSelected: ${focusPos === undefined ? "None" : positionToAlgebraicNotation(focusPos)}`, parse_mode: "Markdown" }), { reply_markup: updateKeyboard() });
});

// Select and highlight piece.
function focusPiece(pos: Position) {
    if (isEnemy(pos)) return;

    focusPos = pos;

    if (isOccupied(pos)) {
        switch (board[pos]) {
            case Piece.WHITE_PAWN:
            case Piece.BLACK_PAWN: {
                movePawn(pos);
                break;
            }
            case Piece.WHITE_ROOK:
            case Piece.BLACK_ROOK:
                moveRook(pos);
                break;
            case Piece.WHITE_KNIGHT:
            case Piece.BLACK_KNIGHT:
                moveKnight(pos);
                break;
            case Piece.WHITE_BISHOP:
            case Piece.BLACK_BISHOP:
                moveBishop(pos);
                break;
            case Piece.WHITE_QUEEN:
            case Piece.BLACK_QUEEN:
                moveQueen(pos);
                break;
            case Piece.WHITE_KING:
            case Piece.BLACK_KING:
                moveKing(pos);
        }
    }
}

function movePawn(pos: Position): void {
    const positionArray: PositionArray = pos.split(',').map((coord: string) => Number(coord)) as PositionArray;
    const x: Rank = positionArray[0];
    const y: File = positionArray[1];
    const initialY: File = isWhite(pos) ? 6 : 1;
    const fileDirection: FileDirection = isWhite(pos) ? -1 : 1;

    switch (y) {
        case initialY:
            move(pos, [0, fileDirection], 2);
            break;
        default:
            move(pos, [0, fileDirection], 1);
    }

    for (const rankDirection of [1, -1] as RankDirection[])
    {
        if (`${x + rankDirection},${y + fileDirection}` in board)
        {
            move(pos, [rankDirection, fileDirection], 1);
        }
    }
}

function moveRook(pos: Position, limit: number | undefined = undefined): void {
    move(pos, [0, -1], limit); // up
    move(pos, [-1, 0], limit); // left
    move(pos, [0, 1], limit); // down
    move(pos, [1, 0], limit); // right
}

function moveBishop(pos: Position, limit: number | undefined = undefined): void {
    move(pos, [-1, -1], limit); // top left
    move(pos, [1, -1], limit); // top right
    move(pos, [-1, 1], limit); // bottom left
    move(pos, [1, 1], limit); // bottom right
}

function moveQueen(pos: Position): void {
    moveRook(pos);
    moveBishop(pos);
}

function moveKing(pos: Position, limit: number= 1): void {
    moveRook(pos, limit);
    moveBishop(pos, limit);
}

function moveKnight(pos: Position): void {
    const positionArray: PositionArray = pos.split(',').map((coord: string) => Number(coord)) as PositionArray;
    const x: Rank = positionArray[0];
    const y: File = positionArray[1];

    for (const pos of [
        `${x - 1},${y - 2}`,
        `${x - 2},${y - 1}`,
        `${x + 1},${y - 2}`,
        `${x + 2},${y - 1}`,
        `${x - 1},${y + 2}`,
        `${x - 2},${y + 1}`,
        `${x + 1},${y + 2}`,
        `${x + 2},${y + 1}`
    ] as Position[])
        if (isEmpty(pos) || isBlack(pos))
            availablePos.push(pos);
}

function move(pos: Position, direction: Direction, limit: number | undefined = undefined): void
{
    const positionArray: PositionArray = pos.split(',').map((coord: string) => Number(coord)) as PositionArray;
    const x: Rank = positionArray[0];
    const y: File = positionArray[1];

    if ((limit === undefined || limit > 0) &&
        x + direction[0] >= 0 &&
        x + direction[0] < MAX_RANK_VALUE &&
        y + direction[1] >= 0 &&
        y + direction[1] < MAX_FILE_VALUE)
    {
        const futurePos: Position = `${x + direction[0]},${y + direction[1]}` as keyof typeof board;

        if (isEmpty(futurePos) || isEnemy(futurePos)) {
            availablePos.push(futurePos);

            if (isEmpty(futurePos))
                move(futurePos, direction, limit === undefined ? undefined : limit - 1);
        }
    }
}

const isOccupied = (pos: Position): boolean => pos in board;
const isEmpty = (pos: Position): boolean => !isOccupied(pos);
// const isAlly = (pos: Position): boolean => player ? isBlack(pos) : isWhite(pos);
const isEnemy = (pos: Position): boolean => player ? isWhite(pos) : isBlack(pos); // black : white
// Refer to the Piece enum table, value 0 - 5 is white piece, meanwhile 5 and value more than 5 is black piece.
const isWhite = (pos: Position): boolean => board[pos] <= 5;
const isBlack = (pos: Position): boolean => board[pos] > 5;

function updateKeyboard(): InlineKeyboard {
    const keyboard: InlineKeyboard = new InlineKeyboard();

    for (let y: File = MAX_FILE_VALUE - 1 as File; y >= 0; y--) {
        for (let x: Rank = 0; x < MAX_RANK_VALUE; x++) {
            const pos: Position = `${x},${y}` as keyof typeof board;

            if (focusPos === pos || availablePos.includes(pos)) {
                keyboard.text("🟩", `${Callback.CHESS} ${pos}`);
            } else if (isOccupied(pos)) {
                keyboard.text(PIECES[board[pos]], `${Callback.CHESS} ${pos}`);
            } else {
                switch ((x + y) % 2) {
                    case 0: // even
                        keyboard.text(BLACK, `${Callback.CHESS}`);
                        break;
                    default: // odd
                        keyboard.text(WHITE, `${Callback.CHESS}`);
                }
            }
        }
        keyboard.row();
    }

    return keyboard;
}

function generatePieces(): void {
    for (const y of [1, 6] as File[]) {
        for (let x: Rank = 0; x < MAX_RANK_VALUE; x++) {
            board[`${x as Rank},${y}`] = y % 2 === 0 ? Piece.BLACK_PAWN : Piece.WHITE_PAWN;
        }
    }

    for (const y of [0, 7] as File[]) {
        for (let x: Rank = 0; x < 4; x++) {
            board[`${x},${y}` as keyof typeof board] = x === 3 ? (y % 2 === 0 ? Piece.WHITE_QUEEN : Piece.BLACK_QUEEN) : (y % 2 === 0 ? x + 1 : 7 + x);
            board[`${7 - x},${y}` as keyof typeof board] = x === 3 ? (y % 2 === 0 ? Piece.WHITE_KING : Piece.BLACK_KING) : (y % 2 === 0 ? x + 1 : 7 + x);
        }
    }
}

function renderChess(): string {
    let renderer: string = "";

    for (let y: File = MAX_FILE_VALUE - 1 as File; y >= 0; y--) {
        for (let x: Rank = 0; x < MAX_RANK_VALUE; x++) {
            const pos: Position = `${x},${y}` as keyof typeof board;

            if (isOccupied(pos))
                renderer += PIECES[board[pos]];
            else {
                switch ((x + y) % 2) {
                    case 0: // even
                        renderer += BLACK;
                        break;
                    default: // odd
                        renderer += WHITE;
                }
            }
        }
        renderer += '\n';
    }

    return renderer;
}

function renderCaptured(player: boolean): string {
    return `\`\`\`${Object.keys(Color).filter(key => isNaN(Number(key)))[+player as Color]}\n${captured[+player as Color].map((piece: Piece) => PIECES[piece]).join('')}‎\`\`\``;
}

function getMaterial(player: boolean): number
{
    let material: number = 0;

    captured[+player as Color].forEach((piece: Piece): void => {
        material += PIECE_VALUES[piece];
    });
    return material;
}

function positionToAlgebraicNotation(pos: Position): string {
    const positionArray: PositionArray = pos.split(',').map((coord: string) => Number(coord)) as PositionArray;
    const x: Rank = positionArray[0];
    const y: File = positionArray[1];

    return `${numberToAlpha(x + 1)}${y + 1}`;
}

function numberToAlpha(n: number, isUpper: boolean = false): string {
    if (n < 0 && n >= 26)
        return "";

    const offset = isUpper ? 64 : 96;

    return String.fromCharCode(n + offset);
}

export default chessModule;