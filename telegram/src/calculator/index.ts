import { type CallbackQueryContext, type CommandContext, Composer, Context, InlineKeyboard } from "grammy";
import { type CalculatorData, createNewCalculator, getCalculatorData, updateCalculator, userExists } from "./database.js";
import { Callback } from "../types.js";

const calculatorModule: Composer<Context> = new Composer();
function constructKeyboard(userId: number): InlineKeyboard
{
    const BASIC: InlineKeyboard = new InlineKeyboard()
        .text("©️", `${Callback.CALCULATOR} ${userId} 10`).text("🔙", `${Callback.CALCULATOR} ${userId} 11`).text("%", `${Callback.CALCULATOR} ${userId} 12`).text("➗", `${Callback.CALCULATOR} ${userId} 13`).row()
        .text("7️⃣", `${Callback.CALCULATOR} ${userId} 7`).text("8️⃣", `${Callback.CALCULATOR} ${userId} 8`).text("9️⃣", `${Callback.CALCULATOR} ${userId} 9`).text("✖️", `${Callback.CALCULATOR} ${userId} 14`).row()
        .text("4️⃣", `${Callback.CALCULATOR} ${userId} 4`).text("5️⃣", `${Callback.CALCULATOR} ${userId} 5`).text("6️⃣", `${Callback.CALCULATOR} ${userId} 6`).text("➖", `${Callback.CALCULATOR} ${userId} 15`).row()
        .text("1️⃣", `${Callback.CALCULATOR} ${userId} 1`).text("2️⃣", `${Callback.CALCULATOR} ${userId} 2`).text("3️⃣", `${Callback.CALCULATOR} ${userId} 3`).text("➕", `${Callback.CALCULATOR} ${userId} 16`).row()
        .text("🔄", `${Callback.CALCULATOR} ${userId} 17`).text("0️⃣", `${Callback.CALCULATOR} ${userId} 0`).text("⏺️", `${Callback.CALCULATOR} ${userId} 18`).text("✔️", `${Callback.CALCULATOR} ${userId} 19`);
    const SCIENTIFIC: InlineKeyboard = new InlineKeyboard()
        .text("2nd", `${Callback.CALCULATOR} ${userId} 20`).text("🚫", `${Callback.CALCULATOR} ${userId} 21`).text("sin", `${Callback.CALCULATOR} ${userId} 22`).text("cos", `${Callback.CALCULATOR} ${userId} 23`).text("tan", `${Callback.CALCULATOR} ${userId} 24`).row()
        .text("^", `${Callback.CALCULATOR} ${userId} 25`).text("lg", `${Callback.CALCULATOR} ${userId} 26`).text("ln", `${Callback.CALCULATOR} ${userId} 27`).text("(", `${Callback.CALCULATOR} ${userId} 28`).text(")", `${Callback.CALCULATOR} ${userId} 29`).row()
        .text("√", `${Callback.CALCULATOR} ${userId} 30`).text("©️", `${Callback.CALCULATOR} ${userId} 10`).text("🔙", `${Callback.CALCULATOR} ${userId} 11`).text("%", `${Callback.CALCULATOR} ${userId} 12`).text("➗", `${Callback.CALCULATOR} ${userId} 13`).row()
        .text("❕", `${Callback.CALCULATOR} ${userId} 31`).text("7️⃣", `${Callback.CALCULATOR} ${userId} 7`).text("8️⃣", `${Callback.CALCULATOR} ${userId} 8`).text("9️⃣", `${Callback.CALCULATOR} ${userId} 9`).text("✖️", `${Callback.CALCULATOR} ${userId} 14`).row()
        .text("⁻¹", `${Callback.CALCULATOR} ${userId} 32`).text("4️⃣", `${Callback.CALCULATOR} ${userId} 4`).text("5️⃣", `${Callback.CALCULATOR} ${userId} 5`).text("6️⃣", `${Callback.CALCULATOR} ${userId} 6`).text("➖", `${Callback.CALCULATOR} ${userId} 15`).row()
        .text("π", `${Callback.CALCULATOR} ${userId} 33`).text("1️⃣", `${Callback.CALCULATOR} ${userId} 1`).text("2️⃣", `${Callback.CALCULATOR} ${userId} 2`).text("3️⃣", `${Callback.CALCULATOR} ${userId} 3`).text("➕", `${Callback.CALCULATOR} ${userId} 16`).row()
        .text("🔄", `${Callback.CALCULATOR} ${userId} 17`).text("e", `${Callback.CALCULATOR} ${userId} 34`).text("0️⃣", `${Callback.CALCULATOR} ${userId} 0`).text("⏺️", `${Callback.CALCULATOR} ${userId} 18`).text("✔️", `${Callback.CALCULATOR} ${userId} 19`);
    const INV_SCIENTIFIC: InlineKeyboard = new InlineKeyboard()
        .text("2nd", `${Callback.CALCULATOR} ${userId} 20`).text("🚫", `${Callback.CALCULATOR} ${userId} 21`).text("sin⁻¹", `${Callback.CALCULATOR} ${userId} 35`).text("cos⁻¹", `${Callback.CALCULATOR} ${userId} 36`).text("tan⁻¹", `${Callback.CALCULATOR} ${userId} 37`).row()
        .text("^", `${Callback.CALCULATOR} ${userId} 25`).text("lg", `${Callback.CALCULATOR} ${userId} 26`).text("ln", `${Callback.CALCULATOR} ${userId} 27`).text("(", `${Callback.CALCULATOR} ${userId} 28`).text(")", `${Callback.CALCULATOR} ${userId} 29`).row()
        .text("√", `${Callback.CALCULATOR} ${userId} 30`).text("©️", `${Callback.CALCULATOR} ${userId} 10`).text("🔙", `${Callback.CALCULATOR} ${userId} 11`).text("%", `${Callback.CALCULATOR} ${userId} 12`).text("➗", `${Callback.CALCULATOR} ${userId} 13`).row()
        .text("❕", `${Callback.CALCULATOR} ${userId} 31`).text("7️⃣", `${Callback.CALCULATOR} ${userId} 7`).text("8️⃣", `${Callback.CALCULATOR} ${userId} 8`).text("9️⃣", `${Callback.CALCULATOR} ${userId} 9`).text("✖️", `${Callback.CALCULATOR} ${userId} 14`).row()
        .text("⁻¹", `${Callback.CALCULATOR} ${userId} 32`).text("4️⃣", `${Callback.CALCULATOR} ${userId} 4`).text("5️⃣", `${Callback.CALCULATOR} ${userId} 5`).text("6️⃣", `${Callback.CALCULATOR} ${userId} 6`).text("➖", `${Callback.CALCULATOR} ${userId} 15`).row()
        .text("π", `${Callback.CALCULATOR} ${userId} 33`).text("1️⃣", `${Callback.CALCULATOR} ${userId} 1`).text("2️⃣", `${Callback.CALCULATOR} ${userId} 2`).text("3️⃣", `${Callback.CALCULATOR} ${userId} 3`).text("➕", `${Callback.CALCULATOR} ${userId} 16`).row()
        .text("🔄", `${Callback.CALCULATOR} ${userId} 17`).text("e", `${Callback.CALCULATOR} ${userId} 34`).text("0️⃣", `${Callback.CALCULATOR} ${userId} 0`).text("⏺️", `${Callback.CALCULATOR} ${userId} 18`).text("✔️", `${Callback.CALCULATOR} ${userId} 19`);

    return getCalculator(userId).scientific ? (getCalculator(userId).secondary ? INV_SCIENTIFIC : SCIENTIFIC) : BASIC;
}

export enum Key {
    ZERO,
    ONE,
    TWO,
    THREE,
    FOUR,
    FIVE,
    SIX,
    SEVEN,
    EIGHT,
    NINE,
    CLEAR,
    BACKSPACE,
    PERCENTAGE,
    DIVIDE,
    MULTIPLY,
    MINUS,
    PLUS,
    MODE_SWITCH,
    DECIMAL,
    EQUAL,
    SECONDARY,
    IDK,
    SINE,
    COSINE,
    TANGENT,
    EXPONENT,
    LOG,
    NATURAL_LOG,
    LEFT_PARENTHESIS,
    RIGHT_PARENTHESIS,
    SQUARE_ROOT,
    FACTORIAL,
    POWER_OF_NEGATIVE_ONE,
    PI,
    EULER_NUMBER,
    ARCSINE,
    ARCCOSINE,
    ARCTANGENT
}
const calculators: Record<number, CalculatorData> = {};

const getCalculator = (userId: number): CalculatorData => {
    const calculator: CalculatorData | undefined = calculators[userId];

    if (calculator !== undefined)
        return calculator;
    else
        throw new Error("Calculator not found.");
};

async function ensureCalculatorDataInitialized(userId: number)
{
    if (!(userId in calculators)) {
        if (await userExists(userId)) {
            calculators[userId] = await getCalculatorData(userId);
        } else {
            calculators[userId] = {
                scientific: false,
                secondary: false,
                entries: [],
                result: ""
            };

            createNewCalculator(userId, getCalculator(userId));
        }
    }
}

calculatorModule.command("cal", async (ctx: CommandContext<Context>): Promise<void> => {
    if (ctx.from === undefined) {
        ctx.reply("`ctx.from` is undefined.");
        return;
    }

    const userId: number = ctx.from.id;

    await ensureCalculatorDataInitialized(userId);

    ctx.reply(render(userId), { reply_markup: constructKeyboard(userId) });
});

calculatorModule.callbackQuery(new RegExp(`^${Callback.CALCULATOR} (\\d+) ([0-9]|[1-2][0-9]|3[0-7])$`), async (ctx: CallbackQueryContext<Context>): Promise<void> => {
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

    await ensureCalculatorDataInitialized(userId);

    const key: number = parseInt(ctx.match[2] as string);

    switch (key) {
        case Key.CLEAR:
            getCalculator(userId).entries = [];
            getCalculator(userId).result = "";
            break;
        case Key.BACKSPACE:
            getCalculator(userId).entries.pop();
            break;
        case Key.MODE_SWITCH:
            getCalculator(userId).scientific = !getCalculator(userId).scientific;
            break;
        case Key.EQUAL:
            getCalculator(userId).result = compileExpression(userId);
            break;
        case Key.SECONDARY:
            getCalculator(userId).secondary = !getCalculator(userId).secondary;
            break;
        default:
            getCalculator(userId).entries.push(key);
    }

    ctx.answerCallbackQuery();
    await updateCalculator(userId, getCalculator(userId));
    await ctx.editMessageText(render(userId), { reply_markup: constructKeyboard(userId) });
});

function render(userId: number): string {
    let renderer: string = "";

    for (const entry of getCalculator(userId).entries) {
        if (entry >= 0 && entry <= 9)
            renderer += entry;
        else {
            switch (entry) {
                case Key.PERCENTAGE:
                    renderer += '%';
                    break;
                case Key.DIVIDE:
                    renderer += '÷';
                    break;
                case Key.MULTIPLY:
                    renderer += '×';
                    break;
                case Key.MINUS:
                    renderer += '-';
                    break;
                case Key.PLUS:
                    renderer += '+';
                    break;
                case Key.DECIMAL:
                    renderer += '.';
                    break;
                case Key.SINE:
                    renderer += "sin(";
                    break;
                case Key.COSINE:
                    renderer += "cos(";
                    break;
                case Key.TANGENT:
                    renderer += "tan(";
                    break;
                case Key.EXPONENT:
                    renderer += "^";
                    break;
                case Key.LOG:
                    renderer += "log(";
                    break;
                case Key.NATURAL_LOG:
                    renderer += "ln(";
                    break;
                case Key.LEFT_PARENTHESIS:
                    renderer += '(';
                    break;
                case Key.RIGHT_PARENTHESIS:
                    renderer += ')';
                    break;
                case Key.SQUARE_ROOT:
                    renderer += '√';
                    break;
                case Key.FACTORIAL:
                    renderer += '!';
                    break;
                case Key.POWER_OF_NEGATIVE_ONE:
                    renderer += "^-1";
                    break;
                case Key.PI:
                    renderer += 'π';
                    break;
                case Key.EULER_NUMBER:
                    renderer += 'e';
                    break;
                case Key.ARCSINE:
                    renderer += 'arcsin(';
                    break;
                case Key.ARCCOSINE:
                    renderer += 'arccos(';
                    break;
                case Key.ARCTANGENT:
                    renderer += 'arctan(';
            }
        }
    }

    return `Entries: ${renderer.length > 0 ? renderer : '0'}\nResult: ${getCalculator(userId).result.length > 0 ? getCalculator(userId).result : '0'}`;
}

// Compiler
export function compileExpression(userId: number): string {
    let compiler = "";

    for (const entry of getCalculator(userId).entries) {
        if (entry >= 0 && entry <= 9)
            compiler += entry;
        else {
            switch (entry) {
                case Key.PERCENTAGE:
                    compiler += '/100';
                    break;
                case Key.DIVIDE:
                    compiler += '/';
                    break;
                case Key.MULTIPLY:
                    compiler += '*';
                    break;
                case Key.MINUS:
                    compiler += '-';
                    break;
                case Key.PLUS:
                    compiler += '+';
                    break;
                case Key.DECIMAL:
                    compiler += '.';
                    break;
                case Key.SINE:
                    compiler += "Math.sin(";
                    break;
                case Key.COSINE:
                    compiler += "Math.cos(";
                    break;
                case Key.TANGENT:
                    compiler += "Math.tan(";
                    break;
                case Key.EXPONENT:
                    compiler += '**';
                    break;
                case Key.LOG:
                    compiler += "Math.log10(";
                    break;
                case Key.NATURAL_LOG:
                    compiler += "Math.log(";
                    break;
                case Key.LEFT_PARENTHESIS:
                    compiler += '(';
                    break;
                case Key.RIGHT_PARENTHESIS:
                    compiler += ')';
                    break;
                case Key.SQUARE_ROOT:
                    compiler += 'Math.sqrt(';
                    break;
                case Key.FACTORIAL:
                    // compiler += '!';
                    break;
                case Key.POWER_OF_NEGATIVE_ONE:
                    compiler += "**-1";
                    break;
                case Key.PI:
                    compiler += 'Math.PI';
                    break;
                case Key.EULER_NUMBER:
                    compiler += 'Math.E';
                    break;
                case Key.ARCSINE:
                    compiler += 'Math.asin(';
                    break;
                case Key.ARCCOSINE:
                    compiler += 'Math.acos(';
                    break;
                case Key.ARCTANGENT:
                   compiler += 'Math.atan(';
            }
        }
    }

    return eval(compiler).toString();
}

export default calculatorModule;