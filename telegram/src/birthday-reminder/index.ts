import { Api, Bot, type CommandContext, Composer, Context, RawApi } from "grammy";
import { createNewBirthday, getTodayBirthdays, markWished, birthdaysForChat, deleteBirthday, type BirthdayRow } from "./database.js";
import { sendText } from "../../../shared/messaging/outbox.js";

const birthdayModule: Composer<Context> = new Composer();
const SEPARATORS: string[] = ['/', '-', '.'];
const MONTHS: string[] = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

class Birthday {
    public day: number;
    public month: number;
    public year: number;
    /** False when the user gave only a day and month. */
    public hasYear: boolean;

    constructor(day: number, month: number, year: number, hasYear: boolean = true) {
        this.day = day;
        this.month = month;
        this.year = year;
        this.hasYear = hasYear;
    }

    public static tryParse(s: string, retryCounter: number = 0): Birthday {
        const separator: string | undefined = SEPARATORS[retryCounter];

        if (separator === undefined) {
            throw new Error(
                `Invalid date format.\nExamples:\n${SEPARATORS.map(
                    (sep: string) => ["DAY", "MONTH", "YEAR"].join(sep)
                ).join('\n')}`
            );
        }

        const date: string[] = s.split(separator);

        if (date.length < 2)
            return this.tryParse(s, retryCounter + 1);

        const hasYear: boolean = date.length >= 3;
        const birthday: Birthday = new Birthday(
            Number(date[0]),
            Number(date[1]),
            // A missing year is only used to validate the day/month pair, so a
            // leap-day birthday entered without a year still has to land on a
            // leap year to be accepted.
            hasYear ? Number(date[2]) : 2000,
            hasYear
        );
        const errs: string[] = [];

        if (!Number.isInteger(birthday.day))
            errs.push("Day is not a whole number.");

        if (!Number.isInteger(birthday.month)) {
            birthday.month = this.tryParseMonth(date[1]!);

            if (!Number.isInteger(birthday.month))
                errs.push("Month is neither a number nor a month name.");
        }
        if (!Number.isInteger(birthday.year))
            errs.push("Year is not a whole number.");
        if (errs.length === 0 && !this.isValidDate(birthday.day, birthday.month, birthday.year))
            errs.push(`${birthday.toString()} is not a real date.`);
        if (errs.length > 0)
            throw new Error(errs.map((err, i) => `${i + 1}. ${err}`).join('\n'));

        return birthday;
    }

    /*
    Month names are matched case-insensitively and the result is 1-based.
    indexOf() is 0-based, so "January" used to come back as 0 and then fail
    isValidDate's `month >= 1` check - every month name was rejected.
    */
    public static tryParseMonth(month: string): number {
        const idx: number = MONTHS.findIndex(
            (m: string) => m.toLowerCase() === month.trim().toLowerCase()
        );
        return idx === -1 ? Number.NaN : idx + 1;
    }

    /** Days in `month` of `year`, using Date's own month overflow. */
    public static daysInMonth = (month: number, year: number): number =>
        new Date(year, month, 0).getDate();

    public static isValidDate(day: number, month: number, year: number): boolean {
        if (month < 1 || month > 12 || day < 1) return false;
        return day <= this.daysInMonth(month, year);
    }

    public toString = (): string => `${this.day}/${this.month}${this.hasYear ? `/${this.year}` : ""}`;
}

const USAGE = "/birthday <date> <name>\nDate accepts: `9/3/2005`, `9-3-2005`, `9.3.2005`, or `9/3` (no year)\n\n/birthday list\n/birthday delete <name>";

birthdayModule.command("birthday", async (ctx: CommandContext<Context>): Promise<void> => {
    const payload: string = ctx.match.trim();

    if (payload === "") {
        await ctx.reply(USAGE, { parse_mode: "Markdown" });
        return;
    }

    const params: string[] = payload.split(/\s+/);
    const sub = params[0]!.toLowerCase();

    try {
        if (sub === "list") {
            const rows: BirthdayRow[] = await birthdaysForChat(ctx.msg.chat.id);

            if (rows.length === 0) {
                await ctx.reply("📭 No birthdays saved in this chat.");
                return;
            }

            const lines = rows.map((r: BirthdayRow) => {
                const age = r.year !== null ? ` _(b. ${r.year})_` : "";
                const done = r.remindYear === new Date().getFullYear() ? " ✅" : "";
                return `• *${r.name}* — ${String(r.day).padStart(2, "0")}/${String(r.month).padStart(2, "0")}${age}${done}`;
            });
            await ctx.reply(`🎂 *Saved birthdays*\n\n${lines.join("\n")}`, { parse_mode: "Markdown" });
            return;
        }

        if (sub === "delete" || sub === "remove") {
            const name = params.slice(1).join(" ");
            if (!name) {
                await ctx.reply("Usage: `/birthday delete <name>`", { parse_mode: "Markdown" });
                return;
            }
            const removed = await deleteBirthday(`tg:${ctx.msg.chat.id}_${name}`.replace(/\s+/g, "_"));
            await ctx.reply(removed ? `🗑️ Removed *${name}*.` : `❌ No birthday saved for *${name}*.`,
                { parse_mode: "Markdown" });
            return;
        }

        if (params.length < 2) {
            await ctx.reply(USAGE, { parse_mode: "Markdown" });
            return;
        }

        const birthday: Birthday = Birthday.tryParse(params[0]!);
        const name: string = params.slice(1).join(" ");

        /*
        Show the date the reminder will actually fire. A birthday that has
        already passed this year fires next year - the old code computed this
        and then threw the result away, reporting the wrong month because it
        built the Date with `birthday.month` where the Date constructor wanted a
        0-based month.
        */
        const today: Date = new Date();
        const thisYear: Date = new Date(today.getFullYear(), birthday.month - 1, birthday.day);
        const fires: Date = thisYear < today
            ? new Date(today.getFullYear() + 1, birthday.month - 1, birthday.day)
            : thisYear;

        await createNewBirthday({
            name,
            day: birthday.day,
            month: birthday.month,
            year: birthday.hasYear ? birthday.year : null,
            chatId: ctx.msg.chat.id,
        });

        const yearNote = birthday.hasYear
            ? `\n🎂 Born: \`${birthday.year}\``
            : "\n💡 Include a year to track age.";

        await ctx.reply(
            `✅ Birthday saved for \`${name}\`\n🔔 Next reminder: \`${fires.toDateString()}\`${yearNote}`,
            { parse_mode: "Markdown" }
        );
    }
    catch (err: unknown) {
        await ctx.reply(`❌ ${err instanceof Error ? err.message : String(err)}`);
    }
});

/**
 * Wish everyone whose birthday is today.
 *
 * Sends through the shared outbox, so a wish composed while Telegram is
 * unreachable is queued and retried rather than lost. The year-lock is written
 * only after the message is safely recorded.
 */
export async function remindBirthday(_bot?: Bot<Context, Api<RawApi>>): Promise<void> {
    let rows: BirthdayRow[];
    try {
        rows = await getTodayBirthdays();
    } catch (err) {
        console.error("🎂 Could not read today's birthdays:", err);
        return;
    }

    const currentYear = new Date().getFullYear();

    for (const row of rows) {
        try {
            const ageLine = row.year !== null
                ? `\n🎁 Turning <b>${currentYear - row.year}</b> today!`
                : "";

            await sendText(
                "telegram",
                String(row.chatId),
                `🎂🎈 <b>HAPPY BIRTHDAY TO ${row.name.toUpperCase()}! 🎈🎂</b>\n\n` +
                `Today is <b>${row.name}</b>'s special day!${ageLine}\n\n` +
                `Let's wish them an amazing day ahead! 🎉✨`,
                { priority: 2, format: "html" }
            );

            await markWished(row.docId, currentYear);
        } catch (err) {
            // One bad row must not stop everyone else being wished
            console.error(`🎂 Failed wishing ${row.name}:`, err);
        }
    }
}

export default birthdayModule;